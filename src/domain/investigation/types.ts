import type { CompanionReplyMessage, ExecutionTimingMetadata, AiErrorInfo } from '../../server/types.ts';

export type IssueCategory =
  | 'missing_proof'
  | 'possible_bug'
  | 'security_risk'
  | 'configuration_risk'
  | 'test_gap'
  | 'dependency_risk'
  | 'unknown';

export type IssueSeverity = 'info' | 'low' | 'medium' | 'high';

export type EvidenceClassification = 'observed' | 'inferred' | 'unverified';

export interface ValidatedEvidenceRef {
  path: string;
  isInspected: boolean;
  githubUrl?: string;
  note?: string;
  verifiedExcerpt?: string;
  verifiedIdentifier?: string;
  derivedLineNumber?: number;
  lineRange?: string;
}

export interface ValidatedCodeEvidence {
  filePath: string;
  targetIdentifier?: string;
  codeSnippet?: string;
  derivedLineNumber?: number;
  lineRange?: string;
  isVerified: boolean;
  explanation?: string;
}

export interface FindingReasoning {
  facts: string[];
  inferences: string[];
}

export interface RoomInvestigationFinding {
  roomId: string;
  roomName: string;
  title: string;
  explanation: string;
  whyItMatters?: string;
  category: IssueCategory;
  severity: IssueSeverity;
  evidenceClassification: EvidenceClassification;
  evidenceReferences: ValidatedEvidenceRef[];
  rejectedReferences?: string[];
  codeEvidence?: ValidatedCodeEvidence;
  reasoning?: FindingReasoning;
  recommendedNextStep: string;
  uncertainties: string;
  companionMessages: CompanionReplyMessage[];
  generatedPrompt?: string;
  timing?: ExecutionTimingMetadata;
  providerUsed?: 'gemini' | 'groq' | 'cloudflare' | 'omniroute';
  provider?: 'gemini' | 'groq' | 'cloudflare' | 'omniroute';
  fallbackUsed?: boolean;
  isCached?: boolean;
}

export interface InvestigateApiRequest {
  roomId: string;
  roomName: string;
  roomLayer: string;
  roomStatus: string;
  roomEvidence: string;
  roomFilePaths?: string[];
  bypassCache?: boolean;
  repoContext: {
    owner: string;
    repo: string;
    branch: string;
    commitSha?: string;
    inspectedFiles: Array<{
      path: string;
      category: string;
      contentExcerpt?: string;
      sizeBytes?: number;
    }>;
    discoveredFilePaths?: string[];
    detectedTechnologies: string[];
    dependencies?: string[];
    ciEvaluation?: {
      status: string;
      isVerified: boolean;
      reason: string;
      checkRunsCount: number;
      failedChecks: string[];
    };
  };
}

export interface InvestigateApiResponse {
  success: boolean;
  finding?: RoomInvestigationFinding;
  cached?: boolean;
  error?: string;
  code?: 'CONFIG_REQUIRED' | 'RATE_LIMITED' | 'PROVIDER_ERROR' | 'INVALID_REQUEST';
  errorInfo?: AiErrorInfo;
  timing?: ExecutionTimingMetadata;
  providerUsed?: 'gemini' | 'groq' | 'cloudflare' | 'omniroute';
  provider?: 'gemini' | 'groq' | 'cloudflare' | 'omniroute';
  fallbackUsed?: boolean;
}
