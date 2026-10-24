/**
 * snapshot.ts — WorkspaceSnapshot domain model and cache management.
 *
 * Connects scanner data (WorkspaceBlueprintData) to a deterministic fingerprint,
 * detected manifests and technologies, and host-only redacted excerpts.
 * Host excerpts are strictly kept in non-enumerable storage so serialization
 * for webview communication never leaks source contents.
 */

import type { WorkspaceBlueprintData, InspectedFileMeta } from '../workspaceScanner.ts';
import { getHostExcerpts } from '../workspaceScanner.ts';
import { computeWorkspaceFingerprint } from './fingerprint.ts';
import { categorizeFile } from '../../../src/domain/github/fileFilter.ts';
import { invalidateContextCache } from '../../../src/server/contextBuilder.ts';
import { invalidateInvestigationCache } from '../../../src/server/investigationProvider.ts';

export interface WorkspaceSnapshot extends WorkspaceBlueprintData {
  readonly fingerprint: string;
  readonly detectedTechnologies: string[];
  readonly detectedManifests: string[];
}

/**
 * Derives detected manifests and technologies from discovered files and inspected manifests.
 *
 * Decision documentation:
 * `src/domain/github/scanner.ts` inlines its technology extraction inside `scanGitHubRepository`
 * without exposing a standalone export. We reuse `categorizeFile` from `src/domain/github/fileFilter.ts`
 * to identify manifests, and apply the exact same dependency inspection rules on package.json /
 * pyproject.toml / requirements.txt to detect technologies grounded strictly in evidence.
 */
export function detectTechnologiesAndManifests(
  discoveredPaths: string[],
  inspectedFiles: InspectedFileMeta[],
  hostExcerpts?: Map<string, string>
): { detectedTechnologies: string[]; detectedManifests: string[] } {
  const detectedManifests: string[] = [];
  const detectedTechnologies = new Set<string>();

  // 1. Identify manifests using shared domain filter
  for (const p of discoveredPaths) {
    if (categorizeFile(p) === 'manifest' && !detectedManifests.includes(p)) {
      detectedManifests.push(p);
    }
  }

  // 2. Identify primary language technologies from discovered file paths
  for (const p of discoveredPaths) {
    const lower = p.toLowerCase();
    if (lower.endsWith('.ts') || lower.endsWith('.tsx')) detectedTechnologies.add('TypeScript');
    if (lower.endsWith('.js') || lower.endsWith('.jsx')) detectedTechnologies.add('JavaScript');
    if (lower.endsWith('.py') || lower.endsWith('pyproject.toml') || lower.endsWith('requirements.txt')) {
      detectedTechnologies.add('Python');
    }
    if (lower.endsWith('.rs')) detectedTechnologies.add('Rust');
    if (lower.endsWith('.go')) detectedTechnologies.add('Go');
    if (lower.endsWith('.java')) detectedTechnologies.add('Java');
    if (lower.includes('dockerfile') || lower.includes('docker-compose')) detectedTechnologies.add('Docker');
    if (lower.includes('.github/workflows/')) detectedTechnologies.add('GitHub Actions');
  }

  // 3. Inspect manifest content for grounded framework and library dependencies
  for (const file of inspectedFiles) {
    const excerpt = hostExcerpts?.get(file.path);
    if (!excerpt) continue;

    if (file.path.endsWith('package.json')) {
      try {
        const pkg = JSON.parse(excerpt);
        const allDeps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
        if (allDeps.react) detectedTechnologies.add('React');
        if (allDeps.vite) detectedTechnologies.add('Vite');
        if (allDeps.next) detectedTechnologies.add('Next.js');
        if (allDeps.jest) detectedTechnologies.add('Jest');
        if (allDeps.vitest) detectedTechnologies.add('Vitest');
        if (allDeps.express) detectedTechnologies.add('Express');
        if (allDeps.tailwindcss) detectedTechnologies.add('Tailwind CSS');
        if (allDeps.pg || allDeps['@prisma/client'] || allDeps.typeorm || allDeps.sqlite3) {
          detectedTechnologies.add('PostgreSQL / SQL');
        }
      } catch {
        // Manifest JSON parsing failure: ignore malformed manifest content safely
      }
    } else if (file.path.endsWith('pyproject.toml') || file.path.endsWith('requirements.txt')) {
      const lower = excerpt.toLowerCase();
      detectedTechnologies.add('Python');
      if (lower.includes('fastapi')) detectedTechnologies.add('FastAPI');
      if (lower.includes('flask')) detectedTechnologies.add('Flask');
      if (lower.includes('django')) detectedTechnologies.add('Django');
      if (lower.includes('pytest')) detectedTechnologies.add('Pytest');
      if (lower.includes('sqlalchemy') || lower.includes('sqlite') || lower.includes('psycopg')) {
        detectedTechnologies.add('PostgreSQL / SQL');
      }
    }
  }

  return {
    detectedManifests,
    detectedTechnologies: Array.from(detectedTechnologies).sort(),
  };
}

