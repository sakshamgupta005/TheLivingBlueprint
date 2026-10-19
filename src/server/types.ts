/**
 * Types for Server-Side AI Companions and Provider Integration
 */

export type CompanionSpeaker = 'dog' | 'cat';
export type ExplanationLevel = 'beginner' | 'intermediate' | 'technical';

export interface WorkflowNode {
  id: string;
  label: string;
  role?: string;
  nodeType?: 'component' | 'decision' | 'storage' | 'external' | 'step';
  roomId?: string;
  filePath?: string;
  classification: 'observed' | 'inferred';
  description: string;
  inputs?: string;
  outputs?: string;
  importance?: string;
  codeSnippet?: {
    code: string;
    line?: number;
    explanation?: string;
  };
}

export interface WorkflowEdge {
  from: string;
  to: string;
  label?: string;
  branchLabel?: string;
  classification: 'observed' | 'inferred';
  evidenceReference?: string;
}

export interface WorkflowDiagram {
  id?: string;
  title: string;
  explanation: string;
  simulationType: 'code-derived workflow walkthrough' | 'static flow simulation';
  flowArchetype?:
    | 'pipeline'
    | 'business_logic'
    | 'api_request'
    | 'data_storage'
    | 'architecture'
    | 'testing_ci'
    | 'configuration';
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  uncertainties?: string;
}

export interface CompanionReplyMessage {
  speaker: CompanionSpeaker;
  text: string;
  evidenceReference?: string;
  workflowDiagram?: WorkflowDiagram;
  suggestedFollowUps?: string[];
}

export interface ValidatedChatResponse {
  replies: CompanionReplyMessage[];
  workflowDiagram?: WorkflowDiagram;
  reply?: CompanionReplyMessage;
  isComplete?: boolean;
  nextSpeaker?: CompanionSpeaker | null;
}

export interface ChatTurn {
  id: string;
  userMessage: string;
  timestamp: string;
  replies: CompanionReplyMessage[];
  selectedRoomId?: string;
}

export interface ChatApiRequest {
  message: string;
  explanationLevel?: ExplanationLevel;
  history?: Array<{ role: 'user' | 'assistant'; text: string; speaker?: CompanionSpeaker }>;
  selectedRoomId?: string;
  includeDiagram?: boolean;
  bypassCache?: boolean;
  repoContext?: {
    owner: string;
    repo: string;
    branch: string;
    commitSha?: string;
    totalFiles: number;
    inspectedFiles: Array<{
      path: string;
      category: string;
      contentExcerpt?: string;
      sizeBytes?: number;
    }>;
    discoveredFilePaths?: string[];
    detectedTechnologies: string[];
    roomSummaries: Array<{
      id: string;
      name: string;
      layer?: string;
      status: string;
      evidence: string;
      filePaths?: string[];
      ciStatus?: string;
      ciCheckName?: string;
    }>;
    dependencies?: string[];
    ciEvaluation?: {
      status: string;
      isVerified: boolean;
      reason: string;
      checkRunsCount: number;
      failedChecks: string[];
    };
    investigationFindings?: Record<string, unknown>;
  };
  investigationFindings?: Record<string, unknown>;
  isFragmentRequest?: boolean;
  fragmentIndex?: number;
  targetSpeaker?: CompanionSpeaker;
  conversationStage?: string;
  previousFragments?: CompanionReplyMessage[];
}

export interface ExecutionTimingMetadata {
  contextPrepMs: number;
  upstreamMs: number;
  validationMs: number;
  fallbackMs?: number;
  totalMs: number;
  promptTokens?: number;
  candidatesTokens?: number;
  totalTokens?: number;
  thinkingLevel?: 'low' | 'high';
  providerUsed?: 'gemini' | 'groq' | 'cloudflare';
  provider?: 'gemini' | 'groq' | 'cloudflare';
  fallbackUsed?: boolean;
  cached?: boolean;
  model?: string;
}

export type AiErrorKind =
  | 'rate_limit_short'
  | 'quota_exceeded_daily'
  | 'billing_limit'
  | 'service_unavailable'
  | 'config_required'
  | 'invalid_request'
  | 'timeout'
  | 'network_error'
  | 'unknown';

export interface AiErrorInfo {
  kind: AiErrorKind;
  title: string;
  message: string;
  retryAfterSeconds?: number;
  retryable: boolean;
  detailSafe?: string;
  proHint?: boolean;
}

export interface ChatApiResponse {
  success: boolean;
  replies?: CompanionReplyMessage[];
  reply?: CompanionReplyMessage;
  isComplete?: boolean;
  nextSpeaker?: CompanionSpeaker | null;
  workflowDiagram?: WorkflowDiagram;
  cached?: boolean;
  error?: string;
  code?: 'CONFIG_REQUIRED' | 'RATE_LIMITED' | 'PROVIDER_ERROR' | 'INVALID_REQUEST';
  errorInfo?: AiErrorInfo;
  timing?: ExecutionTimingMetadata;
  providerUsed?: 'gemini' | 'groq' | 'cloudflare';
  provider?: 'gemini' | 'groq' | 'cloudflare';
  warning?: string;
  fallbackUsed?: boolean;
}

