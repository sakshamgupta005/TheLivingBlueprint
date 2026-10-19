import type { GitHubScanResult } from '../github/types.ts';
import type { ArchitecturalRoom } from '../../types.ts';
import type { RoomInvestigationFinding } from '../investigation/types.ts';
import type { FixLifecycleState } from '../lifecycle/types.ts';
import type { ChatMessageItem } from '../../components/ChatPanel.tsx';

/**
 * Persisted workspace session for a real scanned repository.
 */
export interface WorkspaceSession {
  id: string; // "owner/repo"
  owner: string;
  repo: string;
  branch: string;
  commitSha: string;
  scannedAt: string; // ISO date string
  isSavedData: boolean; // true when restored from storage until refreshed
  scanResult: GitHubScanResult;
  rooms: ArchitecturalRoom[];
  selectedRoomId: string | null;
  chatMessages: ChatMessageItem[];
  findingsByRoomId: Record<string, RoomInvestigationFinding>;
  fixLifecyclesByRoomId: Record<string, FixLifecycleState>;
}

/**
 * Compact summary for recent projects listing.
 */
export interface WorkspaceSummary {
  id: string; // "owner/repo"
  owner: string;
  repo: string;
  branch: string;
  commitSha: string;
  scannedAt: string;
  roomsCount: number;
  ciStatus?: 'passing' | 'failing' | 'pending' | 'unavailable' | 'not_run';
}
