import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { scanWorkspace } from '../src/workspaceScanner.ts';
import { createWorkspaceSnapshot } from '../src/core/snapshot.ts';
import { investigateRoom, createFindingsStore, type FindingsMemento } from '../src/investigationService.ts';
import { askCompanion } from '../src/companionEngine.ts';
import { validateInboundMessage } from '../src/protocol.ts';
import { createConsentManager, type ConsentStore } from '../src/security/consent.ts';
import { createCredentialService, SECRET_KEYS } from '../src/security/credentials.ts';
import type { AiGateContext } from '../src/security/aiGate.ts';

const candidatePaths = [
  path.resolve(process.cwd(), 'test', 'fixtures'),
  path.resolve(process.cwd(), 'vscode-extension', 'test', 'fixtures'),
];
const fixturesDir = candidatePaths.find((p) => fs.existsSync(p)) || candidatePaths[0];
const expressFixture = path.join(fixturesDir, 'small-express');

const FOLDER = 'file:///c%3A/p210/small-express';

function memento(): ConsentStore & FindingsMemento {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      if (value === undefined) data.delete(key);
      else data.set(key, value);
    },
    keys: () => [...data.keys()],
  };
}

async function gate(opts: { trusted?: boolean; consented?: boolean; withKey?: boolean } = {}): Promise<AiGateContext> {
  const consent = createConsentManager(memento());
  if (opts.consented ?? true) await consent.grant(FOLDER, [FOLDER]);
  const secrets = new Map<string, string>(opts.withKey ?? true ? [[SECRET_KEYS.gemini, 'fake' + '-gemini-' + 'p210']] : []);
  return {
    isTrusted: () => opts.trusted ?? true,
    isAiEnabled: () => true,
    getActiveFolderUri: () => FOLDER,
    getOpenFolderUris: () => [FOLDER],
    consent,
    credentials: createCredentialService({
      secrets: { get: async (k) => secrets.get(k), store: async () => {}, delete: async () => {} },
    }),
  };
}

function fakeProvider(answer: { payload?: unknown; status?: number; body?: unknown }) {
  const bodies: string[] = [];
  const fn = (async (_u: unknown, init?: { body?: unknown }) => {
    bodies.push(String(init?.body ?? ''));
    if (answer.status && answer.status !== 200) {
      return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status, headers: { 'content-type': 'application/json' } });
    }
    const text = JSON.stringify(answer.payload);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fn, bodies };
}

const PAYLOAD = {
  title: 'Task lookup has no input validation test',
  explanation: 'The :id route parses the id but no test covers a non-numeric id.',
  whyItMatters: 'Unvalidated ids can return confusing 404s.',
  category: 'test_gap',
  severity: 'medium',
  evidenceClassification: 'observed',
  evidencePaths: ['src/routes/tasks.js', 'src/ghost.ts'],
  codeEvidence: {
    filePath: 'src/routes/tasks.js',
    targetIdentifier: 'task',
    codeSnippet: 'const task = tasks.find',
    explanation: 'Lookup by parsed id.',
  },
  reasoning: { facts: ['The route calls parseInt on req.params.id.'], inferences: ['A non-numeric id yields NaN.'] },
  recommendedNextStep: 'Add a test for GET /tasks/abc.',
  uncertainties: 'Error middleware was not inspected.',
  companionMessages: [{ speaker: 'dog', text: 'Here is the gap.' }],
};

async function setup() {
  const data = createWorkspaceSnapshot(await scanWorkspace(expressFixture));
  const roomId = data.rooms.find((r) => r.filePaths?.includes('src/routes/tasks.js'))?.id ?? data.rooms[0].id;
  return { data, roomId, store: createFindingsStore(memento()) };
}

