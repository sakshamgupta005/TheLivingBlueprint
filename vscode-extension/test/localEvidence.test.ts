import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { scanWorkspace } from '../src/workspaceScanner.ts';
import { createWorkspaceSnapshot, getSnapshotHostExcerpts, type WorkspaceSnapshot } from '../src/core/snapshot.ts';
import {
  runObservedTests,
  applyLocalTestEvidence,
  createTestRunStore,
  TEST_ROOM_ID,
  TEST_RUN_TIMEOUT_MS,
  type ExecutionOutcome,
  type RunTestsDeps,
} from '../src/core/localEvidence.ts';
import { validateInboundMessage } from '../src/protocol.ts';

const candidatePaths = [
  path.resolve(process.cwd(), 'test', 'fixtures'),
  path.resolve(process.cwd(), 'vscode-extension', 'test', 'fixtures'),
];
const fixturesDir = candidatePaths.find((p) => fs.existsSync(p)) || candidatePaths[0];
const CWD = path.join(fixturesDir, 'small-express');

async function snapshot(): Promise<WorkspaceSnapshot> {
  return createWorkspaceSnapshot(await scanWorkspace(CWD));
}

function deps(snap: WorkspaceSnapshot | undefined, outcome: ExecutionOutcome, overrides: Partial<RunTestsDeps> = {}) {
  const calls = { confirm: [] as Array<[string, string]>, execute: [] as Array<[string, string, number]> };
  const d: RunTestsDeps = {
    isTrusted: () => true,
    snapshot: snap,
    cwd: CWD,
    confirm: async (command, cwd) => (calls.confirm.push([command, cwd]), true),
    execute: async (command, cwd, timeoutMs) => (calls.execute.push([command, cwd, timeoutMs]), outcome),
    now: () => new Date('2026-10-24T12:00:00.000Z'),
    ...overrides,
  };
  return { d, calls };
}

const testRoomStatus = (s: WorkspaceSnapshot) => s.rooms.find((r) => r.id === TEST_ROOM_ID)?.status;

