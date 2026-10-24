import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { scanWorkspace } from '../src/workspaceScanner.ts';
import { createWorkspaceSnapshot, type WorkspaceSnapshot } from '../src/core/snapshot.ts';
import { investigateRoom, createFindingsStore, type FindingsMemento, type FindingView } from '../src/investigationService.ts';
import {
  buildHandoffPrompt,
  detectTestCommand,
  createClipboardAdapter,
  createFileAdapter,
  type HandoffPrompt,
} from '../src/core/handoff.ts';
import { validateInboundMessage } from '../src/protocol.ts';
import { createConsentManager, type ConsentStore } from '../src/security/consent.ts';
import { createCredentialService, SECRET_KEYS } from '../src/security/credentials.ts';
import type { AiGateContext } from '../src/security/aiGate.ts';

const candidatePaths = [
  path.resolve(process.cwd(), 'test', 'fixtures'),
  path.resolve(process.cwd(), 'vscode-extension', 'test', 'fixtures'),
];
const fixturesDir = candidatePaths.find((p) => fs.existsSync(p)) || candidatePaths[0];
const FOLDER = 'file:///c%3A/p211/small-express';

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
  const secrets = new Map([[SECRET_KEYS.gemini, 'fake' + '-gemini-' + 'p211']]);
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
  whyItMatters: 'Unvalidated ids can return confusing 404s.',
  category: 'test_gap',
  severity: 'medium',
  evidenceClassification: 'observed',
  evidencePaths: ['src/routes/tasks.js'],
  codeEvidence: { filePath: 'src/routes/tasks.js', targetIdentifier: 'task', codeSnippet: 'const task = tasks.find' },
  reasoning: { facts: ['The route calls parseInt on req.params.id.'], inferences: ['A non-numeric id yields NaN.'] },
  recommendedNextStep: 'Add a test for GET /tasks/abc.',
  uncertainties: 'Error middleware was not inspected.',
  companionMessages: [{ speaker: 'dog', text: 'Here is the gap.' }],
};

const fakeProvider = (async () =>
  new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(PAYLOAD) }] } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )) as unknown as typeof fetch;

/** A real stored finding produced by the P2-10 service with a fake provider. */
async function realFinding(): Promise<{ snapshot: WorkspaceSnapshot; record: FindingView }> {
  const snapshot = createWorkspaceSnapshot(await scanWorkspace(path.join(fixturesDir, 'small-express')));
  const roomId = snapshot.rooms.find((r) => r.filePaths?.includes('src/routes/tasks.js'))?.id ?? snapshot.rooms[0].id;
  const store = createFindingsStore(memento());
  const outcome = await investigateRoom({ roomId, data: snapshot, folderUri: FOLDER, gateContext: await gate(), store, fetchFn: fakeProvider, bypassCache: true });
  assert.strictEqual(outcome.status, 'success');
  return { snapshot, record: store.get(FOLDER, roomId, snapshot.fingerprint)! };
}

async function prompt(): Promise<HandoffPrompt> {
  const { snapshot, record } = await realFinding();
  const built = buildHandoffPrompt(record, snapshot);
  assert.ok(built.ok);
  return (built as { ok: true; prompt: HandoffPrompt }).prompt;
}

