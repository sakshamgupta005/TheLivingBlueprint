/**
 * Typed structures for GitHub REST API interactions and bounded repository scanning.
 */

import type { GitHubCheckRun } from '../lifecycle/types.ts';
import type { EvaluateCiOutcomeResult } from '../lifecycle/ciEvaluator.ts';
import type { CodeIndex } from '../codeIndex/types.ts';

export type ScanStage =
  | 'idle'
  | 'validating'
  | 'fetching_metadata'
  | 'fetching_tree'
  | 'fetching_checks'
  | 'inspecting_files'
  | 'mapping_architecture'
  | 'completed'
  | 'error';

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetDate: string;
  retryAfterSeconds?: number;
}

export interface GitHubRepoMetadata {
  name: string;
  fullName: string;
  description: string | null;
  defaultBranch: string;
  isPrivate: boolean;
  htmlUrl: string;
  stargazersCount: number;
  forksCount: number;
  openIssuesCount: number;
  sizeKb: number;
}

export interface GitTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
  url: string;
}

export type FileCategory =
  | 'manifest'
  | 'readme'
  | 'config'
  | 'test'
  | 'source'
  | 'documentation';

export interface InspectedFile {
  path: string;
  category: FileCategory;
  sizeBytes: number;
  contentExcerpt: string;
  rawUrl: string;
  githubUrl: string;
}

export interface SkippedFile {
  path: string;
  reason:
    | 'ignored_directory'
    | 'binary_asset'
    | 'lockfile'
    | 'exceeds_file_size_limit'
    | 'scan_file_budget_exceeded'
    | 'scan_byte_budget_exceeded'
    | 'content_fetch_failed'
    | 'unsupported_file_type';
}

export interface ParseFailure {
  path: string;
  error: string;
}

export interface EvidenceCoverage {
  discoveredCount: number;
  inspectedCount: number;
  skippedCount: number;
  coverageRatio: number;
}

export interface GitHubScanOptions {
  maxFilesToInspect?: number;
  maxFileSizeBytes?: number;
  totalScanBudgetBytes?: number;
  fetchFn?: typeof fetch;
  githubToken?: string;
  useCache?: boolean;
  timeoutMs?: number;
}

export interface GitHubScanResult {
  success: boolean;
  status: 'completed' | 'partial' | 'failed';
  owner: string;
  repo: string;
  metadata?: GitHubRepoMetadata;
  commitSha?: string;
  scannedAt?: string;
  treeTruncated: boolean;
  subtreesFetched?: string[];
  totalFilesDiscovered: number;
  discoveredFilePaths?: string[];
  inspectedFiles: InspectedFile[];
  skippedFiles: SkippedFile[];
  parseFailures?: ParseFailure[];
  evidenceCoverage?: EvidenceCoverage;
  unsupportedFileTypes?: string[];
  coverageImprovementPossible?: boolean;
  coverageImprovementReason?: string;
  cached?: boolean;
  totalContentBytesInspected?: number;
  scanFileBudget?: number;
  scanByteBudget?: number;
  detectedTechnologies: string[];
  detectedManifests: string[];
  detectedArchitecturalLayers: string[];
  checkRuns?: GitHubCheckRun[];
  ciEvaluation?: EvaluateCiOutcomeResult;
  codeIndex?: CodeIndex;
  repositoryKnowledge?: import('../repositoryKnowledge/types.ts').RepositoryKnowledgeBase;
  rateLimit?: RateLimitInfo;
  warnings: string[];
  error?: string;
  durationMs: number;
}

