import type { ArchitecturalRoom } from '../../types.ts';
import type { GitHubScanResult } from '../github/types.ts';
import type { RoomInvestigationFinding } from '../investigation/types.ts';
import type { FixLifecycleState } from '../lifecycle/types.ts';
import type { ChatMessageItem } from '../../components/ChatPanel.tsx';

export interface WalkthroughStep {
  id: string;
  number: number;
  title: string;
  description: string;
  isComplete: boolean;
  statusNote: string;
  actionLabel?: string;
  actionId?: 'prefill_demo' | 'select_room' | 'focus_blocked_room' | 'ask_chat' | 'investigate' | 'open_fix_report';
}

export interface WalkthroughEvaluationInput {
  isSampleActive: boolean;
  lastScanResult: GitHubScanResult | null;
  selectedRoom: ArchitecturalRoom | null;
  rooms: ArchitecturalRoom[];
  chatMessages: ChatMessageItem[];
  findingsByRoomId: Record<string, RoomInvestigationFinding>;
  fixLifecyclesByRoomId: Record<string, FixLifecycleState>;
  isAiConfigured?: boolean;
}

export interface WalkthroughEvaluationResult {
  steps: WalkthroughStep[];
  completedCount: number;
  totalCount: number;
  isAllCompleted: boolean;
  nextStepIndex: number;
}