describe('VS Code Extension - Local test run evidence (P2-13)', () => {
  it('a test file alone does not verify the test room', async () => {
    const snap = await snapshot();
    assert.strictEqual(testRoomStatus(snap), 'implemented');
  });

  it('pass: confirms the exact observed command, records exit 0 and the status engine verifies the room', async () => {
    const snap = await snapshot();
    const { d, calls } = deps(snap, { kind: 'exited', exitCode: 0 });
    const { result, record } = await runObservedTests(d);

    assert.deepStrictEqual(calls.confirm, [['npm test', CWD]]);
    assert.deepStrictEqual(calls.execute, [['npm test', CWD, TEST_RUN_TIMEOUT_MS]]);
    assert.strictEqual(result.status, 'passed');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.evidenceRecorded, true);
    assert.strictEqual(result.fingerprint, snap.fingerprint);
    assert.strictEqual(record!.evidence.sourceType, 'test_result');
    assert.strictEqual(record!.evidence.verificationResult?.status, 'passed');

    const applied = applyLocalTestEvidence(snap, record);
    assert.strictEqual(applied.applied, true);
    assert.strictEqual(testRoomStatus(applied.snapshot), 'verified');
    assert.strictEqual(applied.snapshot.projectEvaluation.summary.verified, 1);
    assert.strictEqual(testRoomStatus(snap), 'implemented', 'input snapshot is not mutated');
    const others = (s: WorkspaceSnapshot) => s.rooms.filter((r) => r.id !== TEST_ROOM_ID).map((r) => r.status);
    assert.deepStrictEqual(others(applied.snapshot), others(snap), 'only the test room changes');
  });

  it('fail: a non-zero exit records failing evidence and the room becomes blocked', async () => {
    const snap = await snapshot();
    const { result, record } = await runObservedTests(deps(snap, { kind: 'exited', exitCode: 1 }).d);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.evidenceRecorded, true);
    assert.strictEqual(testRoomStatus(applyLocalTestEvidence(snap, record).snapshot), 'blocked');
  });

  it('stale: evidence for another fingerprint is not applied and the room falls back to implemented', async () => {
    const snap = await snapshot();
    const { record } = await runObservedTests(deps(snap, { kind: 'exited', exitCode: 0 }).d);
    const changed = { ...record!, fingerprint: 'a'.repeat(64) };
    const applied = applyLocalTestEvidence(snap, changed);
    assert.strictEqual(applied.applied, false);
    assert.strictEqual(applied.stale, true);
    assert.strictEqual(testRoomStatus(applied.snapshot), 'implemented');
  });

  for (const [label, outcome] of [
    ['timeout', { kind: 'timeout' }],
    ['cancelled task', { kind: 'cancelled' }],
    ['interrupted (exit 130)', { kind: 'exited', exitCode: 130 }],
  ] as Array<[string, ExecutionOutcome]>) {
    it(`${label}: no evidence recorded`, async () => {
      const { result, record } = await runObservedTests(deps(await snapshot(), outcome).d);
      assert.ok(['timeout', 'cancelled'].includes(result.status));
      assert.strictEqual(result.evidenceRecorded, false);
      assert.strictEqual(record, undefined);
    });
  }

  it('declined confirmation: nothing executes and nothing is recorded', async () => {
    const { d, calls } = deps(await snapshot(), { kind: 'exited', exitCode: 0 }, { confirm: async () => false });
    const { result, record } = await runObservedTests(d);
    assert.strictEqual(result.status, 'cancelled');
    assert.strictEqual(calls.execute.length, 0);
    assert.strictEqual(record, undefined);
  });

  it('untrusted workspace: unavailable, no confirmation, no execution', async () => {
    const { d, calls } = deps(await snapshot(), { kind: 'exited', exitCode: 0 }, { isTrusted: () => false });
    const { result } = await runObservedTests(d);
    assert.strictEqual(result.status, 'unavailable');
    assert.strictEqual(result.evidenceRecorded, false);
    assert.deepStrictEqual([calls.confirm.length, calls.execute.length], [0, 0]);
  });

  it('no observed scripts.test: unavailable, never a guessed command', async () => {
    const base = await snapshot();
    const noManifest = createWorkspaceSnapshot(base, new Map());
    const { d, calls } = deps(noManifest, { kind: 'exited', exitCode: 0 });
    const { result } = await runObservedTests(d);
    assert.strictEqual(result.status, 'unavailable');
    assert.match(result.message, /scripts\.test/);
    assert.strictEqual(calls.execute.length, 0);
  });

  it('host-only data survives evaluation and never serializes', async () => {
    const snap = await snapshot();
    const { record } = await runObservedTests(deps(snap, { kind: 'exited', exitCode: 0 }).d);
    const applied = applyLocalTestEvidence(snap, record).snapshot;
    assert.strictEqual(getSnapshotHostExcerpts(applied).size, getSnapshotHostExcerpts(snap).size);
    assert.strictEqual(applied.fingerprint, snap.fingerprint);
    const json = JSON.stringify(applied);
    assert.ok(!json.includes('hostProject') && !json.includes('hostExcerpts'));
  });

  it('store keeps the latest run per folder', async () => {
    const data = new Map<string, unknown>();
    const store = createTestRunStore({ get: <T>(k: string) => data.get(k) as T, update: async (k, v) => void data.set(k, v) });
    const snap = await snapshot();
    const first = (await runObservedTests(deps(snap, { kind: 'exited', exitCode: 1 }).d)).record!;
    const second = (await runObservedTests(deps(snap, { kind: 'exited', exitCode: 0 }).d)).record!;
    await store.save('f', first);
    await store.save('f', second);
    assert.strictEqual(store.get('f')?.status, 'passed');
    assert.strictEqual(store.get('other'), undefined);
  });

  it('protocol: runProjectTests carries no command the webview could inject', () => {
    const result = validateInboundMessage({ command: 'runProjectTests', cmd: 'rm -rf /' });
    assert.strictEqual(result.valid, true);
    if (result.valid) assert.deepStrictEqual(result.message, { command: 'runProjectTests' });
  });
});
