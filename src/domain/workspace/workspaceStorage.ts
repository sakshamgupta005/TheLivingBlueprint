import type { WorkspaceSession, WorkspaceSummary } from './types.ts';
import type { GitHubScanResult } from '../github/types.ts';
import type { ArchitecturalRoom } from '../../types.ts';
import type { RoomInvestigationFinding } from '../investigation/types.ts';
import type { FixLifecycleState } from '../lifecycle/types.ts';
import type { ChatMessageItem } from '../../components/ChatPanel.tsx';

export const WORKSPACES_STORAGE_KEY = 'living_blueprint_workspaces_v1';
export const ACTIVE_WORKSPACE_STORAGE_KEY = 'living_blueprint_active_workspace_id_v1';
export const MAX_STORED_WORKSPACES = 10;

/**
 * Fallback in-memory storage for non-browser or test environments.
 */
class MemoryStorage implements Storage {
  private store: Map<string, string> = new Map();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  key(index: number): string | null {
    const keys = Array.from(this.store.keys());
    return keys[index] || null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

let fallbackMemoryStorage: Storage | null = null;

function resolveStorage(customStorage?: Storage): Storage | null {
  if (customStorage) return customStorage;
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      // Test localStorage availability (may throw in private browsing)
      const testKey = '__lb_storage_test__';
      window.localStorage.setItem(testKey, '1');
      window.localStorage.removeItem(testKey);
      return window.localStorage;
    } catch {
      // Fall through to memory storage
    }
  }
  if (!fallbackMemoryStorage) {
    fallbackMemoryStorage = new MemoryStorage();
  }
  return fallbackMemoryStorage;
}

/**
 * Redact any potential credentials, bearer tokens, or keys before serializing.
 */
export function sanitizeSessionForStorage(session: WorkspaceSession): WorkspaceSession {
  const secretPattern = /(?:bearer\s+[a-zA-Z0-9_\-.~+]+=*|ghp_[a-zA-Z0-9]{15,}|gho_[a-zA-Z0-9]{15,}|github_pat_[a-zA-Z0-9_]{20,}|AIza[0-9A-Za-z\-_]{20,}|key=[a-zA-Z0-9_\-]+|token=[a-zA-Z0-9_\-]+)/gi;

  const sanitizeString = (str?: string): string => {
    if (!str) return str || '';
    return str.replace(secretPattern, '[REDACTED_CREDENTIAL]');
  };

  const sanitizedMessages = (session.chatMessages || []).map((msg) => ({
    ...msg,
    text: sanitizeString(msg.text),
  }));

  return {
    ...session,
    isSavedData: true, // Restored sessions are marked as saved data until explicitly refreshed
    chatMessages: sanitizedMessages,
  };
}

/**
 * Load all stored workspaces safely from localStorage.
 */
export function loadAllWorkspaces(storage?: Storage): WorkspaceSession[] {
  const s = resolveStorage(storage);
  if (!s) return [];

  try {
    const raw = s.getItem(WORKSPACES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((item): item is WorkspaceSession => {
      return (
        item &&
        typeof item.id === 'string' &&
        typeof item.owner === 'string' &&
        typeof item.repo === 'string' &&
        typeof item.commitSha === 'string' &&
        Boolean(item.scanResult) &&
        Array.isArray(item.rooms)
      );
    });
  } catch (err) {
    console.warn('[workspaceStorage] Failed to read workspaces from storage:', err);
    return [];
  }
}

/**
 * Load a single workspace session by id ("owner/repo").
 */
export function loadWorkspace(id: string, storage?: Storage): WorkspaceSession | null {
  const workspaces = loadAllWorkspaces(storage);
  const found = workspaces.find((w) => w.id.toLowerCase() === id.toLowerCase());
  return found || null;
}

/**
 * Save a workspace session. Keeps up to MAX_STORED_WORKSPACES (LRU).
 */
export function saveWorkspace(session: WorkspaceSession, storage?: Storage): boolean {
  if (!session || !session.id || session.id.toLowerCase().includes('sample') || session.id.toLowerCase().includes('booknook')) {
    // Never persist sample BookNook data
    return false;
  }

  const s = resolveStorage(storage);
  if (!s) return false;

  try {
    const sanitized = sanitizeSessionForStorage(session);
    let workspaces = loadAllWorkspaces(storage);

    // Remove existing entry with same id
    workspaces = workspaces.filter((w) => w.id.toLowerCase() !== session.id.toLowerCase());

    // Prepend new/updated session (most recently used first)
    workspaces.unshift(sanitized);

    // Limit to max stored workspaces
    if (workspaces.length > MAX_STORED_WORKSPACES) {
      workspaces = workspaces.slice(0, MAX_STORED_WORKSPACES);
    }

    try {
      s.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(workspaces));
      s.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, session.id);
      return true;
    } catch (quotaError) {
      // If quota exceeded, try evicting older workspaces
      console.warn('[workspaceStorage] Quota error, pruning older workspaces:', quotaError);
      while (workspaces.length > 1) {
        workspaces.pop();
        try {
          s.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(workspaces));
          s.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, session.id);
          return true;
        } catch {
          // keep pruning
        }
      }
      return false;
    }
  } catch (err) {
    console.warn('[workspaceStorage] Error saving workspace:', err);
    return false;
  }
}

