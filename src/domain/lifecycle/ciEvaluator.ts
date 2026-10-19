/**
 * Evaluates GitHub CI and Check Runs for functional test relevance and verification evidence.
 */

import type { EvidenceRecord } from '../types.ts';
import type { GitHubCheckRun, VerificationEvidenceOutcome } from './types.ts';

// Patterns that indicate functional testing/verification suites
const TEST_RELEVANCE_REGEX = /(?:test|tests|spec|specs|unit|e2e|integration|jest|vitest|pytest|cypress|playwright|ci[\/_-]?test|check[\/_-]?test|run[\/_-]?test)/i;

// Patterns that indicate purely non-functional checks (lint, style, docs, deployments)
const UNRELATED_CHECK_REGEX = /(?:lint|eslint|prettier|style|format|docs|typedoc|deploy|preview|pages|release|license|labeler|publish|triage)/i;

/**
 * Classifies whether a check run represents automated testing relevant to functional verification.
 */
export function classifyCheckRunRelevance(name: string): {
  isRelevantTestCheck: boolean;
  relevanceReason: string;
} {
  const isExcluded = UNRELATED_CHECK_REGEX.test(name) && !TEST_RELEVANCE_REGEX.test(name);
  if (isExcluded) {
    return {
      isRelevantTestCheck: false,
      relevanceReason: `Check "${name}" is a formatting, documentation, or deployment task and does not prove functional correctness.`,
    };
  }

  const isTest = TEST_RELEVANCE_REGEX.test(name);
  if (isTest) {
    return {
      isRelevantTestCheck: true,
      relevanceReason: `Check "${name}" matches automated test suite patterns.`,
    };
  }

  // Generic CI checks (e.g., "build", "ci", "validate") without explicit test indicators
  if (/^(?:build|ci|continuous-integration|workflow|check)$/i.test(name.trim())) {
    return {
      isRelevantTestCheck: true,
      relevanceReason: `Check "${name}" is a primary CI pipeline run.`,
    };
  }

  return {
    isRelevantTestCheck: false,
    relevanceReason: `Check "${name}" does not match known test patterns.`,
  };
}

export interface EvaluateCiOutcomeResult {
  outcome: VerificationEvidenceOutcome;
  outcomeReason: string;
  relevantTestChecks: GitHubCheckRun[];
  unrelatedChecks: GitHubCheckRun[];
  verificationEvidenceRecords: EvidenceRecord[];
}

/**
 * Fetches available public GitHub check runs for a commit, falling back to commit status API if needed.
 */
