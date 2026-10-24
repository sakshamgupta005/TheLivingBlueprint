import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as util from 'node:util';
import { createConsentManager, type ConsentStore } from '../src/security/consent.ts';
import { createCredentialService, SECRET_KEYS, type SecretStore } from '../src/security/credentials.ts';

function memento(): ConsentStore & { data: Map<string, unknown> } {
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

function secretStore(initial: Record<string, string> = {}): SecretStore & { data: Map<string, string> } {
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

const A = 'file:///c%3A/work/a';
const B = 'file:///c%3A/work/b';
// Fake values assembled at runtime so no literal matches a real key format.
const FAKE_GEMINI = 'fake' + '-gemini-' + 'value-0001';
const FAKE_ENV_GROQ = 'fake' + '-env-groq-' + 'value-0002';

describe('VS Code Extension - Security: per-folder AI consent (P2-07)', () => {
  it('defaults to off and ignores the legacy global consent key', () => {
    const store = memento();
    store.data.set('livingBlueprint.aiConsent', true);
    const consent = createConsentManager(store);
    assert.strictEqual(consent.isGranted(A, [A]), false);
  });

  it('grants only the requested folder and never leaks to a sibling folder', async () => {
    const consent = createConsentManager(memento());
    assert.strictEqual(await consent.grant(A, [A, B]), true);
    assert.strictEqual(consent.isGranted(A, [A, B]), true);
    assert.strictEqual(consent.isGranted(B, [A, B]), false);
  });

  it('refuses to grant a folder that is not open', async () => {
    const store = memento();
    const consent = createConsentManager(store);
    assert.strictEqual(await consent.grant(B, [A]), false);
    assert.strictEqual(store.data.size, 0);
  });

  it('invalidates consent when the folder set changes, in either direction', async () => {
    const consent = createConsentManager(memento());
    await consent.grant(A, [A]);
    assert.strictEqual(consent.isGranted(A, [A, B]), false, 'adding a folder revokes');
    await consent.grant(A, [A, B]);
    assert.strictEqual(consent.isGranted(A, [A]), false, 'removing a folder revokes');
    assert.strictEqual(consent.isGranted(A, [B, A]), true, 'order does not matter');
  });

  it('revoke, pruneStale and revokeAll delete stored grants', async () => {
    const store = memento();
    const consent = createConsentManager(store);
    await consent.grant(A, [A, B]);
    await consent.grant(B, [A, B]);
    await consent.revoke(A);
    assert.strictEqual(consent.isGranted(A, [A, B]), false);

    await consent.pruneStale([B]);
    assert.strictEqual(store.data.size, 0, 'grant made under a different folder set is pruned');

    await consent.grant(A, [A]);
    store.data.set('unrelated.key', 1);
    await consent.revokeAll();
    assert.deepStrictEqual([...store.data.keys()], ['unrelated.key']);
  });
});

describe('VS Code Extension - Security: credentials (P2-07)', () => {
  it('ignores environment credentials unless the policy allows them', async () => {
    const env = { GROQ_API_KEY: FAKE_ENV_GROQ };
    const off = createCredentialService({ secrets: secretStore(), env });
    assert.strictEqual((await off.getStatus()).anyConfigured, false);
    assert.strictEqual((await off.buildProviderEnv()).GROQ_API_KEY, undefined);

    const on = createCredentialService({ secrets: secretStore(), env, getPolicy: () => ({ allowEnvCredentials: true }) });
    const status = await on.getStatus();
    assert.strictEqual(status.groq, true);
    assert.strictEqual(status.usingEnvironment, true);
  });

  it('never reads process.env implicitly', async () => {
    const previous = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = FAKE_ENV_GROQ;
    try {
      const svc = createCredentialService({ secrets: secretStore(), getPolicy: () => ({ allowEnvCredentials: true }) });
      assert.strictEqual((await svc.getStatus()).groq, false);
    } finally {
      if (previous === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = previous;
    }
  });

  it('prefers SecretStorage over the environment', async () => {
    const svc = createCredentialService({
      secrets: secretStore({ [SECRET_KEYS.gemini]: FAKE_GEMINI }),
      env: { GEMINI_API_KEY: FAKE_ENV_GROQ },
      getPolicy: () => ({ allowEnvCredentials: true }),
    });
    const env = await svc.buildProviderEnv();
    assert.strictEqual(env.GEMINI_API_KEY, FAKE_GEMINI);
    assert.strictEqual((await svc.getStatus()).usingEnvironment, false);
  });

  it('status is booleans only and the provider env hides values from serialization and logs', async () => {
    const svc = createCredentialService({ secrets: secretStore({ [SECRET_KEYS.gemini]: FAKE_GEMINI }) });
    const status = await svc.getStatus();
    assert.ok(Object.values(status).every((v) => typeof v === 'boolean'));
    assert.strictEqual(JSON.stringify(status).includes(FAKE_GEMINI), false);

    const env = await svc.buildProviderEnv();
    assert.strictEqual(JSON.stringify(env).includes(FAKE_GEMINI), false);
    assert.strictEqual(JSON.stringify({ env }).includes(FAKE_GEMINI), false);
    assert.strictEqual(util.inspect(env).includes(FAKE_GEMINI), false);
    assert.deepStrictEqual(Object.keys(env).sort(), [
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
      'GEMINI_API_KEY',
      'GROQ_API_KEY',
      'OMNIROUTE_API_KEY',
      'OMNIROUTE_BASE_URL',
      'OMNIROUTE_MODEL',
    ]);
  });

  it('cloudflare counts as configured only with both token and account id', async () => {
    const tokenOnly = createCredentialService({ secrets: secretStore({ [SECRET_KEYS.cloudflareToken]: FAKE_GEMINI }) });
    assert.strictEqual((await tokenOnly.getStatus()).cloudflare, false);
    assert.strictEqual((await tokenOnly.getStatus()).anyConfigured, false);
  });

  it('validates, stores and clears credentials', async () => {
    const secrets = secretStore();
    const svc = createCredentialService({ secrets });
    await assert.rejects(svc.setCredential('gemini', '   '), /empty value/);
    await assert.rejects(svc.setCredential('gemini', 'has space'), /whitespace/);
    await assert.rejects(svc.setCredential('gemini', 'x'.repeat(513)), /too long/);
    await assert.rejects(svc.setCredential('toString' as never, 'abc'), /unknown provider/);

    await svc.setCredential('gemini', `  ${FAKE_GEMINI}  `);
    assert.strictEqual(secrets.data.get(SECRET_KEYS.gemini), FAKE_GEMINI);
    assert.deepStrictEqual(await svc.getSecretValues(), [FAKE_GEMINI]);

    await svc.clearAll();
    assert.strictEqual(secrets.data.size, 0);
  });
});
