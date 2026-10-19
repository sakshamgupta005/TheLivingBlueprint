import type { GitHubCheckRun } from '../lifecycle/types.ts';
import type { GitTreeEntry, ParseFailure } from './types.ts';

export interface RepositoryCacheRecord {
  owner: string;
  repo: string;
  commitSha: string;
  metadata?: any;
  treeEntries: GitTreeEntry[];
  treeTruncated: boolean;
  subtreesFetched?: string[];
  checkRuns?: GitHubCheckRun[];
  fileContents: Map<string, string>;
  parseFailures?: ParseFailure[];
  unsupportedFileTypes?: string[];
  etag?: string;
  cachedAt: number;
}

const repoCache = new Map<string, RepositoryCacheRecord>();
let cacheHits = 0;
let cacheMisses = 0;

export function getRepoCacheKey(owner: string, repo: string, commitSha: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}@${commitSha}`;
}

export function getCachedRepository(
  owner: string,
  repo: string,
  commitSha: string
): RepositoryCacheRecord | undefined {
  const key = getRepoCacheKey(owner, repo, commitSha);
  const entry = repoCache.get(key);
  if (entry) {
    cacheHits++;
    return entry;
  }
  cacheMisses++;
  return undefined;
}

export function setCachedRepository(record: RepositoryCacheRecord): void {
  const key = getRepoCacheKey(record.owner, record.repo, record.commitSha);
  if (repoCache.size >= 50) {
    const oldestKey = repoCache.keys().next().value;
    if (oldestKey) repoCache.delete(oldestKey);
  }
  repoCache.set(key, record);
}

export function clearScannerCache(): void {
  repoCache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

export function getScannerCacheStats(): { entries: number; hits: number; misses: number } {
  return {
    entries: repoCache.size,
    hits: cacheHits,
    misses: cacheMisses,
  };
}

export function redactSecrets(text: string, token?: string): string {
  if (!text) return text;
  let sanitized = text;
  if (token && token.trim().length > 0) {
    sanitized = sanitized.split(token).join('[REDACTED_GITHUB_TOKEN]');
  }
  // Common GitHub token prefixes
  sanitized = sanitized.replace(/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}/g, '[REDACTED_GITHUB_TOKEN]');
  sanitized = sanitized.replace(/github_pat_[A-Za-z0-9_]{50,}/g, '[REDACTED_GITHUB_PAT]');
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9_.-]{10,}/gi, 'Bearer [REDACTED_AUTH]');
  return sanitized;
}
