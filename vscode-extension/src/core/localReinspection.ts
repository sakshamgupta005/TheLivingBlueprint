/**
 * localReinspection.ts — Source-grounded re-inspection of a finding (P2-14).
 *
 * After a repair prompt was applied, compare each of the original finding's
 * validated source references with the current workspace: unchanged,
 * changed, file removed, or not comparable. No AI is involved, and the
 * result never marks a fix as verified: changed code is "not verified"
 * unless a real P2-13 test run passed for this exact snapshot, and even
 * then it is reported as tests passing, not as the finding being fixed.
 *
 * Pure TypeScript: no vscode import.
 */

import { getSnapshotContentHashes, getSnapshotHostExcerpts, type WorkspaceSnapshot } from './snapshot.ts';
import { locateIdentifier } from './evidenceRefs.ts';
import { findingIdFor } from './handoff.ts';
import type { LocalTestRunRecord } from './localEvidence.ts';
import type { FindingView } from '../investigationService.ts';

export type ReferenceState = 'unchanged' | 'changed' | 'file_removed' | 'not_comparable';
export type ReinspectionClassification = 'evidence_unchanged' | 'evidence_changed' | 'file_removed' | 'not_comparable';

export interface ReinspectedReference {
  file: string;
  originalLine: number;
  state: ReferenceState;
  /** Where the cited identifier is now, when it could be located in the current excerpt. */
  currentLine?: number;
  note: string;
}

export interface ReinspectionResult {
  roomId: string;
  findingId: string;
  originalFingerprint: string;
  fingerprint: string;
  classification: ReinspectionClassification;
  message: string;
  evidence: ReinspectedReference[];
  /** True only when a real local test run passed for `fingerprint` (P2-13). */
  testsPassedForCurrentSnapshot: boolean;
  /** Re-inspection never declares a fix verified. */
  fixVerified: false;
  /** The original finding was produced for an older snapshot. */
  findingStale: boolean;
  at: string;
}

/** SHA-256 of each cited file that was inspected, captured when the finding is stored. */
export function baselineHashesFor(paths: string[], snapshot: WorkspaceSnapshot): Record<string, string> {
  const hashes = getSnapshotContentHashes(snapshot);
  return Object.fromEntries(paths.filter((p) => hashes.has(p)).map((p) => [p, hashes.get(p)!]));
}

function identifierFor(record: FindingView, file: string): string | undefined {
  const f = record.finding;
  if (f.codeEvidence?.filePath === file && f.codeEvidence.targetIdentifier) return f.codeEvidence.targetIdentifier;
  return f.evidenceReferences.find((r) => r.path === file)?.verifiedIdentifier;
}

export function reinspectFinding(
  record: FindingView,
  snapshot: WorkspaceSnapshot,
  testRun: LocalTestRunRecord | undefined,
  now: Date = new Date()
): ReinspectionResult {
  const discovered = new Set(snapshot.discoveredFilePaths);
  const currentHashes = getSnapshotContentHashes(snapshot);
  const excerpts = getSnapshotHostExcerpts(snapshot);
  const baseline = (record as FindingView & { sourceHashes?: Record<string, string> }).sourceHashes ?? {};

  const seen = new Set<string>();
  const evidence: ReinspectedReference[] = [];
  for (const ref of record.navigation?.references ?? []) {
    if (seen.has(ref.file)) continue;
    seen.add(ref.file);
    const base: Omit<ReinspectedReference, 'state' | 'note'> = { file: ref.file, originalLine: ref.line };

    if (!discovered.has(ref.file)) {
      evidence.push({ ...base, state: 'file_removed', note: 'The cited file no longer exists in the workspace.' });
      continue;
    }
    const before = baseline[ref.file];
    const after = currentHashes.get(ref.file);
    if (!before || !after) {
      evidence.push({
        ...base,
        state: 'not_comparable',
        note: before ? 'The file is no longer inspected, so its content cannot be compared.' : 'No baseline content was recorded for this file when the finding was produced.',
      });
      continue;
    }
    const identifier = identifierFor(record, ref.file);
    const currentLine = identifier ? locateIdentifier(excerpts.get(ref.file) ?? '', identifier) : undefined;
    evidence.push(
      before === after
        ? { ...base, state: 'unchanged', currentLine, note: 'File content is identical to when the finding was produced.' }
        : {
            ...base,
            state: 'changed',
            currentLine,
            note: identifier && !currentLine ? `File changed; \`${identifier}\` was not found in the inspected excerpt.` : 'File content changed since the finding was produced.',
          }
    );
  }

  const has = (s: ReferenceState) => evidence.some((e) => e.state === s);
  const classification: ReinspectionClassification = has('file_removed')
    ? 'file_removed'
    : has('changed')
    ? 'evidence_changed'
    : has('unchanged')
    ? 'evidence_unchanged'
    : 'not_comparable';

  const testsPassedForCurrentSnapshot = testRun?.status === 'passed' && testRun.fingerprint === snapshot.fingerprint;
  const testNote = testsPassedForCurrentSnapshot
    ? ` The project's tests passed for this exact snapshot (observed local run); that is not proof this specific finding is fixed.`
    : ' No passing test run exists for this snapshot.';

  const message =
    classification === 'evidence_unchanged'
      ? 'The cited code is unchanged, so the finding has not been addressed in the cited locations.'
      : classification === 'evidence_changed'
      ? `Code changed; not verified.${testNote} Re-investigate to confirm the finding is resolved.`
      : classification === 'file_removed'
      ? `A cited file was removed; not verified.${testNote} Re-investigate to confirm the finding no longer applies.`
      : 'The cited references could not be compared with the current files. Re-investigate this room.';

  return {
    roomId: record.roomId,
    findingId: findingIdFor(record.roomId, record.fingerprint),
    originalFingerprint: record.fingerprint,
    fingerprint: snapshot.fingerprint,
    classification,
    message,
    evidence,
    testsPassedForCurrentSnapshot,
    fixVerified: false,
    findingStale: record.fingerprint !== snapshot.fingerprint,
    at: now.toISOString(),
  };
}
