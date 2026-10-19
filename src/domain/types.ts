/**
 * Domain model for The Living Blueprint
 * Framework-independent TypeScript definitions.
 */

export type OperationStatus =
  | 'idle'
  | 'in_progress'
  | 'completed'
  | 'partial'
  | 'failed_recoverable'
  | 'failed_config';

export interface OperationState<T = unknown> {
  status: OperationStatus;
  data?: T;
  error?: string;
  message?: string;
  canRetry?: boolean;
  rateLimitResetTime?: string;
}

export type RoomStatus =
  | 'planned'
  | 'implemented'
  | 'verified'
  | 'blocked'
  | 'unknown';

export type EvidenceSourceType =
  | 'source_code'
  | 'configuration'
  | 'test_result'
  | 'ai_inference'
  | 'user_confirmation';

export type VerificationStatus = 'passed' | 'failed' | 'inconclusive';

export interface VerificationResult {
  status: VerificationStatus;
  testName?: string;
  details?: string;
  timestamp?: string;
}

export interface EvidenceRecord {
  id: string;
  sourceType: EvidenceSourceType;
  description: string;
  timestamp: string;
  reference?: string;
  targetRequirementId?: string;
  targetRequirementIds?: string[];
  isBlocker?: boolean;
  isSuperseded?: boolean;
  supersededBy?: string;
  supersededAt?: string;
  verificationResult?: VerificationResult;
}

export interface Requirement {
  id: string;
  title: string;
  description?: string;
}

export type PillarType =
  | 'database'
  | 'runtime'
  | 'hosting'
  | 'security'
  | 'observability';

export interface InfrastructurePillar {
  id: string;
  name: string;
  description: string;
  pillarType: PillarType;
  status: 'verified' | 'configured' | 'missing';
  evidenceIds?: string[];
}

export type ConnectionType =
  | 'calls'
  | 'imports'
  | 'persists_to'
  | 'authenticates_with';

export interface DependencyConnection {
  id: string;
  sourceRoomId: string;
  targetRoomId: string;
  type: ConnectionType;
  status: 'verified' | 'unverified' | 'broken';
}

export interface RoomModule {
  id: string;
  name: string;
  description: string;
  layer: 'foundation' | 'core' | 'service' | 'gateway';
  requirements: Requirement[];
  evidenceHistory: EvidenceRecord[];
  pillarId?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  rooms: RoomModule[];
  pillars: InfrastructurePillar[];
  dependencies: DependencyConnection[];
}

export interface RequirementEvaluation {
  requirementId: string;
  status: RoomStatus;
  reason: string;
  activeEvidenceCount: number;
  supersededEvidenceCount: number;
}

export interface RoomStatusEvaluation {
  roomId: string;
  status: RoomStatus;
  reason: string;
  requirementEvaluations: RequirementEvaluation[];
  totalEvidenceCount: number;
  activeEvidenceCount: number;
  supersededEvidenceCount: number;
}

export interface ProjectStatusEvaluation {
  projectId: string;
  rooms: RoomStatusEvaluation[];
  summary: Record<RoomStatus, number>;
}
