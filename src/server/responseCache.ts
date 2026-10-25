import { resilienceContextKey } from '../domain/resilience/index.ts';
import { isDiagramIntentRequested } from './contextBuilder.ts';
import type {
  ChatApiRequest,
  ExecutionTimingMetadata,
  ValidatedChatResponse,
} from './types.ts';
import type {
  InvestigateApiRequest,
  RoomInvestigationFinding,
} from '../domain/investigation/types.ts';

export const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const MAX_CACHE_ENTRIES = 50;

export interface ChatCacheEntry {
  response: ValidatedChatResponse;
  timing: ExecutionTimingMetadata;
  providerUsed?: 'gemini' | 'groq' | 'cloudflare' | 'omniroute';
  timestamp: number;
}

export interface InvestigationCacheEntry {
  finding: RoomInvestigationFinding;
  timing: ExecutionTimingMetadata;
  providerUsed?: 'gemini' | 'groq' | 'cloudflare' | 'omniroute';
  timestamp: number;
}

interface CacheStats {
  chatHits: number;
  chatMisses: number;
  investigationHits: number;
  investigationMisses: number;
  evictions: number;
}

// In-memory process cache (note: per-serverless-instance, not distributed)
const chatCache = new Map<string, ChatCacheEntry>();
const investigationCache = new Map<string, InvestigationCacheEntry>();

const stats: CacheStats = {
  chatHits: 0,
  chatMisses: 0,
  investigationHits: 0,
  investigationMisses: 0,
  evictions: 0,
};

/**
 * Normalizes request message text for stable cache key derivation.
 */