export async function fetchCommitCheckRuns(
  owner: string,
  repo: string,
  commitSha: string,
  fetchFn: typeof fetch = fetch
): Promise<{ checks: GitHubCheckRun[]; warnings: string[] }> {
  const checks: GitHubCheckRun[] = [];
  const warnings: string[] = [];

  let rateLimitedOrDenied = false;

  try {
    const checkRes = await fetchFn(
      `https://api.github.com/repos/${owner}/${repo}/commits/${commitSha}/check-runs`,
      { headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'TheLivingBlueprint' } }
    );

    if (checkRes.ok) {
      const checkData = await checkRes.json();
      if (Array.isArray(checkData.check_runs)) {
        for (const cr of checkData.check_runs) {
          const relevance = classifyCheckRunRelevance(cr.name || '');
          const output = cr.output
            ? {
                title: cr.output.title || null,
                summary: cr.output.summary || null,
                text: cr.output.text || null,
              }
            : undefined;
          const failureDetails = output
            ? [output.title, output.summary, output.text].filter(Boolean).join('\n')
            : undefined;

          checks.push({
            id: cr.id,
            name: cr.name,
            status: cr.status,
            conclusion: cr.conclusion,
            htmlUrl: cr.html_url || cr.details_url,
            completedAt: cr.completed_at,
            commitSha: cr.head_sha || commitSha,
            isRelevantTestCheck: relevance.isRelevantTestCheck,
            relevanceReason: relevance.relevanceReason,
            output,
            failureDetails,
          });
        }
      }
    } else if (checkRes.status === 403 || checkRes.status === 401) {
      rateLimitedOrDenied = true;
      warnings.push(`GitHub API permission denied or rate limit exceeded (HTTP ${checkRes.status}) when fetching CI check runs.`);
    } else if (checkRes.status !== 404) {
      warnings.push(`GitHub check-runs API returned HTTP ${checkRes.status}.`);
    }
  } catch {
    warnings.push('Failed to query GitHub check-runs API; check results unavailable.');
  }

  // Fallback 1: GitHub Actions workflow runs for this exact commit
  if (checks.length === 0 && !rateLimitedOrDenied) {
    try {
      const actionsRes = await fetchFn(
        `https://api.github.com/repos/${owner}/${repo}/actions/runs?head_sha=${commitSha}&per_page=10`,
        { headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'TheLivingBlueprint' } }
      );
      if (actionsRes.ok) {
        const actionsData = await actionsRes.json();
        if (Array.isArray(actionsData.workflow_runs)) {
          for (const wr of actionsData.workflow_runs) {
            const relevance = classifyCheckRunRelevance(wr.name || '');
            checks.push({
              id: wr.id,
              name: wr.name,
              status: wr.status,
              conclusion: wr.conclusion,
              htmlUrl: wr.html_url,
              completedAt: wr.updated_at,
              commitSha: wr.head_sha || commitSha,
              isRelevantTestCheck: relevance.isRelevantTestCheck,
              relevanceReason: relevance.relevanceReason,
            });
          }
        }
      }
    } catch {
      // Fallback non-fatal
    }
  }

  // Fallback 2: commit status API if no check runs found
  if (checks.length === 0 && !rateLimitedOrDenied) {
    try {
      const statusRes = await fetchFn(
        `https://api.github.com/repos/${owner}/${repo}/commits/${commitSha}/status`,
        { headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'TheLivingBlueprint' } }
      );
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        if (Array.isArray(statusData.statuses)) {
          for (const st of statusData.statuses) {
            const relevance = classifyCheckRunRelevance(st.context || '');
            checks.push({
              id: st.id,
              name: st.context,
              status: st.state === 'pending' ? 'in_progress' : 'completed',
              conclusion: st.state === 'success' ? 'success' : st.state === 'failure' ? 'failure' : null,
              htmlUrl: st.target_url,
              completedAt: st.updated_at,
              commitSha,
              isRelevantTestCheck: relevance.isRelevantTestCheck,
              relevanceReason: relevance.relevanceReason,
            });
          }
        }
      }
    } catch {
      // Optional fallback suppressed
    }
  }

  return { checks, warnings };
}

/**
 * Evaluates a list of GitHub check runs and returns the verification outcome and minted evidence records.
 */
