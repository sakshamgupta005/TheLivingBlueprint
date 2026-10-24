/**
 * localEvidence.ts — Opt-in local test run as observed evidence (P2-13).
 *
 * The only command ever run is the workspace's observed package.json
 * scripts.test, after an explicit confirmation, in a trusted workspace.
 * Its real exit code becomes a domain EvidenceRecord (sourceType
 * 'test_result') on the test room's requirement, bound to the snapshot
 * fingerprint. The existing status engine then decides verified/blocked.
 * A changed fingerprint means the evidence is not applied (stale), so the
 * room falls back to its scan-derived status. Declined, cancelled or timed
 * out runs record nothing.
 *
 * Pure TypeScript: no vscode import; execution and confirmation are injected.
 */

import type { EvidenceRecord, Project } from '../../../src/domain/types.ts';
import { addEvidenceRecord, deriveProjectStatus } from '../../../src/domain/statusEngine.ts';
import type { WorkspaceSnapshot } from './snapshot.ts';
import { detectTestCommand } from './handoff.ts';

/** Requirement and room the shared mapper creates for automated test verification. */
export const TEST_ROOM_ID = 'room-tests';
export const TEST_REQUIREMENT_ID = 'req-gw-ci';
export const TEST_RUN_TIMEOUT_MS = 120_000;

export type TestRunStatus = 'passed' | 'failed' | 'cancelled' | 'timeout' | 'unavailable';

export interface TestRunResultMessage {
  type: 'testRunResult';
  status: TestRunStatus;
  exitCode?: number;
  fingerprint?: string;
  evidenceRecorded: boolean;
  message: string;
}

export interface LocalTestRunRecord {
  fingerprint: string;
  command: string;
  cwd: string;
  exitCode: number;
  status: 'passed' | 'failed';
  at: string;
  evidence: EvidenceRecord;
}

export type ExecutionOutcome = { kind: 'exited'; exitCode: number } | { kind: 'timeout' } | { kind: 'cancelled' };

/** Exit codes from SIGINT/SIGTERM: the user stopped the run, so it proves nothing. */
const INTERRUPT_EXIT_CODES = new Set([130, 143]);

/** Only package.json scripts.test is runnable in this milestone. */
export function observedTestCommand(snapshot: WorkspaceSnapshot): { command: string; source: string } | undefined {
  const observed = detectTestCommand(snapshot);
  return observed && observed.source.startsWith('package.json') ? observed : undefined;
}

export function createLocalTestEvidence(
  fingerprint: string,
  command: string,
  exitCode: number,
  at: Date
): EvidenceRecord {
  const timestamp = at.toISOString();
  return {
    id: `ev-local-test-${fingerprint.slice(0, 12)}-${at.getTime()}`,
    sourceType: 'test_result',
    description: `Local test run \`${command}\` exited with code ${exitCode} for workspace fingerprint ${fingerprint.slice(0, 12)}.`,
    timestamp,
    reference: `local-test-run:${fingerprint}`,
    targetRequirementId: TEST_REQUIREMENT_ID,
    verificationResult: {
      status: exitCode === 0 ? 'passed' : 'failed',
      testName: command,
      details: `Exit code ${exitCode}. Test output was not parsed for counts.`,
      timestamp,
    },
  };
}

export interface RunTestsDeps {
  isTrusted(): boolean;
  snapshot: WorkspaceSnapshot | undefined;
  cwd: string | undefined;
  confirm(command: string, cwd: string): Promise<boolean>;
  execute(command: string, cwd: string, timeoutMs: number): Promise<ExecutionOutcome>;
  now?(): Date;
}

