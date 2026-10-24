/**
 * Domain types for T30: Connect Source Code, Tests, and Real CI Evidence.
 * Provides a navigable relationship view between implementation, tests, and actual CI checks.
 */

export type TestMappingType = 'syntax' | 'heuristic';

export interface MappedTestAssertion {
  expression: string;
  line: number;
  kind?: 'assert_throws' | 'assert_equal' | 'expect' | 'generic';
}

export interface MappedTest {
  id: string;
  testFilePath: string;
  testCaseName?: string;
  lineRange?: { startLine: number; endLine: number };
  mappingType: TestMappingType; // 'syntax' or 'heuristic'
  targetSymbol?: {
    name: string;
    filePath: string;
    line?: number;
  };
  evidence: string; // Explicit explanation of how the mapping was established
  assertions: MappedTestAssertion[];
  claims: {
    testFileDetected: boolean;
    testReferencesCode: boolean;
    testExecuted: boolean;
    testPassed: boolean;
  };
}

export type CiCheckState =
  | 'passed'
  | 'failed'
  | 'pending'
  | 'missing'
  | 'inaccessible'
  | 'lacks_logs'
  | 'stale_commit_mismatch';

export interface FailureDetailConnection {
  rawOutput?: string;
  summary?: string;
  hasDetailedLogs: boolean;
  failureReason?: string;
  failingTestCase?: string;
  targetFile?: string;
  targetLine?: number;
  targetSymbol?: string;
  explanation?: string;
}

export interface ExactCommitCiCheckInfo {
  checkName: string;
  status: 'queued' | 'in_progress' | 'completed' | 'missing' | 'inaccessible';
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'timed_out'
    | 'action_required'
    | 'skipped'
    | null;
  commitSha: string;
  isExactScannedCommit: boolean;
  htmlUrl?: string;
  completedAt?: string;
  stateExplanation: string;
  honestStateLabel: CiCheckState;
  failureDetails?: FailureDetailConnection;
}

export type ChainVerificationStatus =
  | 'complete_verified'
  | 'complete_failing'
  | 'pending_ci'
  | 'unverified_implementation'
  | 'missing_test'
  | 'stale_evidence'
  | 'ci_inaccessible';

export interface LinkedEvidenceChain {
  id: string;
  requirement: {
    id: string;
    title: string;
    description?: string;
  };
  implementation: {
    filePath: string;
    symbolName?: string;
    symbolKind?: string;
    lineRange?: { startLine: number; endLine: number };
    excerpt?: string;
  };
  test: MappedTest | null;
  ciCheck: ExactCommitCiCheckInfo | null;
  chainStatus: ChainVerificationStatus;
  explanation: string;
  claims: {
    testFileDetected: boolean;
    testReferencesCode: boolean;
    testExecuted: boolean;
    testPassed: boolean;
  };
  failureConnection?: {
    failedTestName?: string;
    failingFile: string;
    relevantSourceFile?: string;
    relevantSourceLine?: number;
    relevantSourceSymbol?: string;
    explanation: string;
    failureOutputExcerpt?: string;
  };
}

export interface EvidenceChainSummary {
  repositorySha: string;
  isExactCommit: boolean;
  totalChains: number;
  verifiedChainsCount: number;
  failingChainsCount: number;
  unverifiedCount: number;
  missingTestsCount: number;
  staleShaWarnings: string[];
  ciState: CiCheckState;
  claimsSeparation: {
    filesDetectedCount: number;
    referencingTestsCount: number;
    executedTestsCount: number;
    passedCheckCount: number;
  };
  chains: LinkedEvidenceChain[];
}
