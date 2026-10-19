import type {
  ExactCommitCiCheckInfo,
  EvidenceChainSummary,
  FailureDetailConnection,
  LinkedEvidenceChain,
} from './types.ts';
import type { ArchitecturalRoom } from '../../types.ts';
import type { GitHubScanResult } from '../github/types.ts';
import type { GitHubCheckRun } from '../lifecycle/types.ts';
import { mapTestsToImplementation, type TestMapperInputFile } from './testMapper.ts';

export interface BuildEvidenceChainOptions {
  room: ArchitecturalRoom;
  scanResult?: GitHubScanResult | null;
  externalCheckRuns?: GitHubCheckRun[];
  scannedCommitSha?: string;
  isSampleActive?: boolean;
  rawTestOutput?: string;
}

/**
 * Extracts structured failure details from raw check run output or test logs.
 */
export function parseFailureOutput(
  rawText?: string,
  failingCheckName?: string
): FailureDetailConnection {
  if (!rawText || rawText.trim().length === 0) {
    return {
      hasDetailedLogs: false,
      failureReason: 'Detailed test failure output was not provided by the CI provider.',
    };
  }

  const lines = rawText.split('\n');

  // Look for failed test name (e.g. "rejects whitespace-only task titles")
  let failingTestCase: string | undefined;
  for (const line of lines) {
    const testMatch = line.match(/(?:✖|FAIL|failed|test)\s+([A-Za-z0-9_\s-]{5,80})/i);
    if (testMatch) {
      failingTestCase = testMatch[1].trim();
      break;
    }
  }

  // Look for target test file and line
  let targetFile: string | undefined;
  let targetLine: number | undefined;
  for (const line of lines) {
    const fileMatch = line.match(/(?:at\s+.*?\()?([a-zA-Z0-9_\-./]+\.(?:test|spec)\.[a-zA-Z0-9]+):(\d+)/);
    if (fileMatch) {
      targetFile = fileMatch[1];
      targetLine = parseInt(fileMatch[2], 10);
      break;
    }
  }

  // Look for implementation target (e.g. at validateTaskTitle (src/tasks/validation.js:15:7))
  const srcFrames: Array<{ symbol: string; file: string; line: number }> = [];
  for (const line of lines) {
    const implMatch = line.match(/at\s+([A-Za-z0-9_$]+)\s+\((?:.*?[/\\])?(src\/[A-Za-z0-9_\-./]+\.[a-zA-Z0-9]+):(\d+)/);
    if (implMatch) {
      srcFrames.push({
        symbol: implMatch[1],
        file: implMatch[2],
        line: parseInt(implMatch[3], 10),
      });
    }
  }

  // Prefer root cause validation/error frames if present, otherwise first source frame
  const selectedFrame =
    srcFrames.find((f) => /validation|validate/i.test(f.file) || /validation|validate/i.test(f.symbol)) ||
    srcFrames[0];

  const targetSymbol = selectedFrame?.symbol;
  const relevantSourceFile = selectedFrame?.file;
  const relevantSourceLine = selectedFrame?.line;

  // Assertion error line
  let failureReason = lines.find((l) => /AssertionError|Error:|failed|Expected/i.test(l))?.trim();
  if (!failureReason) {
    failureReason = `Test execution failed in check "${failingCheckName || 'CI'}"`;
  }

  const explanation = targetSymbol && relevantSourceFile
    ? `${failureReason}. Failure originated in function "${targetSymbol}" at ${relevantSourceFile}:${relevantSourceLine || 1}.`
    : targetFile
    ? `${failureReason} in test file ${targetFile}:${targetLine || 1}.`
    : failureReason;

  return {
    rawOutput: rawText,
    summary: failureReason,
    hasDetailedLogs: true,
    failureReason,
    failingTestCase,
    targetFile: targetFile || relevantSourceFile,
    targetLine: targetLine || relevantSourceLine,
    targetSymbol,
    explanation,
  };
}

/**
 * Evaluates the CI check status for the exact scanned commit SHA.
 * Strictly guarantees that a check for another commit is never treated as current evidence.
 */
export function evaluateExactCommitCiCheck(
  check: GitHubCheckRun | undefined,
  targetCommitSha: string | undefined,
  inaccessibleWarning?: string
): ExactCommitCiCheckInfo {
  if (inaccessibleWarning) {
    return {
      checkName: 'GitHub Checks API',
      status: 'inaccessible',
      conclusion: null,
      commitSha: targetCommitSha || 'unknown',
      isExactScannedCommit: true,
      honestStateLabel: 'inaccessible',
      stateExplanation: `CI check information is inaccessible: ${inaccessibleWarning}`,
    };
  }

  if (!check) {
    return {
      checkName: 'Automated CI Check',
      status: 'missing',
      conclusion: null,
      commitSha: targetCommitSha || 'unknown',
      isExactScannedCommit: true,
      honestStateLabel: 'missing',
      stateExplanation: `No CI workflows or check runs found for scanned commit ${
        targetCommitSha ? targetCommitSha.slice(0, 7) : 'HEAD'
      }.`,
    };
  }

  const checkSha = check.commitSha || targetCommitSha || '';
  const isExactCommit = Boolean(
    !targetCommitSha || !check.commitSha || check.commitSha.toLowerCase() === targetCommitSha.toLowerCase()
  );

  // Mismatched / Stale SHA Protection
  if (!isExactCommit) {
    return {
      checkName: check.name,
      status: check.status,
      conclusion: check.conclusion,
      commitSha: checkSha,
      isExactScannedCommit: false,
      htmlUrl: check.htmlUrl,
      completedAt: check.completedAt,
      honestStateLabel: 'stale_commit_mismatch',
      stateExplanation: `Stale CI result: Check run "${check.name}" was executed on commit ${checkSha.slice(
        0,
        7
      )}, which does not match active scanned commit ${targetCommitSha?.slice(
        0,
        7
      )}. A check for another commit cannot be treated as current evidence.`,
    };
  }

  // Pending / In-Progress
  if (check.status === 'queued' || check.status === 'in_progress') {
    return {
      checkName: check.name,
      status: check.status,
      conclusion: null,
      commitSha: checkSha,
      isExactScannedCommit: true,
      htmlUrl: check.htmlUrl,
      completedAt: check.completedAt,
      honestStateLabel: 'pending',
      stateExplanation: `CI check "${check.name}" is currently ${check.status} on commit ${checkSha.slice(
        0,
        7
      )}. Verification is pending completion.`,
    };
  }

  // Failed
  if (check.conclusion === 'failure' || check.conclusion === 'timed_out') {
    const failureDetails = parseFailureOutput(check.failureDetails, check.name);
    const lacksLogs = !failureDetails.hasDetailedLogs;

    return {
      checkName: check.name,
      status: 'completed',
      conclusion: check.conclusion,
      commitSha: checkSha,
      isExactScannedCommit: true,
      htmlUrl: check.htmlUrl,
      completedAt: check.completedAt,
      honestStateLabel: lacksLogs ? 'lacks_logs' : 'failed',
      failureDetails,
      stateExplanation: lacksLogs
        ? `CI check "${check.name}" failed on commit ${checkSha.slice(
            0,
            7
          )}, but detailed failure logs were not provided by the GitHub API.`
        : `CI check "${check.name}" failed on commit ${checkSha.slice(0, 7)}: ${failureDetails.explanation}`,
    };
  }

  // Passed
  if (check.conclusion === 'success') {
    return {
      checkName: check.name,
      status: 'completed',
      conclusion: 'success',
      commitSha: checkSha,
      isExactScannedCommit: true,
      htmlUrl: check.htmlUrl,
      completedAt: check.completedAt,
      honestStateLabel: 'passed',
      stateExplanation: `CI check "${check.name}" passed on exact commit ${checkSha.slice(0, 7)}.`,
    };
  }

  // Inconclusive / Skipped / Neutral
  return {
    checkName: check.name,
    status: check.status,
    conclusion: check.conclusion,
    commitSha: checkSha,
    isExactScannedCommit: true,
    htmlUrl: check.htmlUrl,
    completedAt: check.completedAt,
    honestStateLabel: 'pending',
    stateExplanation: `CI check "${check.name}" concluded with status "${check.conclusion || check.status}".`,
  };
}

/**
 * Builds the complete evidence chain connecting requirement → implementation → test → exact CI check.
 */
export function buildEvidenceChain(options: BuildEvidenceChainOptions): EvidenceChainSummary {
  const { room, scanResult, externalCheckRuns } = options;
  if (!room) {
    return {
      repositorySha: options.scannedCommitSha || scanResult?.commitSha || 'local-head',
      isExactCommit: false,
      totalChains: 0,
      verifiedChainsCount: 0,
      failingChainsCount: 0,
      unverifiedCount: 0,
      missingTestsCount: 0,
      staleShaWarnings: [],
      ciState: 'missing',
      claimsSeparation: {
        filesDetectedCount: 0,
        referencingTestsCount: 0,
        executedTestsCount: 0,
        passedCheckCount: 0,
      },
      chains: [],
    };
  }
  const commitSha = options.scannedCommitSha || scanResult?.commitSha || 'local-head';

  const checkRuns = externalCheckRuns || scanResult?.checkRuns || [];
  const warnings = scanResult?.warnings || [];
  const inaccessibleWarning = warnings.find((w) => /rate limit|permission|HTTP 40[13]/i.test(w));

  const inspectedFiles = scanResult?.inspectedFiles || [];
  const testInputFiles: TestMapperInputFile[] = inspectedFiles.map((f) => ({
    path: f.path,
    content: f.contentExcerpt || '',
    category: f.category,
  }));

  // Identify primary relevant CI check for this room
  const primaryCheck = checkRuns.find((c) => c.isRelevantTestCheck) || checkRuns[0];
  const evaluatedCi = evaluateExactCommitCiCheck(primaryCheck, commitSha, inaccessibleWarning);

  const chains: LinkedEvidenceChain[] = [];
  const requirements = room.requirements && room.requirements.length > 0
    ? room.requirements
    : [
        {
          id: `req-${room.id}-1`,
          title: `Core Functionality for ${room.name}`,
          description: room.description,
        },
      ];

  const implementationFiles = (room.filePaths || []).filter(
    (p) => !/\.(test|spec)\./i.test(p) && !/^test[s]?\//i.test(p)
  );

  let verifiedChainsCount = 0;
  let failingChainsCount = 0;
  let missingTestsCount = 0;
  let unverifiedCount = 0;

  for (let idx = 0; idx < requirements.length; idx++) {
    const req = requirements[idx];
    const implPath = implementationFiles[idx % Math.max(1, implementationFiles.length)] ||
      (room.filePaths && room.filePaths[0]) ||
      'src/index.js';

    // Search for implementation file content
    const implFileObj = inspectedFiles.find((f) => f.path.replace(/\\/g, '/') === implPath.replace(/\\/g, '/'));
    const implContent = implFileObj?.contentExcerpt || '';

    // Extract primary symbol if available
    const symbolMatch = implContent.match(/export\s+(?:function|class|const)\s+([A-Za-z0-9_$]+)/);
    const symbolName = symbolMatch ? symbolMatch[1] : undefined;

    // Map relevant tests to this implementation
    const mappedTests = mapTestsToImplementation({
      testFiles: testInputFiles,
      targetImplementation: {
        filePath: implPath,
        symbolName,
        line: 1,
      },
      scannedCommitSha: commitSha,
      checkRuns,
    });

    const relevantTest = mappedTests.length > 0 ? mappedTests[0] : null;

    // Evaluate the 4 separate claims
    const testFileDetected = Boolean(
      inspectedFiles.some(
        (f) => f.category === 'test' || /\.(test|spec)\./i.test(f.path) || /^test[s]?\//i.test(f.path)
      )
    );
    const testReferencesCode = Boolean(relevantTest && relevantTest.claims.testReferencesCode);
    const testExecuted = Boolean(
      evaluatedCi.isExactScannedCommit &&
      (evaluatedCi.status === 'completed') &&
      evaluatedCi.honestStateLabel !== 'missing' &&
      evaluatedCi.honestStateLabel !== 'inaccessible'
    );
    const testPassed = Boolean(
      testExecuted && evaluatedCi.conclusion === 'success' && evaluatedCi.honestStateLabel === 'passed'
    );

    // Determine Chain Verification Status
    let chainStatus: LinkedEvidenceChain['chainStatus'] = 'unverified_implementation';
    let chainExplanation = '';

    if (evaluatedCi.honestStateLabel === 'stale_commit_mismatch') {
      chainStatus = 'stale_evidence';
      chainExplanation = evaluatedCi.stateExplanation;
    } else if (evaluatedCi.honestStateLabel === 'inaccessible') {
      chainStatus = 'ci_inaccessible';
      chainExplanation = evaluatedCi.stateExplanation;
    } else if (evaluatedCi.honestStateLabel === 'failed' || evaluatedCi.honestStateLabel === 'lacks_logs') {
      chainStatus = 'complete_failing';
      chainExplanation = evaluatedCi.stateExplanation;
      failingChainsCount++;
    } else if (testPassed && testReferencesCode) {
      chainStatus = 'complete_verified';
      chainExplanation = `Chain verified: Requirement backed by implementation "${implPath}", test "${relevantTest?.testFilePath}", and passing CI check "${evaluatedCi.checkName}" on commit ${commitSha.slice(0, 7)}.`;
      verifiedChainsCount++;
    } else if (evaluatedCi.honestStateLabel === 'pending') {
      chainStatus = 'pending_ci';
      chainExplanation = evaluatedCi.stateExplanation;
    } else if (!relevantTest) {
      chainStatus = 'missing_test';
      chainExplanation = `Implementation exists in "${implPath}", but no relevant test suite references this code.`;
      missingTestsCount++;
    } else {
      chainStatus = 'unverified_implementation';
      chainExplanation = `Test "${relevantTest.testFilePath}" references code, but automated CI verification has not established a passing result on commit ${commitSha.slice(0, 7)}.`;
      unverifiedCount++;
    }

    // Build failure connection if failed
    let failureConnection: LinkedEvidenceChain['failureConnection'];
    if (evaluatedCi.honestStateLabel === 'failed' && evaluatedCi.failureDetails?.hasDetailedLogs) {
      const details = evaluatedCi.failureDetails;
      failureConnection = {
        failedTestName: details.failingTestCase || relevantTest?.testCaseName,
        failingFile: details.targetFile || relevantTest?.testFilePath || implPath,
        relevantSourceFile: details.targetFile?.includes('test') ? implPath : details.targetFile,
        relevantSourceLine: details.targetLine,
        relevantSourceSymbol: details.targetSymbol || symbolName,
        explanation: details.explanation || evaluatedCi.stateExplanation,
        failureOutputExcerpt: details.rawOutput?.slice(0, 500),
      };
    }

    chains.push({
      id: `chain-${room.id}-${req.id}`,
      requirement: {
        id: req.id,
        title: req.title,
        description: req.description,
      },
      implementation: {
        filePath: implPath,
        symbolName,
        lineRange: { startLine: 1, endLine: Math.max(1, implContent.split('\n').length) },
        excerpt: implContent.slice(0, 300),
      },
      test: relevantTest,
      ciCheck: evaluatedCi,
      chainStatus,
      explanation: chainExplanation,
      claims: {
        testFileDetected,
        testReferencesCode,
        testExecuted,
        testPassed,
      },
      failureConnection,
    });
  }

  // Tally claim counts
  const filesDetectedCount = inspectedFiles.filter(
    (f) => f.category === 'test' || /\.(test|spec)\./i.test(f.path) || /^test[s]?\//i.test(f.path)
  ).length;

  const referencingTestsCount = chains.filter((c) => c.claims.testReferencesCode).length;
  const executedTestsCount = chains.filter((c) => c.claims.testExecuted).length;
  const passedCheckCount = chains.filter((c) => c.claims.testPassed).length;

  const staleShaWarnings: string[] = [];
  if (evaluatedCi.honestStateLabel === 'stale_commit_mismatch') {
    staleShaWarnings.push(evaluatedCi.stateExplanation);
  }

  return {
    repositorySha: commitSha,
    isExactCommit: evaluatedCi.isExactScannedCommit,
    totalChains: chains.length,
    verifiedChainsCount,
    failingChainsCount,
    unverifiedCount,
    missingTestsCount,
    staleShaWarnings,
    ciState: evaluatedCi.honestStateLabel,
    claimsSeparation: {
      filesDetectedCount,
      referencingTestsCount,
      executedTestsCount,
      passedCheckCount,
    },
    chains,
  };
}