export async function runObservedTests(
  deps: RunTestsDeps
): Promise<{ result: TestRunResultMessage; record?: LocalTestRunRecord }> {
  const unavailable = (message: string) => ({
    result: { type: 'testRunResult' as const, status: 'unavailable' as const, evidenceRecorded: false, message },
  });

  if (!deps.isTrusted()) return unavailable('Test runs are disabled in untrusted workspaces.');
  if (!deps.snapshot || !deps.cwd) return unavailable('No workspace snapshot yet. Wait for the scan to finish.');

  const observed = observedTestCommand(deps.snapshot);
  if (!observed) return unavailable('No package.json "scripts.test" was observed in this workspace, so there is nothing safe to run.');

  const fingerprint = deps.snapshot.fingerprint;
  if (!(await deps.confirm(observed.command, deps.cwd))) {
    return { result: { type: 'testRunResult', status: 'cancelled', fingerprint, evidenceRecorded: false, message: 'Test run declined. Nothing was executed.' } };
  }

  const outcome = await deps.execute(observed.command, deps.cwd, TEST_RUN_TIMEOUT_MS);
  if (outcome.kind === 'timeout') {
    return {
      result: { type: 'testRunResult', status: 'timeout', fingerprint, evidenceRecorded: false, message: `Test run stopped after ${TEST_RUN_TIMEOUT_MS / 1000}s. No evidence recorded.` },
    };
  }
  if (outcome.kind === 'cancelled' || INTERRUPT_EXIT_CODES.has(outcome.exitCode)) {
    return { result: { type: 'testRunResult', status: 'cancelled', fingerprint, evidenceRecorded: false, message: 'Test run was cancelled. No evidence recorded.' } };
  }

  const at = (deps.now ?? (() => new Date()))();
  const status = outcome.exitCode === 0 ? 'passed' : 'failed';
  const record: LocalTestRunRecord = {
    fingerprint,
    command: observed.command,
    cwd: deps.cwd,
    exitCode: outcome.exitCode,
    status,
    at: at.toISOString(),
    evidence: createLocalTestEvidence(fingerprint, observed.command, outcome.exitCode, at),
  };
  return {
    record,
    result: {
      type: 'testRunResult',
      status,
      exitCode: outcome.exitCode,
      fingerprint,
      evidenceRecorded: true,
      message:
        status === 'passed'
          ? `\`${observed.command}\` passed (exit 0). Evidence recorded for this workspace snapshot only.`
          : `\`${observed.command}\` failed (exit ${outcome.exitCode}). Failing evidence recorded for this snapshot.`,
    },
  };
}

export interface AppliedEvidence {
  snapshot: WorkspaceSnapshot;
  applied: boolean;
  stale: boolean;
  reason?: string;
}

/** Copies hidden host-only properties (excerpts, hashes, project) onto a derived snapshot. */
function withHostProps<T extends object>(source: object, target: T): T {
  for (const name of Object.getOwnPropertyNames(source)) {
    if (!Object.prototype.propertyIsEnumerable.call(source, name) && !(name in target)) {
      Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(source, name)!);
    }
  }
  return target;
}

/**
 * Evaluates the snapshot with the local run's evidence through the shared
 * status engine. Never mutates the input snapshot. Evidence for another
 * fingerprint is not applied (stale).
 */
export function applyLocalTestEvidence(snapshot: WorkspaceSnapshot, record: LocalTestRunRecord | undefined): AppliedEvidence {
  if (!record) return { snapshot, applied: false, stale: false };
  if (record.fingerprint !== snapshot.fingerprint) {
    return { snapshot, applied: false, stale: true, reason: 'The workspace changed since the last test run; run tests again.' };
  }
  const project = (snapshot as unknown as { hostProject?: Project }).hostProject;
  const testModule = project?.rooms.find((r) => r.id === TEST_ROOM_ID);
  if (!project || !testModule) {
    return { snapshot, applied: false, stale: false, reason: 'No test room was mapped in this workspace, so the run cannot verify a room.' };
  }

  const updatedProject: Project = {
    ...project,
    rooms: project.rooms.map((r) => (r.id === TEST_ROOM_ID ? addEvidenceRecord(r, record.evidence) : r)),
  };
  const evaluation = deriveProjectStatus(updatedProject);
  const statusById = new Map(evaluation.rooms.map((r) => [r.roomId, r.status]));

  const derived = withHostProps(snapshot, {
    ...snapshot,
    rooms: snapshot.rooms.map((room) =>
      room.id === TEST_ROOM_ID
        ? {
            ...room,
            status: statusById.get(room.id) ?? room.status,
            metrics: {
              ...room.metrics,
              ciStatus: record.status === 'passed' ? ('passing' as const) : ('failing' as const),
              ciCheckName: `Local run: ${record.command}`,
            },
          }
        : { ...room, status: statusById.get(room.id) ?? room.status }
    ),
    projectEvaluation: evaluation,
    statusSummary: evaluation.summary,
  });
  Object.defineProperty(derived, 'hostProject', { value: updatedProject, enumerable: false, configurable: true });
  return { snapshot: derived, applied: true, stale: false };
}

export interface TestRunMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const KEY_PREFIX = 'livingBlueprint.testRun.v1:';

/** Latest run per folder; a new run supersedes the previous one. */
export function createTestRunStore(memento: TestRunMemento) {
  return {
    get(folderUri: string): LocalTestRunRecord | undefined {
      return memento.get<LocalTestRunRecord>(KEY_PREFIX + folderUri);
    },
    async save(folderUri: string, record: LocalTestRunRecord): Promise<void> {
      await memento.update(KEY_PREFIX + folderUri, record);
    },
  };
}
