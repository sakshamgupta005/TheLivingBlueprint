import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseAndValidateChatResponse, executeAiChat } from '../src/server/aiProvider.ts';
import { buildSystemPrompt } from '../src/server/contextBuilder.ts';
import { evaluateRequirement } from '../src/domain/statusEngine.ts';
import type { EvidenceRecord, Requirement } from '../src/domain/types.ts';
import type { ChatApiRequest } from '../src/server/types.ts';

describe('Chatbot VELOCITY Integration Verification', () => {
  describe('1. The cat does not have to speak in every response', () => {
    it('accepts a dog-only response without forcing Cleo to speak', () => {
      const dogOnlyRaw = JSON.stringify({
        replies: [
          {
            speaker: 'dog',
            text: 'Hello! I am Barkley and I am happy to guide you through the architecture today.',
          },
        ],
      });

      const parsed = parseAndValidateChatResponse(dogOnlyRaw);
      assert.strictEqual(parsed.replies.length, 1);
      assert.strictEqual(parsed.replies[0].speaker, 'dog');
      assert.strictEqual(parsed.replies.some((r) => r.speaker === 'cat'), false);
    });

    it('accepts single fragment reply object from modern dialogue flow', () => {
      const singleReplyRaw = JSON.stringify({
        reply: {
          speaker: 'dog',
          text: 'Barkley here! Explaining the repository overview.',
        },
        isComplete: true,
        nextSpeaker: null,
      });

      const parsed = parseAndValidateChatResponse(singleReplyRaw);
      assert.strictEqual(parsed.replies.length, 1);
      assert.strictEqual(parsed.replies[0].speaker, 'dog');
      assert.strictEqual(parsed.isComplete, true);
    });
  });

  describe('2. The companions can use relevant investigation results in subsequent messages', () => {
    it('includes investigation findings in system prompt for companions to explain', () => {
      const request: ChatApiRequest = {
        message: 'What issues did you find in the auth room?',
        selectedRoomId: 'room-auth',
        investigationFindings: {
          'room-auth': {
            title: 'Hardcoded Insecure Fallback Secret',
            severity: 'high',
            category: 'security_risk',
            explanation: 'src/auth/jwt.ts falls back to hardcoded string when JWT_SECRET is unset.',
            codeEvidence: {
              filePath: 'src/auth/jwt.ts',
              codeSnippet: 'const secret = process.env.JWT_SECRET || "default_insecure_secret";',
            },
            recommendedNextStep: 'Enforce secret configuration in environment.',
          },
        },
        repoContext: {
          owner: 'acme-corp',
          repo: 'secure-vault',
          branch: 'main',
          totalFiles: 10,
          inspectedFiles: [
            {
              path: 'src/auth/jwt.ts',
              category: 'source',
              contentExcerpt: 'export const secret = "default_insecure_secret";',
            },
          ],
          discoveredFilePaths: ['src/auth/jwt.ts', 'package.json'],
          detectedTechnologies: ['TypeScript'],
          roomSummaries: [
            {
              id: 'room-auth',
              name: 'Authentication Room',
              status: 'needs_investigation',
              evidence: 'Insecure fallback suspected',
            },
          ],
        },
      };

      const systemPrompt = buildSystemPrompt(request);
      assert.match(systemPrompt, /PREVIOUS ROOM INVESTIGATION FINDINGS/i);
      assert.match(systemPrompt, /Hardcoded Insecure Fallback Secret/);
      assert.match(systemPrompt, /HIGH/);
      assert.match(systemPrompt, /default_insecure_secret/);
      assert.match(systemPrompt, /Enforce secret configuration/);
    });
  });

  describe('3. Answers respect the current repository and room context', () => {
    it('bounds companion prompt to the active repository and selected room', () => {
      const request: ChatApiRequest = {
        message: 'Tell me about this room',
        selectedRoomId: 'room-api',
        repoContext: {
          owner: 'target-corp',
          repo: 'real-api',
          branch: 'production',
          commitSha: 'a1b2c3d4e5f6',
          totalFiles: 5,
          inspectedFiles: [
            {
              path: 'src/routes.ts',
              category: 'source',
              contentExcerpt: 'app.get("/users", handler);',
            },
          ],
          discoveredFilePaths: ['src/routes.ts'],
          detectedTechnologies: ['Express'],
          roomSummaries: [
            {
              id: 'room-api',
              name: 'API Gateway',
              status: 'implemented',
              evidence: 'Routes found in src/routes.ts',
            },
          ],
        },
      };

      const prompt = buildSystemPrompt(request);
      assert.match(prompt, /TARGET REPOSITORY: target-corp\/real-api/);
      assert.match(prompt, /SCANNED COMMIT SHA: a1b2c3d4e5f6/);
      assert.match(prompt, /CURRENT SELECTED ROOM: API Gateway \(id: room-api\)/);
    });
  });

  describe('4. Uninspected files are never presented as inspected', () => {
    it('strictly distinguishes discovered-only files from inspected files in the companion prompt', () => {
      const request: ChatApiRequest = {
        message: 'Did you read internal/secret.go?',
        repoContext: {
          owner: 'acme',
          repo: 'test-app',
          branch: 'main',
          totalFiles: 2,
          inspectedFiles: [
            {
              path: 'README.md',
              category: 'docs',
              contentExcerpt: '# Acme Test App',
            },
          ],
          discoveredFilePaths: ['README.md', 'internal/secret.go'],
          detectedTechnologies: ['Go'],
          roomSummaries: [],
        },
      };

      const prompt = buildSystemPrompt(request);
      assert.match(prompt, /DISCOVERED FILE PATHS \(Tree Only - File contents were NOT inspected\)/);
      assert.match(prompt, /internal\/secret\.go/);
      assert.match(prompt, /Never invent imports, functions, or implementation details/);
    });
  });

  describe('5. AI interpretations cannot independently establish verified status', () => {
    it('contains strict non-promotion rule in system prompt when investigation findings exist', () => {
      const request: ChatApiRequest = {
        message: 'Is this verified?',
        selectedRoomId: 'room-auth',
        investigationFindings: {
          'room-auth': {
            title: 'Diagnostic Finding',
            severity: 'low',
            explanation: 'Some issue',
          },
        },
        repoContext: {
          owner: 'acme',
          repo: 'test-app',
          branch: 'main',
          totalFiles: 1,
          inspectedFiles: [],
          discoveredFilePaths: ['README.md'],
          detectedTechnologies: [],
          roomSummaries: [],
        },
      };

      const prompt = buildSystemPrompt(request);
      assert.match(
        prompt,
        /AI interpretations cannot independently promote an unverified room to verified status/
      );
    });

    it('deterministic status engine remains strictly independent of conversational claims', () => {
      const requirement: Requirement = {
        id: 'req-auth',
        title: 'Authentication',
        description: 'User login and tokens',
      };

      const aiClaimEvidence: EvidenceRecord = {
        id: 'ev-ai-1',
        targetRequirementId: 'req-auth',
        description: 'AI companion claims everything works without proof',
        sourceType: 'ai_inference',
        capturedAt: new Date().toISOString(),
        isBlocker: false,
        verificationResult: {
          status: 'passed',
          output: 'AI claims verified',
          verifiedAt: new Date().toISOString(),
          verifier: 'ai',
        },
      };

      const result = evaluateRequirement(requirement, [aiClaimEvidence]);

      // AI claims alone cannot promote to verified status
      assert.notStrictEqual(result.status, 'verified');
      assert.strictEqual(result.status, 'unknown');
    });
  });

  describe('6. Existing error handling and provider fallback continue to behave correctly', () => {
    it('handles rate limits safely without leaking keys or throwing unhandled errors', async () => {
      const mockFetchRateLimit = async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 429,
              message: 'Resource has been exhausted (e.g. check quota).',
              status: 'RESOURCE_EXHAUSTED',
            },
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );

      const res = await executeAiChat(
        {
          message: 'Hello',
        },
        {
          GEMINI_API_KEY: 'test-gemini-secret-key-12345',
        },
        mockFetchRateLimit as unknown as typeof fetch
      );

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.code, 'RATE_LIMITED');
      assert.strictEqual(res.error?.includes('test-gemini-secret-key-12345'), false);
    });
  });
});
