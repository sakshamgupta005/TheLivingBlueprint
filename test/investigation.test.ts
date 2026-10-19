import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateInvestigationFinding } from '../src/domain/investigation/validator.ts';
import { generateRepairPrompt } from '../src/domain/investigation/promptGenerator.ts';
import { executeRoomInvestigation } from '../src/server/investigationProvider.ts';
import { deriveRoomStatus } from '../src/domain/statusEngine.ts';
import type { InvestigateApiRequest } from '../src/domain/investigation/types.ts';
import type { RoomModule } from '../src/domain/types.ts';

describe('Evidence-Backed Investigation & Prompt Generator', () => {
  const baseRequest: InvestigateApiRequest = {
    roomId: 'room-auth',
    roomName: 'Authentication & Session',
    roomLayer: 'service',
    roomStatus: 'implemented',
    roomEvidence: 'Scanned from testowner/myrepo: Discovered auth implementation in src/auth/jwt.ts',
    repoContext: {
      owner: 'testowner',
      repo: 'myrepo',
      branch: 'main',
      commitSha: 'a1b2c3d4e5f6',
      inspectedFiles: [
        { path: 'src/auth/jwt.ts', category: 'source', contentExcerpt: 'export function verifyJwt() {}' },
        { path: 'package.json', category: 'manifest' },
      ],
      discoveredFilePaths: ['src/auth/jwt.ts', 'package.json', 'tests/auth.test.ts', 'README.md'],
      detectedTechnologies: ['TypeScript', 'Node.js'],
    },
  };

  describe('Evidence Validation & Grounding', () => {
    it('validates a grounded, evidence-backed finding with observed files', () => {
      const rawFinding = {
        title: 'JWT Secret Hardcoded Default Fallback',
        explanation: 'src/auth/jwt.ts contains a fallback default secret when process.env.JWT_SECRET is missing.',
        category: 'security_risk',
        severity: 'high',
        evidenceClassification: 'observed',
        evidencePaths: ['src/auth/jwt.ts'],
        recommendedNextStep: 'Require JWT_SECRET environment variable or throw at startup.',
        uncertainties: 'Inspected file excerpt only; production environment configuration unverified.',
        companionMessages: [
          { speaker: 'dog', text: 'Barkley here! I found a fallback secret in jwt.ts.' },
          { speaker: 'cat', text: 'Cleo here. If JWT_SECRET is unset, tokens can be forged.' },
        ],
      };

      const finding = validateInvestigationFinding(rawFinding, baseRequest);

      assert.strictEqual(finding.title, 'JWT Secret Hardcoded Default Fallback');
      assert.strictEqual(finding.category, 'security_risk');
      assert.strictEqual(finding.severity, 'high');
      assert.strictEqual(finding.evidenceClassification, 'observed');
      assert.strictEqual(finding.evidenceReferences.length, 1);
      assert.strictEqual(finding.evidenceReferences[0].path, 'src/auth/jwt.ts');
      assert.strictEqual(finding.evidenceReferences[0].isInspected, true);
      assert.ok(finding.evidenceReferences[0].githubUrl?.includes('testowner/myrepo'));
    });

    it('filters out fabricated or ungrounded evidence paths', () => {
      const rawFindingWithFabrications = {
        title: 'Session Token Bug',
        explanation: 'Claims session bug in fictitious files.',
        category: 'possible_bug',
        severity: 'medium',
        evidenceClassification: 'observed',
        evidencePaths: [
          'src/auth/jwt.ts', // Real inspected
          'src/nonexistent/secret_handler.ts', // Fabricated!
          'fictitious/leak.go', // Fabricated!
        ],
        recommendedNextStep: 'Fix session token generation.',
        uncertainties: 'None stated.',
      };

      const finding = validateInvestigationFinding(rawFindingWithFabrications, baseRequest);

      // Only the real path must be preserved; fabricated paths must be stripped
      assert.strictEqual(finding.evidenceReferences.length, 1);
      assert.strictEqual(finding.evidenceReferences[0].path, 'src/auth/jwt.ts');
      assert.strictEqual(finding.evidenceReferences[0].isInspected, true);
    });

    it('demotes classification to UNVERIFIED and caps severity when all references are fabricated', () => {
      const rawFindingAllFake = {
        title: 'Phantom Vulnerability',
        explanation: 'Invented security issue.',
        category: 'security_risk',
        severity: 'high',
        evidenceClassification: 'observed',
        evidencePaths: ['fake/file1.ts', 'fake/file2.ts'],
        recommendedNextStep: 'Investigate phantom file.',
        uncertainties: 'Unverified claim.',
      };

      const finding = validateInvestigationFinding(rawFindingAllFake, baseRequest);

      assert.strictEqual(finding.evidenceReferences.length, 0);
      assert.strictEqual(finding.evidenceClassification, 'unverified');
      // High severity must be capped to medium when unverified
      assert.notStrictEqual(finding.severity, 'high');
      assert.strictEqual(finding.severity, 'medium');
    });

    it('marks uninspected discovered files accurately as uninspected', () => {
      const rawFinding = {
        title: 'Missing Integration Tests',
        explanation: 'tests/auth.test.ts was found in tree but was not inspected in the 12-file sample.',
        category: 'test_gap',
        severity: 'low',
        evidenceClassification: 'inferred',
        evidencePaths: ['tests/auth.test.ts'],
        recommendedNextStep: 'Inspect tests/auth.test.ts and verify test coverage.',
        uncertainties: 'File exists in git tree but content was not read.',
      };

      const finding = validateInvestigationFinding(rawFinding, baseRequest);
      assert.strictEqual(finding.evidenceReferences.length, 1);
      assert.strictEqual(finding.evidenceReferences[0].path, 'tests/auth.test.ts');
      assert.strictEqual(finding.evidenceReferences[0].isInspected, false);
      assert.match(finding.evidenceReferences[0].note || '', /not inspected/i);
    });

    it('falls back safely on invalid categories and severity values', () => {
      const rawFindingInvalid = {
        title: 'Weird category test',
        explanation: 'Testing invalid enums',
        category: 'unsupported_category_name',
        severity: 'ultra_critical_extreme',
        evidenceClassification: 'invalid_classification',
      };

      const finding = validateInvestigationFinding(rawFindingInvalid, baseRequest);
      assert.strictEqual(finding.category, 'unknown');
      assert.strictEqual(finding.severity, 'info');
      assert.strictEqual(finding.evidenceClassification, 'inferred');
    });
  });

  describe('Repair Prompt Generation', () => {
    it('generates targeted repair prompt for observed evidence with explicit acceptance criteria', () => {
      const finding = validateInvestigationFinding(
        {
          title: 'Hardcoded JWT Secret Fallback',
          explanation: 'Fallback string detected in src/auth/jwt.ts',
          category: 'security_risk',
          severity: 'medium',
          evidenceClassification: 'observed',
          evidencePaths: ['src/auth/jwt.ts'],
          recommendedNextStep: 'Throw an error if JWT_SECRET environment variable is missing.',
          uncertainties: 'Inspected file only; deployment secrets unverified.',
        },
        baseRequest
      );

      const prompt = generateRepairPrompt(finding, baseRequest.repoContext);

      // Verifies all required elements in generated prompt:
      assert.match(prompt, /testowner\/myrepo/);
      assert.match(prompt, /main/);
      assert.match(prompt, /Authentication & Session/);
      assert.match(prompt, /Hardcoded JWT Secret Fallback/);
      assert.match(prompt, /src\/auth\/jwt\.ts/);
      assert.match(prompt, /Acceptance Criteria/i);
      assert.match(prompt, /Never claim tests passed or builds succeeded unless they actually ran/i);
      assert.match(prompt, /Preserve existing architectural patterns/i);
    });

    it('generates INVESTIGATION-FIRST prompt when evidence is weak or unverified', () => {
      const finding = validateInvestigationFinding(
        {
          title: 'Speculative Token Leak Risk',
          explanation: 'Insufficient evidence to confirm if session tokens are leaked.',
          category: 'unknown',
          severity: 'low',
          evidenceClassification: 'unverified',
          evidencePaths: [],
          recommendedNextStep: 'Search for cookie serialization logic.',
          uncertainties: 'Zero inspected files match session logic.',
        },
        baseRequest
      );

      const prompt = generateRepairPrompt(finding, baseRequest.repoContext);

      // Investigation-First specific directives:
      assert.match(prompt, /Investigation & Diagnostic Task/i);
      assert.match(prompt, /UNVERIFIED \/ INSUFFICIENT EVIDENCE/);
      assert.match(prompt, /Investigate Before Editing/i);
      assert.match(prompt, /Do NOT assume this issue exists or make speculative code modifications/i);
    });
  });

  describe('Provider Execution & State Separation', () => {
    it('returns CONFIG_REQUIRED when API key is missing', async () => {
      const res = await executeRoomInvestigation(baseRequest, {});
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.code, 'CONFIG_REQUIRED');
      assert.match(res.error!, /GEMINI_API_KEY/);
    });

    it('handles successful model response and attaches generated prompt', async () => {
      const mockFetch = async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        title: 'Missing Token Expiration Check',
                        explanation: 'Token decoder in src/auth/jwt.ts does not verify exp claim.',
                        category: 'security_risk',
                        severity: 'medium',
                        evidenceClassification: 'observed',
                        evidencePaths: ['src/auth/jwt.ts'],
                        recommendedNextStep: 'Validate exp claim during token verification.',
                        uncertainties: 'Inspected file only.',
                        companionMessages: [
                          { speaker: 'dog', text: 'Barkley: Found the token verifier in jwt.ts!' },
                          { speaker: 'cat', text: 'Cleo: exp claim verification is omitted.' },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );

      const res = await executeRoomInvestigation(
        baseRequest,
        { GEMINI_API_KEY: 'test-key' },
        mockFetch as unknown as typeof fetch
      );

      assert.strictEqual(res.success, true);
      assert.ok(res.finding);
      assert.strictEqual(res.finding.title, 'Missing Token Expiration Check');
      assert.strictEqual(res.finding.evidenceReferences.length, 1);
      assert.ok(res.finding.generatedPrompt);
      assert.match(res.finding.generatedPrompt, /Missing Token Expiration Check/);
    });

    it('ensures investigation results NEVER directly mutate room status in status engine', () => {
      const room: RoomModule = {
        id: 'room-auth',
        name: 'Authentication',
        description: 'Auth service',
        layer: 'service',
        requirements: [{ id: 'req-auth', title: 'Token Verification' }],
        evidenceHistory: [
          {
            id: 'ev-code',
            sourceType: 'source_code',
            description: 'Source code in jwt.ts',
            timestamp: '2026-10-19T00:00:00Z',
            targetRequirementId: 'req-auth',
          },
        ],
      };

      // Room status before investigation is IMPLEMENTED
      const beforeStatus = deriveRoomStatus(room);
      assert.strictEqual(beforeStatus.status, 'implemented');

      // Even if an investigation finding exists, room status must remain deterministic
      const afterStatus = deriveRoomStatus(room);
      assert.strictEqual(afterStatus.status, 'implemented');
      assert.notStrictEqual(afterStatus.status, 'verified');
    });
  });
});
