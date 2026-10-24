import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'node:crypto';
import { categorizeFile, scoreFileForInspection } from '../../src/domain/github/fileFilter.ts';
import { mapScanResultToHouse } from '../../src/domain/github/architectureMapper.ts';
import { deriveProjectStatus } from '../../src/domain/statusEngine.ts';
import { buildCanvasFromModules } from '../../src/domain/graph/layoutEngine.ts';
import type { CanvasGraph } from '../../src/domain/graph/types.ts';
import type { ProjectStatusEvaluation, InfrastructurePillar, DependencyConnection } from '../../src/domain/types.ts';
import type { ArchitecturalRoom } from '../../src/types.ts';
import type { GitHubScanResult, InspectedFile, FileCategory } from '../../src/domain/github/types.ts';
import {
  shouldIgnorePath,
  parseGitIgnore,
  redactSourceContent,
  isSensitivePath,
  type ExtensionSkippedFile,
  type GitIgnoreMatcher,
} from './scanFilters.ts';

export type { ExtensionSkippedFile } from './scanFilters.ts';

export interface InspectedFileMeta {
  path: string;
  category: FileCategory;
  sizeBytes: number;
  score: number;
}

export interface WorkspaceBlueprintData {
  workspaceName: string;
  workspacePath: string;
  scannedAt: string;
  discoveredFilesCount: number;
  inspectedFilesCount: number;
  totalScanBytes: number;
  statusSummary: Record<string, number>;
  projectEvaluation: ProjectStatusEvaluation;
  rooms: ArchitecturalRoom[];
  pillars: InfrastructurePillar[];
  dependencies: DependencyConnection[];
  graph: CanvasGraph;
  discoveredFilePaths: string[];
  inspectedFiles: InspectedFileMeta[];
  skippedFiles: ExtensionSkippedFile[];
  truncated: boolean;
  truncationReason?: 'max_files_exceeded' | 'max_depth_exceeded' | 'time_budget_exceeded';
  includesUnsavedChanges?: boolean;
}

export interface TruncationInfo {
  truncated: boolean;
  reason?: 'max_files_exceeded' | 'max_depth_exceeded' | 'time_budget_exceeded';
  detail?: string;
}

export interface DiscoveryResult {
  discoveredFilePaths: string[];
  skippedFiles: ExtensionSkippedFile[];
  truncation: TruncationInfo;
}

export interface FileReader {
  readFile(filePath: string): Promise<string>;
  stat(filePath: string): Promise<{ size: number }>;
  readdir(dirPath: string): Promise<fs.Dirent[]>;
}

export interface DiscoveryOptions {
  maxDiscoveredFiles?: number;
  maxDepth?: number;
  discoveryTimeBudgetMs?: number;
  signal?: AbortSignal;
  fileReader?: FileReader;
}

export interface ScanOptions extends DiscoveryOptions {
  maxFilesToInspect?: number;
  maxFileSizeBytes?: number;
  totalScanBudgetBytes?: number;
  maxExcerptChars?: number;
  dirtyBuffers?: Map<string, string>;
}

const DEFAULT_MAX_FILES_TO_INSPECT = 40;
const DEFAULT_MAX_FILE_SIZE = 80 * 1024; // 80 KB
const DEFAULT_TOTAL_BUDGET = 200 * 1024; // 200 KB
const DEFAULT_MAX_EXCERPT_CHARS = 3000; // 3,000 characters per file in host memory

const DEFAULT_MAX_DISCOVERED_FILES = 5000;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_DISCOVERY_TIME_BUDGET_MS = 3000;

export const defaultFileReader: FileReader = {
  readFile: (filePath: string) => fs.promises.readFile(filePath, 'utf8'),
  stat: (filePath: string) => fs.promises.stat(filePath),
  readdir: (dirPath: string) => fs.promises.readdir(dirPath, { withFileTypes: true }),
};

/**
 * Recursively discovers relevant project files in the workspace with safety bounds,
 * sensitive file exclusion, .gitignore respect, and AbortSignal cancellation.
 */
