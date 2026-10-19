import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPANION_EVALUATION_SET,
  scoreCompanionResponse,
  runCompanionEvaluationSuite,
} from '../src/domain/evaluation/index.ts';
import {
  buildSystemPrompt,
} from '../src/server/contextBuilder.ts';
import {
  parseAndValidateChatResponse,
} from '../src/server/aiProvider.ts';
import type { ChatApiRequest, ValidatedChatResponse } from '../src/server/types.ts';

describe('T32: Companion Teaching Quality, Mode Differentiation & Deterministic Evaluation', () => {
  const mockRepoContext: ChatApiRequest['repoContext'] = {
    owner: 'sakshamgupta005',
    repo: 'patchboard-tasks-api',
    branch: 'main',
    commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
    totalFiles: 18,
    detectedTechnologies: ['Node.js', 'Express', 'JavaScript'],
    inspectedFiles: [
      {
        path: 'src/tasks/validation.js',
        category: 'source',
        contentExcerpt: 'function validateTaskTitle(title) { if (title.length === 0) return false; return true; }',
      },
      {
        path: 'src/routes.js',
        category: 'source',
        contentExcerpt: 'router.post("/tasks", (req, res) => { const valid = validateTaskTitle(req.body.title); });',
      },
      {
        path: 'test/createTask.test.js',
        category: 'test',
        contentExcerpt: 'it("rejects whitespace-only task titles", () => { ... })',
      },
    ],
    discoveredFilePaths: [
      'src/tasks/validation.js',
      'src/routes.js',
      'test/createTask.test.js',
      'src/db/connection.js',
    ],
    roomSummaries: [
      {
        id: 'room-routes',
        name: 'API Routes & Gateway',
        layer: 'gateway',
        status: 'implemented',
        evidence: 'Discovered routes.js',
        filePaths: ['src/routes.js'],
      },
      {
        id: 'room-validation',
        name: 'Input Validation',
        layer: 'core',
        status: 'blocked',
        evidence: 'CI failure',
        filePaths: ['src/tasks/validation.js'],
      },
    ],
  };

  describe('1. 28-Question Comprehensive Evaluation Benchmark Suite', () => {
    it('contains at least 25 questions covering all 6 required categories', () => {
      assert.ok(COMPANION_EVALUATION_SET.length >= 25, 'Must have at least 25 evaluation questions');
      assert.strictEqual(COMPANION_EVALUATION_SET.length, 28);

      const categories = new Set(COMPANION_EVALUATION_SET.map((c) => c.category));
      assert.ok(categories.has('code_explanation'));
      assert.ok(categories.has('bug_diagnosis'));
      assert.ok(categories.has('missing_evidence'));
      assert.ok(categories.has('architecture'));
      assert.ok(categories.has('tests_ci'));
      assert.ok(categories.has('follow_up'));
    });

    it('scores high passing rates across all evaluation test cases', () => {
      const summary = runCompanionEvaluationSuite(
        COMPANION_EVALUATION_SET,
        (testCase) => testCase.sampleGoodResponse
      );

      assert.strictEqual(summary.totalEvaluated, 28);
      assert.strictEqual(summary.passedCount, 28, 'All sample good responses must pass');
      assert.strictEqual(summary.failedCount, 0);

      // Verify minimum score thresholds
      assert.ok(summary.averageGrounding >= 85, `Average grounding was ${summary.averageGrounding}`);
      assert.ok(summary.averageCorrectness >= 90, `Average correctness was ${summary.averageCorrectness}`);
      assert.ok(summary.averageHelpfulness >= 85, `Average helpfulness was ${summary.averageHelpfulness}`);
      assert.ok(summary.averageClarity >= 85, `Average clarity was ${summary.averageClarity}`);
      assert.ok(summary.averageComposite >= 88, `Average composite was ${summary.averageComposite}`);

      // Category breakdown checks
      for (const [catName, catData] of Object.entries(summary.categoryBreakdown)) {
        assert.ok(catData.count > 0, `Category ${catName} must have test cases`);
        assert.strictEqual(catData.passed, catData.count, `All cases in ${catName} must pass`);
        assert.ok(catData.avgComposite >= 85, `Category ${catName} avg composite was ${catData.avgComposite}`);
      }
    });
  });

  describe('2. Deterministic Scoring: Penalties for Hallucination, False Premises & Filler', () => {
    it('penalizes hallucinated identifiers like validateTaskInput and input.title', () => {
      const evalCase = COMPANION_EVALUATION_SET.find((c) => c.id === 'eval-code-1')!;
      assert.ok(evalCase.samplePoorResponse);

      const score = scoreCompanionResponse(evalCase, evalCase.samplePoorResponse!);

      assert.strictEqual(score.passed, false, 'Poor response with hallucinations must fail');
      assert.ok(score.hallucinatedReferences.length >= 1, 'Must catch hallucinated identifiers');
      assert.ok(score.scores.hallucinationPenalty >= 30, 'Must apply hallucination penalty');
      assert.ok(score.compositeScore < 70, `Composite score was ${score.compositeScore}`);
    });

    it('penalizes agreeing with an unsupported premise (e.g. inventing OAuth2 logic)', () => {
      const evalCase = COMPANION_EVALUATION_SET.find((c) => c.id === 'eval-missing-1')!;
      assert.ok(evalCase.samplePoorResponse);

      const score = scoreCompanionResponse(evalCase, evalCase.samplePoorResponse!);

      assert.strictEqual(score.passed, false, 'Must fail when agreeing with unsupported premise');
      assert.strictEqual(score.scores.correctness, 0, 'Correctness must drop to 0 for false premise');
    });

    it('penalizes repetitive greeting filler ("Woof! Barkley here!")', () => {
      const evalCase = COMPANION_EVALUATION_SET.find((c) => c.id === 'eval-code-1')!;
      const fillerResponse: ValidatedChatResponse = {
        replies: [
          {
            speaker: 'dog',
            text: 'Woof woof! Barkley here! Validation in src/tasks/validation.js checks title.length === 0.',
          },
        ],
      };

      const score = scoreCompanionResponse(evalCase, fillerResponse);
      assert.ok(score.scores.clarity < 85, 'Greeting filler must penalize clarity');
      assert.ok(score.findings.some((f) => f.includes('Contains repetitive greeting filler')));
    });

    it('rewards direct answers in the opening sentence and progressive follow-ups', () => {
      const evalCase = COMPANION_EVALUATION_SET.find((c) => c.id === 'eval-bug-1')!;
      const score = scoreCompanionResponse(evalCase, evalCase.sampleGoodResponse);

      assert.ok(score.scores.helpfulness >= 90);
      assert.ok(score.findings.some((f) => f.includes('Answers the actual question directly')));
      assert.ok(score.findings.some((f) => f.includes('progressive detail')));
    });
  });

  describe('3. Meaningful Differentiation Across Explanation Modes', () => {
    it('beginner mode emphasizes analogies, plain English, and technical term definitions', () => {
      const prompt = buildSystemPrompt({
        message: 'How does validation work?',
        explanationLevel: 'beginner',
        repoContext: mockRepoContext,
      });

      assert.ok(prompt.includes('EXPLANATION LEVEL: BEGINNER'));
      assert.ok(prompt.includes('Accessible language, relatable analogies and examples'));
      assert.ok(prompt.includes('Real-World Analogies: Use concrete physical analogies'));
      assert.ok(prompt.includes('Technical Terms: Explain technical jargon in plain English'));
    });

    it('intermediate mode emphasizes control flow, structural boundaries, and mechanics', () => {
      const prompt = buildSystemPrompt({
        message: 'How does the route interact with validation?',
        explanationLevel: 'intermediate',
        repoContext: mockRepoContext,
      });

      assert.ok(prompt.includes('EXPLANATION LEVEL: INTERMEDIATE'));
      assert.ok(prompt.includes('Practical implementation details, control flow, functions'));
      assert.ok(prompt.includes('Mechanics: Trace how data enters'));
      assert.ok(prompt.includes('Trade-offs & Coupling'));
    });

    it('technical mode emphasizes exact function contracts, line references, and CI check runs', () => {
      const prompt = buildSystemPrompt({
        message: 'Explain validateTaskTitle contract',
        explanationLevel: 'technical',
        repoContext: mockRepoContext,
      });

      assert.ok(prompt.includes('EXPLANATION LEVEL: TECHNICAL'));
      assert.ok(prompt.includes('Precise function behaviour, exact source references'));
      assert.ok(prompt.includes('Teaching Method: Focus on exact function contracts'));
      assert.ok(prompt.includes('Edge Cases & Failures'));
    });
  });

  describe('4. Single Shared Turn Architecture, Progressive Detail & Diagrams', () => {
    it('parses suggestedFollowUps from model output for progressive detail', () => {
      const rawJson = JSON.stringify({
        replies: [
          {
            speaker: 'dog',
            text: 'The code checks title.length === 0 in src/tasks/validation.js.',
            evidenceReference: 'src/tasks/validation.js',
            suggestedFollowUps: [
              'Why does whitespace pass this check?',
              'Inspect route caller in src/routes.js',
            ],
          },
        ],
      });

      const parsed = parseAndValidateChatResponse(rawJson, mockRepoContext);

      assert.strictEqual(parsed.replies.length, 1);
      assert.ok(parsed.replies[0].suggestedFollowUps);
      assert.strictEqual(parsed.replies[0].suggestedFollowUps?.length, 2);
      assert.strictEqual(
        parsed.replies[0].suggestedFollowUps?.[0],
        'Why does whitespace pass this check?'
      );
    });

    it('returns both companion voices in a single model turn without extra calls', () => {
      const rawJson = JSON.stringify({
        replies: [
          {
            speaker: 'dog',
            text: 'The route in src/routes.js receives the task payload.',
            evidenceReference: 'src/routes.js',
          },
          {
            speaker: 'cat',
            text: 'And test/createTask.test.js proves the validation failed in CI.',
            evidenceReference: 'test/createTask.test.js',
          },
        ],
      });

      const parsed = parseAndValidateChatResponse(rawJson, mockRepoContext);

      assert.strictEqual(parsed.replies.length, 2);
      assert.strictEqual(parsed.replies[0].speaker, 'dog');
      assert.strictEqual(parsed.replies[1].speaker, 'cat');
    });

    it('returns structured workflow diagram when relevant and grounds nodes in repo files', () => {
      const evalCase = COMPANION_EVALUATION_SET.find((c) => c.id === 'eval-followup-4')!;
      assert.ok(evalCase.sampleGoodResponse.workflowDiagram);

      const diagram = evalCase.sampleGoodResponse.workflowDiagram;
      assert.strictEqual(diagram.nodes.length, 4);
      assert.strictEqual(diagram.edges.length, 3);
      assert.ok(diagram.nodes.some((n) => n.filePath === 'src/routes.js'));
      assert.ok(diagram.nodes.some((n) => n.filePath === 'src/tasks/validation.js'));
    });
  });
});
