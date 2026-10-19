import * as fs from 'fs';
import * as path from 'path';
import { categorizeFile, isFileIgnored, scoreFileForInspection } from '../../src/domain/github/fileFilter.ts';
import { mapScanResultToHouse } from '../../src/domain/github/architectureMapper.ts';
import { deriveProjectStatus } from '../../src/domain/statusEngine.ts';
import { buildCanvasFromModules } from '../../src/domain/graph/layoutEngine.ts';
import type { CanvasGraph } from '../../src/domain/graph/types.ts';
import type { ProjectStatusEvaluation, InfrastructurePillar, DependencyConnection } from '../../src/domain/types.ts';
import type { ArchitecturalRoom } from '../../src/types.ts';
import type { GitHubScanResult, InspectedFile, FileCategory } from '../../src/domain/github/types.ts';

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
}

export interface ScanOptions {
  maxFilesToInspect?: number;
  maxFileSizeBytes?: number;
  totalScanBudgetBytes?: number;
}

const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_FILE_SIZE = 80 * 1024; // 80 KB
const DEFAULT_TOTAL_BUDGET = 200 * 1024; // 200 KB

/**
 * Recursively discovers all relevant project files in the workspace,
 * pruning ignored directories (.git, node_modules, build artifacts, etc.).
 */
export async function discoverWorkspaceFiles(rootDir: string): Promise<string[]> {
  const discovered: string[] = [];

  async function walk(currentDir: string) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        const check = isFileIgnored(relPath + '/');
        if (!check.ignored) {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        const check = isFileIgnored(relPath);
        if (!check.ignored) {
          discovered.push(relPath);
        }
      }
    }
  }

  await walk(rootDir);
  return discovered;
}

/**
 * Scans a local workspace with bounded inspection, scores architectural files,
 * maps them to Living Blueprint rooms and pillars, and computes deterministic statuses.
 */
export async function scanWorkspace(
  workspaceRoot: string,
  options: ScanOptions = {}
): Promise<WorkspaceBlueprintData> {
  const maxFiles = options.maxFilesToInspect ?? DEFAULT_MAX_FILES;
  const maxFileSize = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
  const maxTotalBudget = options.totalScanBudgetBytes ?? DEFAULT_TOTAL_BUDGET;

  const workspaceName = path.basename(workspaceRoot) || 'Workspace';
  const scannedAt = new Date().toISOString();

  // 1. Discover all candidate files
  const discoveredFiles = await discoverWorkspaceFiles(workspaceRoot);

  // 2. Score files for architectural importance
  const scoredFiles = discoveredFiles.map((relPath) => ({
    path: relPath,
    category: categorizeFile(relPath),
    score: scoreFileForInspection(relPath),
  }));

  // Sort descending by architectural importance
  scoredFiles.sort((a, b) => b.score - a.score);

  // 3. Perform bounded inspection
  const inspectedFiles: InspectedFile[] = [];
  const inspectedMeta: InspectedFileMeta[] = [];
  let totalBytesRead = 0;

  for (const item of scoredFiles) {
    if (inspectedFiles.length >= maxFiles || totalBytesRead >= maxTotalBudget) {
      break;
    }

    const fullPath = path.join(workspaceRoot, item.path);
    try {
      const stat = await fs.promises.stat(fullPath);
      if (stat.size > maxFileSize) {
        continue;
      }

      const content = await fs.promises.readFile(fullPath, 'utf8');
      const bytes = Buffer.byteLength(content, 'utf8');
      totalBytesRead += bytes;

      inspectedFiles.push({
        path: item.path,
        category: item.category,
        sizeBytes: bytes,
        contentExcerpt: content.slice(0, 1000),
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
      // If unreadable, skip bounded inspection for this file
    }
  }

  // 4. Construct scan result for architecture mapping
  // Note: Local workspace scan does NOT assume tests passed without actual test execution records.
  const scanResult: GitHubScanResult = {
    success: true,
    status: 'completed',
    owner: 'local',
    repo: workspaceName,
    discoveredFilePaths: discoveredFiles,
    inspectedFiles,
    skippedFiles: [],
    treeTruncated: false,
    totalFilesDiscovered: discoveredFiles.length,
    detectedTechnologies: [],
    detectedManifests: [],
    detectedArchitecturalLayers: [],
    warnings: [],
    durationMs: 0,
    checkRuns: [], // Honest verification: local scan has no unverified assumed passes
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

  return {
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
  };
}
