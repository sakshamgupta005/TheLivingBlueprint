import type {
  CompanionEvalCase,
  CompanionEvalScore,
  CompanionEvaluationSummary,
  CompanionEvalCategory,
} from './types.ts';
import type {
  ValidatedChatResponse,
  CompanionReplyMessage,
  WorkflowNode,
  WorkflowEdge,
} from '../../server/types.ts';

const KNOWN_FABRICATED_IDENTIFIERS = [
  'validatetaskinput',
  'input.title',
  'taskvalidator.js',
  'auth.config.js',
  'connectredis',
  'oauth2client',
  'stripe.webhooks',
  'pgpool',
  'models/user.js',
];

const GREETING_FILLER_PATTERNS = [
  /\b(?:barkley|cleo)\s+here\b/i,
  /\bwoof\s+woof\b/i,
  /\bhi\s+(?:friend|there|buddy)\b/i,
  /\bhello\s+(?:friend|there|user)\b/i,
  /\bas\s+an\s+ai\b/i,
  /\bthat['’]?s\s+a\s+(?:great|wonderful)\s+question\b/i,
];

/**
 * Deterministically evaluates a companion chat response against an evaluation test case.
 */
export function scoreCompanionResponse(
  testCase: CompanionEvalCase,
  response: ValidatedChatResponse,
  _repoFileTree: string[] = [
    'src/tasks/validation.js',
    'src/routes.js',
    'test/createTask.test.js',
    'package.json',
  ]
): CompanionEvalScore {
  const replyTexts = response.replies.map((r: CompanionReplyMessage) => r.text).join(' ');
  const diagramTexts = response.workflowDiagram
    ? [
        response.workflowDiagram.title,
        response.workflowDiagram.explanation,
        ...response.workflowDiagram.nodes.map((n: WorkflowNode) => `${n.label} ${n.description} ${n.filePath || ''}`),
        ...response.workflowDiagram.edges.map((e: WorkflowEdge) => e.label || ''),
      ].join(' ')
    : '';
  const fullText = `${replyTexts} ${diagramTexts}`;
  const lowerText = fullText.toLowerCase();
  const evidenceRefs = [
    ...response.replies.map((r: CompanionReplyMessage) => r.evidenceReference || '').filter(Boolean),
    ...(response.workflowDiagram?.nodes.map((n: WorkflowNode) => n.filePath || '').filter(Boolean) || []),
  ];

  const findings: string[] = [];

  // 1. Hallucination Detection
  const hallucinatedReferences: string[] = [];
  for (const fab of KNOWN_FABRICATED_IDENTIFIERS) {
    if (lowerText.includes(fab)) {
      hallucinatedReferences.push(fab);
      findings.push(`Detected hallucinated identifier/reference: "${fab}".`);
    }
  }

  // 2. Grounding Score (0-100)
  let groundingScore = 50; // base
  if (testCase.expectedGroundingRefs.length > 0) {
    let matchedGrounding = 0;
    for (const ref of testCase.expectedGroundingRefs) {
      const lowerRef = ref.toLowerCase();
      const inText = lowerText.includes(lowerRef);
      const inRefs = evidenceRefs.some((er) => er.toLowerCase().includes(lowerRef));
      if (inText || inRefs) {
        matchedGrounding++;
      }
    }
    const ratio = matchedGrounding / testCase.expectedGroundingRefs.length;
    groundingScore = Math.round(ratio * 100);
    if (ratio === 1) {
      findings.push('All expected code/evidence references successfully grounded.');
    } else if (ratio > 0) {
      findings.push(`Partially grounded: ${matchedGrounding}/${testCase.expectedGroundingRefs.length} references cited.`);
    } else {
      findings.push('Failed grounding: none of the expected references were cited.');
    }
  } else {
    // If no specific grounding references expected (e.g. missing evidence question),
    // ensure no fabricated repository files are cited
    groundingScore = hallucinatedReferences.length === 0 ? 100 : 40;
  }

  // 3. Correctness Score (0-100)
  let correctnessScore = 100;
  if (testCase.unsupportedPremise && testCase.unsupportedPremise.mustReject) {
    // Check if response properly rejected the unsupported premise
    const rejected = testCase.unsupportedPremise.expectedRejectionTerms.some((term) =>
      lowerText.includes(term.toLowerCase())
    );

    if (rejected) {
      correctnessScore = 100;
      findings.push(`Correctly rejected unsupported premise: "${testCase.unsupportedPremise.feature}".`);
    } else {
      correctnessScore = 0;
      findings.push(`Failed correctness: accepted unsupported premise "${testCase.unsupportedPremise.feature}".`);
    }
  } else if (testCase.expectedDirectAnswerTerms.length > 0) {
    let matchedTerms = 0;
    for (const term of testCase.expectedDirectAnswerTerms) {
      if (lowerText.includes(term.toLowerCase())) {
        matchedTerms++;
      }
    }
    const ratio = matchedTerms / testCase.expectedDirectAnswerTerms.length;
    correctnessScore = Math.max(30, Math.round(ratio * 100));
    if (ratio >= 0.7) {
      findings.push('Core factual answer terms verified.');
    } else {
      findings.push('Answer lacks key factual terms.');
    }
  }

  // 4. Helpfulness & Teaching Score (0-100)
  let helpfulnessScore = 70;
  // Check if first message answers directly in the first 2 sentences
  const firstMessage = response.replies[0]?.text || '';
  const firstTwoSentences = firstMessage.split(/[.!?]\s+/).slice(0, 2).join(' ').toLowerCase();

  const answersDirectlyFirst = testCase.expectedDirectAnswerTerms.some((term) =>
    firstTwoSentences.includes(term.toLowerCase())
  ) || (testCase.unsupportedPremise && testCase.unsupportedPremise.expectedRejectionTerms.some((term) =>
    firstTwoSentences.includes(term.toLowerCase())
  ));

  if (answersDirectlyFirst) {
    helpfulnessScore += 15;
    findings.push('Answers the actual question directly in the opening statement.');
  } else {
    helpfulnessScore -= 10;
    findings.push('Did not answer core question in the opening sentence.');
  }

  // Check for progressive detail / what to inspect next / suggested follow-ups
  const hasFollowUps = response.replies.some(
    (r: CompanionReplyMessage) => (r.suggestedFollowUps && r.suggestedFollowUps.length > 0) ||
      /inspect|next|explore|would you like|check/i.test(r.text)
  );
  if (hasFollowUps) {
    helpfulnessScore += 15;
    findings.push('Offers progressive detail and next inspection targets.');
  }

  helpfulnessScore = Math.max(0, Math.min(100, helpfulnessScore));

  // 5. Clarity Score (0-100)
  let clarityScore = 85;
  // Check for greeting filler
  for (const pattern of GREETING_FILLER_PATTERNS) {
    if (pattern.test(fullText)) {
      clarityScore -= 15;
      findings.push(`Contains repetitive greeting filler matching ${pattern}.`);
      break;
    }
  }

  // Check explanation level suitability
  if (testCase.explanationLevel === 'beginner') {
    // Check if technical terms have plain English explanations or analogies
    if (/like|think of|imagine|analog|checkpoint|receptionist|guard/i.test(lowerText)) {
      clarityScore += 15;
      findings.push('Uses intuitive real-world analogy appropriate for beginners.');
    }
  } else if (testCase.explanationLevel === 'technical') {
    if (/boolean|type|contract|parameter|condition|exit code|http \d{3}/i.test(lowerText)) {
      clarityScore += 15;
      findings.push('Demonstrates technical precision with exact types/contracts.');
    }
  }

  clarityScore = Math.max(0, Math.min(100, clarityScore));

  // Hallucination penalty
  const hallucinationPenalty = Math.min(60, hallucinatedReferences.length * 30);

  // Composite Calculation
  const baseScore =
    0.25 * groundingScore +
    0.25 * correctnessScore +
    0.25 * helpfulnessScore +
    0.25 * clarityScore;

  const compositeScore = Math.max(0, Math.min(100, Math.round(baseScore - hallucinationPenalty)));
  const passed =
    compositeScore >= 80 &&
    hallucinatedReferences.length === 0 &&
    correctnessScore >= 70;

  return {
    evalId: testCase.id,
    category: testCase.category,
    question: testCase.question,
    scores: {
      grounding: groundingScore,
      correctness: correctnessScore,
      helpfulness: helpfulnessScore,
      clarity: clarityScore,
      hallucinationPenalty,
    },
    compositeScore,
    passed,
    hallucinatedReferences,
    findings,
  };
}

/**
 * Runs the full evaluation suite across all test cases.
 */
export function runCompanionEvaluationSuite(
  cases: CompanionEvalCase[],
  responseProvider: (c: CompanionEvalCase) => ValidatedChatResponse,
  repoFileTree?: string[]
): CompanionEvaluationSummary {
  const results: CompanionEvalScore[] = [];

  const categoryMap: Record<
    CompanionEvalCategory,
    { count: number; passed: number; sumComposite: number }
  > = {
    code_explanation: { count: 0, passed: 0, sumComposite: 0 },
    bug_diagnosis: { count: 0, passed: 0, sumComposite: 0 },
    missing_evidence: { count: 0, passed: 0, sumComposite: 0 },
    architecture: { count: 0, passed: 0, sumComposite: 0 },
    tests_ci: { count: 0, passed: 0, sumComposite: 0 },
    follow_up: { count: 0, passed: 0, sumComposite: 0 },
  };

  for (const testCase of cases) {
    const response = responseProvider(testCase);
    const score = scoreCompanionResponse(testCase, response, repoFileTree);
    results.push(score);

    const cat = categoryMap[testCase.category];
    cat.count++;
    if (score.passed) cat.passed++;
    cat.sumComposite += score.compositeScore;
  }

  const total = results.length;
  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = total - passedCount;

  const avg = (fn: (r: CompanionEvalScore) => number) =>
    total > 0 ? Math.round(results.reduce((acc, r) => acc + fn(r), 0) / total) : 0;

  const categoryBreakdown: Record<
    CompanionEvalCategory,
    { count: number; passed: number; avgComposite: number }
  > = {} as any;

  for (const [k, v] of Object.entries(categoryMap)) {
    const key = k as CompanionEvalCategory;
    categoryBreakdown[key] = {
      count: v.count,
      passed: v.passed,
      avgComposite: v.count > 0 ? Math.round(v.sumComposite / v.count) : 0,
    };
  }

  return {
    totalEvaluated: total,
    passedCount,
    failedCount,
    averageGrounding: avg((r) => r.scores.grounding),
    averageCorrectness: avg((r) => r.scores.correctness),
    averageHelpfulness: avg((r) => r.scores.helpfulness),
    averageClarity: avg((r) => r.scores.clarity),
    averageComposite: avg((r) => r.compositeScore),
    categoryBreakdown,
    results,
  };
}
