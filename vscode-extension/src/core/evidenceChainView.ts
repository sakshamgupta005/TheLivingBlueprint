/**
 * evidenceChainView.ts — Read-only test ↔ implementation evidence chain (P2-12).
 *
 * Adapts the shared buildEvidenceChain output for the extension. The local
 * workspace has no CI or test-run evidence yet, so "executed" and "passed"
 * are reported as 'not_run' — absence of a run is never shown as pass or fail.
 * Chains whose implementation path is not in the snapshot (the domain falls
 * back to a placeholder path) are dropped and counted, never shown.
 *
 * Pure TypeScript: no vscode import.
 */

import { buildEvidenceChain } from '../../../src/domain/evidenceChain/index.ts';
import type { ChainVerificationStatus, LinkedEvidenceChain } from '../../../src/domain/evidenceChain/index.ts';
import type { GitHubScanResult } from '../../../src/domain/github/types.ts';
import { getSnapshotHostExcerpts, type WorkspaceSnapshot } from './snapshot.ts';

export type ClaimState = 'established' | 'not_established' | 'not_run';

export interface EvidenceChainItem {
  id: string;
  requirement: { id: string; title: string; description?: string };
  implementation: { filePath: string; symbolName?: string; lineRange?: { startLine: number; endLine: number } };
  test: {
    filePath: string;
    testCaseName?: string;
    lineRange?: { startLine: number; endLine: number };
    mappingType: 'syntax' | 'heuristic';
    evidence: string;
  } | null;
  claims: {
    testFileDetected: ClaimState;
    testReferencesCode: ClaimState;
    testExecuted: ClaimState;
    testPassed: ClaimState;
  };
  chainStatus: ChainVerificationStatus;
  explanation: string;
}

export interface EvidenceChainView {
  roomId: string;
  items: EvidenceChainItem[];
  /** False until a real local test run (P2-13) or CI evidence exists. */
  runEvidenceAvailable: boolean;
  droppedCount: number;
  message?: string;
}

export type EvidenceChainViewResult = { ok: true; view: EvidenceChainView } | { ok: false; reason: string };

const detected = (v: boolean): ClaimState => (v ? 'established' : 'not_established');

function toItem(chain: LinkedEvidenceChain, runEvidenceAvailable: boolean): EvidenceChainItem {
  // Without any run evidence, a false executed/passed claim means "not run", not "failed".
  const run = (v: boolean): ClaimState => (v ? 'established' : runEvidenceAvailable ? 'not_established' : 'not_run');
  return {
    id: chain.id,
    requirement: chain.requirement,
    implementation: {
      filePath: chain.implementation.filePath,
      symbolName: chain.implementation.symbolName,
      lineRange: chain.implementation.lineRange,
    },
    test: chain.test
      ? {
          filePath: chain.test.testFilePath,
          testCaseName: chain.test.testCaseName,
          lineRange: chain.test.lineRange,
          mappingType: chain.test.mappingType,
          evidence: chain.test.evidence,
        }
      : null,
    claims: {
      testFileDetected: detected(chain.claims.testFileDetected),
      testReferencesCode: detected(chain.claims.testReferencesCode),
      testExecuted: run(chain.claims.testExecuted),
      testPassed: run(chain.claims.testPassed),
    },
    chainStatus: chain.chainStatus,
    explanation: chain.explanation,
  };
}

/** Minimal view of a P2-13 local test run (avoids importing the runner module). */
export interface LocalRunEvidence {
  fingerprint: string;
  status: 'passed' | 'failed';
  command: string;
}

export function buildEvidenceChainView(
  snapshot: WorkspaceSnapshot,
  roomId: string,
  localRun?: LocalRunEvidence
): EvidenceChainViewResult {
  const room = snapshot.rooms.find((r) => r.id === roomId);
  if (!room) return { ok: false, reason: 'Room is not in the current workspace snapshot' };

  if (!room.filePaths || room.filePaths.length === 0) {
    return {
      ok: true,
      view: { roomId, items: [], runEvidenceAvailable: false, droppedCount: 0, message: 'No implementation files are mapped to this room.' },
    };
  }

  const excerpts = getSnapshotHostExcerpts(snapshot);
  // Minimal local scan result: only the fields buildEvidenceChain reads. No check runs exist locally.
  const scanResult = {
    commitSha: snapshot.fingerprint,
    inspectedFiles: snapshot.inspectedFiles.map((f) => ({
      path: f.path,
      category: f.category,
      sizeBytes: f.sizeBytes,
      contentExcerpt: excerpts.get(f.path) ?? '',
    })),
    checkRuns: [],
    warnings: [],
  } as unknown as GitHubScanResult;

  const summary = buildEvidenceChain({ room, scanResult, externalCheckRuns: [], scannedCommitSha: snapshot.fingerprint });
  // Only a real P2-13 run for this exact snapshot counts as execution evidence.
  const run = localRun && localRun.fingerprint === snapshot.fingerprint ? localRun : undefined;
  const runEvidenceAvailable = Boolean(run);
  const discovered = new Set(snapshot.discoveredFilePaths);
  const kept = summary.chains.filter((c) => discovered.has(c.implementation.filePath));

  const items = kept.map((c) => {
    const item = toItem(c, runEvidenceAvailable);
    if (run && item.test) {
      // The whole suite ran via the observed command; a mapped test therefore executed.
      item.claims.testExecuted = 'established';
      item.claims.testPassed = run.status === 'passed' ? 'established' : 'not_established';
    }
    return item;
  });

  return {
    ok: true,
    view: {
      roomId,
      items,
      runEvidenceAvailable,
      droppedCount: summary.chains.length - kept.length,
      message: run
        ? `Execution results come from the local \`${run.command}\` run for this snapshot (${run.status}); individual test outcomes were not parsed.`
        : 'No test run or CI evidence exists for this snapshot yet, so execution and pass results are "not run".',
    },
  };
}
