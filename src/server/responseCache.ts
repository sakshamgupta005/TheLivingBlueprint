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
  providerUsed?: 'gemini' | 'groq' | 'cloudflare';
  timestamp: number;
}

export interface InvestigationCacheEntry {
  finding: RoomInvestigationFinding;
  timing: ExecutionTimingMetadata;
  providerUsed?: 'gemini' | 'groq' | 'cloudflare';
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

  return `chat##${repo.owner}/${repo.repo}@${commitSha}##room:${roomId}##level:${level}##diag:${diagIntent}##msg:${normMsg}##ctx:${contextFingerprint.length}:${repo.totalFiles}##v1`;
}

/**
 * Derives a deterministic cache key for room investigations.
 * Returns null if the request should NOT be cached (explicit bypassCache or missing repo/room).
 */
export function buildInvestigationCacheKey(request: InvestigateApiRequest): string | null {
  if (request.bypassCache === true) {
    return null;
  }

  const repo = request.repoContext;
  if (!repo || !repo.owner || !repo.repo || !request.roomId) {
    return null;
  }

  const commitSha = repo.commitSha || 'no-commit';
  const roomStatus = request.roomStatus || 'unknown';
  const sortedFiles = (request.roomFilePaths || []).slice().sort().join(',');

  return `investigate##${repo.owner}/${repo.repo}@${commitSha}##room:${request.roomId}##status:${roomStatus}##files:${sortedFiles}##v1`;
}

export function getCachedChatResponse(key: string): ChatCacheEntry | null {
  const entry = chatCache.get(key);
  if (!entry) {
    stats.chatMisses++;
    return null;
  }

  // Check TTL expiration
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    chatCache.delete(key);
    stats.chatMisses++;
    return null;
  }

  // Refresh LRU position
  chatCache.delete(key);
  chatCache.set(key, entry);

  stats.chatHits++;
  return entry;
}

export function setCachedChatResponse(
  key: string,
  entry: Omit<ChatCacheEntry, 'timestamp'>
): void {
  // Validate that we only cache successful responses with actual replies
  if (!entry.response || !Array.isArray(entry.response.replies) || entry.response.replies.length === 0) {
    return;
  }

  if (chatCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = chatCache.keys().next().value;
    if (oldest) {
      chatCache.delete(oldest);
      stats.evictions++;
    }
  }

  chatCache.set(key, {
    ...entry,
    timestamp: Date.now(),
  });
}

export function getCachedInvestigation(key: string): InvestigationCacheEntry | null {
  const entry = investigationCache.get(key);
  if (!entry) {
    stats.investigationMisses++;
    return null;
  }

  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    investigationCache.delete(key);
    stats.investigationMisses++;
    return null;
  }

  // Refresh LRU position
  investigationCache.delete(key);
  investigationCache.set(key, entry);

  stats.investigationHits++;
  return entry;
}

export function setCachedInvestigation(
  key: string,
  entry: Omit<InvestigationCacheEntry, 'timestamp'>
): void {
  // Only cache fully validated findings with zero rejected references
  if (
    !entry.finding ||
    (entry.finding.rejectedReferences && entry.finding.rejectedReferences.length > 0)
  ) {
    return;
  }

  if (investigationCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = investigationCache.keys().next().value;
    if (oldest) {
      investigationCache.delete(oldest);
      stats.evictions++;
    }
  }

  investigationCache.set(key, {
    ...entry,
    timestamp: Date.now(),
  });
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

  for (const key of Array.from(chatCache.keys())) {
    if (commitSha && key.includes(`@${commitSha}`)) {
      chatCache.delete(key);
    } else if (targetRepo && key.includes(targetRepo)) {
      chatCache.delete(key);
    } else if (roomId && key.includes(`room:${roomId}`)) {
      chatCache.delete(key);
    }
  }

  for (const key of Array.from(investigationCache.keys())) {
    if (commitSha && key.includes(`@${commitSha}`)) {
      investigationCache.delete(key);
    } else if (targetRepo && key.includes(targetRepo)) {
      investigationCache.delete(key);
    } else if (roomId && key.includes(`room:${roomId}`)) {
      investigationCache.delete(key);
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
  const entry = roomExplanationCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > EXPLANATION_CACHE_TTL_MS) {
    roomExplanationCache.delete(key);
    return null;
  }
  return entry;
}

export function setCachedRoomExplanation(key: string, value: { text: string; diagram?: any }): void {
  if (!value.text || value.text.trim().length === 0) return;
  if (roomExplanationCache.size >= MAX_EXPLANATION_CACHE_ENTRIES) {
    const oldest = roomExplanationCache.keys().next().value;
    if (oldest) roomExplanationCache.delete(oldest);
  }
  roomExplanationCache.set(key, { ...value, timestamp: Date.now() });
}

export function clearRoomExplanationCache(): void {
  roomExplanationCache.clear();
}

