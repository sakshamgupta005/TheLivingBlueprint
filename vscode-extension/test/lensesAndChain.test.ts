import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { scanWorkspace } from '../src/workspaceScanner.ts';
import { createWorkspaceSnapshot } from '../src/core/snapshot.ts';
import { buildLensView, LENS_IDS } from '../src/core/lenses.ts';
import { buildEvidenceChainView } from '../src/core/evidenceChainView.ts';
import { validateInboundMessage, ARCHITECTURE_LENS_IDS } from '../src/protocol.ts';

const candidatePaths = [
  path.resolve(process.cwd(), 'test', 'fixtures'),
  path.resolve(process.cwd(), 'vscode-extension', 'test', 'fixtures'),
];
const fixturesDir = candidatePaths.find((p) => fs.existsSync(p)) || candidatePaths[0];

const SECRET_DEFAULT = 'postgres://admin:' + 'hunter2pw' + '@db.internal:5432/app';
const CONFIG_SOURCE = [
  "const dbUrl = process.env.DATABASE_URL || '" + SECRET_DEFAULT + "';",
  "const port = process.env.PORT || '8080';",
  'const apiSecret = process.env.API_SECRET;',
  'module.exports = { dbUrl, port, apiSecret };',
].join('\n');

async function expressSnapshot(extraExcerpts?: Record<string, string>) {
  const data = await scanWorkspace(path.join(fixturesDir, 'small-express'));
  if (!extraExcerpts) return createWorkspaceSnapshot(data);
  const base = createWorkspaceSnapshot(data);
  const map = new Map((base as unknown as { hostExcerpts: Map<string, string> }).hostExcerpts);
  for (const [k, v] of Object.entries(extraExcerpts)) map.set(k, v);
  return createWorkspaceSnapshot(data, map);
}

describe('VS Code Extension - Architecture lenses (P2-12)', () => {
  it('offers exactly the protocol lens ids', () => {
    assert.deepStrictEqual([...LENS_IDS], [...ARCHITECTURE_LENS_IDS]);
  });

  it('module lens returns the scanner graph', async () => {
    const snapshot = await expressSnapshot();
    const view = buildLensView('modules', snapshot);
    assert.strictEqual(view.sufficientEvidence, true);
    assert.strictEqual(view.graph, snapshot.graph);
    assert.ok(view.graph!.nodes.length > 0);
  });

  it('module hierarchy is explicitly unsupported instead of an empty graph', async () => {
    const view = buildLensView('module_hierarchy', await expressSnapshot());
    assert.strictEqual(view.graph, null);
    assert.strictEqual(view.sufficientEvidence, false);
    assert.match(view.message ?? '', /TypeScript code index/);
  });

  it('every lens on an empty workspace returns null graph with an explanation', async () => {
    const snapshot = createWorkspaceSnapshot(await scanWorkspace(path.join(fixturesDir, 'empty')));
    for (const id of LENS_IDS) {
      const view = buildLensView(id, snapshot);
      assert.strictEqual(view.graph, null, id);
      assert.strictEqual(view.sufficientEvidence, false, id);
      assert.ok(view.message && view.message.length > 0, `${id} explains why`);
    }
  });

  it('config lens shows configuration names but never values', async () => {
    const snapshot = await expressSnapshot({ 'src/config.js': CONFIG_SOURCE });
    const view = buildLensView('config_wiring', snapshot);
    assert.strictEqual(view.sufficientEvidence, true, view.message);
    const serialized = JSON.stringify(view);
    assert.ok(serialized.includes('DATABASE_URL') && serialized.includes('PORT'), 'names are shown');
    assert.ok(!serialized.includes('hunter2pw'), 'no secret value');
    assert.ok(!serialized.includes(SECRET_DEFAULT), 'no default value');
    assert.ok(!serialized.includes("'8080'") && !serialized.includes('Default: 8080'), 'no non-secret default either');
  });
});

