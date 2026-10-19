import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  mapTestsToImplementation,
  buildEvidenceChain,
  evaluateExactCommitCiCheck,
  parseFailureOutput,
  type TestMapperInputFile,
} from '../src/domain/evidenceChain/index.ts';
import type { ArchitecturalRoom } from '../src/types.ts';
import type { GitHubScanResult } from '../src/domain/github/types.ts';
import type { GitHubCheckRun } from '../src/domain/lifecycle/types.ts';
import type { EvidenceRecord } from '../src/domain/types.ts';

describe('T30: Connect Source Code, Tests, and Real CI Evidence', () => {
  const currentCommitSha = '4ddfe585adbccd57794efba49ca1102ff654382f';
  const staleCommitSha = '1111111111111111111111111111111111111111';

  // Sample files mimicking the Patchboard repository
  const testFiles: TestMapperInputFile[] = [
    {
      path: 'test/createTask.test.js',
      category: 'test',
      content: `
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createTask, TaskValidationError } from '../src/tasks/createTask.js';

describe('Task Creation & Validation', () => {
  it('creates a task with a valid title and trims surrounding whitespace', () => {
    const task = createTask('  Deploy production build  ');
    assert.strictEqual(task.title, 'Deploy production build');
  });

  it('rejects whitespace-only task titles', () => {
    assert.throws(
      () => {
        createTask('   ');
      },
      TaskValidationError,
      'Expected whitespace-only title to be rejected with TaskValidationError'
    );
  });
});
      `,
    },
    {
      path: 'test/server.test.js',
      category: 'test',
      content: `
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Server Endpoints', () => {
  it('responds with 200 on health check', () => {
    assert.ok(true);
  });
});
      `,
    },
    {
      path: 'test/unrelated.test.js',
      category: 'test',
      content: `
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Unrelated Test', () => {
  it('does something else', () => {
    assert.ok(true);
  });
});
      `,
    },
  ];

  const sampleRoom: ArchitecturalRoom = {
    id: 'room-input-validation',
    name: 'Input Validation & Schema',
    layer: 'core',
    status: 'blocked',
    description: 'Enforces schema constraints, field validation rules, and input boundaries.',
    evidence: 'Failing unit test in test/createTask.test.js',
    filePaths: ['src/tasks/createTask.js', 'src/tasks/validation.js'],
    requirements: [
      {
        id: 'req-whitespace-validation',
        title: 'Whitespace-Only Title Rejection',
        description: 'Task titles must contain at least one non-whitespace character.',
      },
    ],
    metrics: {
      ciStatus: 'failing',
      ciCheckName: 'Run Unit and Integration Tests',
    },
    coords: { isoX: 0, isoY: 0, width: 100, height: 100, depth: 50 },
  };

  const sampleInspectedFiles: GitHubScanResult['inspectedFiles'] = [
    {
      path: 'src/tasks/createTask.js',
      category: 'source',
      sizeBytes: 614,
      contentExcerpt: `
import { validateTaskTitle } from './validation.js';
import { addTask } from './store.js';

export function createTask(rawTitle) {
  const validation = validateTaskTitle(rawTitle);
  if (!validation.valid) {
    throw new TaskValidationError(validation.error);
  }
  return addTask({ title: validation.sanitizedTitle });
}
      `,
    },
    {
      path: 'src/tasks/validation.js',
      category: 'source',
      sizeBytes: 611,
      contentExcerpt: `
export function validateTaskTitle(title) {
  if (typeof title !== 'string') return { valid: false, error: 'Must be string' };
  if (title.length === 0) return { valid: false, error: 'Cannot be empty' };
  return { valid: true, sanitizedTitle: title.trim() };
}
      `,
    },
    {
      path: 'test/createTask.test.js',
      category: 'test',
      sizeBytes: 2015,
      contentExcerpt: testFiles[0].content,
    },
    {
      path: 'test/server.test.js',
      category: 'test',
      sizeBytes: 2680,
      contentExcerpt: testFiles[1].content,
    },
  ];

  describe('1. Test-to-Implementation Mapping (Syntax vs Heuristic)', () => {
    it('maps tests to implementation symbols using syntax imports and direct references', () => {
      const mapped = mapTestsToImplementation({
        testFiles,
        targetImplementation: {
          filePath: 'src/tasks/createTask.js',
          symbolName: 'createTask',
        },
        scannedCommitSha: currentCommitSha,
      });

      assert.ok(mapped.length >= 1, 'Should find at least 1 mapped test');
      const syntaxMatch = mapped.find((m) => m.testFilePath === 'test/createTask.test.js');
      assert.ok(syntaxMatch, 'Must map test/createTask.test.js');
      assert.strictEqual(syntaxMatch.mappingType, 'syntax', 'Must be classified as syntax mapping');
      assert.ok(
        syntaxMatch.evidence.includes('Syntax-confirmed mapping'),
        'Evidence must state syntax confirmation'
      );
      assert.ok(syntaxMatch.assertions.length > 0, 'Must extract assertions from test file');
    });

    it('labels heuristic associations separately when no direct syntax import exists', () => {
      // test/server.test.js does not import src/server.js in its excerpt, but matches by name
      const mapped = mapTestsToImplementation({
        testFiles,
        targetImplementation: {
          filePath: 'src/server.js',
        },
        scannedCommitSha: currentCommitSha,
      });

      assert.ok(mapped.length >= 1, 'Should find heuristic match');
      const heuristicMatch = mapped.find((m) => m.testFilePath === 'test/server.test.js');
      assert.ok(heuristicMatch, 'Must map test/server.test.js');
      assert.strictEqual(heuristicMatch.mappingType, 'heuristic', 'Must be classified as heuristic');
      assert.ok(
        heuristicMatch.evidence.includes('Heuristic association'),
        'Evidence must state heuristic association'
      );
    });

    it('does not map unrelated test files that have no syntax or heuristic relation', () => {
      const mapped = mapTestsToImplementation({
        testFiles,
        targetImplementation: {
          filePath: 'src/tasks/validation.js',
          symbolName: 'validateTaskTitle',
        },
        scannedCommitSha: currentCommitSha,
      });

      const unrelated = mapped.find((m) => m.testFilePath === 'test/unrelated.test.js');
      assert.strictEqual(unrelated, undefined, 'Unrelated test file must not be mapped');
    });
  });

  describe('2. Exact Scanned Commit CI Check Validation (Never Treat Stale SHA as Current)', () => {
    it('rejects green check from a different (stale) commit SHA and reports mismatch', () => {
      const staleCheck: GitHubCheckRun = {
        id: 9999,
        name: 'Run Unit and Integration Tests',
        status: 'completed',
        conclusion: 'success',
        commitSha: staleCommitSha, // Stale SHA!
        completedAt: '2026-10-18T10:00:00Z',
        isRelevantTestCheck: true,
        relevanceReason: 'Unit test suite',
      };

      const result = evaluateExactCommitCiCheck(staleCheck, currentCommitSha);

      assert.strictEqual(result.isExactScannedCommit, false);
      assert.strictEqual(result.honestStateLabel, 'stale_commit_mismatch');
      assert.ok(
        result.stateExplanation.includes('Stale CI result'),
        'Must explain that check run belongs to an older/different commit'
      );
      assert.ok(
        result.stateExplanation.includes('cannot be treated as current evidence'),
        'Must forbid treating stale green checks as current evidence'
      );
    });

    it('accepts passing CI check on the exact scanned commit SHA', () => {
      const exactPassingCheck: GitHubCheckRun = {
        id: 1001,
        name: 'Run Unit and Integration Tests',
        status: 'completed',
        conclusion: 'success',
        commitSha: currentCommitSha,
        completedAt: '2026-10-19T10:00:00Z',
        isRelevantTestCheck: true,
        relevanceReason: 'Unit test suite',
      };

      const result = evaluateExactCommitCiCheck(exactPassingCheck, currentCommitSha);

      assert.strictEqual(result.isExactScannedCommit, true);
      assert.strictEqual(result.honestStateLabel, 'passed');
      assert.strictEqual(result.conclusion, 'success');
    });

    it('reports missing CI check when no workflow runs exist for commit', () => {
      const result = evaluateExactCommitCiCheck(undefined, currentCommitSha);

      assert.strictEqual(result.honestStateLabel, 'missing');
      assert.strictEqual(result.status, 'missing');
      assert.ok(result.stateExplanation.includes('No CI workflows or check runs found'));
    });

    it('reports pending CI check when job is in progress or queued', () => {
      const pendingCheck: GitHubCheckRun = {
        id: 1002,
        name: 'Run Unit and Integration Tests',
        status: 'in_progress',
        conclusion: null,
        commitSha: currentCommitSha,
        isRelevantTestCheck: true,
        relevanceReason: 'Unit test suite',
      };

      const result = evaluateExactCommitCiCheck(pendingCheck, currentCommitSha);

      assert.strictEqual(result.honestStateLabel, 'pending');
      assert.strictEqual(result.status, 'in_progress');
      assert.ok(result.stateExplanation.includes('currently in_progress'));
    });

    it('reports inaccessible CI checks when permissions or rate limits prevent querying', () => {
      const result = evaluateExactCommitCiCheck(
        undefined,
        currentCommitSha,
        'GitHub API permission denied or rate limit exceeded (HTTP 403)'
      );

      assert.strictEqual(result.honestStateLabel, 'inaccessible');
      assert.strictEqual(result.status, 'inaccessible');
      assert.ok(result.stateExplanation.includes('inaccessible: GitHub API permission denied'));
    });

    it('reports lacks_logs when check failed but detailed logs are absent', () => {
      const failedWithoutLogs: GitHubCheckRun = {
        id: 1003,
        name: 'Run Unit and Integration Tests',
        status: 'completed',
        conclusion: 'failure',
        commitSha: currentCommitSha,
        isRelevantTestCheck: true,
        relevanceReason: 'Unit test suite',
        failureDetails: '', // Empty logs
      };

      const result = evaluateExactCommitCiCheck(failedWithoutLogs, currentCommitSha);

      assert.strictEqual(result.honestStateLabel, 'lacks_logs');
      assert.ok(result.stateExplanation.includes('detailed failure logs were not provided'));
    });
  });

  describe('3. Separation of the 4 Distinct Claims (Requirement 5)', () => {
    it('strictly separates test_file_detected, test_references_code, test_executed, and test_passed', () => {
      // Scenario A: Test file detected, but NO check executed yet
      const scanWithoutCI: GitHubScanResult = {
        owner: 'sakshamgupta005',
        repo: 'patchboard-tasks-api',
        commitSha: currentCommitSha,
        success: true,
        totalFilesDiscovered: 18,
        inspectedFiles: sampleInspectedFiles,
        skippedFiles: [],
        warnings: [],
        checkRuns: [], // No checks
        detectedTechnologies: ['node'],
        status: 'completed',
        durationMs: 120,
      };

      const summaryA = buildEvidenceChain({
        room: sampleRoom,
        scanResult: scanWithoutCI,
      });

      assert.ok(summaryA.claimsSeparation.filesDetectedCount > 0, 'Test files were detected');
      assert.ok(summaryA.claimsSeparation.referencingTestsCount > 0, 'Tests reference code');
      assert.strictEqual(
        summaryA.claimsSeparation.executedTestsCount,
        0,
        'Tests were NOT executed in CI'
      );
      assert.strictEqual(
        summaryA.claimsSeparation.passedCheckCount,
        0,
        'Tests have NOT passed in CI'
      );

      // Scenario B: Test file detected, executed in CI, but FAILING
      const failingCheck: GitHubCheckRun = {
        id: 117772098048,
        name: 'Run Unit and Integration Tests',
        status: 'completed',
        conclusion: 'failure',
        commitSha: currentCommitSha,
        isRelevantTestCheck: true,
        relevanceReason: 'Unit test suite',
        failureDetails: `
✖ rejects whitespace-only task titles (2.1ms)
  AssertionError [ERR_ASSERTION]: Expected whitespace-only title to be rejected with TaskValidationError
      at TestContext.<anonymous> (test/createTask.test.js:47:12)
      at createTask (src/tasks/createTask.js:16:22)
      at validateTaskTitle (src/tasks/validation.js:15:7)
        `,
      };

      const scanWithFailingCI: GitHubScanResult = {
        ...scanWithoutCI,
        checkRuns: [failingCheck],
      };

      const summaryB = buildEvidenceChain({
        room: sampleRoom,
        scanResult: scanWithFailingCI,
      });

      assert.ok(summaryB.claimsSeparation.filesDetectedCount > 0, '1. Test file detected: TRUE');
      assert.ok(summaryB.claimsSeparation.referencingTestsCount > 0, '2. Test references code: TRUE');
      assert.ok(summaryB.claimsSeparation.executedTestsCount > 0, '3. Test executed: TRUE');
      assert.strictEqual(summaryB.claimsSeparation.passedCheckCount, 0, '4. Test passed: FALSE (failed)');
    });
  });

  describe('4. Failure Connection to Related Files & Source Locations (Requirement 6)', () => {
    it('parses real failure output and connects failed test case to relevant source file, line, and symbol', () => {
      const rawLog = `
✖ rejects whitespace-only task titles (2.4ms)
  AssertionError [ERR_ASSERTION]: Expected whitespace-only title to be rejected with TaskValidationError
      at TestContext.<anonymous> (test/createTask.test.js:47:12)
      at createTask (src/tasks/createTask.js:16:22)
      at validateTaskTitle (src/tasks/validation.js:15:7)
      `;

      const parsed = parseFailureOutput(rawLog, 'Run Unit and Integration Tests');

      assert.strictEqual(parsed.hasDetailedLogs, true);
      assert.strictEqual(parsed.failingTestCase, 'rejects whitespace-only task titles');
      assert.strictEqual(parsed.targetFile, 'test/createTask.test.js');
      assert.strictEqual(parsed.targetLine, 47);
      assert.strictEqual(parsed.targetSymbol, 'validateTaskTitle');
      assert.ok(parsed.explanation?.includes('AssertionError'));
    });

    it('attaches complete failure connection to the linked evidence chain', () => {
      const failingCheck: GitHubCheckRun = {
        id: 117772098048,
        name: 'Run Unit and Integration Tests',
        status: 'completed',
        conclusion: 'failure',
        commitSha: currentCommitSha,
        isRelevantTestCheck: true,
        relevanceReason: 'Unit test suite',
        failureDetails: `
✖ rejects whitespace-only task titles (2.1ms)
  AssertionError [ERR_ASSERTION]: Expected whitespace-only title to be rejected with TaskValidationError
      at TestContext.<anonymous> (test/createTask.test.js:47:12)
      at createTask (src/tasks/createTask.js:16:22)
      at validateTaskTitle (src/tasks/validation.js:15:7)
        `,
      };

      const scanResult: GitHubScanResult = {
        owner: 'sakshamgupta005',
        repo: 'patchboard-tasks-api',
        commitSha: currentCommitSha,
        success: true,
        totalFilesDiscovered: 18,
        inspectedFiles: sampleInspectedFiles,
        skippedFiles: [],
        warnings: [],
        checkRuns: [failingCheck],
        detectedTechnologies: ['node'],
        status: 'completed',
        durationMs: 120,
      };

      const summary = buildEvidenceChain({
        room: sampleRoom,
        scanResult,
      });

      assert.strictEqual(summary.failingChainsCount, 1);
      const chain = summary.chains[0];
      assert.strictEqual(chain.chainStatus, 'complete_failing');
      assert.ok(chain.failureConnection, 'Must populate failureConnection');
      assert.strictEqual(chain.failureConnection?.failedTestName, 'rejects whitespace-only task titles');
      assert.strictEqual(chain.failureConnection?.relevantSourceSymbol, 'validateTaskTitle');
      assert.ok(
        chain.failureConnection?.explanation.includes('AssertionError'),
        'Must explain failure using actual output'
      );
    });
  });

  describe('5. Evidence History and Supersession (Requirement 7)', () => {
    it('preserves existing evidence history and distinguishes superseded from active evidence', () => {
      const priorFailureEvidence: EvidenceRecord = {
        id: 'ev-prior-fail-1',
        sourceType: 'test_result',
        description: 'CI check failed on earlier commit',
        timestamp: '2026-10-18T10:00:00Z',
        isBlocker: true,
        isSuperseded: true,
        supersededBy: 'ev-new-pass-2',
        supersededAt: '2026-10-19T10:00:00Z',
        verificationResult: {
          status: 'failed',
          testName: 'Run Unit and Integration Tests',
          details: 'Failed on baseline',
          timestamp: '2026-10-18T10:00:00Z',
        },
      };

      const aiDescriptionEvidence: EvidenceRecord = {
        id: 'ev-ai-claim-1',
        sourceType: 'ai_inference',
        description: 'AI model claimed the feature works',
        timestamp: '2026-10-19T09:00:00Z',
      };

      const roomWithHistory: ArchitecturalRoom = {
        ...sampleRoom,
        evidenceHistory: [priorFailureEvidence, aiDescriptionEvidence],
      };

      assert.strictEqual(roomWithHistory.evidenceHistory?.length, 2);
      assert.strictEqual(roomWithHistory.evidenceHistory![0].isSuperseded, true);
      assert.strictEqual(roomWithHistory.evidenceHistory![1].sourceType, 'ai_inference');
      // AI inference is never allowed to claim verification
      assert.notStrictEqual(roomWithHistory.evidenceHistory![1].sourceType, 'test_result');
    });
  });

  describe('6. Full Linked Chain Assembly (Requirement 2)', () => {
    it('presents a verified chain where requirement → implementation → relevant test → exact CI check all pass', () => {
      const passingCheck: GitHubCheckRun = {
        id: 2001,
        name: 'Run Unit and Integration Tests',
        status: 'completed',
        conclusion: 'success',
        commitSha: currentCommitSha,
        isRelevantTestCheck: true,
        relevanceReason: 'Unit test suite',
      };

      const scanResult: GitHubScanResult = {
        owner: 'sakshamgupta005',
        repo: 'patchboard-tasks-api',
        commitSha: currentCommitSha,
        success: true,
        totalFilesDiscovered: 18,
        inspectedFiles: sampleInspectedFiles,
        skippedFiles: [],
        warnings: [],
        checkRuns: [passingCheck],
        detectedTechnologies: ['node'],
        status: 'completed',
        durationMs: 100,
      };

      const summary = buildEvidenceChain({
        room: sampleRoom,
        scanResult,
      });

      assert.strictEqual(summary.verifiedChainsCount, 1);
      const chain = summary.chains[0];
      assert.strictEqual(chain.chainStatus, 'complete_verified');
      assert.strictEqual(chain.claims.testFileDetected, true);
      assert.strictEqual(chain.claims.testReferencesCode, true);
      assert.strictEqual(chain.claims.testExecuted, true);
      assert.strictEqual(chain.claims.testPassed, true);
      assert.ok(chain.explanation.includes('Chain verified'));
    });
  });
});
