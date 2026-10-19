import type { ExplanationLevel, ValidatedChatResponse } from '../../server/types.ts';

export type CompanionEvalCategory =
  | 'code_explanation'
  | 'bug_diagnosis'
  | 'missing_evidence'
  | 'architecture'
  | 'tests_ci'
  | 'follow_up';

export interface CompanionEvalCase {
  id: string;
  category: CompanionEvalCategory;
  question: string;
  explanationLevel: ExplanationLevel;
  selectedRoomId?: string;
  description: string;
  expectedDirectAnswerTerms: string[];
  expectedGroundingRefs: string[];
  unsupportedPremise?: {
    feature: string;
    mustReject: boolean;
    expectedRejectionTerms: string[];
  };
  requiredTermDefinitions?: string[];
  rubricCriteria: {
    grounding: string;
    correctness: string;
    helpfulness: string;
    clarity: string;
  };
  sampleGoodResponse: ValidatedChatResponse;
  samplePoorResponse?: ValidatedChatResponse;
}

export interface CompanionEvalScore {
  evalId: string;
  category: CompanionEvalCategory;
  question: string;
  scores: {
    grounding: number;
    correctness: number;
    helpfulness: number;
    clarity: number;
    hallucinationPenalty: number;
  };
  compositeScore: number;
  passed: boolean;
  hallucinatedReferences: string[];
  findings: string[];
}

export interface CompanionEvaluationSummary {
  totalEvaluated: number;
  passedCount: number;
  failedCount: number;
  averageGrounding: number;
  averageCorrectness: number;
  averageHelpfulness: number;
  averageClarity: number;
  averageComposite: number;
  categoryBreakdown: Record<
    CompanionEvalCategory,
    { count: number; passed: number; avgComposite: number }
  >;
  results: CompanionEvalScore[];
}
