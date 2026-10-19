/**
 * Domain types for Fix Reporting, Repository Re-Inspection, and Verification Lifecycle (T06).
 */

import type { EvidenceRecord, RoomStatusEvaluation } from '../types.ts';
import type { InspectedFile } from '../github/types.ts';
import type { RoomInvestigationFinding } from '../investigation/types.ts';

export interface UserFixReport {
  summary: string;
  commitRef?: string;
  changedFiles?: string[];
  testOutput?: string;
  investigationFindingId?: string;
  originalFindingTitle?: string;
  roomId: string;
  roomName: string;
}

export interface GitHubCommitInfo {
  sha: string;
  message: string;
  author?: string;
  date?: string;
  htmlUrl?: string;
  files: Array<{
    filename: string;
    status: 'added' | 'modified' | 'removed' | 'renamed';
    additions: number;
    deletions: number;
    patch?: string;
    rawUrl?: string;
  }>;
}

export interface GitHubCheckRunOutput {
  title?: string | null;
  summary?: string | null;
  text?: string | null;
}

export interface GitHubCheckRun {
  id: number | string;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'timed_out'
    | 'action_required'
    | 'skipped'
    | null;
  htmlUrl?: string;
  completedAt?: string;
  isRelevantTestCheck: boolean;
  relevanceReason?: string;
  commitSha?: string;
  output?: GitHubCheckRunOutput;
  failureDetails?: string;
}

export type VerificationEvidenceOutcome =
  | 'verified'
  | 'implemented_only'
  | 'failed'
  | 'inconclusive'
  | 'no_checks';

export interface CompanionLifecycleDialogue {
  speaker: 'dog' | 'cat';
  text: string;
}

export interface FixLifecycleState {
  report: UserFixReport;
  originalFinding?: RoomInvestigationFinding | null;
  baselineCommitSha?: string;
  inspectedCommit?: GitHubCommitInfo;
  isNewRevision: boolean;
  inspectedChangedFiles: InspectedFile[];
  uninspectedReportedFiles: string[];
  checks: GitHubCheckRun[];
  relevantTestChecks: GitHubCheckRun[];
  unrelatedChecks: GitHubCheckRun[];
  verificationOutcome: VerificationEvidenceOutcome;
  outcomeReason: string;
  newEvidenceRecords: EvidenceRecord[];
  resultingStatusEvaluation?: RoomStatusEvaluation;
  companionMessages: CompanionLifecycleDialogue[];
  warnings: string[];
  error?: string;
  timestamp: string;
}

export interface ReinspectionOptions {
  fetchFn?: typeof fetch;
  maxFilesToInspect?: number;
}
