import type { EvidenceRecord, Requirement } from './domain/types.ts';

export type RoomStatus =
  | 'planned'
  | 'implemented'
  | 'verified'
  | 'blocked'
  | 'unknown'
  | 'in_progress';

export interface ArchitecturalRoom {
  id: string;
  name: string;
  layer: 'foundation' | 'core' | 'service' | 'gateway';
  status: RoomStatus;
  description: string;
  evidence: string;
  filePaths?: string[];
  dependencies?: string[];
  requirements?: Requirement[];
  evidenceHistory?: EvidenceRecord[];
  metrics: {
    testsPassed?: number;
    totalTests?: number;
    testFilesCount?: number;
    filesCount?: number;
    ciStatus?: 'passing' | 'failing' | 'pending' | 'unavailable' | 'not_run';
    ciCheckName?: string;
    ciUrl?: string;
  };
  coords: {
    isoX: number;
    isoY: number;
    width: number;
    height: number;
    depth: number;
  };
}

export interface ChatMessagePreview {
  id: string;
  sender: 'dog' | 'cat';
  speakerName: string;
  tagline: string;
  content: string;
  timestamp: string;
}