export async function discoverWorkspaceFilesDetailed(
  rootDir: string,
  options: DiscoveryOptions = {}
): Promise<DiscoveryResult> {
  const maxDiscovered = options.maxDiscoveredFiles ?? DEFAULT_MAX_DISCOVERED_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const timeBudgetMs = options.discoveryTimeBudgetMs ?? DEFAULT_DISCOVERY_TIME_BUDGET_MS;
  const signal = options.signal;
  const reader = options.fileReader ?? defaultFileReader;

  const discovered: string[] = [];
  const skippedFiles: ExtensionSkippedFile[] = [];
  const truncation: TruncationInfo = { truncated: false };

  // Read top-level .gitignore if present
  let gitIgnoreMatcher: GitIgnoreMatcher | undefined;
  try {
    const gitIgnorePath = path.join(rootDir, '.gitignore');
    const content = await reader.readFile(gitIgnorePath);
    gitIgnoreMatcher = parseGitIgnore(content);
  } catch {
    // If no .gitignore exists or unreadable, continue without it
  }

  const startTime = Date.now();

  async function walk(currentDir: string, currentDepth: number) {
    if (signal?.aborted) {
      const err = new Error('Scan aborted');
      err.name = 'AbortError';
      throw err;
    }

    if (truncation.truncated) {
      return;
    }

    if (Date.now() - startTime >= timeBudgetMs) {
      truncation.truncated = true;
      truncation.reason = 'time_budget_exceeded';
      truncation.detail = `Discovery time budget of ${timeBudgetMs}ms reached`;
      return;
    }

    if (currentDepth > maxDepth) {
      const relPath = path.relative(rootDir, currentDir).replace(/\\/g, '/');
      skippedFiles.push({
        path: relPath,
        reason: 'discovery_depth_exceeded',
        detail: `Maximum directory depth of ${maxDepth} exceeded`,
      });
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = await reader.readdir(currentDir);
    } catch {
      return;
    }

    // Deterministic traversal: alphabetical sort by name
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (signal?.aborted) {
        const err = new Error('Scan aborted');
        err.name = 'AbortError';
        throw err;
      }

      if (truncation.truncated) {
        break;
      }

      if (Date.now() - startTime >= timeBudgetMs) {
        truncation.truncated = true;
        truncation.reason = 'time_budget_exceeded';
        truncation.detail = `Discovery time budget of ${timeBudgetMs}ms reached`;
        break;
      }

      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        const decision = shouldIgnorePath(relPath, true, gitIgnoreMatcher);
        if (decision.ignored) {
          skippedFiles.push({
            path: relPath,
            reason: decision.reason || 'ignored_directory',
            detail: decision.detail,
          });
        } else {
          await walk(fullPath, currentDepth + 1);
        }
      } else if (entry.isFile()) {
        const decision = shouldIgnorePath(relPath, false, gitIgnoreMatcher);
        if (decision.ignored) {
          skippedFiles.push({
            path: relPath,
            reason: decision.reason || 'sensitive_file',
            detail: decision.detail,
          });
        } else {
          if (discovered.length >= maxDiscovered) {
            truncation.truncated = true;
            truncation.reason = 'max_files_exceeded';
            truncation.detail = `Maximum discovered file limit of ${maxDiscovered} reached`;
            break;
          }
          discovered.push(relPath);
        }
      }
    }
  }

  await walk(rootDir, 0);

  // Guarantee deterministic path ordering
  discovered.sort((a, b) => a.localeCompare(b));
  skippedFiles.sort((a, b) => a.path.localeCompare(b.path));

  return {
    discoveredFilePaths: discovered,
    skippedFiles,
    truncation,
  };
}

/**
 * Returns discovered file paths as a list, for backwards compatibility.
 */
export async function discoverWorkspaceFiles(
  rootDir: string,
  options: DiscoveryOptions = {}
): Promise<string[]> {
  const result = await discoverWorkspaceFilesDetailed(rootDir, options);
  const arr = [...result.discoveredFilePaths];
  (arr as any).skippedFiles = result.skippedFiles;
  (arr as any).truncation = result.truncation;
  return arr;
}

/**
 * Helper to retrieve host-only file excerpts from scan data.
 */
export function getHostFileExcerpt(
  data: WorkspaceBlueprintData,
  filePath: string
): string | undefined {
  const excerpts = (data as any).hostExcerpts as Map<string, string> | undefined;
  return excerpts?.get(filePath);
}

/**
 * Helper to retrieve all host-only file excerpts from scan data.
 */
export function getHostExcerpts(
  data: WorkspaceBlueprintData
): Map<string, string> {
  return ((data as any).hostExcerpts as Map<string, string>) || new Map();
}

/**
 * Scans a local workspace with bounded inspection, cancellation, dirty buffers,
 * maps architectural files to Living Blueprint rooms and pillars, and computes deterministic statuses.
 */