describe('VS Code Extension - Repair prompt construction (P2-11)', () => {
  it('builds from the real finding: generatedPrompt, refs, fingerprint, observed test command, inspect-first', async () => {
    const { snapshot, record } = await realFinding();
    const built = buildHandoffPrompt(record, snapshot);
    assert.ok(built.ok);
    if (!built.ok) return;
    const body = built.prompt.body;
    assert.ok(body.includes(record.finding.generatedPrompt!.trim()), 'domain repair prompt is embedded unchanged');
    assert.ok(body.includes(snapshot.fingerprint));
    assert.ok(body.includes('src/routes/tasks.js:14'), 'validated source reference with its real line');
    assert.match(body, /Evidence classification: \*\*OBSERVED\*\*/);
    assert.match(body, /Inspect the current code first/);
    assert.match(body, /Observed test command: `npm test` \(from package\.json scripts\.test/);
    assert.match(body, /Acceptance criteria[\s\S]*Add a test for GET \/tasks\/abc\./);
    assert.match(body, /future work and was not performed/);
    assert.strictEqual(built.prompt.findingId, `${record.roomId}-${snapshot.fingerprint.slice(0, 12)}`.replace(/[^A-Za-z0-9._-]/g, '-'));
  });

  it('labels inferred findings and says when no test command was observed', async () => {
    const { snapshot, record } = await realFinding();
    const inferred: FindingView = { ...record, finding: { ...record.finding, evidenceClassification: 'inferred' } };
    const noManifest = createWorkspaceSnapshot(snapshot, new Map());
    const built = buildHandoffPrompt({ ...inferred, fingerprint: noManifest.fingerprint }, noManifest);
    assert.ok(built.ok);
    if (!built.ok) return;
    assert.match(built.prompt.body, /\*\*INFERRED\*\* — INFERRED: derived from structure/);
    assert.match(built.prompt.body, /No test command was detected in the inspected files/);
    assert.strictEqual(detectTestCommand(noManifest), undefined, 'never invented');
  });

  it('rejects missing, stale and prompt-less findings', async () => {
    const { snapshot, record } = await realFinding();
    assert.strictEqual(buildHandoffPrompt(undefined, snapshot).ok, false);
    assert.strictEqual(buildHandoffPrompt({ ...record, stale: true }, snapshot).ok, false);
    assert.strictEqual(buildHandoffPrompt({ ...record, fingerprint: 'older' }, snapshot).ok, false);
    const noPrompt = { ...record, finding: { ...record.finding, generatedPrompt: '' } };
    assert.strictEqual(buildHandoffPrompt(noPrompt, snapshot).ok, false);
  });
});

describe('VS Code Extension - Handoff adapters (P2-11)', () => {
  it('clipboard: reports success only when the write succeeds', async () => {
    const p = await prompt();
    let copied = '';
    const ok = await createClipboardAdapter({ writeText: async (t) => void (copied = t) }).handoff(p);
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(copied, p.body);

    const failed = await createClipboardAdapter({ writeText: async () => { throw new Error('denied'); } }).handoff(p);
    assert.deepStrictEqual([failed.ok, failed.reason], [false, 'clipboard_failed']);
  });

  it('file: cancelling the modal writes nothing', async () => {
    const p = await prompt();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-handoff-'));
    const result = await createFileAdapter({ workspaceRoot: root, confirm: async () => false }).handoff(p);
    assert.deepStrictEqual([result.ok, result.reason], [false, 'cancelled']);
    assert.strictEqual(fs.existsSync(path.join(root, '.living-blueprint')), false);
  });

  it('file: confirmed save writes exactly .living-blueprint/prompts/<findingId>.md inside the workspace', async () => {
    const p = await prompt();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-handoff-'));
    let asked = '';
    const result = await createFileAdapter({ workspaceRoot: root, confirm: async (m) => ((asked = m), true) }).handoff(p);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.path, `.living-blueprint/prompts/${p.findingId}.md`);
    assert.match(asked, /Save the repair prompt to \.living-blueprint\/prompts\//);
    assert.strictEqual(fs.readFileSync(path.join(root, result.path!), 'utf8'), p.body);
  });

  it('file: rejects traversal ids and symlink escapes before writing', async () => {
    const p = await prompt();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-handoff-'));
    let wrote = false;
    const writeFile = async () => void (wrote = true);

    for (const findingId of ['../../evil', '..', 'a/b', '.hidden']) {
      const r = await createFileAdapter({ workspaceRoot: root, confirm: async () => true, writeFile }).handoff({ ...p, findingId });
      assert.deepStrictEqual([r.ok, r.reason], [false, 'outside_workspace'], findingId);
    }

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-outside-'));
    const escaped = await createFileAdapter({
      workspaceRoot: root,
      confirm: async () => true,
      writeFile,
      realpath: async (x) => (x === root ? root : outside), // .living-blueprint resolves outside
    }).handoff(p);
    assert.deepStrictEqual([escaped.ok, escaped.reason], [false, 'outside_workspace']);
    assert.strictEqual(wrote, false);
  });

  it('file: unavailable without a workspace folder', async () => {
    const adapter = createFileAdapter({ workspaceRoot: undefined, confirm: async () => true });
    assert.strictEqual(adapter.available(), false);
    assert.strictEqual((await adapter.handoff(await prompt())).reason, 'unavailable');
  });
});

describe('VS Code Extension - handoffRepairPrompt protocol (P2-11)', () => {
  it('requires a current room and a copy/save action', () => {
    const validRoomIds = ['room-api'];
    assert.strictEqual(validateInboundMessage({ command: 'handoffRepairPrompt', roomId: 'room-api', action: 'copy' }, { validRoomIds }).valid, true);
    assert.strictEqual(validateInboundMessage({ command: 'handoffRepairPrompt', roomId: 'room-api', action: 'save' }, { validRoomIds }).valid, true);
    assert.strictEqual(validateInboundMessage({ command: 'handoffRepairPrompt', roomId: 'room-api', action: 'run' }, { validRoomIds }).valid, false);
    assert.strictEqual(validateInboundMessage({ command: 'handoffRepairPrompt', roomId: 'room-old', action: 'copy' }, { validRoomIds }).valid, false);
    assert.strictEqual(validateInboundMessage({ command: 'handoffRepairPrompt', roomId: 'room-api', action: 'copy' }).valid, false);
  });
});
