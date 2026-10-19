/**
 * Repository Re-Inspection Engine & Lifecycle State Coordinator (T06).
 * Strictly read-only against GitHub REST API.
 */

import { addEvidenceRecord, deriveRoomStatus } from '../statusEngine.ts';
import type { EvidenceRecord, RoomModule } from '../types.ts';
import { categorizeFile } from '../github/fileFilter.ts';
import type { InspectedFile } from '../github/types.ts';
import {
  evaluateCheckRunsForVerification,
  fetchCommitCheckRuns,
} from './ciEvaluator.ts';
import type {
  FixLifecycleState,
  GitHubCommitInfo,
  ReinspectionOptions,
  UserFixReport,
} from './types.ts';
import { validateCommitReference } from './urlValidator.ts';

/**
 * Re-inspects the updated repository for a reported fix, retrieves CI check runs,
 * mints properly attributed evidence, and updates the room's deterministic status.
 */
export async function reinspectForFix(
  report: UserFixReport,
  room: RoomModule,
  activeOwner: string,
  activeRepo: string,
  activeDefaultBranch: string = 'main',
  baselineCommitSha?: string,
  options: ReinspectionOptions = {}
): Promise<FixLifecycleState> {
  const fetchFn = options.fetchFn || fetch;
  const maxFiles = options.maxFilesToInspect || 5;
  const warnings: string[] = [];
  const timestamp = new Date().toISOString();

  // 1. Resolve Target Ref (Commit SHA, PR, or latest branch head)
  let targetRef = activeDefaultBranch;
  let commitUrl: string | undefined;

  if (report.commitRef && report.commitRef.trim().length > 0) {
    const valResult = validateCommitReference(report.commitRef, activeOwner, activeRepo);
    if (!valResult.valid) {
      return createErrorLifecycle(
        report,
        baselineCommitSha,
        valResult.error,
        room
      );
    }

    if (valResult.refType === 'pull_request_url' && valResult.pullNumber) {
      // Fetch PR to resolve head SHA
      try {
        const prRes = await fetchFn(
          `https://api.github.com/repos/${activeOwner}/${activeRepo}/pulls/${valResult.pullNumber}`,
          { headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'TheLivingBlueprint' } }
        );
        if (!prRes.ok) {
          return createErrorLifecycle(
            report,
            baselineCommitSha,
            `Unable to retrieve pull request #${valResult.pullNumber} on ${activeOwner}/${activeRepo} (HTTP ${prRes.status}).`,
            room
          );
        }
        const prData = await prRes.json();
        targetRef = prData.head?.sha;
        commitUrl = prData.html_url;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Network error';
        return createErrorLifecycle(report, baselineCommitSha, `Failed to inspect PR: ${msg}`, room);
      }
    } else {
      targetRef = valResult.resolvedRef;
      commitUrl = valResult.canonicalUrl;
    }
  }

  // 2. Fetch Commit Details from GitHub REST API
  let commitInfo: GitHubCommitInfo | undefined;
  try {
    const commitRes = await fetchFn(
      `https://api.github.com/repos/${activeOwner}/${activeRepo}/commits/${targetRef}`,
      { headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'TheLivingBlueprint' } }
    );

    if (commitRes.status === 404) {
      return createErrorLifecycle(
        report,
        baselineCommitSha,
        `Commit reference "${targetRef}" was not found in ${activeOwner}/${activeRepo}.`,
        room
      );
    }

    if (commitRes.status === 403) {
      return createErrorLifecycle(
        report,
        baselineCommitSha,
        'GitHub API rate limit exceeded while retrieving commit details.',
        room
      );
    }

    if (!commitRes.ok) {
      return createErrorLifecycle(
        report,
        baselineCommitSha,
        `GitHub API returned HTTP ${commitRes.status} for commit "${targetRef}".`,
        room
      );
    }

    const commitData = await commitRes.json();
    commitInfo = {
      sha: commitData.sha,
      message: commitData.commit?.message || '',
      author: commitData.commit?.author?.name,
      date: commitData.commit?.author?.date,
      htmlUrl: commitData.html_url || commitUrl,
      files: Array.isArray(commitData.files)
        ? commitData.files.map((f: any) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch,
            rawUrl: f.raw_url,
          }))
        : [],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Network failure';
    return createErrorLifecycle(report, baselineCommitSha, `Failed to inspect commit: ${msg}`, room);
  }

  // 3. Compare with Baseline
  const isNewRevision = !!baselineCommitSha && commitInfo.sha !== baselineCommitSha;
  if (baselineCommitSha && commitInfo.sha === baselineCommitSha) {
    warnings.push(
      `Branch / commit has not changed (HEAD is still baseline ${baselineCommitSha.slice(0, 7)}). Code changes may not be pushed yet.`
    );
  }

  // 4. Inspect Changed Files within Budget
  const inspectedChangedFiles: InspectedFile[] = [];
  const uninspectedReportedFiles: string[] = [];
  const reportedFileList = report.changedFiles || [];

  // Match reported files against commit changed files
  for (const reportedPath of reportedFileList) {
    const trimmed = reportedPath.trim();
    if (!trimmed) continue;
    const foundInCommit = commitInfo.files.find(
      (f) => f.filename.toLowerCase() === trimmed.toLowerCase()
    );
    if (!foundInCommit) {
      uninspectedReportedFiles.push(trimmed);
      warnings.push(`Reported file "${trimmed}" was not modified in commit ${commitInfo.sha.slice(0, 7)}.`);
    }
  }

  // Inspect up to maxFiles changed files
  for (const cf of commitInfo.files.slice(0, maxFiles)) {
    const contentExcerpt = cf.patch
      ? cf.patch.slice(0, 500)
      : `File ${cf.status} with +${cf.additions}/-${cf.deletions} lines`;

    inspectedChangedFiles.push({
      path: cf.filename,
      category: categorizeFile(cf.filename),
      sizeBytes: contentExcerpt.length,
      contentExcerpt,
      rawUrl: cf.rawUrl || '',
      githubUrl: `https://github.com/${activeOwner}/${activeRepo}/blob/${commitInfo.sha}/${cf.filename}`,
    });
  }

  // 5. Fetch CI Check Runs
  const { checks, warnings: ciWarnings } = await fetchCommitCheckRuns(
    activeOwner,
    activeRepo,
    commitInfo.sha,
    fetchFn
  );
  warnings.push(...ciWarnings);

  // 6. Evaluate CI for Verification Evidence
  const targetRequirementId = room.requirements[0]?.id || `req-${room.id}`;
  const ciEvaluation = evaluateCheckRunsForVerification(
    checks,
    targetRequirementId,
    commitInfo.sha,
    timestamp
  );

  // 7. Mint Evidence Records with Strict Provenance
  const newEvidenceRecords: EvidenceRecord[] = [];

  // (a) User report evidence (Provenance: user_confirmation only)
  if (report.testOutput && report.testOutput.trim().length > 0) {
    newEvidenceRecords.push({
      id: `ev-fix-user-${commitInfo.sha.slice(0, 7)}-${Date.now()}`,
      sourceType: 'user_confirmation',
      description: `User-reported test output for fix: "${report.summary}". Note: Unverified claim from coding agent; not independently corroborated by CI.`,
      timestamp,
      reference: commitInfo.htmlUrl,
      targetRequirementId,
    });
  } else {
    newEvidenceRecords.push({
      id: `ev-fix-report-${commitInfo.sha.slice(0, 7)}-${Date.now()}`,
      sourceType: 'user_confirmation',
      description: `User reported fix: "${report.summary}"`,
      timestamp,
      reference: commitInfo.htmlUrl,
      targetRequirementId,
    });
  }

  // (b) Inspected changed code (Provenance: source_code)
  if (inspectedChangedFiles.length > 0) {
    const inspectedFilePaths = inspectedChangedFiles.map((f) => f.path).join(', ');
    newEvidenceRecords.push({
      id: `ev-code-fix-${commitInfo.sha.slice(0, 7)}-${Date.now()}`,
      sourceType: 'source_code',
      description: `Inspected code modifications in commit ${commitInfo.sha.slice(0, 7)}: ${inspectedFilePaths}`,
      timestamp,
      reference: inspectedChangedFiles[0].githubUrl,
      targetRequirementId,
    });
  }

  // (c) CI Verification Results (Provenance: test_result from CI checks)
  for (const ciEv of ciEvaluation.verificationEvidenceRecords) {
    newEvidenceRecords.push(ciEv);
  }

  // 8. Update Room Evidence and Status deterministically
  let updatedRoom = { ...room };

  // Find previous blocker or failing test in room evidence to supersede if new passing verification exists
  const priorFailingEvidence = room.evidenceHistory.find(
    (e) => !e.isSuperseded && ((e.verificationResult && e.verificationResult.status === 'failed') || e.isBlocker)
  );

  for (const newRec of newEvidenceRecords) {
    // Supersede prior failing evidence only if this new record is a passing verification result
    const shouldSupersede =
      priorFailingEvidence &&
      newRec.sourceType === 'test_result' &&
      newRec.verificationResult?.status === 'passed';

    updatedRoom = addEvidenceRecord(
      updatedRoom,
      newRec,
      shouldSupersede ? priorFailingEvidence.id : undefined
    );
  }

  const resultingStatusEvaluation = deriveRoomStatus(updatedRoom);

  // 9. Generate Dog & Cat Companion Dialogue
  const companionMessages: Array<{ speaker: 'dog' | 'cat'; text: string }> = [];

  const shortSha = commitInfo.sha.slice(0, 7);
  if (ciEvaluation.outcome === 'verified') {
    companionMessages.push({
      speaker: 'dog',
      text: `Awesome job! Commit ${shortSha} modified ${inspectedChangedFiles.length} file(s) and passed all relevant CI checks!`,
    });
    companionMessages.push({
      speaker: 'cat',
      text: `The test suite passed in CI. I've verified the evidence myself—the room is now officially verified.`,
    });
  } else if (ciEvaluation.outcome === 'failed') {
    companionMessages.push({
      speaker: 'dog',
      text: `I inspected commit ${shortSha} with the reported fix, but the automated test check failed in CI!`,
    });
    companionMessages.push({
      speaker: 'cat',
      text: `Look at the CI failure log. Don't claim a fix works until the actual tests turn green.`,
    });
  } else if (ciEvaluation.outcome === 'implemented_only') {
    companionMessages.push({
      speaker: 'dog',
      text: `Commit ${shortSha} has real code changes, but no automated test checks ran for this commit.`,
    });
    companionMessages.push({
      speaker: 'cat',
      text: `Passing a linter or preview is not a test suite. I see code changes, so status is implemented, not verified.`,
    });
  } else {
    companionMessages.push({
      speaker: 'dog',
      text: `Inspected commit ${shortSha} with your reported fix summary!`,
    });
    companionMessages.push({
      speaker: 'cat',
      text: `No CI test results are accessible here. Your pasted test claims stay unverified until a real runner confirms them.`,
    });
  }

  return {
    report,
    baselineCommitSha,
    inspectedCommit: commitInfo,
    isNewRevision,
    inspectedChangedFiles,
    uninspectedReportedFiles,
    checks,
    relevantTestChecks: ciEvaluation.relevantTestChecks,
    unrelatedChecks: ciEvaluation.unrelatedChecks,
    verificationOutcome: ciEvaluation.outcome,
    outcomeReason: ciEvaluation.outcomeReason,
    newEvidenceRecords,
    resultingStatusEvaluation,
    companionMessages,
    warnings,
    timestamp,
  };
}

function createErrorLifecycle(
  report: UserFixReport,
  baselineCommitSha: string | undefined,
  errorMessage: string,
  room: RoomModule
): FixLifecycleState {
  return {
    report,
    baselineCommitSha,
    isNewRevision: false,
    inspectedChangedFiles: [],
    uninspectedReportedFiles: report.changedFiles || [],
    checks: [],
    relevantTestChecks: [],
    unrelatedChecks: [],
    verificationOutcome: 'no_checks',
    outcomeReason: errorMessage,
    newEvidenceRecords: [],
    resultingStatusEvaluation: deriveRoomStatus(room),
    companionMessages: [
      { speaker: 'dog', text: `I ran into an issue re-inspecting: ${errorMessage}` },
      { speaker: 'cat', text: 'Check the reference or rate limit. No status changes will be made.' },
    ],
    warnings: [],
    error: errorMessage,
    timestamp: new Date().toISOString(),
  };
}