describe('VS Code Extension - Room investigation service (P2-10)', () => {
  it('returns the full seven-level finding from the shared engine with validated navigation', async () => {
    const { data, roomId, store } = await setup();
    const statusesBefore = JSON.stringify(data.rooms.map((r) => [r.id, r.status]));
    const provider = fakeProvider({ payload: PAYLOAD });

    const outcome = await investigateRoom({
      roomId, data, folderUri: FOLDER, gateContext: await gate(), store, fetchFn: provider.fn, bypassCache: true,
    });
    assert.strictEqual(outcome.status, 'success');
    if (outcome.status !== 'success') return;
    const f = outcome.record.finding;

    // 1 finding/severity/category, 2 why, 3 evidence, 4 reasoning, 5 unknowns/rejected, 6 next step, 7 repair prompt
    assert.strictEqual(f.title, PAYLOAD.title);
    assert.strictEqual(f.severity, 'medium');
    assert.strictEqual(f.category, 'test_gap');
    assert.ok(f.whyItMatters);
    assert.ok(f.evidenceReferences.some((r) => r.path === 'src/routes/tasks.js'));
    assert.ok(f.reasoning && f.reasoning.facts.length > 0);
    assert.ok(f.rejectedReferences?.includes('src/ghost.ts'), 'invented path is rejected by the domain validator');
    assert.ok(f.uncertainties);
    assert.ok(f.recommendedNextStep);
    assert.ok(f.generatedPrompt && f.generatedPrompt.length > 0, 'repair prompt generated by the shared engine');
    assert.ok(['observed', 'inferred', 'unverified'].includes(f.evidenceClassification));

    assert.ok(f.evidenceReferences.every((r) => !('githubUrl' in r)), 'no fake GitHub links for local files');
    const nav = outcome.record.navigation.references;
    assert.ok(nav.every((r) => data.discoveredFilePaths.includes(r.file)), 'navigation only to snapshot files');
    assert.ok(nav.some((r) => r.file === 'src/routes/tasks.js' && r.line === 14), 'code evidence lands on its real line');
    assert.ok(!nav.some((r) => r.file === 'src/ghost.ts'));
    assert.strictEqual(outcome.record.stale, false);
    assert.strictEqual(outcome.record.fingerprint, data.fingerprint);

    assert.strictEqual(JSON.stringify(data.rooms.map((r) => [r.id, r.status])), statusesBefore, 'status untouched');
    assert.ok(provider.bodies[0].includes('src/routes/tasks.js'), 'real inspected context reaches the engine');
  });

  it('rejects a room that is not in the snapshot without any provider call', async () => {
    const { data, store } = await setup();
    const provider = fakeProvider({ payload: PAYLOAD });
    const outcome = await investigateRoom({ roomId: 'room-ghost', data, folderUri: FOLDER, gateContext: await gate(), store, fetchFn: provider.fn });
    assert.strictEqual(outcome.status, 'invalid_room');
    assert.strictEqual(provider.bodies.length, 0);
  });

  for (const [label, opts] of [
    ['consent off', { consented: false }],
    ['untrusted workspace', { trusted: false }],
    ['missing credentials', { withKey: false }],
  ] as const) {
    it(`${label}: unavailable, zero provider calls, no finding invented`, async () => {
      const { data, roomId, store } = await setup();
      const provider = fakeProvider({ payload: PAYLOAD });
      const outcome = await investigateRoom({ roomId, data, folderUri: FOLDER, gateContext: await gate(opts), store, fetchFn: provider.fn });
      assert.strictEqual(outcome.status, 'unavailable');
      assert.strictEqual(provider.bodies.length, 0);
      assert.deepStrictEqual(store.all(FOLDER, data.fingerprint), {});
    });
  }

  it('a failed investigation preserves the previous finding', async () => {
    const { data, roomId, store } = await setup();
    const ctx = await gate();
    await investigateRoom({ roomId, data, folderUri: FOLDER, gateContext: ctx, store, fetchFn: fakeProvider({ payload: PAYLOAD }).fn, bypassCache: true });

    const failing = fakeProvider({ status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid.' } } });
    const outcome = await investigateRoom({ roomId, data, folderUri: FOLDER, gateContext: ctx, store, fetchFn: failing.fn, bypassCache: true });

    assert.strictEqual(outcome.status, 'error');
    if (outcome.status !== 'error') return;
    assert.ok(outcome.errorInfo, 'provider error surfaced');
    assert.strictEqual(outcome.previous?.finding.title, PAYLOAD.title);
    assert.strictEqual(store.get(FOLDER, roomId, data.fingerprint)?.finding.title, PAYLOAD.title, 'store untouched');
  });

  it('a changed fingerprint marks findings stale and keeps them out of chat context', async () => {
    const { data, roomId, store } = await setup();
    await investigateRoom({ roomId, data, folderUri: FOLDER, gateContext: await gate(), store, fetchFn: fakeProvider({ payload: PAYLOAD }).fn, bypassCache: true });

    const view = store.get(FOLDER, roomId, 'a-newer-fingerprint');
    assert.ok(view, 'stale finding is kept, not deleted');
    assert.strictEqual(view!.stale, true);
    assert.deepStrictEqual(store.currentFindings(FOLDER, 'a-newer-fingerprint'), {});
    assert.ok(store.currentFindings(FOLDER, data.fingerprint)[roomId]);
  });

  it('current findings reach the companion prompt', async () => {
    const { data, roomId, store } = await setup();
    const ctx = await gate();
    await investigateRoom({ roomId, data, folderUri: FOLDER, gateContext: ctx, store, fetchFn: fakeProvider({ payload: PAYLOAD }).fn, bypassCache: true });
    const chat = fakeProvider({ payload: { replies: [{ speaker: 'dog', text: 'ok' }] } });
    await askCompanion('What did the investigation find?', data, ctx, {
      fetchFn: chat.fn,
      investigationFindings: store.currentFindings(FOLDER, data.fingerprint),
    });
    assert.ok(chat.bodies[0].includes(PAYLOAD.title));
  });
});

describe('VS Code Extension - investigateRoom protocol (P2-10)', () => {
  it('accepts only rooms in the current snapshot', () => {
    const validRoomIds = ['room-api'];
    assert.strictEqual(validateInboundMessage({ command: 'investigateRoom', roomId: 'room-api' }, { validRoomIds }).valid, true);
    assert.strictEqual(validateInboundMessage({ command: 'investigateRoom', roomId: 'room-old' }, { validRoomIds }).valid, false);
    assert.strictEqual(validateInboundMessage({ command: 'investigateRoom', roomId: 'room-api' }).valid, false, 'no snapshot, no room');
    assert.strictEqual(validateInboundMessage({ command: 'investigateRoom', roomId: '' }, { validRoomIds }).valid, false);
    assert.strictEqual(
      validateInboundMessage({ command: 'investigateRoom', roomId: 'room-api', bypassCache: 'yes' }, { validRoomIds }).valid,
      false
    );
  });
});
