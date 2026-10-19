import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { executeAiChat } from '../src/server/aiProvider.ts';
import { executeRoomInvestigation } from '../src/server/investigationProvider.ts';
import {
  getProviderConfigs,
  DEFAULT_GROQ_MODEL,
  DEFAULT_CLOUDFLARE_MODEL,
  isValidModelIdentifier,
} from '../src/server/aiProviderRunner.ts';
import { redactSensitiveInfo } from '../src/server/errorClassifier.ts';
import { clearResponseCache } from '../src/server/responseCache.ts';
import type { ChatApiRequest } from '../src/server/types.ts';
import type { InvestigateApiRequest } from '../src/domain/investigation/types.ts';

describe('T21 — Groq Automatic AI Fallback & Recovery', () => {
  beforeEach(() => {
    clearResponseCache();
  });
  const baseChatRequest: ChatApiRequest = {
    message: 'Explain how task creation works and whether titles are validated.',
    repoContext: {
      owner: 'sakshamgupta005',
      repo: 'patchboard-tasks-api',
      branch: 'main',
      commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
      totalFiles: 18,
      inspectedFiles: [
        {
          path: 'src/tasks/validation.js',
          category: 'source',
          contentExcerpt: 'function validateTaskTitle(title) { if (title.length === 0) return false; return true; }',
        },
        {
          path: 'test/createTask.test.js',
          category: 'test',
          contentExcerpt: 'it("rejects whitespace-only title", () => { ... });',
        },
      ],
      discoveredFilePaths: ['src/tasks/validation.js', 'test/createTask.test.js'],
      detectedTechnologies: ['JavaScript', 'Node.js', 'Express'],
      roomSummaries: [
        {
          id: 'room-validation',
          name: 'Input Validation & Schema',
          status: 'blocked',
          evidence: 'Test failure in test/createTask.test.js',
        },
      ],
    },
  };

  const baseInvestigateRequest: InvestigateApiRequest = {
    roomId: 'room-validation',
    roomName: 'Input Validation & Schema',
    roomLayer: 'domain',
    roomStatus: 'blocked',
    roomEvidence: 'Test failure in test/createTask.test.js',
    roomFilePaths: ['src/tasks/validation.js'],
    repoContext: {
      owner: 'sakshamgupta005',
      repo: 'patchboard-tasks-api',
      branch: 'main',
      commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
      inspectedFiles: [
        {
          path: 'src/tasks/validation.js',
          category: 'source',
          contentExcerpt: 'function validateTaskTitle(title) { if (title.length === 0) return false; return true; }',
        },
        {
          path: 'test/createTask.test.js',
          category: 'test',
          contentExcerpt: 'it("rejects whitespace-only title", () => { ... });',
        },
      ],
      discoveredFilePaths: ['src/tasks/validation.js', 'test/createTask.test.js'],
      detectedTechnologies: ['JavaScript', 'Node.js'],
      ciEvaluation: {
        status: 'failing',
        isVerified: false,
        reason: 'CI check failed',
        checkRunsCount: 1,
        failedChecks: ['Run Unit and Integration Tests'],
      },
    },
  };

  // Scenario 1: Gemini success without contacting Groq
  it('1. Gemini success without contacting Groq', async () => {
    let geminiCalled = 0;
    let groqCalled = 0;

    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('googleapis.com')) {
        geminiCalled++;
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        replies: [
                          {
                            speaker: 'dog',
                            text: 'Barkley here! Validation handles title checks.',
                            evidenceReference: 'src/tasks/validation.js',
                          },
                        ],
                      }),
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { totalTokenCount: 150 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('api.groq.com')) {
        groqCalled++;
        return new Response('{}', { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const res = await executeAiChat(
      baseChatRequest,
      {
        GEMINI_API_KEY: 'test-gemini-key',
        GROQ_API_KEY: 'test-groq-key',
      },
      mockFetch as unknown as typeof fetch
    );

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.provider, 'gemini');
    assert.strictEqual(res.fallbackUsed, false);
    assert.strictEqual(geminiCalled, 1, 'Gemini should be called exactly once');
    assert.strictEqual(groqCalled, 0, 'Groq should NEVER be contacted when Gemini succeeds');
    assert.strictEqual(res.replies?.[0]?.speaker, 'dog');
  });

  // Scenario 2: Gemini daily quota exhaustion → Groq success
  it('2. Gemini daily quota exhaustion immediately attempts Groq without retrying Gemini', async () => {
    let geminiCalled = 0;
    let groqCalled = 0;

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes('googleapis.com')) {
        geminiCalled++;
        // 429 Daily Quota Exceeded
        return new Response(
          JSON.stringify({
            error: {
              code: 429,
              message: "Quota exceeded for quota metric 'Requests' and limit 'Requests per day' of service 'generativelanguage.googleapis.com'",
              status: 'RESOURCE_EXHAUSTED',
            },
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('api.groq.com')) {
        groqCalled++;
        const parsedBody = JSON.parse(init?.body as string);
        assert.strictEqual(parsedBody.model, 'qwen/qwen3.8-27b');
        assert.strictEqual(parsedBody.response_format.type, 'json_object');
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    replies: [
                      {
                        speaker: 'dog',
                        text: 'Barkley here via Groq backup! The code verifies title length.',
                      },
                      {
                        speaker: 'cat',
                        text: 'Cleo noting: whitespace-only strings are not trimmed.',
                      },
                    ],
                  }),
                },
                finish_reason: 'stop',
              },
            ],
            usage: { total_tokens: 180 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const res = await executeAiChat(
      baseChatRequest,
      {
        GEMINI_API_KEY: 'gemini-secret-1234',
        GROQ_API_KEY: 'gsk_groq_secret_5678',
      },
      mockFetch as unknown as typeof fetch
    );

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.provider, 'groq');
    assert.strictEqual(res.fallbackUsed, true);
    assert.strictEqual(res.timing?.provider, 'groq');
    assert.strictEqual(res.timing?.fallbackUsed, true);
    assert.strictEqual(geminiCalled, 1, 'Gemini daily quota exhaustion must NOT be retried');
    assert.strictEqual(groqCalled, 1, 'Groq must be attempted once');
    assert.strictEqual(res.replies?.length, 2);
  });

  // Scenario 3: Gemini timeout or server error → Groq success
  it('3. Gemini timeout or 503 service error falls back to Groq successfully', async () => {
    let geminiCalled = 0;
    let groqCalled = 0;

    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('googleapis.com')) {
        geminiCalled++;
        // 503 Service Unavailable
        return new Response(
          JSON.stringify({
            error: {
              code: 503,
              message: 'The model is overloaded. Please try again later.',
              status: 'UNAVAILABLE',
            },
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('api.groq.com')) {
        groqCalled++;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: 'Title whitespace validation bypass',
                    explanation: 'The validateTaskTitle function checks raw length without trimming whitespace.',
                    category: 'possible_bug',
                    severity: 'medium',
                    evidenceClassification: 'observed',
                    evidencePaths: ['src/tasks/validation.js'],
                    codeEvidence: {
                      filePath: 'src/tasks/validation.js',
                      targetIdentifier: 'validateTaskTitle',
                      codeSnippet: 'if (title.length === 0) return false;',
                      explanation: 'Checks raw string length without trimming whitespace.',
                    },
                    recommendedNextStep: 'Trim title before checking length.',
                    uncertainties: 'None for validation unit.',
                    companionMessages: [
                      { speaker: 'dog', text: 'Barkley spotted the issue in validation.js!' },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const res = await executeRoomInvestigation(
      baseInvestigateRequest,
      {
        GEMINI_API_KEY: 'test-gemini-key',
        GROQ_API_KEY: 'test-groq-key',
      },
      mockFetch as unknown as typeof fetch
    );

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.provider, 'groq');
    assert.strictEqual(res.finding?.provider, 'groq');
    assert.strictEqual(res.finding?.fallbackUsed, true);
    assert.strictEqual(res.finding?.category, 'possible_bug');
    assert.strictEqual(res.finding?.evidenceClassification, 'observed');
    assert.strictEqual(res.finding?.codeEvidence?.targetIdentifier, 'validateTaskTitle');
    assert.strictEqual(geminiCalled, 1);
    assert.strictEqual(groqCalled, 1);
  });

  // Scenario 4: Gemini key/configuration failure → Groq success
  it('4. Gemini key/configuration failure immediately uses Groq fallback', async () => {
    let groqCalled = 0;

    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('api.groq.com')) {
        groqCalled++;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    replies: [{ speaker: 'dog', text: 'Groq answered directly!' }],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    };

    // No GEMINI_API_KEY, but valid GROQ_API_KEY
    const res = await executeAiChat(
      baseChatRequest,
      {
        GROQ_API_KEY: 'gsk_valid_groq_key_123',
      },
      mockFetch as unknown as typeof fetch
    );

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.provider, 'groq');
    assert.strictEqual(res.fallbackUsed, true);
    assert.strictEqual(groqCalled, 1);
  });

  // Scenario 5: Groq key missing or Groq failure returns safe structured error
  it('5. Groq key missing returns Gemini error; Groq failure returns safe errorInfo', async () => {
    // 5a. Groq key missing: returns Gemini's original error
    const mockGeminiFail = async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: 'Resource exhausted',
            status: 'RESOURCE_EXHAUSTED',
          },
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const resNoGroq = await executeAiChat(
      baseChatRequest,
      {
        GEMINI_API_KEY: 'test-gemini-key',
        // GROQ_API_KEY omitted
      },
      mockGeminiFail as unknown as typeof fetch
    );

    assert.strictEqual(resNoGroq.success, false);
    assert.strictEqual(resNoGroq.code, 'RATE_LIMITED');
    assert.ok(resNoGroq.errorInfo);

    // 5b. Groq also fails (both fail): returns structured error without crashing
    const mockBothFail = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('googleapis.com')) {
        return new Response(
          JSON.stringify({
            error: { code: 429, message: 'Gemini rate limited' },
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('api.groq.com')) {
        return new Response(
          JSON.stringify({
            error: { code: 'rate_limit_exceeded', message: 'Groq rate limit reached' },
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const resBothFail = await executeAiChat(
      baseChatRequest,
      {
        GEMINI_API_KEY: 'test-gemini-key',
        GROQ_API_KEY: 'test-groq-key',
      },
      mockBothFail as unknown as typeof fetch
    );

    assert.strictEqual(resBothFail.success, false);
    assert.strictEqual(resBothFail.code, 'RATE_LIMITED');
    assert.ok(resBothFail.errorInfo);
    assert.strictEqual(resBothFail.errorInfo?.retryable, true);
  });

  // Scenario 6: Malformed or fabricated evidence from Groq being rejected
  it('6. Malformed or fabricated evidence from Groq is rejected by application validators', async () => {
    const mockFetchFabricatedGroq = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('googleapis.com')) {
        return new Response('Quota exceeded', { status: 429 });
      }
      if (urlStr.includes('api.groq.com')) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: 'Fabricated finding from Groq',
                    explanation: 'Groq invented non-existent files and functions.',
                    category: 'security_risk',
                    severity: 'high',
                    evidenceClassification: 'observed', // Groq claims observed
                    evidencePaths: [
                      'src/tasks/validation.js', // Real
                      'src/secret/fake_auth.js', // Hallucinated fake file
                      'nonexistent/passwords.txt', // Hallucinated fake file
                    ],
                    codeEvidence: {
                      filePath: 'src/tasks/validation.js',
                      targetIdentifier: 'hallucinatedMethodNameNotInData', // Fake identifier
                      codeSnippet: 'this code was completely invented by LLM', // Fake excerpt
                      explanation: 'Fabricated proof',
                    },
                    recommendedNextStep: 'Check auth.',
                    uncertainties: 'None.',
                    companionMessages: [{ speaker: 'dog', text: 'Watch out!' }],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const res = await executeRoomInvestigation(
      baseInvestigateRequest,
      {
        GEMINI_API_KEY: 'test-gemini-key',
        GROQ_API_KEY: 'test-groq-key',
      },
      mockFetchFabricatedGroq as unknown as typeof fetch
    );

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.provider, 'groq');
    const finding = res.finding!;

    // 1. Fabricated files must be stripped from verified evidencePaths and added to rejectedReferences
    assert.ok(finding.rejectedReferences?.includes('src/secret/fake_auth.js'));
    assert.ok(finding.rejectedReferences?.includes('nonexistent/passwords.txt'));
    assert.strictEqual(finding.evidenceReferences.length, 1);
    assert.strictEqual(finding.evidenceReferences[0].path, 'src/tasks/validation.js');

    // 2. Fabricated code snippet and identifier must NOT be accepted as verified evidence
    assert.ok(!finding.codeEvidence || finding.codeEvidence.isVerified === false);

    // 3. Fake 'observed' claim must be demoted to 'inferred'
    assert.notStrictEqual(finding.evidenceClassification, 'observed');
  });

  // Scenario 7: No duplicate submissions, unbounded retries, or leaked credentials
  it('7. No duplicate submissions, bounded retries, and zero leaked credentials', async () => {
    const geminiSecretKey = 'AIzaSySecretGeminiToken123456';
    const groqSecretKey = 'gsk_very_secret_groq_token_abcdef123456';

    let geminiCalls = 0;
    let groqCalls = 0;

    const mockFetchKeyLeaking = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('googleapis.com')) {
        geminiCalls++;
        return new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: `API key not valid: key=${geminiSecretKey}. Please pass a valid key.`,
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('api.groq.com')) {
        groqCalls++;
        return new Response(
          JSON.stringify({
            error: {
              code: 'invalid_api_key',
              message: `Invalid API key provided: Bearer ${groqSecretKey}`,
            },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const res = await executeAiChat(
      baseChatRequest,
      {
        GEMINI_API_KEY: geminiSecretKey,
        GROQ_API_KEY: groqSecretKey,
      },
      mockFetchKeyLeaking as unknown as typeof fetch
    );

    // Exactly 1 call to Gemini, 1 call to Groq (no infinite loops or retry storms)
    assert.strictEqual(geminiCalls, 1, 'Gemini must be called at most once on non-transient error');
    assert.strictEqual(groqCalls, 1, 'Groq must be attempted at most once as fallback');

    // Check zero leaks in error message, detailSafe, and serialized JSON
    const serialized = JSON.stringify(res);
    assert.strictEqual(
      serialized.includes(geminiSecretKey),
      false,
      'Gemini API key MUST NOT appear anywhere in serialized response'
    );
    assert.strictEqual(
      serialized.includes(groqSecretKey),
      false,
      'Groq API key MUST NOT appear anywhere in serialized response'
    );

    // Verify redactSensitiveInfo redacts both key patterns
    const rawLeak = `Bearer ${groqSecretKey} and key=${geminiSecretKey} and GROQ_API_KEY=${groqSecretKey}`;
    const cleaned = redactSensitiveInfo(rawLeak, [geminiSecretKey, groqSecretKey]);
    assert.strictEqual(cleaned.includes(geminiSecretKey), false);
    assert.strictEqual(cleaned.includes(groqSecretKey), false);
    assert.ok(cleaned.includes('[REDACTED]'), 'Secret should be explicitly redacted');
  });

  // Model configuration
  it('8. Supports configurable GROQ_MODEL environment variable and namespaced identifiers', () => {
    assert.strictEqual(DEFAULT_GROQ_MODEL, 'qwen/qwen3.8-27b');

    // Missing GROQ_MODEL defaults to qwen/qwen3.8-27b
    const configDefault = getProviderConfigs({});
    assert.strictEqual(configDefault.groq.model, 'qwen/qwen3.8-27b');

    // Explicit GROQ_MODEL overrides default
    const configCustom = getProviderConfigs({
      GROQ_MODEL: 'custom/model-id-99b',
    });
    assert.strictEqual(configCustom.groq.model, 'custom/model-id-99b');

    // Model identifier validator accepts namespaced IDs containing / and standard characters
    assert.strictEqual(isValidModelIdentifier('qwen/qwen3.8-27b'), true);
    assert.strictEqual(isValidModelIdentifier('meta-llama/llama-4-scout'), true);
    assert.strictEqual(isValidModelIdentifier('gemini-3.8-flash'), true);
    assert.strictEqual(isValidModelIdentifier('gpt-4o_mini.v1'), true);
    assert.strictEqual(isValidModelIdentifier(''), false);
    assert.strictEqual(isValidModelIdentifier('model with spaces'), false);
    assert.strictEqual(isValidModelIdentifier('@cf/meta/llama-3.3-70b-instruct-fp8-fast'), true);
    assert.strictEqual(isValidModelIdentifier('@cf/qwen/qwen2.5-72b-instruct'), true);
  });

  // T21.2: Scenario 9 — Tertiary fallback to Cloudflare Workers AI after Gemini & Groq retryable errors
  it('9. Gemini 429 and Groq 503 retryable failures trigger Cloudflare Workers AI success', async () => {
    let geminiCalled = 0;
    let groqCalled = 0;
    let cloudflareCalled = 0;
    let capturedCfUrl = '';
    let capturedCfAuth = '';

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes('googleapis.com')) {
        geminiCalled++;
        return new Response(JSON.stringify({ error: { code: 429, message: 'Gemini rate limited' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.includes('api.groq.com')) {
        groqCalled++;
        return new Response(JSON.stringify({ error: { message: 'Groq service overloaded' } }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.includes('api.cloudflare.com')) {
        cloudflareCalled++;
        capturedCfUrl = urlStr;
        const headers = init?.headers as Record<string, string>;
        capturedCfAuth = headers?.Authorization || '';
        return new Response(
          JSON.stringify({
            result: {
              response: JSON.stringify({
                replies: [
                  {
                    speaker: 'dog',
                    text: 'Barkley here via Cloudflare Workers AI! Validation is in src/tasks/validation.js.',
                    evidenceReference: 'src/tasks/validation.js',
                  },
                ],
              }),
            },
            success: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const res = await executeAiChat(
      baseChatRequest,
      {
        GEMINI_API_KEY: 'gemini-key-1',
        GROQ_API_KEY: 'groq-key-2',
        CLOUDFLARE_ACCOUNT_ID: 'cf-acc-12345',
        CLOUDFLARE_API_TOKEN: 'cf-tok-67890',
      },
      mockFetch as unknown as typeof fetch
    );

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.provider, 'cloudflare');
    assert.strictEqual(res.providerUsed, 'cloudflare');
    assert.strictEqual(res.fallbackUsed, true);
    assert.strictEqual(res.timing?.provider, 'cloudflare');
    assert.strictEqual(res.timing?.fallbackUsed, true);
    assert.strictEqual(geminiCalled, 1, 'Gemini attempted first');
    assert.strictEqual(groqCalled, 1, 'Groq attempted second');
    assert.strictEqual(cloudflareCalled, 1, 'Cloudflare attempted third');
    assert.strictEqual(
      capturedCfUrl,
      'https://api.cloudflare.com/client/v4/accounts/cf-acc-12345/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast'
    );
    assert.strictEqual(capturedCfAuth, 'Bearer cf-tok-67890');
    assert.strictEqual(res.replies?.[0]?.speaker, 'dog');
  });

  // T21.2: Scenario 10 — Provider order: Gemini success skips Groq and Cloudflare; Groq success skips Cloudflare
  it('10. Gemini success skips Groq and Cloudflare; Groq success skips Cloudflare', async () => {
    let geminiCalls = 0;
    let groqCalls = 0;
    let cfCalls = 0;

    const mockFetchGeminiOk = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('googleapis.com')) {
        geminiCalls++;
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ replies: [{ speaker: 'dog', text: 'Gemini handled it.' }] }) }],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (urlStr.includes('api.groq.com')) groqCalls++;
      if (urlStr.includes('api.cloudflare.com')) cfCalls++;
      return new Response('Not found', { status: 404 });
    };

    const res1 = await executeAiChat(
      baseChatRequest,
      {
        GEMINI_API_KEY: 'gemini-key',
        GROQ_API_KEY: 'groq-key',
        CLOUDFLARE_ACCOUNT_ID: 'cf-acc',
        CLOUDFLARE_API_TOKEN: 'cf-tok',
      },
      mockFetchGeminiOk as unknown as typeof fetch
    );

    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.provider, 'gemini');
    assert.strictEqual(geminiCalls, 1);
    assert.strictEqual(groqCalls, 0, 'Groq must NOT be called when Gemini succeeds');
    assert.strictEqual(cfCalls, 0, 'Cloudflare must NOT be called when Gemini succeeds');

    // Now test Groq success skips Cloudflare
    let groqCalls2 = 0;
    let cfCalls2 = 0;
    const mockFetchGroqOk = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('googleapis.com')) {
        return new Response('Gemini 429', { status: 429 });
      }
      if (urlStr.includes('api.groq.com')) {
        groqCalls2++;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ replies: [{ speaker: 'dog', text: 'Groq handled it.' }] }) } }],
          }),
          { status: 200 }
        );
      }
      if (urlStr.includes('api.cloudflare.com')) cfCalls2++;
      return new Response('Not found', { status: 404 });
    };

    clearResponseCache();
    const res2 = await executeAiChat(
      baseChatRequest,
      {
        GEMINI_API_KEY: 'gemini-key',
        GROQ_API_KEY: 'groq-key',
        CLOUDFLARE_ACCOUNT_ID: 'cf-acc',
        CLOUDFLARE_API_TOKEN: 'cf-tok',
      },
      mockFetchGroqOk as unknown as typeof fetch
    );

    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.provider, 'groq');
    assert.strictEqual(groqCalls2, 1);
    assert.strictEqual(cfCalls2, 0, 'Cloudflare must NOT be called when Groq succeeds');
  });

  // T21.2: Scenario 11 — Skipped unconfigured providers
  it('11. Unconfigured providers are skipped; Cloudflare answers directly when Gemini & Groq are omitted', async () => {
    let cfCalled = 0;

    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('api.cloudflare.com')) {
        cfCalled++;
        return new Response(
          JSON.stringify({
            result: {
              response: JSON.stringify({
                replies: [{ speaker: 'dog', text: 'Direct response from Cloudflare!' }],
              }),
            },
            success: true,
          }),
          { status: 200 }
        );
      }
      return new Response('Not found', { status: 404 });
    };

    // Only Cloudflare configured
    const res = await executeAiChat(
      baseChatRequest,
      {
        CLOUDFLARE_ACCOUNT_ID: 'cf-acc-direct',
        CLOUDFLARE_API_TOKEN: 'cf-tok-direct',
      },
      mockFetch as unknown as typeof fetch
    );

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.provider, 'cloudflare');
    assert.strictEqual(res.fallbackUsed, true);
    assert.strictEqual(cfCalled, 1);
  });

  // T21.2: Scenario 12 — Cloudflare NOT attempted when previous failure is a non-retryable provider error
  it('12. Non-retryable error (e.g. 400 Bad Request or 401 Unauthorized) stops fallback and does NOT contact Cloudflare', async () => {
    let geminiCalls = 0;
    let groqCalls = 0;
    let cfCalls = 0;

    // 12a. Gemini 400 Bad Request (not retryable) -> does NOT attempt Cloudflare
    const mockFetch400 = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('googleapis.com')) {
        geminiCalls++;
        return new Response(JSON.stringify({ error: { code: 400, message: 'Invalid payload argument' } }), {
          status: 400,
        });
      }
      if (urlStr.includes('api.groq.com')) {
        groqCalls++;
        return new Response(JSON.stringify({ error: { message: 'Groq 500 error' } }), { status: 500 });
      }
      if (urlStr.includes('api.cloudflare.com')) {
        cfCalls++;
        return new Response('{}', { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const res = await executeAiChat(
      baseChatRequest,
      {
        GEMINI_API_KEY: 'gemini-key',
        GROQ_API_KEY: 'groq-key',
        CLOUDFLARE_ACCOUNT_ID: 'cf-acc',
        CLOUDFLARE_API_TOKEN: 'cf-tok',
      },
      mockFetch400 as unknown as typeof fetch
    );

    assert.strictEqual(res.success, false);
    assert.strictEqual(cfCalls, 0, 'Cloudflare must NOT be attempted when Gemini failed with non-retryable 400');

    // 12b. Gemini 429 (retryable) but Groq 401 Unauthorized (non-retryable) -> does NOT attempt Cloudflare
    let cfCalls2 = 0;
    const mockFetchGroq401 = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('googleapis.com')) {
        return new Response(JSON.stringify({ error: { code: 429, message: 'Gemini rate limit' } }), { status: 429 });
      }
      if (urlStr.includes('api.groq.com')) {
        return new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 });
      }
      if (urlStr.includes('api.cloudflare.com')) {
        cfCalls2++;
        return new Response('{}', { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const res2 = await executeAiChat(
      baseChatRequest,
      {
        GEMINI_API_KEY: 'gemini-key',
        GROQ_API_KEY: 'groq-key',
        CLOUDFLARE_ACCOUNT_ID: 'cf-acc',
        CLOUDFLARE_API_TOKEN: 'cf-tok',
      },
      mockFetchGroq401 as unknown as typeof fetch
    );

    assert.strictEqual(res2.success, false);
    assert.strictEqual(cfCalls2, 0, 'Cloudflare must NOT be attempted when Groq failed with non-retryable 401');
  });

  // T21.2: Scenario 13 — Cloudflare Workers AI structured investigation & strict evidence validation
  it('13. Malformed or fabricated evidence from Cloudflare is rejected by application validators', async () => {
    const mockFetchFabricatedCloudflare = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('googleapis.com')) {
        return new Response('Gemini 429', { status: 429 });
      }
      if (urlStr.includes('api.groq.com')) {
        return new Response('Groq 429', { status: 429 });
      }
      if (urlStr.includes('api.cloudflare.com')) {
        return new Response(
          JSON.stringify({
            result: {
              response: JSON.stringify({
                title: 'Hallucinated Cloudflare Finding',
                explanation: 'Cloudflare invented nonexistent files and functions.',
                category: 'security_risk',
                severity: 'high',
                evidenceClassification: 'observed', // Cloudflare model claims observed
                evidencePaths: [
                  'src/tasks/validation.js', // Real
                  'fake/uninspected_passwords.txt', // Fake
                ],
                codeEvidence: {
                  filePath: 'src/tasks/validation.js',
                  targetIdentifier: 'hallucinatedMethodNotExisting', // Fake
                  codeSnippet: 'this code was completely hallucinated', // Fake
                  explanation: 'Fabricated snippet',
                },
                recommendedNextStep: 'Check credentials.',
                uncertainties: 'None.',
                companionMessages: [{ speaker: 'dog', text: 'Careful with validation!' }],
              }),
            },
            success: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const res = await executeRoomInvestigation(
      baseInvestigateRequest,
      {
        GEMINI_API_KEY: 'gemini-key',
        GROQ_API_KEY: 'groq-key',
        CLOUDFLARE_ACCOUNT_ID: 'cf-acc',
        CLOUDFLARE_API_TOKEN: 'cf-tok',
      },
      mockFetchFabricatedCloudflare as unknown as typeof fetch
    );

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.provider, 'cloudflare');
    assert.strictEqual(res.finding?.provider, 'cloudflare');
    assert.strictEqual(res.finding?.fallbackUsed, true);

    const finding = res.finding!;
    // Fabricated file rejected
    assert.ok(finding.rejectedReferences?.includes('fake/uninspected_passwords.txt'));
    assert.strictEqual(finding.evidenceReferences.length, 1);
    assert.strictEqual(finding.evidenceReferences[0].path, 'src/tasks/validation.js');

    // Fabricated code snippet not verified
    assert.ok(!finding.codeEvidence || finding.codeEvidence.isVerified === false);

    // Unsupported 'observed' claim demoted
    assert.notStrictEqual(finding.evidenceClassification, 'observed');
  });

  // T21.2: Scenario 14 — All three providers fail returns structured error without crashing
  it('14. All three providers failing returns safe structured error with retryable info', async () => {
    const mockAllFail = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('googleapis.com')) {
        return new Response(JSON.stringify({ error: { code: 429, message: 'Gemini rate limited' } }), {
          status: 429,
        });
      }
      if (urlStr.includes('api.groq.com')) {
        return new Response(JSON.stringify({ error: { message: 'Groq rate limited' } }), { status: 429 });
      }
      if (urlStr.includes('api.cloudflare.com')) {
        return new Response(
          JSON.stringify({ errors: [{ code: 10014, message: 'Workers AI rate limit reached' }] }),
          { status: 429 }
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const res = await executeAiChat(
      baseChatRequest,
      {
        GEMINI_API_KEY: 'gemini-key',
        GROQ_API_KEY: 'groq-key',
        CLOUDFLARE_ACCOUNT_ID: 'cf-acc',
        CLOUDFLARE_API_TOKEN: 'cf-tok',
      },
      mockAllFail as unknown as typeof fetch
    );

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, 'RATE_LIMITED');
    assert.ok(res.errorInfo);
    assert.strictEqual(res.errorInfo.retryable, true);
    assert.ok(res.error?.includes('All configured AI providers failed'));
  });

  // T21.2: Scenario 15 — Zero credential exposure across all providers including Cloudflare
  it('15. Zero credential exposure: Cloudflare API token, account ID, and headers are redacted', async () => {
    const geminiSecret = 'AIzaSySecretGeminiToken999999';
    const groqSecret = 'gsk_very_secret_groq_token_888888';
    const cfToken = 'cf_secret_token_7777777777777777';
    const cfAccountId = 'cf_account_id_666666';

    const mockLeakyApi = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('googleapis.com')) {
        return new Response(JSON.stringify({ error: { message: `Leak key=${geminiSecret}` } }), { status: 429 });
      }
      if (urlStr.includes('api.groq.com')) {
        return new Response(JSON.stringify({ error: { message: `Leak Bearer ${groqSecret}` } }), { status: 429 });
      }
      if (urlStr.includes('api.cloudflare.com')) {
        return new Response(
          JSON.stringify({
            errors: [
              {
                code: 10000,
                message: `Authentication error on account /accounts/${cfAccountId}/ai/ with token ${cfToken}`,
              },
            ],
          }),
          { status: 401 }
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const res = await executeAiChat(
      baseChatRequest,
      {
        GEMINI_API_KEY: geminiSecret,
        GROQ_API_KEY: groqSecret,
        CLOUDFLARE_ACCOUNT_ID: cfAccountId,
        CLOUDFLARE_API_TOKEN: cfToken,
      },
      mockLeakyApi as unknown as typeof fetch
    );

    const serialized = JSON.stringify(res);
    assert.strictEqual(serialized.includes(geminiSecret), false, 'Gemini key must not leak');
    assert.strictEqual(serialized.includes(groqSecret), false, 'Groq key must not leak');
    assert.strictEqual(serialized.includes(cfToken), false, 'Cloudflare API token must not leak');
    assert.strictEqual(serialized.includes(cfAccountId), false, 'Cloudflare Account ID must not leak');

    // Test redactSensitiveInfo unit directly
    const rawLeak = `Bearer ${cfToken} on /accounts/${cfAccountId}/ai/run with CLOUDFLARE_API_TOKEN=${cfToken}`;
    const cleaned = redactSensitiveInfo(rawLeak, [cfToken, cfAccountId]);
    assert.strictEqual(cleaned.includes(cfToken), false);
    assert.strictEqual(cleaned.includes(cfAccountId), false);
    assert.ok(cleaned.includes('[REDACTED]'));
  });

  // T21.2: Scenario 16 — Cloudflare model configuration and environment defaults
  it('16. Supports configurable CLOUDFLARE_AI_MODEL environment variable and @-prefixed identifiers', () => {
    assert.strictEqual(DEFAULT_CLOUDFLARE_MODEL, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');

    // Default configuration
    const configDefault = getProviderConfigs({});
    assert.strictEqual(configDefault.cloudflare.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    assert.strictEqual(configDefault.cloudflare.isConfigured, false);

    // Custom configuration
    const configCustom = getProviderConfigs({
      CLOUDFLARE_ACCOUNT_ID: 'my-account-123',
      CLOUDFLARE_API_TOKEN: 'my-token-456',
      CLOUDFLARE_AI_MODEL: '@cf/mistral/mistral-7b-instruct-v0.2',
    });
    assert.strictEqual(configCustom.cloudflare.isConfigured, true);
    assert.strictEqual(configCustom.cloudflare.accountId, 'my-account-123');
    assert.strictEqual(configCustom.cloudflare.model, '@cf/mistral/mistral-7b-instruct-v0.2');
  });

  // Scenario 17: Automatic recovery to primary hierarchy after rate limit refill
  it('17. Automatically recovers to primary (Gemini) once rate limit refills, maintaining strict hierarchy', async () => {
    let geminiIsRateLimited = true;
    let geminiAttempts = 0;
    let groqAttempts = 0;
    let cfAttempts = 0;

    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('googleapis.com')) {
        geminiAttempts++;
        if (geminiIsRateLimited) {
          return new Response(
            JSON.stringify({
              error: {
                code: 429,
                message: 'Resource exhausted: rate limit exceeded',
                status: 'RESOURCE_EXHAUSTED',
              },
            }),
            { status: 429, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        replies: [{ speaker: 'dog', text: 'Gemini primary is back online!' }],
                      }),
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('api.groq.com')) {
        groqAttempts++;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    replies: [{ speaker: 'cat', text: 'Groq backup handled request.' }],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('api.cloudflare.com')) {
        cfAttempts++;
        return new Response(
          JSON.stringify({
            result: {
              response: JSON.stringify({
                replies: [{ speaker: 'cat', text: 'Cloudflare tertiary handled request.' }],
              }),
            },
            success: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const env = {
      GEMINI_API_KEY: 'gemini-key',
      GROQ_API_KEY: 'groq-key',
      CLOUDFLARE_ACCOUNT_ID: 'cf-acc',
      CLOUDFLARE_API_TOKEN: 'cf-tok',
    };

    // 1st request: Gemini is rate-limited -> falls back to Groq (secondary)
    const res1 = await executeAiChat(baseChatRequest, env, mockFetch as unknown as typeof fetch);
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.provider, 'groq');
    assert.strictEqual(res1.fallbackUsed, true);
    assert.strictEqual(geminiAttempts, 1);
    assert.strictEqual(groqAttempts, 1);
    assert.strictEqual(cfAttempts, 0);

    // 2nd request: Gemini quota refills (geminiIsRateLimited = false)
    geminiIsRateLimited = false;
    clearResponseCache();
    const res2 = await executeAiChat(baseChatRequest, env, mockFetch as unknown as typeof fetch);

    // Primary (Gemini) must be automatically picked without sticky fallback lock-in
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.provider, 'gemini');
    assert.strictEqual(res2.fallbackUsed, false);
    assert.strictEqual(geminiAttempts, 2, 'Gemini must be attempted first on subsequent request');
    assert.strictEqual(groqAttempts, 1, 'Groq must NOT be called when primary succeeds');
    assert.strictEqual(cfAttempts, 0, 'Cloudflare must NOT be called when primary succeeds');
  });
});

