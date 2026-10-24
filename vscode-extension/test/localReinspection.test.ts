import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { scanWorkspace } from '../src/workspaceScanner.ts';
import { createWorkspaceSnapshot, type WorkspaceSnapshot } from '../src/core/snapshot.ts';
import { investigateRoom, createFindingsStore, type FindingsMemento, type FindingView } from '../src/investigationService.ts';
import { reinspectFinding } from '../src/core/localReinspection.ts';
import { createLocalTestEvidence, type LocalTestRunRecord } from '../src/core/localEvidence.ts';
import { validateInboundMessage } from '../src/protocol.ts';
import { createConsentManager, type ConsentStore } from '../src/security/consent.ts';
import { createCredentialService, SECRET_KEYS } from '../src/security/credentials.ts';
import type { AiGateContext } from '../src/security/aiGate.ts';

const candidatePaths = [
  path.resolve(process.cwd(), 'test', 'fixtures'),
  path.resolve(process.cwd(), 'vscode-extension', 'test', 'fixtures'),
];
const fixturesDir = candidatePaths.find((p) => fs.existsSync(p)) || candidatePaths[0];
const FOLDER = 'file:///c%3A/p214/workspace';
const ROUTES = 'src/routes/tasks.js';

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

async function gate(): Promise<AiGateContext> {
  const consent = createConsentManager(memento());
  await consent.grant(FOLDER, [FOLDER]);
  const secrets = new Map([[SECRET_KEYS.gemini, 'fake' + '-gemini-' + 'p214']]);
  return {
    isTrusted: () => true,
    isAiEnabled: () => true,
    getActiveFolderUri: () => FOLDER,
    getOpenFolderUris: () => [FOLDER],
    consent,
    credentials: createCredentialService({
      secrets: { get: async (k) => secrets.get(k), store: async () => {}, delete: async () => {} },
    }),
  };
}

const PAYLOAD = {
  title: 'Task lookup has no input validation test',
  explanation: 'The :id route parses the id but no test covers a non-numeric id.',
  category: 'test_gap',
  severity: 'medium',
  evidenceClassification: 'observed',
  evidencePaths: [ROUTES],
  codeEvidence: { filePath: ROUTES, targetIdentifier: 'task', codeSnippet: 'const task = tasks.find' },
  reasoning: { facts: ['parseInt on req.params.id'], inferences: ['NaN for non-numeric ids'] },
  recommendedNextStep: 'Add a test for GET /tasks/abc.',
  uncertainties: 'None.',
  companionMessages: [{ speaker: 'dog', text: 'Gap found.' }],
};

/** Fake provider used only to create the original finding; re-inspection never calls it. */
const provider = (async () =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(PAYLOAD) }] } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;

async function scan(root: string): Promise<WorkspaceSnapshot> {
  return createWorkspaceSnapshot(await scanWorkspace(root));
}

/** A temp copy of the fixture with a stored finding citing src/routes/tasks.js. */
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-reinspect-'));
  fs.cpSync(path.join(fixturesDir, 'small-express'), root, { recursive: true });
  const original = await scan(root);
  const roomId = original.rooms.find((r) => r.filePaths?.includes(ROUTES))!.id;
  const store = createFindingsStore(memento());
  const outcome = await investigateRoom({ roomId, data: original, folderUri: FOLDER, gateContext: await gate(), store, fetchFn: provider, bypassCache: true });
  assert.strictEqual(outcome.status, 'success');
  const record = (fp: string) => store.get(FOLDER, roomId, fp)!;
  return { root, original, roomId, store, record };
}

const passingRun = (fingerprint: string): LocalTestRunRecord => ({
  fingerprint,
  command: 'npm test',
  cwd: '/x',
  exitCode: 0,
  status: 'passed',
  at: new Date(0).toISOString(),
  evidence: createLocalTestEvidence(fingerprint, 'npm test', 0, new Date(0)),
});

