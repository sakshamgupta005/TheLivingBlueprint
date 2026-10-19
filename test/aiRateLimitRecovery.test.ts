import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyGeminiError,
  classifyNetworkError,
  parseRetryDelay,
  redactSensitiveInfo,
  isTransientError,
} from '../src/server/errorClassifier.ts';
import { executeAiChat } from '../src/server/aiProvider.ts';
import { executeRoomInvestigation } from '../src/server/investigationProvider.ts';
import type { ChatApiRequest } from '../src/server/types.ts';
import type { InvestigateApiRequest } from '../src/domain/investigation/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('T20 — Professional AI Rate-Limit Experience & Graceful Recovery', () => {
  describe('1. Error Classification & Quota Differentiation', () => {
    it('classifies short-term rate limits correctly with professional message', () => {
      const errorBody = {
        error: {
          code: 429,
          message: 'Resource has been exhausted (e.g. check quota).',
          status: 'RESOURCE_EXHAUSTED',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'RATE_LIMIT_EXCEEDED',
              metadata: { quota_metric: 'generate_content_requests_per_minute' },
            },
          ],
        },
      };

      const classified = classifyGeminiError(429, 'Too Many Requests', errorBody);

      assert.strictEqual(classified.kind, 'rate_limit_short');
      assert.strictEqual(classified.title, 'AI is taking a short break');
      assert.match(classified.message, /usage limit/i);
      assert.match(classified.message, /project and saved progress are safe/i);
      assert.strictEqual(classified.retryable, true);
      assert.strictEqual(classified.proHint, true);
    });

    it('classifies daily quota exhaustion distinctly from short-term bursts', () => {
      const errorBody = {
        error: {
          code: 429,
          message:
            "Quota exceeded for quota metric 'Requests per day' and limit 'Requests per day' of service 'generativelanguage.googleapis.com'",
          status: 'RESOURCE_EXHAUSTED',
        },
      };

      const classified = classifyGeminiError(429, 'Too Many Requests', errorBody);

      assert.strictEqual(classified.kind, 'quota_exceeded_daily');
      assert.strictEqual(classified.title, 'Daily AI usage limit reached');
      assert.match(classified.message, /daily usage quota/i);
      assert.strictEqual(classified.proHint, true);
    });

    it('classifies spend/billing quota restrictions accurately', () => {
      const errorBody = {
        error: {
          code: 429,
          message: 'Billing account has reached its monthly spend limit or is disabled (BILLING_DISABLED).',
          status: 'RESOURCE_EXHAUSTED',
        },
      };

      const classified = classifyGeminiError(429, 'Too Many Requests', errorBody);

      assert.strictEqual(classified.kind, 'billing_limit');
      assert.strictEqual(classified.title, 'AI billing or quota restriction');
      assert.match(classified.message, /billing or spend limit/i);
      assert.strictEqual(classified.retryable, false);
      assert.strictEqual(classified.proHint, true);
    });

    it('distinguishes 503 service overload from quota exhaustion', () => {
      const errorBody = {
        error: {
          code: 503,
          message: 'The model is overloaded. Please try again later.',
          status: 'UNAVAILABLE',
        },
      };

      const classified = classifyGeminiError(503, 'Service Unavailable', errorBody);

      assert.strictEqual(classified.kind, 'service_unavailable');
      assert.strictEqual(classified.title, 'AI provider temporarily unavailable');
      assert.match(classified.message, /overload or maintenance/i);
      assert.strictEqual(classified.retryable, true);
      assert.strictEqual(classified.proHint, false);
    });

    it('keeps invalid API keys and configuration errors distinct from rate limits', () => {
      const invalidKeyBody = {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
          details: [{ reason: 'API_KEY_INVALID' }],
        },
      };

      const classified = classifyGeminiError(400, 'Bad Request', invalidKeyBody);

      assert.strictEqual(classified.kind, 'config_required');
      assert.strictEqual(classified.title, 'AI configuration required');
      assert.match(classified.message, /invalid or expired/i);
      assert.strictEqual(classified.retryable, false);
      assert.strictEqual(classified.proHint, false);
    });
  });

  describe('2. Retry Metadata Parsing & Reset Timing', () => {
    it('parses valid numeric Retry-After headers', () => {
      const delay = parseRetryDelay('45');
      assert.strictEqual(delay, 45);
    });

    it('parses structured Google RPC RetryInfo metadata', () => {
      const details = [
        {
          '@type': 'type.googleapis.com/google.rpc.RetryInfo',
          retryDelay: '35.4s',
        },
      ];
      const delay = parseRetryDelay(null, details);
      assert.strictEqual(delay, 35);
    });

    it('does not invent or guess reset times when metadata is absent or invalid', () => {
      assert.strictEqual(parseRetryDelay(null, []), undefined);
      assert.strictEqual(parseRetryDelay('invalid', undefined), undefined);
      assert.strictEqual(parseRetryDelay('-10', undefined), undefined);
      assert.strictEqual(parseRetryDelay('0', undefined), undefined);
    });
  });

  describe('3. Bounded Retry Behavior & Overload Protection', () => {
    it('identifies transient errors correctly for bounded retry', () => {
      const transientOverload = {
        kind: 'service_unavailable' as const,
        title: 'Unavailable',
        message: 'Overloaded',
        retryable: true,
      };
      assert.strictEqual(isTransientError(transientOverload), true);

      const nonTransientDaily = {
        kind: 'quota_exceeded_daily' as const,
        title: 'Daily Quota',
        message: 'Daily quota exceeded',
        retryable: false,
      };
      assert.strictEqual(isTransientError(nonTransientDaily), false);

      const nonTransientConfig = {
        kind: 'config_required' as const,
        title: 'Config',
        message: 'Config required',
        retryable: false,
      };
      assert.strictEqual(isTransientError(nonTransientConfig), false);
    });

    it('never creates infinite retry loops or retries non-retryable errors', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount++;
        return new Response(
          JSON.stringify({
            error: {
              code: 429,
              message: "Quota exceeded for quota metric 'Requests per day'",
              status: 'RESOURCE_EXHAUSTED',
            },
          }),
          { status: 429 }
        );
      };

      const req: ChatApiRequest = { message: 'Explain architecture' };
      const res = await executeAiChat(
        req,
        { GEMINI_API_KEY: 'test-secret-key-123' },
        mockFetch as unknown as typeof fetch
      );

      // Non-retryable daily quota must execute exactly 1 attempt (0 auto retries)
      assert.strictEqual(callCount, 1);
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.code, 'RATE_LIMITED');
      assert.strictEqual(res.errorInfo?.kind, 'quota_exceeded_daily');
    });

    it('limits transient retry attempts to at most 2 and honours timeout budget', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount++;
        return new Response(
          JSON.stringify({
            error: {
              code: 503,
              message: 'Service Unavailable',
              status: 'UNAVAILABLE',
            },
          }),
          { status: 503 }
        );
      };

      const req: ChatApiRequest = { message: 'Explain this' };
      const res = await executeAiChat(
        req,
        { GEMINI_API_KEY: 'test-secret-key-123' },
        mockFetch as unknown as typeof fetch
      );

      // Must be strictly bounded to at most 2 calls (1 attempt + 1 transient retry)
      assert.ok(callCount <= 2, `Expected at most 2 calls, got ${callCount}`);
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.errorInfo?.kind, 'service_unavailable');
    });
  });

  describe('4. Credential Redaction & Secrets Safety', () => {
    it('redacts sensitive API keys, bearer tokens, and URLs containing keys', () => {
      const secret = 'AIzaSyA_RealSecretKey998877';
      const rawText = `Failed request to https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${secret} with Bearer ${secret}`;

      const sanitized = redactSensitiveInfo(rawText, [secret]);

      assert.strictEqual(sanitized.includes(secret), false);
      assert.match(sanitized, /key=\[REDACTED\]/);
      assert.match(sanitized, /Bearer\s+\[REDACTED\]/);
    });

    it('returns safe, redacted error messages in server responses', async () => {
      const secretKey = 'SuperSecretGeminiKey12345';
      const mockFetch = async () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: `Invalid key param key=${secretKey} rejected.`,
            },
          }),
          { status: 400 }
        );
      };

      const req: ChatApiRequest = { message: 'Test message' };
      const res = await executeAiChat(
        req,
        { GEMINI_API_KEY: secretKey },
        mockFetch as unknown as typeof fetch
      );

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.error?.includes(secretKey), false);
      assert.strictEqual(res.errorInfo?.detailSafe?.includes(secretKey), false);
    });
  });

  describe('5. Investigation Error Classification & Recovery', () => {
    it('classifies room investigation rate limits and returns structured errorInfo', async () => {
      const mockFetch = async () => {
        return new Response(
          JSON.stringify({
            error: {
              code: 429,
              message: 'Resource has been exhausted (e.g. check quota).',
              status: 'RESOURCE_EXHAUSTED',
            },
          }),
          {
            status: 429,
            headers: { 'retry-after': '30' },
          }
        );
      };

      const req: InvestigateApiRequest = {
        roomId: 'validation-room',
        roomName: 'Input Validation',
        roomLayer: 'Domain Layer',
        roomStatus: 'implemented',
        roomEvidence: 'Validation logic inspected',
        repoContext: {
          owner: 'test',
          repo: 'demo',
          branch: 'main',
          inspectedFiles: [],
          detectedTechnologies: ['TypeScript'],
        },
      };

      const res = await executeRoomInvestigation(
        req,
        { GEMINI_API_KEY: 'test-key' },
        mockFetch as unknown as typeof fetch
      );

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.code, 'RATE_LIMITED');
      assert.strictEqual(res.errorInfo?.kind, 'rate_limit_short');
      assert.strictEqual(res.errorInfo?.retryAfterSeconds, 30);
      assert.strictEqual(res.errorInfo?.proHint, true);
    });

    it('handles network timeouts cleanly without fabricating findings', async () => {
      const timeoutErr = new Error('The operation was aborted');
      timeoutErr.name = 'AbortError';

      const mockFetch = async () => {
        throw timeoutErr;
      };

      const req: InvestigateApiRequest = {
        roomId: 'auth-room',
        roomName: 'Auth Gateway',
        roomLayer: 'Interface Layer',
        roomStatus: 'verified',
        roomEvidence: 'JWT token signing verified',
        repoContext: {
          owner: 'test',
          repo: 'demo',
          branch: 'main',
          inspectedFiles: [],
          detectedTechnologies: ['Node.js'],
        },
      };

      const res = await executeRoomInvestigation(
        req,
        { GEMINI_API_KEY: 'test-key' },
        mockFetch as unknown as typeof fetch
      );

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.errorInfo?.kind, 'timeout');
      assert.strictEqual(res.finding, undefined);
      assert.match(res.error!, /timed out/i);
    });
  });

  describe('6. UI and Presentation Alignment', () => {
    it('provides truthful fallback when Gemini returns insufficient quota information', () => {
      const classified = classifyGeminiError(429, 'Too Many Requests', null);

      assert.strictEqual(classified.kind, 'rate_limit_short');
      assert.strictEqual(classified.retryAfterSeconds, undefined);
      assert.strictEqual(classified.retryable, true);
      assert.strictEqual(classified.title, 'AI is taking a short break');
    });

    it('classifies network failures with honest guidance', () => {
      const networkError = new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:443');
      const classified = classifyNetworkError(networkError);

      assert.strictEqual(classified.kind, 'network_error');
      assert.strictEqual(classified.retryable, true);
      assert.match(classified.message, /check your internet connection/i);
    });
  });

  describe('7. Pro Plan Messaging & Workflow Usability', () => {
    it('ensures Pro plan message is strictly informational without fake purchase or quota claims', () => {
      const noticeSrc = fs.readFileSync(
        path.resolve(__dirname, '../src/components/AiUsageLimitNotice.tsx'),
        'utf-8'
      );

      assert.ok(
        noticeSrc.includes('Pro plan coming soon'),
        'Must display "Pro plan coming soon" label'
      );
      assert.ok(
        noticeSrc.includes('Designed for people who need higher AI usage limits.'),
        'Must include exact honest copy'
      );

      // Verify no fake upgrade, purchase, checkout or cart functionality exists
      assert.ok(!noticeSrc.includes('checkout'), 'Must not contain checkout functionality');
      assert.ok(!noticeSrc.includes('stripe'), 'Must not contain payment processing');
      assert.ok(!/\$\s*\d+/.test(noticeSrc), 'Must not claim unverified pricing');
      assert.ok(!noticeSrc.includes('/month'), 'Must not claim unverified recurring pricing');
    });

    it('prevents duplicate submissions and concurrent retries while requests are in flight', () => {
      const chatPanelSrc = fs.readFileSync(
        path.resolve(__dirname, '../src/components/ChatPanel.tsx'),
        'utf-8'
      );
      const roomInspectorSrc = fs.readFileSync(
        path.resolve(__dirname, '../src/components/RoomInspector.tsx'),
        'utf-8'
      );

      // ChatPanel must guard with isSendingRef and isLoading
      assert.ok(
        chatPanelSrc.includes('isSendingRef.current'),
        'ChatPanel must check isSendingRef to guard concurrent sends'
      );
      assert.ok(
        chatPanelSrc.includes('disabled={isLoading'),
        'ChatPanel must disable submit/retry during loading'
      );

      // RoomInspector must guard with isInvestigatingRef and isInvestigating
      assert.ok(
        roomInspectorSrc.includes('isInvestigatingRef.current'),
        'RoomInspector must check isInvestigatingRef to guard concurrent requests'
      );
      assert.ok(
        roomInspectorSrc.includes('disabled={isInvestigating'),
        'RoomInspector must disable retry button while investigating'
      );
    });

    it('preserves chat history and existing findings when AI is rate limited', () => {
      const chatPanelSrc = fs.readFileSync(
        path.resolve(__dirname, '../src/components/ChatPanel.tsx'),
        'utf-8'
      );
      const roomInspectorSrc = fs.readFileSync(
        path.resolve(__dirname, '../src/components/RoomInspector.tsx'),
        'utf-8'
      );

      // ChatPanel appends user message before calling API and does not wipe messages on failure
      assert.ok(
        chatPanelSrc.includes('newMessages = [...messages, userMessageItem]'),
        'ChatPanel preserves user message in messages stream'
      );
      // In catch or error response, setMessages is NOT called with empty array
      const chatCatchIdx = chatPanelSrc.indexOf('catch (err: unknown)');
      const chatCatchBlock = chatPanelSrc.slice(chatCatchIdx, chatCatchIdx + 400);
      assert.ok(
        !chatCatchBlock.includes('setMessages([])'),
        'ChatPanel does not clear messages on catch'
      );

      // RoomInspector preserves existing finding on error
      const inspectorCatchIdx = roomInspectorSrc.indexOf('catch (err: unknown)');
      const inspectorCatchBlock = roomInspectorSrc.slice(inspectorCatchIdx, inspectorCatchIdx + 400);
      assert.ok(
        !inspectorCatchBlock.includes('setFinding(null)'),
        'RoomInspector preserves existing finding on catch'
      );
    });

    it('offers local exploration actions without relying on AI inference', () => {
      const noticeSrc = fs.readFileSync(
        path.resolve(__dirname, '../src/components/AiUsageLimitNotice.tsx'),
        'utf-8'
      );

      assert.ok(
        noticeSrc.includes('btn-local-explore'),
        'Notice provides local exploration actions'
      );
      assert.ok(
        noticeSrc.includes('Explore {selectedRoomName'),
        'Offers explore room action'
      );
      assert.ok(
        noticeSrc.includes('View existing evidence'),
        'Offers view existing evidence action'
      );
    });
  });
});