/**
 * Delete a workspace session from storage.
 */
export function deleteWorkspace(id: string, storage?: Storage): boolean {
  const s = resolveStorage(storage);
  if (!s) return false;

  try {
    const workspaces = loadAllWorkspaces(storage).filter(
      (w) => w.id.toLowerCase() !== id.toLowerCase()
    );
    s.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(workspaces));

    const activeId = getActiveWorkspaceId(storage);
    if (activeId && activeId.toLowerCase() === id.toLowerCase()) {
      s.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
    }
    return true;
  } catch (err) {
    console.warn('[workspaceStorage] Error deleting workspace:', err);
    return false;
  }
}

/**
 * Get active workspace ID.
 */
export function getActiveWorkspaceId(storage?: Storage): string | null {
  const s = resolveStorage(storage);
  if (!s) return null;
  try {
    return s.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Set active workspace ID.
 */
export function setActiveWorkspaceId(id: string | null, storage?: Storage): void {
  const s = resolveStorage(storage);
  if (!s) return;
  try {
    if (id) {
      s.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, id);
    } else {
      s.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

/**
 * Get compact summary list of all recent projects.
 */
export function getRecentProjects(storage?: Storage): WorkspaceSummary[] {
  const workspaces = loadAllWorkspaces(storage);
  return workspaces.map((w) => {
    let ciStatus: WorkspaceSummary['ciStatus'] = 'unavailable';
    if (w.scanResult.ciEvaluation) {
      if (w.scanResult.ciEvaluation.outcome === 'verified') ciStatus = 'passing';
      else if (w.scanResult.ciEvaluation.outcome === 'failed') ciStatus = 'failing';
      else if (w.scanResult.ciEvaluation.outcome === 'inconclusive') ciStatus = 'pending';
      else if (w.scanResult.ciEvaluation.outcome === 'no_checks' || w.scanResult.ciEvaluation.outcome === 'implemented_only') ciStatus = 'not_run';
    }

    return {
      id: w.id,
      owner: w.owner,
      repo: w.repo,
      branch: w.branch || 'main',
      commitSha: w.commitSha,
      scannedAt: w.scannedAt,
      roomsCount: w.rooms?.length || 0,
      ciStatus,
    };
  });
}

/**
 * Helper to construct a WorkspaceSession from an initial GitHubScanResult and derived rooms.
 */
export function createWorkspaceSessionFromScan(
  result: GitHubScanResult,
  rooms: ArchitecturalRoom[],
  selectedRoomId?: string | null,
  existingChat?: ChatMessageItem[],
  existingFindings?: Record<string, RoomInvestigationFinding>,
  existingLifecycles?: Record<string, FixLifecycleState>
): WorkspaceSession {
  return {
    id: `${result.owner}/${result.repo}`,
    owner: result.owner,
    repo: result.repo,
    branch: result.metadata?.defaultBranch || 'main',
    commitSha: result.commitSha || 'unknown',
    scannedAt: result.scannedAt || new Date().toISOString(),
    isSavedData: false, // Freshly scanned
    scanResult: result,
    rooms,
    selectedRoomId: selectedRoomId ?? (rooms[0]?.id || null),
    chatMessages: existingChat || [],
    findingsByRoomId: existingFindings || {},
    fixLifecyclesByRoomId: existingLifecycles || {},
  };
}