export function evaluateCheckRunsForVerification(
  checks: GitHubCheckRun[],
  targetRequirementId: string,
  targetCommitSha: string,
  timestamp: string
): EvaluateCiOutcomeResult {
  // Commit SHA mismatch check
  const commitMatchingChecks = checks.filter(
    (c) => !c.commitSha || !targetCommitSha || c.commitSha === targetCommitSha
  );

  if (checks.length > 0 && commitMatchingChecks.length === 0) {
    return {
      outcome: 'inconclusive',
      outcomeReason: `Discovered CI checks belong to commit ${checks[0].commitSha?.slice(0, 7) || 'unknown'}, which does not match scanned revision ${targetCommitSha.slice(0, 7)}. Verification cannot be claimed.`,
      relevantTestChecks: [],
      unrelatedChecks: [],
      verificationEvidenceRecords: [],
    };
  }

  const effectiveChecks = commitMatchingChecks;
  const relevantTestChecks = effectiveChecks.filter((c) => c.isRelevantTestCheck);
  const unrelatedChecks = effectiveChecks.filter((c) => !c.isRelevantTestCheck);

  if (checks.length === 0) {
    return {
      outcome: 'no_checks',
      outcomeReason: 'No GitHub Actions or CI check runs found for this commit reference.',
      relevantTestChecks: [],
      unrelatedChecks: [],
      verificationEvidenceRecords: [],
    };
  }

  if (relevantTestChecks.length === 0) {
    return {
      outcome: 'implemented_only',
      outcomeReason: `All ${checks.length} check run(s) (${checks.map((c) => c.name).join(', ')}) are linters, previews, or deployment tasks. An unrelated green check does not prove functional correctness.`,
      relevantTestChecks: [],
      unrelatedChecks,
      verificationEvidenceRecords: [],
    };
  }

  // 1. Any relevant test check failed
  const failedTestChecks = relevantTestChecks.filter(
    (c) => c.status === 'completed' && (c.conclusion === 'failure' || c.conclusion === 'timed_out')
  );

  if (failedTestChecks.length > 0) {
    const failedNames = failedTestChecks.map((c) => c.name).join(', ');
    const evidence: EvidenceRecord = {
      id: `ev-ci-fail-${targetCommitSha.slice(0, 7)}-${Date.now()}`,
      sourceType: 'test_result',
      description: `CI check run(s) failed on commit ${targetCommitSha.slice(0, 7)}: ${failedNames}`,
      timestamp,
      reference: failedTestChecks[0].htmlUrl || `commit:${targetCommitSha}`,
      targetRequirementId,
      isBlocker: true,
      verificationResult: {
        status: 'failed',
        testName: failedNames,
        details: failedTestChecks[0].failureDetails
          ? `Check conclusion: ${failedTestChecks[0].conclusion}\n${failedTestChecks[0].failureDetails}`
          : `Check conclusion: ${failedTestChecks[0].conclusion}`,
        timestamp,
      },
    };

    return {
      outcome: 'failed',
      outcomeReason: `Automated test check(s) failed: ${failedNames}.`,
      relevantTestChecks,
      unrelatedChecks,
      verificationEvidenceRecords: [evidence],
    };
  }

  // 2. Pending or in-progress relevant checks
  const pendingTestChecks = relevantTestChecks.filter(
    (c) => c.status === 'queued' || c.status === 'in_progress'
  );

  if (pendingTestChecks.length > 0) {
    const pendingNames = pendingTestChecks.map((c) => c.name).join(', ');
    return {
      outcome: 'inconclusive',
      outcomeReason: `Relevant CI test check(s) are still running or queued: ${pendingNames}. Verification evidence cannot be established while checks are in progress.`,
      relevantTestChecks,
      unrelatedChecks,
      verificationEvidenceRecords: [],
    };
  }

  // 3. Successful relevant test checks
  const successfulTestChecks = relevantTestChecks.filter(
    (c) => c.status === 'completed' && c.conclusion === 'success'
  );

  if (successfulTestChecks.length > 0) {
    const passNames = successfulTestChecks.map((c) => c.name).join(', ');
    const evidence: EvidenceRecord = {
      id: `ev-ci-pass-${targetCommitSha.slice(0, 7)}-${Date.now()}`,
      sourceType: 'test_result',
      description: `CI test check run(s) completed successfully on commit ${targetCommitSha.slice(0, 7)}: ${passNames}`,
      timestamp,
      reference: successfulTestChecks[0].htmlUrl || `commit:${targetCommitSha}`,
      targetRequirementId,
      verificationResult: {
        status: 'passed',
        testName: passNames,
        details: `Completed successfully at ${successfulTestChecks[0].completedAt || timestamp}`,
        timestamp,
      },
    };

    return {
      outcome: 'verified',
      outcomeReason: `Relevant test check(s) passed: ${passNames}.`,
      relevantTestChecks,
      unrelatedChecks,
      verificationEvidenceRecords: [evidence],
    };
  }

  return {
    outcome: 'inconclusive',
    outcomeReason: 'Checks concluded with neutral, cancelled, or skipped statuses.',
    relevantTestChecks,
    unrelatedChecks,
    verificationEvidenceRecords: [],
  };
}
