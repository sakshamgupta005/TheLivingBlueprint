import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateInvestigationFinding } from '../src/domain/investigation/validator.ts';
import { generateRepairPrompt } from '../src/domain/investigation/promptGenerator.ts';
import { executeRoomInvestigation } from '../src/server/investigationProvider.ts';
import type { InvestigateApiRequest } from '../src/domain/investigation/types.ts';

describe('T34 — Investigation Workspace and Findings Hierarchy', () => {
  const sampleRequest: InvestigateApiRequest = {
    roomId: 'room-auth',
    roomName: 'Authentication & Session',
    roomLayer: 'service',
    roomStatus: 'implemented',
    roomEvidence: 'Discovered JWT implementation in src/auth/jwt.ts',
    roomFilePaths: ['src/auth/jwt.ts', 'tests/auth.test.ts'],
    repoContext: {
      owner: 'acme-corp',
      repo: 'secure-vault',
      branch: 'main',
      commitSha: 'c0ffee1234567890abcdef',
      inspectedFiles: [
        {
          path: 'src/auth/jwt.ts',
          category: 'source',
          contentExcerpt: `// Header comment\nexport function verifyToken(token, options) {\n  if (!token) throw new Error("Missing token");\n  const secret = process.env.JWT_SECRET || "default_insecure_secret";\n  return jwt.verify(token, secret);\n}`,
        },
        {
          path: 'tests/auth.test.ts',
          category: 'test',
          contentExcerpt: `describe("auth", () => {\n  it("verifies valid token", () => {\n    assert.ok(true);\n  });\n});`,
        },
      ],
      discoveredFilePaths: [
        'src/auth/jwt.ts',
        'tests/auth.test.ts',
        'package.json',
        'README.md',
      ],
      detectedTechnologies: ['TypeScript', 'Node.js', 'JWT'],
      ciEvaluation: {
        status: 'failing',
        isVerified: false,
        reason: 'CI check failed on test suite',
        checkRunsCount: 2,
        failedChecks: ['Run Unit Tests'],
      },
    },
  };

  describe('1. 7-Level Findings Hierarchy Validation', () => {
    it('structures finding with all 7 levels: finding, whyItMatters, evidence with lineRange, reasoning, unknowns, nextStep, and repair prompt', () => {
      const raw = {
        title: 'Hardcoded Insecure Fallback Secret',
        explanation: 'src/auth/jwt.ts falls back to a hardcoded string when JWT_SECRET is unset in production.',
        whyItMatters: 'Any attacker who knows the hardcoded secret can forge admin JWT tokens and bypass authentication.',
        category: 'security_risk',
        severity: 'high',
        evidenceClassification: 'observed',
        evidencePaths: ['src/auth/jwt.ts'],
        codeEvidence: {
          filePath: 'src/auth/jwt.ts',
          targetIdentifier: 'verifyToken',
          codeSnippet: 'const secret = process.env.JWT_SECRET || "default_insecure_secret";',
          explanation: 'Default fallback exposes system to forged signatures.',
        },
        reasoning: {
          facts: [
            'Line in src/auth/jwt.ts specifies || "default_insecure_secret"',
            'CI check "Run Unit Tests" failed on commit c0ffee1',
          ],
          inferences: [
            'If JWT_SECRET is missing from production environment variables, authentication is compromised.',
          ],
        },
        recommendedNextStep: 'Throw at application startup if process.env.JWT_SECRET is missing.',
        uncertainties: 'Inspected file sample only; actual cloud deployment environment variables were not inspected.',
      };

      const finding = validateInvestigationFinding(raw, sampleRequest);

      // Level 1: Finding & Severity
      assert.strictEqual(finding.title, 'Hardcoded Insecure Fallback Secret');
      assert.strictEqual(finding.severity, 'high');
      assert.strictEqual(finding.evidenceClassification, 'observed');

      // Level 2: Why It Matters
      assert.ok(finding.whyItMatters);
      assert.match(finding.whyItMatters, /forge admin JWT tokens/i);

      // Level 3: Evidence with line ranges
      assert.strictEqual(finding.evidenceReferences.length, 1);
      assert.strictEqual(finding.evidenceReferences[0].isInspected, true);
      assert.ok(finding.codeEvidence);
      assert.strictEqual(finding.codeEvidence.isVerified, true);
      assert.strictEqual(finding.codeEvidence.derivedLineNumber, 4);
      assert.strictEqual(finding.codeEvidence.lineRange, 'L4');
      assert.strictEqual(finding.evidenceReferences[0].lineRange, 'L4');

      // Level 4: Reasoning (Direct Facts vs Inferences)
      assert.ok(finding.reasoning);
      assert.strictEqual(finding.reasoning.facts.length, 2);
      assert.match(finding.reasoning.facts[0], /default_insecure_secret/);
      assert.strictEqual(finding.reasoning.inferences.length, 1);

      // Level 5: Unknowns
      assert.match(finding.uncertainties, /cloud deployment environment/i);

      // Level 6: Next Step
      assert.match(finding.recommendedNextStep, /Throw at application startup/i);

      // Level 7: Copyable Repair Prompt
      const repairPrompt = generateRepairPrompt(finding, sampleRequest.repoContext);
      assert.match(repairPrompt, /Hardcoded Insecure Fallback Secret/);
      assert.match(repairPrompt, /## Why It Matters/);
      assert.match(repairPrompt, /## Grounded Reasoning/);
      assert.match(repairPrompt, /Direct Observed Facts/);
      assert.match(repairPrompt, /Architectural Inferences/);
      assert.match(repairPrompt, /Acceptance Criteria/);
    });

    it('derives multiline snippet line ranges correctly (e.g. L2-L5)', () => {
      const raw = {
        title: 'Token Validation Block',
        explanation: 'Inspects token validation function.',
        category: 'possible_bug',
        severity: 'low',
        evidenceClassification: 'observed',
        evidencePaths: ['src/auth/jwt.ts'],
        codeEvidence: {
          filePath: 'src/auth/jwt.ts',
          targetIdentifier: 'verifyToken',
          codeSnippet: `export function verifyToken(token, options) {\n  if (!token) throw new Error("Missing token");`,
          explanation: 'Function declaration with initial guard clause.',
        },
        recommendedNextStep: 'Add automated unit tests for empty token input.',
        uncertainties: 'None.',
      };

      const finding = validateInvestigationFinding(raw, sampleRequest);
      assert.ok(finding.codeEvidence);
      assert.strictEqual(finding.codeEvidence.derivedLineNumber, 2);
      assert.strictEqual(finding.codeEvidence.lineRange, 'L2-L3');
    });
  });

  describe('2. Missing Evidence & Grounding Limits', () => {
    it('demotes finding to UNVERIFIED and bounds severity to MEDIUM when no inspected files exist', () => {
      const emptyRepoRequest: InvestigateApiRequest = {
        ...sampleRequest,
        repoContext: {
          ...sampleRequest.repoContext,
          inspectedFiles: [],
          discoveredFilePaths: [],
        },
      };

      const raw = {
        title: 'Speculative Token Leakage',
        explanation: 'Speculative issue claiming data breach.',
        category: 'security_risk',
        severity: 'high', // Should be capped because unverified
        evidenceClassification: 'observed', // Should be demoted
        evidencePaths: ['nonexistent/path.ts'],
        recommendedNextStep: 'Check everything.',
        uncertainties: 'No inspected files available.',
      };

      const finding = validateInvestigationFinding(raw, emptyRepoRequest);

      assert.strictEqual(finding.evidenceClassification, 'unverified');
      assert.strictEqual(finding.severity, 'medium'); // Capped from high
      assert.strictEqual(finding.evidenceReferences.length, 0);
      assert.ok(finding.rejectedReferences?.includes('nonexistent/path.ts'));

      // Generates investigation-first repair prompt
      const prompt = generateRepairPrompt(finding, emptyRepoRequest.repoContext);
      assert.match(prompt, /Investigation & Diagnostic Task/i);
      assert.match(prompt, /UNVERIFIED \/ INSUFFICIENT EVIDENCE/);
      assert.match(prompt, /Investigate Before Editing/i);
    });

    it('synthesizes sensible default whyItMatters when omitted by model', () => {
      const raw = {
        title: 'Test Gap in Auth',
        category: 'test_gap',
        severity: 'low',
        evidencePaths: ['src/auth/jwt.ts'],
      };

      const finding = validateInvestigationFinding(raw, sampleRequest);
      assert.ok(finding.whyItMatters);
      assert.match(finding.whyItMatters, /continuous integration/i);
    });
  });

  describe('3. Mixed Confidence & Separation of Facts from Inferences', () => {
    it('strips fabricated identifiers from reasoning facts and demotes classification', () => {
      const raw = {
        title: 'Authentication Token Verification',
        explanation: 'Checks token verification calling validateTaskInput.',
        category: 'possible_bug',
        severity: 'medium',
        evidenceClassification: 'observed',
        evidencePaths: ['src/auth/jwt.ts'],
        reasoning: {
          facts: [
            'Source calls validateTaskInput(token)', // Fabricated identifier!
            'File src/auth/jwt.ts exists in commit c0ffee1',
          ],
          inferences: [
            'Token payload validation might fail unexpectedly.',
          ],
        },
        recommendedNextStep: 'Investigate token verification contract.',
        uncertainties: 'Limited sample.',
      };

      const finding = validateInvestigationFinding(raw, sampleRequest);

      // The fabricated identifier must be rejected
      assert.ok(finding.rejectedReferences?.some((r) => r.includes('validateTaskInput')));
      // Classification must be demoted from observed to inferred because of rejected claims
      assert.strictEqual(finding.evidenceClassification, 'inferred');
      // The fabricated fact must be purged from facts
      assert.strictEqual(
        finding.reasoning?.facts.some((f) => f.includes('validateTaskInput')),
        false
      );
    });
  });

  describe('4. Long Results & Readability Bounds', () => {
    it('bounds overly long strings without crashing or corrupting data', () => {
      const hugeExplanation = 'A'.repeat(2000);
      const hugeNextStep = 'B'.repeat(1000);
      const hugeUncertainties = 'C'.repeat(1000);
      const hugeWhyItMatters = 'D'.repeat(800);

      const raw = {
        title: 'Long Explanation Test',
        explanation: hugeExplanation,
        whyItMatters: hugeWhyItMatters,
        category: 'unknown',
        severity: 'info',
        evidencePaths: ['src/auth/jwt.ts'],
        recommendedNextStep: hugeNextStep,
        uncertainties: hugeUncertainties,
      };

      const finding = validateInvestigationFinding(raw, sampleRequest);

      assert.ok(finding.explanation.length <= 800);
      assert.ok(finding.whyItMatters && finding.whyItMatters.length <= 400);
      assert.ok(finding.recommendedNextStep.length <= 300);
      assert.ok(finding.uncertainties.length <= 500);
    });
  });

  describe('5. Provider Failure & Clean Error Recovery', () => {
    it('returns structured failure when AI provider encounters rate limits', async () => {
      const mockFetch429 = async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 429,
              message: 'Resource exhausted: rate limit exceeded',
              status: 'RESOURCE_EXHAUSTED',
            },
          }),
          { status: 429 }
        );

      const res = await executeRoomInvestigation(
        sampleRequest,
        { GEMINI_API_KEY: 'mock-key' },
        mockFetch429 as unknown as typeof fetch
      );

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.code, 'RATE_LIMITED');
      assert.ok(res.errorInfo);
      assert.strictEqual(res.errorInfo.retryable, true);
    });
  });

  describe('6. Malformed Model Output Handling', () => {
    it('handles markdown codeblock wrapped JSON cleanly', async () => {
      const validPayload = {
        title: 'Grounded Finding from Markdown Block',
        explanation: 'Model output wrapped inside triple backticks markdown.',
        whyItMatters: 'Ensures parser resilience across model variants.',
        category: 'test_gap',
        severity: 'low',
        evidenceClassification: 'observed',
        evidencePaths: ['src/auth/jwt.ts'],
        recommendedNextStep: 'Verify parser handles markdown blocks.',
        uncertainties: 'None.',
      };

      const mockFetchMarkdown = async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: `\`\`\`json\n${JSON.stringify(validPayload)}\n\`\`\``,
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );

      const res = await executeRoomInvestigation(
        sampleRequest,
        { GEMINI_API_KEY: 'mock-key' },
        mockFetchMarkdown as unknown as typeof fetch
      );

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.finding?.title, 'Grounded Finding from Markdown Block');
      assert.strictEqual(res.finding?.whyItMatters, 'Ensures parser resilience across model variants.');
    });

    it('returns PROVIDER_ERROR when model returns unparseable garbage', async () => {
      const mockFetchGarbage = async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: 'Not a JSON object at all! Just conversational chatter.',
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );

      const res = await executeRoomInvestigation(
        { ...sampleRequest, bypassCache: true },
        { GEMINI_API_KEY: 'mock-key' },
        mockFetchGarbage as unknown as typeof fetch
      );

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.code, 'PROVIDER_ERROR');
      assert.match(res.error!, /parse structured JSON/i);
    });
  });
});
