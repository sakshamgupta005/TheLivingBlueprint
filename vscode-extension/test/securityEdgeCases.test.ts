import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createConsentManager, type ConsentStore } from '../src/security/consent.ts';
import {
  createCredentialService,
  SECRET_KEYS,
  InvalidCredentialError,
  type SecretStore,
} from '../src/security/credentials.ts';

// Fake storage only. No real environment or API keys are read.
function fakeMemento(): ConsentStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key, value) => {
      if (value === undefined) data.delete(key);
      else data.set(key, value);
    },
    keys: () => [...data.keys()],
  };
}

function fakeSecrets(initial: Record<string, string> = {}): SecretStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (key) => data.get(key),
    store: async (key, value) => {
      data.set(key, value);
    },
    delete: async (key) => {
      data.delete(key);
    },
  };
}

const ROOT_A = 'file:///c%3A/edge/a';
const ROOT_B = 'file:///c%3A/edge/b';
const ROOT_C = 'file:///c%3A/edge/c';
const fake = (label: string) => 'fake' + '-' + label + '-0000';

describe('Security edge cases: consent', () => {
  it('is off for every folder in a fresh store, including multi-root', () => {
    const consent = createConsentManager(fakeMemento());
    for (const folder of [ROOT_A, ROOT_B, ROOT_C]) {
      assert.strictEqual(consent.isGranted(folder, [ROOT_A, ROOT_B, ROOT_C]), false);
    }
  });

  it('a folder outside the open set cannot obtain or report consent', async () => {
    const store = fakeMemento();
    const consent = createConsentManager(store);
    assert.strictEqual(await consent.grant(ROOT_C, [ROOT_A, ROOT_B]), false);
    assert.strictEqual(await consent.grant('', [ROOT_A]), false);
    assert.strictEqual(store.data.size, 0, 'nothing is persisted for a rejected grant');

    await consent.grant(ROOT_A, [ROOT_A]);
    assert.strictEqual(consent.isGranted(ROOT_A, [ROOT_B]), false, 'granted folder is not open now');
  });

  it('trailing slashes do not create a second identity', async () => {
    const consent = createConsentManager(fakeMemento());
    await consent.grant(ROOT_A + '/', [ROOT_A]);
    assert.strictEqual(consent.isGranted(ROOT_A, [ROOT_A + '/']), true);
  });

  it('does not carry across a folder-set swap, even when the folder count is equal', async () => {
    const consent = createConsentManager(fakeMemento());
    await consent.grant(ROOT_A, [ROOT_A, ROOT_B]);
    assert.strictEqual(consent.isGranted(ROOT_A, [ROOT_A, ROOT_C]), false);
  });

  it('re-opening the original folder set does not resurrect pruned consent', async () => {
    const store = fakeMemento();
    const consent = createConsentManager(store);
    await consent.grant(ROOT_A, [ROOT_A, ROOT_B]);
    await consent.pruneStale([ROOT_A]);
    assert.strictEqual(store.data.size, 0);
    assert.strictEqual(consent.isGranted(ROOT_A, [ROOT_A, ROOT_B]), false);
  });

  it('pruneStale keeps valid grants for the current folder set', async () => {
    const consent = createConsentManager(fakeMemento());
    await consent.grant(ROOT_A, [ROOT_A, ROOT_B]);
    await consent.pruneStale([ROOT_B, ROOT_A]);
    assert.strictEqual(consent.isGranted(ROOT_A, [ROOT_A, ROOT_B]), true);
  });

  it('malformed stored values are not treated as consent and are pruned', async () => {
    const store = fakeMemento();
    store.data.set('livingBlueprint.aiConsent.v2:' + ROOT_A, true);
    const consent = createConsentManager(store);
    assert.strictEqual(consent.isGranted(ROOT_A, [ROOT_A]), false);
    await consent.pruneStale([ROOT_A]);
    assert.strictEqual(store.data.size, 0);
  });
});