export async function scanWorkspace(
  workspaceRoot: string,
  options: ScanOptions = {}
): Promise<WorkspaceBlueprintData> {
  const maxFiles = options.maxFilesToInspect ?? DEFAULT_MAX_FILES_TO_INSPECT;
  const maxFileSize = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
  const maxTotalBudget = options.totalScanBudgetBytes ?? DEFAULT_TOTAL_BUDGET;
  const maxExcerptChars = options.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS;
  const signal = options.signal;
  const reader = options.fileReader ?? defaultFileReader;

  if (signal?.aborted) {
    const err = new Error('Scan aborted');
    err.name = 'AbortError';
    throw err;
  }

  const workspaceName = path.basename(workspaceRoot) || 'Workspace';
  const scannedAt = new Date().toISOString();

  // 1. Discover all candidate files with security and budget bounds
  const discoveryResult = await discoverWorkspaceFilesDetailed(workspaceRoot, options);
  const discoveredFiles = discoveryResult.discoveredFilePaths;
  const skippedFiles: ExtensionSkippedFile[] = [...discoveryResult.skippedFiles];

  // If workspace is empty or has zero usable files, produce an explicit empty snapshot with zero rooms
  const isOnlyPlaceholder =
    discoveredFiles.length > 0 &&
    discoveredFiles.every((f) => {
      const base = path.basename(f).toLowerCase();
      return base === '.gitkeep' || base === '.keep';
    });

  if (discoveredFiles.length === 0 || isOnlyPlaceholder) {
    const emptyEvaluation = deriveProjectStatus({
      id: workspaceName,
      name: workspaceName,
      rooms: [],
      pillars: [],
      dependencies: [],
    });

    const emptyGraph = buildCanvasFromModules([], `${workspaceName} Architecture Graph`);

    const emptyData: WorkspaceBlueprintData = {
      workspaceName,
      workspacePath: workspaceRoot,
      scannedAt,
      discoveredFilesCount: discoveredFiles.length,
      inspectedFilesCount: 0,
      totalScanBytes: 0,
      statusSummary: emptyEvaluation.summary,
      projectEvaluation: emptyEvaluation,
      rooms: [],
      pillars: [],
      dependencies: [],
      graph: emptyGraph,
      discoveredFilePaths: discoveredFiles,
      inspectedFiles: [],
      skippedFiles,
      truncated: discoveryResult.truncation.truncated,
      truncationReason: discoveryResult.truncation.reason,
      includesUnsavedChanges: false,
    };

    Object.defineProperty(emptyData, 'hostExcerpts', {
      value: new Map<string, string>(),
      enumerable: false,
      writable: true,
    });

    Object.defineProperty(emptyData, 'hostContentHashes', {
      value: new Map<string, string>(),
      enumerable: false,
      writable: true,
    });

    return emptyData;
  }

  // 2. Score files for architectural importance
  const scoredFiles = discoveredFiles.map((relPath) => ({
    path: relPath,
    category: categorizeFile(relPath),
    score: scoreFileForInspection(relPath),
  }));

  // Deterministic sort: score descending, path ascending
  scoredFiles.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  // 3. Perform bounded inspection and host-only excerpt retention
  const inspectedFiles: InspectedFile[] = [];
  const inspectedMeta: InspectedFileMeta[] = [];
  const hostExcerpts = new Map<string, string>();
  const hostContentHashes = new Map<string, string>();
  let totalBytesRead = 0;
  let hasUnsavedChanges = false;

  for (const item of scoredFiles) {
    if (signal?.aborted) {
      const err = new Error('Scan aborted');
      err.name = 'AbortError';
      throw err;
    }

    if (inspectedFiles.length >= maxFiles || totalBytesRead >= maxTotalBudget) {
      break;
    }

    // Safety: ensure exclusion check passes before file reading
    if (isSensitivePath(item.path).sensitive) {
      skippedFiles.push({
        path: item.path,
        reason: 'sensitive_file',
        detail: 'Pre-read safety exclusion',
      });
      continue;
    }

    const fullPath = path.join(workspaceRoot, item.path);
    try {
      let rawContent: string;
      let bytes: number;

      // Overlay open dirty text document buffer if available
      if (options.dirtyBuffers && options.dirtyBuffers.has(item.path)) {
        rawContent = options.dirtyBuffers.get(item.path)!;
        bytes = Buffer.byteLength(rawContent, 'utf8');
        hasUnsavedChanges = true;

        if (bytes > maxFileSize) {
          skippedFiles.push({
            path: item.path,
            reason: 'exceeds_file_size_limit',
            detail: `Dirty buffer size ${bytes}B exceeds limit of ${maxFileSize}B`,
          });
          continue;
        }
      } else {
        const stat = await reader.stat(fullPath);
        if (stat.size > maxFileSize) {
          skippedFiles.push({
            path: item.path,
            reason: 'exceeds_file_size_limit',
            detail: `File size ${stat.size}B exceeds limit of ${maxFileSize}B`,
          });
          continue;
        }

        rawContent = await reader.readFile(fullPath);
        bytes = Buffer.byteLength(rawContent, 'utf8');
      }

      totalBytesRead += bytes;

      // Compute in-memory SHA-256 hash of full raw content (never stored or emitted unredacted)
      const contentHash = crypto.createHash('sha256').update(rawContent, 'utf8').digest('hex');
      hostContentHashes.set(item.path, contentHash);

      // Apply source redaction before storing or inspecting
      const redactedContent = redactSourceContent(rawContent);

      // Bounded host excerpt (default 3,000 chars)
      const boundedHostExcerpt = redactedContent.slice(0, maxExcerptChars);
      hostExcerpts.set(item.path, boundedHostExcerpt);

      inspectedFiles.push({
        path: item.path,
        category: item.category,
        sizeBytes: bytes,
        contentExcerpt: boundedHostExcerpt.slice(0, 1000),
        rawUrl: `file://${fullPath}`,
        githubUrl: `file://${fullPath}`,
      });

      inspectedMeta.push({
        path: item.path,
        category: item.category,
        sizeBytes: bytes,
        score: item.score,
      });
    } catch {
      skippedFiles.push({
        path: item.path,
        reason: 'content_fetch_failed',
        detail: 'Failed to stat or read file content',
      });
    }
  }

  // 4. Construct scan result for architecture mapping
  const scanResult: GitHubScanResult = {
    success: true,
    status: 'completed',
    owner: 'local',
    repo: workspaceName,
    discoveredFilePaths: discoveredFiles,
    inspectedFiles,
    skippedFiles: [],
    treeTruncated: discoveryResult.truncation.truncated,
    totalFilesDiscovered: discoveredFiles.length,
    detectedTechnologies: [],
    detectedManifests: [],
    detectedArchitecturalLayers: [],
    warnings: [],
    durationMs: 0,
    checkRuns: [],
    metadata: {
      name: workspaceName,
      fullName: `local/${workspaceName}`,
      description: `Local workspace at ${workspaceRoot}`,
      defaultBranch: 'main',
      isPrivate: true,
      htmlUrl: `file://${workspaceRoot}`,
      stargazersCount: 0,
      forksCount: 0,
      openIssuesCount: 0,
      sizeKb: Math.round(totalBytesRead / 1024),
    },
  };

  // 5. Map to House architecture modules and pillars
  const mappedHouse = mapScanResultToHouse(scanResult);

  // 6. Deterministically evaluate project status
  const projectEvaluation = deriveProjectStatus(mappedHouse.project);

  // 7. Build interactive architecture canvas graph
  const graph = buildCanvasFromModules(mappedHouse.rooms, `${workspaceName} Architecture Graph`);

  const blueprintData: WorkspaceBlueprintData = {
    workspaceName,
    workspacePath: workspaceRoot,
    scannedAt,
    discoveredFilesCount: discoveredFiles.length,
    inspectedFilesCount: inspectedFiles.length,
    totalScanBytes: totalBytesRead,
    statusSummary: projectEvaluation.summary,
    projectEvaluation,
    rooms: mappedHouse.rooms,
    pillars: mappedHouse.pillars,
    dependencies: mappedHouse.project.dependencies || [],
    graph,
    discoveredFilePaths: discoveredFiles,
    inspectedFiles: inspectedMeta,
    skippedFiles,
    truncated: discoveryResult.truncation.truncated,
    truncationReason: discoveryResult.truncation.reason,
    includesUnsavedChanges: hasUnsavedChanges,
  };

  // Attach hostExcerpts as a non-enumerable property so JSON.stringify
  // never exposes excerpts to the webview when posted
  Object.defineProperty(blueprintData, 'hostExcerpts', {
    value: hostExcerpts,
    enumerable: false,
    writable: true,
  });
  // Host-only domain project (requirements + evidence history) so local test-run
  // evidence can be evaluated by the same status engine (P2-13).
  Object.defineProperty(blueprintData, 'hostProject', {
    value: mappedHouse.project,
    enumerable: false,
    writable: true,
  });

  Object.defineProperty(blueprintData, 'hostContentHashes', {
    value: hostContentHashes,
    enumerable: false,
    writable: true,
  });

  return blueprintData;
}