describe('VS Code Extension - Evidence chain view (P2-12)', () => {
  it('distinguishes detection and references from execution and pass, which stay not_run', async () => {
    const snapshot = await expressSnapshot();
    const room = snapshot.rooms.find((r) => (r.filePaths ?? []).length > 0)!;
    const result = buildEvidenceChainView(snapshot, room.id);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.strictEqual(result.view.runEvidenceAvailable, false);
    assert.ok(result.view.items.length > 0);
    for (const item of result.view.items) {
      assert.ok(['established', 'not_established'].includes(item.claims.testFileDetected));
      assert.ok(['established', 'not_established'].includes(item.claims.testReferencesCode));
      assert.strictEqual(item.claims.testExecuted, 'not_run');
      assert.strictEqual(item.claims.testPassed, 'not_run');
      assert.ok(snapshot.discoveredFilePaths.includes(item.implementation.filePath), 'only real implementation paths');
      assert.notStrictEqual(item.chainStatus, 'complete_verified');
    }
    assert.match(result.view.message ?? '', /not run/);
  });

  it('a real local run for THIS snapshot establishes execution; another snapshot\'s run does not', async () => {
    const snapshot = await expressSnapshot();
    const room = snapshot.rooms.find((r) => r.id === 'room-tests') ?? snapshot.rooms[0];
    const failing = buildEvidenceChainView(snapshot, room.id, { fingerprint: snapshot.fingerprint, status: 'failed', command: 'npm test' });
    assert.ok(failing.ok);
    if (!failing.ok) return;
    assert.strictEqual(failing.view.runEvidenceAvailable, true);
    for (const item of failing.view.items.filter((i) => i.test)) {
      assert.strictEqual(item.claims.testExecuted, 'established');
      assert.strictEqual(item.claims.testPassed, 'not_established');
    }
    const otherSnapshot = buildEvidenceChainView(snapshot, room.id, { fingerprint: 'f'.repeat(64), status: 'passed', command: 'npm test' });
    assert.ok(otherSnapshot.ok && otherSnapshot.view.runEvidenceAvailable === false);
    if (otherSnapshot.ok) assert.ok(otherSnapshot.view.items.every((i) => i.claims.testPassed === 'not_run'));
  });

  it('a room without files yields no chain and no placeholder path', async () => {
    const snapshot = await expressSnapshot();
    snapshot.rooms.push({ ...snapshot.rooms[0], id: 'room-empty', filePaths: [] });
    const result = buildEvidenceChainView(snapshot, 'room-empty');
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepStrictEqual(result.view.items, []);
    assert.ok(!JSON.stringify(result.view).includes('src/index.js'));
  });

  it('rejects an unknown room', async () => {
    const result = buildEvidenceChainView(await expressSnapshot(), 'room-ghost');
    assert.strictEqual(result.ok, false);
  });
});

describe('VS Code Extension - Lens and chain protocol (P2-12)', () => {
  it('validates lens ids and evidence-chain room ids', () => {
    assert.strictEqual(validateInboundMessage({ command: 'selectArchitectureLens', lensId: 'config_wiring' }).valid, true);
    assert.strictEqual(validateInboundMessage({ command: 'selectArchitectureLens', lensId: 'control_flow' }).valid, false, 'not offered in the extension');
    assert.strictEqual(validateInboundMessage({ command: 'selectArchitectureLens', lensId: 7 }).valid, false);
    const validRoomIds = ['room-api'];
    assert.strictEqual(validateInboundMessage({ command: 'requestEvidenceChain', roomId: 'room-api' }, { validRoomIds }).valid, true);
    assert.strictEqual(validateInboundMessage({ command: 'requestEvidenceChain', roomId: 'room-old' }, { validRoomIds }).valid, false);
    assert.strictEqual(validateInboundMessage({ command: 'requestEvidenceChain', roomId: 'room-api' }).valid, false, 'no snapshot');
  });
});