export function normalizeQueryText(text: string): string {
  return (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Derives a deterministic cache key for repeatable chat requests (e.g. suggestion chips, room explanations).
 * Returns null if the request should NOT be cached (multi-turn history, bypassCache, missing repo/commit).
 */
export function buildChatCacheKey(request: ChatApiRequest): string | null {
  if (request.bypassCache === true) {
    return null;
  }

  // Do not cache multi-turn conversation history blindly; only single repeatable queries/chips
  if (Array.isArray(request.history) && request.history.length > 0) {
    return null;
  }

  const repo = request.repoContext;
  if (!repo || !repo.owner || !repo.repo) {
    return null;
  }

  const normMsg = normalizeQueryText(request.message);
  if (!normMsg) {
    return null;
  }

  const commitSha = repo.commitSha || 'no-commit';
  const roomId = request.selectedRoomId || 'global';
  const level = request.explanationLevel || 'beginner';
  const diagIntent = isDiagramIntentRequested(request) ? 'diag' : 'nodiag';

  // Compact context fingerprint of inspected files and total file count
  const contextFingerprint = (repo.inspectedFiles || [])
    .map((f) => `${f.path}:${f.contentExcerpt?.length || 0}`)
    .sort()
    .join(';');

  return `chat##${repo.owner}/${repo.repo}@${commitSha}##room:${roomId}##level:${level}##diag:${diagIntent}##msg:${normMsg}##ctx:${contextFingerprint.length}:${repo.totalFiles}##res:${request.resilienceContext ? `${resilienceContextKey(request.resilienceContext)}` : 'none'}##v1`;
}

/**
 * Derives a deterministic cache key for room investigations.
 * Returns null if the request should NOT be cached (explicit bypassCache or missing repo/room).
 */
export function buildInvestigationCacheKey(request: InvestigateApiRequest): string | null {
  if (request.bypassCache === true) {
    return null;
  }

  if (!request.roomId) {
    return null;
  }

  const repo = request.repoContext;
  const owner = repo?.owner || 'workspace';
  const repoName = repo?.repo || 'project';
  const commitSha = repo?.commitSha || 'no-commit';
  const roomStatus = request.roomStatus || 'unknown';
  const sortedFiles = (request.roomFilePaths || []).slice().sort().join(',');

  return `investigate##${owner}/${repoName}@${commitSha}##room:${request.roomId}##status:${roomStatus}##files:${sortedFiles}##res:${request.resilienceContext ? `${resilienceContextKey(request.resilienceContext)}` : 'none'}##v1`;
}

function getFromCache<T extends { timestamp: number }>(
  cache: Map<string, T>,
  key: string,
  ttl: number,
  onHit?: () => void,
  onMiss?: () => void
): T | null {
  const entry = cache.get(key);
  if (!entry || Date.now() - entry.timestamp > ttl) {
    if (entry) cache.delete(key);
    onMiss?.();
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  onHit?.();
  return entry;
}

function setInCache<T>(cache: Map<string, T>, key: string, entry: T, maxEntries: number, onEvict?: () => void): void {
  if (cache.size >= maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest) {
      cache.delete(oldest);
      onEvict?.();
    }
  }
  cache.set(key, entry);
}

export function getCachedChatResponse(key: string): ChatCacheEntry | null {
  return getFromCache(chatCache, key, CACHE_TTL_MS, () => stats.chatHits++, () => stats.chatMisses++);
}

export function setCachedChatResponse(
  key: string,
  entry: Omit<ChatCacheEntry, 'timestamp'>
): void {
  if (!entry.response?.replies?.length) return;
  setInCache(chatCache, key, { ...entry, timestamp: Date.now() }, MAX_CACHE_ENTRIES, () => stats.evictions++);
}

export function getCachedInvestigation(key: string): InvestigationCacheEntry | null {
  return getFromCache(investigationCache, key, CACHE_TTL_MS, () => stats.investigationHits++, () => stats.investigationMisses++);
}

export function setCachedInvestigation(
  key: string,
  entry: Omit<InvestigationCacheEntry, 'timestamp'>
): void {
  if (!entry.finding || (entry.finding.rejectedReferences && entry.finding.rejectedReferences.length > 0)) return;
  setInCache(investigationCache, key, { ...entry, timestamp: Date.now() }, MAX_CACHE_ENTRIES, () => stats.evictions++);
}

export function clearResponseCache(): void {
  chatCache.clear();
  investigationCache.clear();
  stats.chatHits = 0;
  stats.chatMisses = 0;
  stats.investigationHits = 0;
  stats.investigationMisses = 0;
  stats.evictions = 0;
}

export function invalidateResponseCache(criteria?: {
  owner?: string;
  repo?: string;
  commitSha?: string;
  roomId?: string;
}): void {
  if (!criteria || (!criteria.owner && !criteria.repo && !criteria.commitSha && !criteria.roomId)) {
    clearResponseCache();
    return;
  }

  const { owner, repo, commitSha, roomId } = criteria;
  const targetRepo = owner && repo ? `${owner}/${repo}` : undefined;
  const matches = (k: string) =>
    (commitSha && k.includes(`@${commitSha}`)) ||
    (targetRepo && k.includes(targetRepo)) ||
    (roomId && k.includes(`room:${roomId}`));

  for (const map of [chatCache, investigationCache]) {
    for (const key of Array.from(map.keys())) {
      if (matches(key)) map.delete(key);
    }
  }
}

export function getResponseCacheStats() {
  return {
    ...stats,
    chatSize: chatCache.size,
    investigationSize: investigationCache.size,
    roomExplanationSize: roomExplanationCache.size,
  };
}

// Bounded in-memory cache for room AI explanations (used by RoomInternalsView)
export interface RoomExplanationCacheEntry {
  text: string;
  diagram?: any;
  timestamp: number;
}

const MAX_EXPLANATION_CACHE_ENTRIES = 30;
const EXPLANATION_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const roomExplanationCache = new Map<string, RoomExplanationCacheEntry>();

export function getCachedRoomExplanation(key: string): { text: string; diagram?: any } | null {
  return getFromCache(roomExplanationCache, key, EXPLANATION_CACHE_TTL_MS);
}

export function setCachedRoomExplanation(key: string, value: { text: string; diagram?: any }): void {
  if (!value.text?.trim()) return;
  setInCache(roomExplanationCache, key, { ...value, timestamp: Date.now() }, MAX_EXPLANATION_CACHE_ENTRIES);
}

export function clearRoomExplanationCache(): void {
  roomExplanationCache.clear();
}