/**
 * Creates a stable WorkspaceSnapshot connecting blueprint data to fingerprint
 * and host-only excerpts without exposing excerpts in enumerable fields.
 */
export function createWorkspaceSnapshot(
  data: WorkspaceBlueprintData,
  hostExcerptsOverride?: Map<string, string>,
  hostContentHashesOverride?: Map<string, string>
): WorkspaceSnapshot {
  const excerpts = hostExcerptsOverride ?? getHostExcerpts(data);
  const contentHashes = hostContentHashesOverride ?? (data as any).hostContentHashes;
  const fingerprint = computeWorkspaceFingerprint(
    data.inspectedFiles,
    excerpts,
    data.discoveredFilePaths,
    contentHashes
  );
  const { detectedTechnologies, detectedManifests } = detectTechnologiesAndManifests(
    data.discoveredFilePaths,
    data.inspectedFiles,
    excerpts
  );

  const snapshot: WorkspaceSnapshot = {
    ...data,
    fingerprint,
    detectedTechnologies,
    detectedManifests,
  };

  // Securely define hostExcerpts as a non-enumerable property
  Object.defineProperty(snapshot, 'hostExcerpts', {
    value: excerpts,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // Per-file SHA-256 of inspected content (P2-14 re-inspection); never serialized.
  Object.defineProperty(snapshot, 'hostContentHashes', {
    value: contentHashes,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // Carry the host-only domain project (P2-13 local evidence); never serialized.
  Object.defineProperty(snapshot, 'hostProject', {
    value: (data as unknown as { hostProject?: unknown }).hostProject,
    enumerable: false,
    writable: false,
    configurable: true,
  });

  return snapshot;
}

/**
 * Retrieves a host-only file excerpt from a snapshot.
 */
export function getSnapshotExcerpt(
  snapshot: WorkspaceSnapshot,
  filePath: string
): string | undefined {
  const excerpts = (snapshot as any).hostExcerpts as Map<string, string> | undefined;
  return excerpts?.get(filePath);
}

/** Host-only SHA-256 of each inspected file's full content, keyed by path. */
export function getSnapshotContentHashes(snapshot: WorkspaceSnapshot): Map<string, string> {
  return ((snapshot as any).hostContentHashes as Map<string, string>) ?? new Map();
}

/**
 * Retrieves all host-only excerpts from a snapshot.
 */
export function getSnapshotHostExcerpts(
  snapshot: WorkspaceSnapshot
): Map<string, string> {
  return ((snapshot as any).hostExcerpts as Map<string, string>) ?? new Map();
}

/**
 * Invalidates shared server context and investigation caches when a workspace fingerprint changes.
 * Isolate across multiple workspace roots using repo name and commitSha (fingerprint).
 */
export function invalidateWorkspaceCaches(
  repoName: string,
  previousFingerprint: string
): void {
  if (!previousFingerprint) return;

  invalidateContextCache({
    owner: 'local',
    repo: repoName,
    commitSha: previousFingerprint,
  });

  invalidateInvestigationCache({
    owner: 'local',
    repo: repoName,
    commitSha: previousFingerprint,
  });
}
