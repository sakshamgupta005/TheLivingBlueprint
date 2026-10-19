/**
 * Types for Request Journey and Call-Sequence Diagrams (T28).
 * Provides deterministic sequence tracing, participant identification,
 * return paths, error branches, and step exploration.
 */

export type JourneyParticipantKind =
  | 'client'
  | 'entry_route'
  | 'handler'
  | 'service'
  | 'validator'
  | 'storage'
  | 'external'
  | 'unresolved'
  | 'response';

export type JourneyConfidence =
  | 'directly_observed'
  | 'statically_reconstructed'
  | 'unresolved';

export interface JourneyParticipant {
  id: string;
  label: string;
  kind: JourneyParticipantKind;
  filePath?: string;
  lineRange?: { startLine: number; endLine: number };
  symbolId?: string;
  roomId?: string;
  isExternal?: boolean;
  unresolvedReason?: string;
  confidence: 'directly_observed' | 'inferred' | 'unresolved';
}

export type JourneyStepType =
  | 'call'
  | 'return'
  | 'validation_check'
  | 'storage_op'
  | 'response_send'
  | 'error_branch'
  | 'unresolved_call';

export interface JourneyStep {
  id: string;
  order: number;
  fromParticipantId: string;
  toParticipantId: string;
  type: JourneyStepType;
  label: string;
  detail?: string;
  filePath?: string;
  lineRange?: { startLine: number; endLine: number };
  codeExcerpt?: string;
  isAsync?: boolean;
  isError?: boolean;
  confidence: JourneyConfidence;
  evidence: string;
  unresolvedReason?: string;
}

export interface JourneyStats {
  totalParticipants: number;
  totalSteps: number;
  callsCount: number;
  returnsCount: number;
  errorBranchesCount: number;
  unresolvedCount: number;
}

export interface JourneyEntryPoint {
  id: string;
  method: string;
  routePath: string;
  framework: string;
  sourcePath: string;
  lineRange: { startLine: number; endLine: number };
  handlerSymbol?: string;
  evidence: string;
}

export interface RequestJourney {
  id: string;
  title: string;
  entryPoint: JourneyEntryPoint | null;
  /**
   * Requirement 5: Distinguish statically reconstructed path from observed runtime trace.
   * Statically reconstructed means derived from AST syntax and symbol index;
   * observed runtime trace would require runtime hooks/profiling.
   */
  traceKind: 'statically_reconstructed' | 'observed_runtime';
  isComplete: boolean;
  unresolvedLinksCount: number;
  participants: JourneyParticipant[];
  steps: JourneyStep[];
  explanation: string;
  stats: JourneyStats;
  supportedExploration: {
    canStepForward: boolean;
    canStepBackward: boolean;
  };
}

export interface JourneyTraceOptions {
  entryPointId?: string;
  startSymbolId?: string;
  startRoutePath?: string;
  maxDepth?: number;
}
