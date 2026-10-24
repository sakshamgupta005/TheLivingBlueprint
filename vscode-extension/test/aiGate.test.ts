import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { scanWorkspace } from '../src/workspaceScanner.ts';
import { askCompanion } from '../src/companionEngine.ts';
import { createConsentManager, type ConsentStore } from '../src/security/consent.ts';
import { createCredentialService, SECRET_KEYS, type SecretStore } from '../src/security/credentials.ts';
import { evaluateAiGate, guardFetch, buildPayloadPreview, type AiGateContext } from '../src/security/aiGate.ts';
import { createWorkspaceSnapshot } from '../src/core/snapshot.ts';

const candidatePaths = [
  path.resolve(process.cwd(), 'test', 'fixtures'),
  path.resolve(process.cwd(), 'vscode-extension', 'test', 'fixtures'),
];
const fixturesDir = candidatePaths.find((p) => fs.existsSync(p)) || candidatePaths[0];
const expressFixture = path.join(fixturesDir, 'small-express');

const FOLDER = 'file:///c%3A/gate/small-express';
const FAKE_KEY = 'fake' + '-gemini-' + 'gate-0001';

function memento(): ConsentStore {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key, value) => {
      if (value === undefined) data.delete(key);
      else data.set(key, value);
    },
    keys: () => [...data.keys()],
  };
}

function countingSecrets(initial: Record<string, string>): SecretStore & { reads: number } {
  const data = new Map(Object.entries(initial));
  const store = {
    reads: 0,
    get: async (key: string) => {
      store.reads++;
      return data.get(key);
    },
    store: async (key: string, value: string) => {
      data.set(key, value);
    },
    delete: async (key: string) => {
      data.delete(key);
    },
  };
  return store;
}

function countingFetch(): typeof fetch & { calls: number } {
  const fn = (async () => {
    fn.calls++;
    return new Response(JSON.stringify({ error: { message: 'fake provider rejection' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch & { calls: number };
  fn.calls = 0;
  return fn;
}

async function setup(opts: { trusted?: boolean; aiEnabled?: boolean; consented?: boolean; withKey?: boolean }) {
  const consent = createConsentManager(memento());
  if (opts.consented) await consent.grant(FOLDER, [FOLDER]);
  const secrets = countingSecrets(opts.withKey ? { [SECRET_KEYS.gemini]: FAKE_KEY } : {});
  const ctx: AiGateContext = {
    isTrusted: () => opts.trusted ?? true,
    isAiEnabled: () => opts.aiEnabled ?? true,
    getActiveFolderUri: () => FOLDER,
    getOpenFolderUris: () => [FOLDER],
    consent,
    credentials: createCredentialService({ secrets }),
  };
  return { ctx, consent, secrets };
}

describe('VS Code Extension - Central AI gate (P2-07)', () => {
  it('consent off: zero provider calls, zero credential reads, offline answer', async () => {
    const data = await scanWorkspace(expressFixture);
    const { ctx, secrets } = await setup({ consented: false, withKey: true });
    const fetchFn = countingFetch();
    const result = await askCompanion('What does this project do?', data, ctx, { fetchFn });
    assert.strictEqual(fetchFn.calls, 0);
    assert.strictEqual(secrets.reads, 0);
    assert.strictEqual(result.mode, 'offline');
    assert.ok(result.messages.length > 0 && result.messages.every((m) => !m.isAiGenerated));
  });

  it('untrusted workspace: zero provider calls and zero credential reads even with consent and a key', async () => {
    const data = await scanWorkspace(expressFixture);
    const { ctx, secrets } = await setup({ trusted: false, consented: true, withKey: true });
    const fetchFn = countingFetch();
    await askCompanion('What does this project do?', data, ctx, { fetchFn });
    assert.strictEqual(fetchFn.calls, 0);
    assert.strictEqual(secrets.reads, 0);
    assert.strictEqual((await evaluateAiGate(ctx)).state, 'blockedUntrusted');
  });

  it('AI disabled in settings: zero provider calls', async () => {
    const data = await scanWorkspace(expressFixture);
    const { ctx } = await setup({ aiEnabled: false, consented: true, withKey: true });
    const fetchFn = countingFetch();
    await askCompanion('What does this project do?', data, ctx, { fetchFn });
    assert.strictEqual(fetchFn.calls, 0);
    assert.strictEqual((await evaluateAiGate(ctx)).state, 'disabled');
  });

  it('missing credentials: zero provider calls and a needsKey state', async () => {
    const data = await scanWorkspace(expressFixture);
    const { ctx } = await setup({ consented: true, withKey: false });
    const fetchFn = countingFetch();
    const result = await askCompanion('What does this project do?', data, ctx, { fetchFn });
    assert.strictEqual(fetchFn.calls, 0);
    assert.strictEqual(result.mode, 'offline');
    assert.match(result.offlineReason ?? '', /credentials/);
    assert.strictEqual((await evaluateAiGate(ctx)).state, 'needsKey');
  });

  it('positive control: with trust, setting, consent and a key, the provider is called through the injected fetch', async () => {
    const data = await scanWorkspace(expressFixture);
    const { ctx } = await setup({ consented: true, withKey: true });
    const fetchFn = countingFetch();
    const result = await askCompanion('What does this project do?', data, ctx, { fetchFn });
    assert.ok(fetchFn.calls >= 1, 'counting fetch must observe the provider call');
    // The fake provider rejects: the error is surfaced and no reply is invented.
    assert.strictEqual(result.mode, 'ai');
    assert.strictEqual(result.messages.length, 0);
    assert.ok(result.errorInfo || result.error, 'provider failure must be surfaced');
  });

  it('revoking consent blocks subsequent provider calls through the guarded fetch', async () => {
    const { ctx, consent } = await setup({ consented: true, withKey: true });
    const fetchFn = countingFetch();
    const guarded = guardFetch(fetchFn, ctx, FOLDER);
    await guarded('https://example.invalid/first');
    await consent.revoke(FOLDER);
    await assert.rejects(guarded('https://example.invalid/second'), /AI request blocked/);
    assert.strictEqual(fetchFn.calls, 1);
  });

  it('payload preview never includes credentials or excerpt text and makes no network call', async () => {
    const data = await scanWorkspace(expressFixture);
    const snapshot = createWorkspaceSnapshot(data);
    const { ctx } = await setup({ consented: true, withKey: true });
    const gate = await evaluateAiGate(ctx);
    const preview = buildPayloadPreview(snapshot, undefined, gate);
    const serialized = JSON.stringify(preview);

    assert.strictEqual(serialized.includes(FAKE_KEY), false, 'no credential values');
    assert.strictEqual(preview.networkCallMade, false);
    assert.strictEqual(preview.credentialsIncluded, false);
    assert.match(preview.notice, /not yet connected/, 'labels the gap with live chat honestly');
    for (const f of preview.repoContext.inspectedFiles) {
      assert.strictEqual('contentExcerpt' in f, false, 'excerpt text stays on the host');
    }
    assert.ok(preview.excerptTotals.chars > 0, 'counts still describe what is prepared');
  });

  it('preview does not read credentials when consent is off', async () => {
    const data = await scanWorkspace(expressFixture);
    const { ctx, secrets } = await setup({ consented: false, withKey: true });
    const preview = buildPayloadPreview(createWorkspaceSnapshot(data), undefined, await evaluateAiGate(ctx));
    assert.strictEqual(secrets.reads, 0);
    assert.strictEqual(typeof preview.providersConfigured, 'string');
  });
});