describe('VS Code Extension - Local re-inspection (P2-14)', () => {
  it('records a content-hash baseline for cited inspected files when the finding is stored', async () => {
    const { original, record } = await setup();
    const r = record(original.fingerprint) as FindingView & { sourceHashes?: Record<string, string> };
    assert.ok(r.sourceHashes?.[ROUTES] && /^[0-9a-f]{64}$/.test(r.sourceHashes[ROUTES]));
  });

  it('evidence unchanged: same files, same fingerprint, finding not addressed', async () => {
    const { root, original, record } = await setup();
    const current = await scan(root);
    assert.strictEqual(current.fingerprint, original.fingerprint);
    const result = reinspectFinding(record(current.fingerprint), current, undefined);
    assert.strictEqual(result.classification, 'evidence_unchanged');
    assert.strictEqual(result.evidence.find((e) => e.file === ROUTES)?.state, 'unchanged');
    assert.match(result.message, /not been addressed/);
    assert.strictEqual(result.findingStale, false);
    assert.strictEqual(result.fixVerified, false);
  });

  it('evidence changed: new fingerprint, stale finding kept, identifier relocated, NOT verified', async () => {
    const { root, original, record, store, roomId } = await setup();
    const file = path.join(root, ROUTES);
    fs.writeFileSync(file, '// guard added\n// another line\n' + fs.readFileSync(file, 'utf8'));
    const current = await scan(root);
    assert.notStrictEqual(current.fingerprint, original.fingerprint);

    const view = record(current.fingerprint);
    assert.strictEqual(view.stale, true, 'older finding is still visible, marked stale');
    const result = reinspectFinding(view, current, undefined);
    assert.strictEqual(result.classification, 'evidence_changed');
    const ref = result.evidence.find((e) => e.file === ROUTES)!;
    assert.strictEqual(ref.state, 'changed');
    assert.strictEqual(ref.originalLine, 14);
    assert.strictEqual(ref.currentLine, 16, 'identifier found at its new line');
    assert.match(result.message, /not verified/);
    assert.strictEqual(result.testsPassedForCurrentSnapshot, false);
    assert.strictEqual(result.fixVerified, false);
    assert.strictEqual(result.findingStale, true);

    await store.attachReinspection(FOLDER, roomId, result);
    const after = store.get(FOLDER, roomId, current.fingerprint)!;
    assert.strictEqual(after.finding.title, PAYLOAD.title, 'original finding preserved');
    assert.strictEqual(after.fingerprint, original.fingerprint);
    assert.strictEqual(after.reinspections?.at(-1)?.classification, 'evidence_changed');
  });

  it('changed code plus passing tests for THIS snapshot is reported as tests passing, still not a verified fix', async () => {
    const { root, original, record } = await setup();
    fs.appendFileSync(path.join(root, ROUTES), '\n// edited\n');
    const current = await scan(root);

    const withRun = reinspectFinding(record(current.fingerprint), current, passingRun(current.fingerprint));
    assert.strictEqual(withRun.testsPassedForCurrentSnapshot, true);
    assert.strictEqual(withRun.fixVerified, false);
    assert.match(withRun.message, /not proof this specific finding is fixed/);

    const oldRun = reinspectFinding(record(current.fingerprint), current, passingRun(original.fingerprint));
    assert.strictEqual(oldRun.testsPassedForCurrentSnapshot, false, 'a pass for an older snapshot does not count');
    const failing = { ...passingRun(current.fingerprint), status: 'failed' as const, exitCode: 1 };
    assert.strictEqual(reinspectFinding(record(current.fingerprint), current, failing).testsPassedForCurrentSnapshot, false);
  });

  it('file removed: a cited file that no longer exists', async () => {
    const { root, record } = await setup();
    fs.rmSync(path.join(root, ROUTES));
    const current = await scan(root);
    const result = reinspectFinding(record(current.fingerprint), current, undefined);
    assert.strictEqual(result.classification, 'file_removed');
    assert.strictEqual(result.evidence.find((e) => e.file === ROUTES)?.state, 'file_removed');
    assert.match(result.message, /not verified/);
    assert.strictEqual(result.fixVerified, false);
  });

  it('not comparable: a finding stored without a baseline is never guessed', async () => {
    const { root, original, record } = await setup();
    const legacy = { ...record(original.fingerprint), sourceHashes: undefined };
    const result = reinspectFinding(legacy, await scan(root), undefined);
    assert.strictEqual(result.classification, 'not_comparable');
    assert.match(result.message, /Re-investigate/);
  });

  it('re-inspection never changes room status', async () => {
    const { root, record } = await setup();
    fs.appendFileSync(path.join(root, ROUTES), '\n// fixed?\n');
    const current = await scan(root);
    const before = JSON.stringify(current.rooms.map((r) => [r.id, r.status]));
    reinspectFinding(record(current.fingerprint), current, passingRun(current.fingerprint));
    assert.strictEqual(JSON.stringify(current.rooms.map((r) => [r.id, r.status])), before);
  });

  it('protocol: reinspectFinding needs a room from the current snapshot', () => {
    const validRoomIds = ['room-api'];
    assert.strictEqual(validateInboundMessage({ command: 'reinspectFinding', roomId: 'room-api' }, { validRoomIds }).valid, true);
    assert.strictEqual(validateInboundMessage({ command: 'reinspectFinding', roomId: 'room-x' }, { validRoomIds }).valid, false);
    assert.strictEqual(validateInboundMessage({ command: 'reinspectFinding', roomId: '' }, { validRoomIds }).valid, false);
    assert.strictEqual(validateInboundMessage({ command: 'reinspectFinding', roomId: 'room-api' }).valid, false);
  });
});