describe('Security edge cases: credentials', () => {
  it('SecretStorage wins over the environment for every provider', async () => {
    const svc = createCredentialService({
      secrets: fakeSecrets({
        [SECRET_KEYS.gemini]: fake('stored-gemini'),
        [SECRET_KEYS.groq]: fake('stored-groq'),
        [SECRET_KEYS.cloudflareToken]: fake('stored-cf-token'),
        [SECRET_KEYS.cloudflareAccount]: fake('stored-cf-account'),
      }),
      env: {
        GEMINI_API_KEY: fake('env-gemini'),
        GROQ_API_KEY: fake('env-groq'),
        CLOUDFLARE_API_TOKEN: fake('env-cf-token'),
        CLOUDFLARE_ACCOUNT_ID: fake('env-cf-account'),
      },
      getPolicy: () => ({ allowEnvCredentials: true }),
    });
    const env = await svc.buildProviderEnv();
    assert.strictEqual(env.GEMINI_API_KEY, fake('stored-gemini'));
    assert.strictEqual(env.GROQ_API_KEY, fake('stored-groq'));
    assert.strictEqual(env.CLOUDFLARE_API_TOKEN, fake('stored-cf-token'));
    assert.strictEqual(env.CLOUDFLARE_ACCOUNT_ID, fake('stored-cf-account'));
    assert.strictEqual((await svc.getStatus()).usingEnvironment, false);
  });

  it('environment is ignored by default and when the policy is explicitly false', async () => {
    const env = { GEMINI_API_KEY: fake('env-gemini'), GOOGLE_GENAI_API_KEY: fake('env-google') };
    for (const getPolicy of [undefined, () => ({ allowEnvCredentials: false })]) {
      const svc = createCredentialService({ secrets: fakeSecrets(), env, getPolicy });
      assert.strictEqual((await svc.buildProviderEnv()).GEMINI_API_KEY, undefined);
      assert.deepStrictEqual(await svc.getSecretValues(), []);
    }
  });

  it('policy is re-read on every call, so turning it off takes effect immediately', async () => {
    let allow = true;
    const svc = createCredentialService({
      secrets: fakeSecrets(),
      env: { GROQ_API_KEY: fake('env-groq') },
      getPolicy: () => ({ allowEnvCredentials: allow }),
    });
    assert.strictEqual((await svc.getStatus()).groq, true);
    allow = false;
    assert.strictEqual((await svc.getStatus()).groq, false);
  });

  it('uses the GOOGLE_GENAI_API_KEY alias only under the explicit policy', async () => {
    const svc = createCredentialService({
      secrets: fakeSecrets(),
      env: { GOOGLE_GENAI_API_KEY: fake('env-google') },
      getPolicy: () => ({ allowEnvCredentials: true }),
    });
    assert.strictEqual((await svc.buildProviderEnv()).GEMINI_API_KEY, fake('env-google'));
  });

  it('rejects empty, whitespace-only, embedded-whitespace and overlong writes without storing', async () => {
    const secrets = fakeSecrets();
    const svc = createCredentialService({ secrets });
    for (const bad of ['', ' ', '\t\n', 'two words', 'line\nbreak', 'x'.repeat(513)]) {
      await assert.rejects(svc.setCredential('groq', bad), InvalidCredentialError);
    }
    assert.strictEqual(secrets.data.size, 0);
    await svc.setCredential('groq', 'x'.repeat(512));
    assert.strictEqual(secrets.data.get(SECRET_KEYS.groq)?.length, 512, '512 is the inclusive limit');
  });

  it('clearAll removes every provider secret and status returns to unconfigured', async () => {
    const secrets = fakeSecrets({
      [SECRET_KEYS.gemini]: fake('g'),
      [SECRET_KEYS.cloudflareToken]: fake('t'),
      [SECRET_KEYS.cloudflareAccount]: fake('a'),
      'other.extension.key': fake('other'),
    });
    const svc = createCredentialService({ secrets });
    await svc.clearAll();
    assert.deepStrictEqual([...secrets.data.keys()], ['other.extension.key']);
    assert.strictEqual((await svc.getStatus()).anyConfigured, false);
  });

  it('status exposes exactly the documented boolean fields and no values', async () => {
    const svc = createCredentialService({ secrets: fakeSecrets({ [SECRET_KEYS.gemini]: fake('stored-gemini') }) });
    const status = await svc.getStatus();
    assert.deepStrictEqual(Object.keys(status).sort(), ['anyConfigured', 'cloudflare', 'gemini', 'groq', 'omniroute', 'usingEnvironment']);
    for (const v of Object.values(status)) assert.strictEqual(typeof v, 'boolean');
  });

  it('buildProviderEnv returns an explicit object with all credential names even when nothing is configured', async () => {
    // Callers must pass this object to root AI functions; omitting it (or passing
    // undefined) makes those functions default to process.env. JSON hiding on this
    // object is only a logging safeguard, so this test does not rely on it.
    const env = await createCredentialService({ secrets: fakeSecrets() }).buildProviderEnv();
    assert.ok(env && typeof env === 'object');
    for (const name of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
      assert.ok(Object.prototype.hasOwnProperty.call(env, name), `${name} is an own property`);
      assert.strictEqual(env[name], undefined);
    }
  });

  it('omniroute is off until a model is set, and rejects a non-http base URL', async () => {
    const secrets = fakeSecrets();
    const svc = createCredentialService({ secrets });
    assert.strictEqual((await svc.getStatus()).omniroute, false);
    await assert.rejects(svc.setCredential('omnirouteBaseUrl', 'javascript:alert(1)'), InvalidCredentialError);
    await svc.setCredential('omnirouteBaseUrl', 'http://localhost:20128/v1');
    assert.strictEqual((await svc.getStatus()).omniroute, false, 'base URL alone does not enable it');
    await svc.setCredential('omnirouteModel', 'my-combo');
    const status = await svc.getStatus();
    assert.strictEqual(status.omniroute, true);
    assert.strictEqual(status.anyConfigured, true);
    const env = await svc.buildProviderEnv();
    assert.strictEqual(env.OMNIROUTE_MODEL, 'my-combo');
    assert.strictEqual(env.OMNIROUTE_API_KEY, undefined, 'key is optional');
  });

  it('cloudflare readiness needs both token and account id', async () => {
    const svc = createCredentialService({ secrets: fakeSecrets({ [SECRET_KEYS.cloudflareAccount]: fake('acct') }) });
    assert.strictEqual((await svc.getStatus()).cloudflare, false);
  });
});
