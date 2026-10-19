import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { executeAiChat } from '../src/server/aiProvider.ts';
import { executeRoomInvestigation } from '../src/server/investigationProvider.ts';
import {
  buildChatCacheKey,
  buildInvestigationCacheKey,
  clearResponseCache,
  getCachedChatResponse,
  getCachedInvestigation,
  getResponseCacheStats,
  invalidateResponseCache,
  CACHE_TTL_MS,
  MAX_CACHE_ENTRIES,
  getCachedRoomExplanation,
  setCachedRoomExplanation,
  clearRoomExplanationCache,
} from '../src/server/responseCache.ts';
import type { ChatApiRequest } from '../src/server/types.ts';
import type { InvestigateApiRequest } from '../src/domain/investigation/types.ts';

describe('S04 — Safe Repeat-Request Caching', () => {
  const baseRepoContext: NonNullable<ChatApiRequest['repoContext']> = {
    owner: 'acme-corp',
    repo: 'task-flow',
    branch: 'main',
    commitSha: 'a1b2c3d4e5f67890abcdef1234567890abcdef12',
    totalFiles: 14,
    detectedTechnologies: ['TypeScript', 'Express'],
    roomSummaries: [
      {
        id: 'room-auth',
        name: 'Authentication Layer',
        layer: 'security',
        status: 'implemented',
        evidence: 'JWT verification in src/auth.ts',
        filePaths: ['src/auth.ts'],
      },
      {
        id: 'room-tasks',
        name: 'Tasks API Layer',
        layer: 'domain',
        status: 'implemented',
        evidence: 'Task CRUD operations in src/tasks.ts',
        filePaths: ['src/tasks.ts'],
      },
    ],
    inspectedFiles: [
      {
        path: 'src/auth.ts',
        category: 'source',
        contentExcerpt: 'export function verifyToken(t: string) { return Boolean(t); }',
        sizeBytes: 60,
      },
      {
        path: 'src/tasks.ts',
        category: 'source',
        contentExcerpt: 'export function getTasks() { return [{ id: 1, title: "Do work" }]; }',
        sizeBytes: 70,
      },
    ],
    discoveredFilePaths: ['src/auth.ts', 'src/tasks.ts', 'package.json'],
  };

  const mockValidChatEnv = {
    GEMINI_API_KEY: 'test-key',
    AI_PROVIDER: 'gemini',
  };

  beforeEach(() => {
    clearResponseCache();
    clearRoomExplanationCache();
  });

  describe('1. Cache Key Isolation & Determinism', () => {
    it('generates identical keys for identical repeatable requests', () => {
      const req1: ChatApiRequest = {
        message: 'What happens when a user sends a request?',
        explanationLevel: 'intermediate',
        selectedRoomId: 'room-auth',
        repoContext: baseRepoContext,
      };
      const req2: ChatApiRequest = {
        message: '   what happens when a user sends a request?   ',
        explanationLevel: 'intermediate',
        selectedRoomId: 'room-auth',
        repoContext: baseRepoContext,
      };

      const key1 = buildChatCacheKey(req1);
      const key2 = buildChatCacheKey(req2);

      assert.ok(key1 !== null);
      assert.strictEqual(key1, key2, 'Normalized message must yield identical cache key');
    });

    it('isolates cache keys across different commit SHAs (no stale answers on commit switch)', () => {
      const reqCommit1: ChatApiRequest = {
        message: 'Explain authentication flow',
        selectedRoomId: 'room-auth',
        repoContext: baseRepoContext,
      };
      const reqCommit2: ChatApiRequest = {
        message: 'Explain authentication flow',
        selectedRoomId: 'room-auth',
        repoContext: {
          ...baseRepoContext,
          commitSha: 'ffffffffffffffffffffffffffffffffffffffff',
        },
      };

      const key1 = buildChatCacheKey(reqCommit1);
      const key2 = buildChatCacheKey(reqCommit2);

      assert.ok(key1 !== null && key2 !== null);
      assert.notStrictEqual(key1, key2, 'Different commit SHAs must produce distinct cache keys');
    });

    it('isolates cache keys across different repositories (no data leaks across projects)', () => {
      const reqRepo1: ChatApiRequest = {
        message: 'Explain authentication flow',
        repoContext: baseRepoContext,
      };
      const reqRepo2: ChatApiRequest = {
        message: 'Explain authentication flow',
        repoContext: {
          ...baseRepoContext,
          owner: 'other-org',
          repo: 'secret-service',
        },
      };

      const key1 = buildChatCacheKey(reqRepo1);
      const key2 = buildChatCacheKey(reqRepo2);

      assert.ok(key1 !== null && key2 !== null);
      assert.notStrictEqual(key1, key2, 'Different repositories must never share cache keys');
    });

    it('isolates cache keys across different rooms', () => {
      const reqRoom1: ChatApiRequest = {
        message: 'Explain functions step by step',
        selectedRoomId: 'room-auth',
        repoContext: baseRepoContext,
      };
      const reqRoom2: ChatApiRequest = {
        message: 'Explain functions step by step',
        selectedRoomId: 'room-tasks',
        repoContext: baseRepoContext,
      };

      const key1 = buildChatCacheKey(reqRoom1);
      const key2 = buildChatCacheKey(reqRoom2);

      assert.ok(key1 !== null && key2 !== null);
      assert.notStrictEqual(key1, key2, 'Different rooms must have distinct keys');
    });

    it('isolates cache keys across explanation levels and diagram intent', () => {
      const reqBeginner: ChatApiRequest = {
        message: 'Explain this project',
        explanationLevel: 'beginner',
        repoContext: baseRepoContext,
      };
      const reqAdvanced: ChatApiRequest = {
        message: 'Explain this project',
        explanationLevel: 'advanced',
        repoContext: baseRepoContext,
      };
      const reqDiagram: ChatApiRequest = {
        message: 'Explain this project',
        explanationLevel: 'beginner',
        includeDiagram: true,
        repoContext: baseRepoContext,
      };

      const keyBeginner = buildChatCacheKey(reqBeginner);
      const keyAdvanced = buildChatCacheKey(reqAdvanced);
      const keyDiagram = buildChatCacheKey(reqDiagram);

      assert.notStrictEqual(keyBeginner, keyAdvanced);
      assert.notStrictEqual(keyBeginner, keyDiagram);
    });

    it('does not cache general conversational chat with multi-turn history', () => {
      const conversationalReq: ChatApiRequest = {
        message: 'Yes, but what about the database?',
        history: [
          { role: 'user', text: 'Hello' },
          { role: 'assistant', text: 'Hi! How can I help?' },
        ],
        repoContext: baseRepoContext,
      };

      const key = buildChatCacheKey(conversationalReq);
      assert.strictEqual(key, null, 'Multi-turn conversational requests must return null and never be cached blindly');
    });
  });

  describe('2. End-to-End Chat Request Caching & Provider Call Bypass', () => {
    it('bypasses upstream AI call on repeat request and returns cached: true with upstreamMs: 0', async () => {
      let upstreamCalls = 0;
      const mockFetch: typeof fetch = async () => {
        upstreamCalls++;
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
                            text: 'The authentication boundary verifies JWT tokens.',
                            evidenceReference: 'src/auth.ts',
                          },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const request: ChatApiRequest = {
        message: 'Explain authentication flow',
        selectedRoomId: 'room-auth',
        explanationLevel: 'intermediate',
        repoContext: baseRepoContext,
      };

      // Turn 1: Cache miss
      const res1 = await executeAiChat(request, mockValidChatEnv, mockFetch);
      assert.strictEqual(res1.success, true);
      assert.strictEqual(res1.cached, undefined, 'First call must not be marked as cached');
      assert.strictEqual(upstreamCalls, 1, 'First call must invoke the upstream AI provider');

      // Turn 2: Repeat request with identical inputs -> Cache hit
      const res2 = await executeAiChat(request, mockValidChatEnv, mockFetch);
      assert.strictEqual(res2.success, true);
      assert.strictEqual(res2.cached, true, 'Repeat call must return cached: true');
      assert.strictEqual(res2.timing?.cached, true, 'Timing must record cached: true');
      assert.strictEqual(res2.timing?.upstreamMs, 0, 'Cached response must record 0ms upstream latency');
      assert.strictEqual(upstreamCalls, 1, 'Upstream AI provider call MUST be bypassed on cache hit');
      assert.deepStrictEqual(res2.replies, res1.replies, 'Cached response content must match original');

      const stats = getResponseCacheStats();
      assert.strictEqual(stats.chatHits, 1);
      assert.strictEqual(stats.chatMisses, 1);
    });

    it('honors bypassCache: true to force a fresh upstream AI provider call', async () => {
      let upstreamCalls = 0;
      const mockFetch: typeof fetch = async () => {
        upstreamCalls++;
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
                            text: `Fresh reply #${upstreamCalls}`,
                          },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const baseRequest: ChatApiRequest = {
        message: 'Explain authentication flow',
        selectedRoomId: 'room-auth',
        repoContext: baseRepoContext,
      };

      // Turn 1: prime cache
      await executeAiChat(baseRequest, mockValidChatEnv, mockFetch);
      assert.strictEqual(upstreamCalls, 1);

      // Turn 2: explicit refresh with bypassCache: true
      const refreshReq: ChatApiRequest = {
        ...baseRequest,
        bypassCache: true,
      };
      const res2 = await executeAiChat(refreshReq, mockValidChatEnv, mockFetch);
      assert.strictEqual(res2.success, true);
      assert.strictEqual(res2.cached, undefined, 'Bypass cache must not return cached: true');
      assert.strictEqual(upstreamCalls, 2, 'Must invoke upstream provider when bypassCache: true is set');
    });

    it('never caches provider errors, rate limits, or malformed responses', async () => {
      let upstreamCalls = 0;
      let shouldFail = true;

      const mockFetch: typeof fetch = async () => {
        upstreamCalls++;
        if (shouldFail) {
          return new Response(
            JSON.stringify({ error: { message: 'Resource exhausted', code: 429 } }),
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
                        replies: [{ speaker: 'dog', text: 'Now succeeded' }],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const request: ChatApiRequest = {
        message: 'Show me tasks',
        repoContext: baseRepoContext,
      };

      // 1. Rate limited error
      const errRes = await executeAiChat(request, mockValidChatEnv, mockFetch);
      assert.strictEqual(errRes.success, false);
      assert.strictEqual(upstreamCalls, 1);

      // Verify nothing was cached
      const cacheKey = buildChatCacheKey(request);
      assert.ok(cacheKey);
      assert.strictEqual(getCachedChatResponse(cacheKey), null, 'Failed request must not be stored in cache');

      // 2. Next attempt should make upstream call, not return cached error
      shouldFail = false;
      const successRes = await executeAiChat(request, mockValidChatEnv, mockFetch);
      assert.strictEqual(successRes.success, true);
      assert.strictEqual(upstreamCalls, 2);
    });
  });

  describe('3. Investigation Caching & Explicit Room Refresh', () => {
    const baseInvestigateReq: InvestigateApiRequest = {
      roomId: 'room-auth',
      roomName: 'Authentication Layer',
      roomLayer: 'security',
      roomStatus: 'implemented',
      roomEvidence: 'JWT verification in src/auth.ts',
      roomFilePaths: ['src/auth.ts'],
      repoContext: baseRepoContext,
    };

    it('caches valid room investigation finding and bypasses upstream call on repeat request', async () => {
      let upstreamCalls = 0;
      const mockFetch: typeof fetch = async () => {
        upstreamCalls++;
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        title: 'JWT Auth Verification',
                        explanation: 'JWT token signing verified in src/auth.ts',
                        category: 'security_risk',
                        severity: 'low',
                        evidenceClassification: 'observed',
                        evidencePaths: ['src/auth.ts'],
                        recommendedNextStep: 'Add integration tests for expired tokens',
                        uncertainties: 'None',
                        companionMessages: [{ speaker: 'dog', text: 'Auth verified!' }],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      // Turn 1: Live investigation
      const res1 = await executeRoomInvestigation(baseInvestigateReq, mockValidChatEnv, mockFetch);
      assert.strictEqual(res1.success, true);
      assert.strictEqual(res1.cached, undefined);
      assert.strictEqual(res1.finding?.isCached, undefined);
      assert.strictEqual(upstreamCalls, 1);

      // Turn 2: Repeat request without bypass -> Cache hit
      const res2 = await executeRoomInvestigation(baseInvestigateReq, mockValidChatEnv, mockFetch);
      assert.strictEqual(res2.success, true);
      assert.strictEqual(res2.cached, true);
      assert.strictEqual(res2.finding?.isCached, true);
      assert.strictEqual(res2.timing?.upstreamMs, 0);
      assert.strictEqual(upstreamCalls, 1, 'Must bypass upstream call for cached investigation');

      // Turn 3: Explicit Investigate Room refresh (bypassCache: true)
      const res3 = await executeRoomInvestigation(
        { ...baseInvestigateReq, bypassCache: true },
        mockValidChatEnv,
        mockFetch
      );
      assert.strictEqual(res3.success, true);
      assert.strictEqual(res3.cached, undefined);
      assert.strictEqual(res3.finding?.isCached, undefined);
      assert.strictEqual(upstreamCalls, 2, 'Explicit refresh must bypass cache');
    });

    it('never caches findings with rejected ungrounded evidence paths', async () => {
      let upstreamCalls = 0;
      const mockFetch: typeof fetch = async () => {
        upstreamCalls++;
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        title: 'Ungrounded Finding',
                        explanation: 'Fake finding',
                        category: 'security_risk',
                        severity: 'high',
                        evidenceClassification: 'observed',
                        evidencePaths: ['src/non_existent_fake_file.ts'], // Fabricated path
                        recommendedNextStep: 'Check file',
                        uncertainties: 'None',
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const res = await executeRoomInvestigation(baseInvestigateReq, mockValidChatEnv, mockFetch);
      assert.strictEqual(res.success, true);
      // Finding had rejected reference
      assert.ok(res.finding?.rejectedReferences && res.finding.rejectedReferences.length > 0);

      // Verify it was NOT stored in cache
      const cacheKey = buildInvestigationCacheKey(baseInvestigateReq);
      assert.ok(cacheKey);
      assert.strictEqual(getCachedInvestigation(cacheKey), null, 'Findings with rejected evidence must never be cached');
    });
  });

  describe('4. Cache Expiration & Invalidation', () => {
    it('invalidates cache entries by repository criteria', () => {
      const key1 = buildChatCacheKey({
        message: 'Question 1',
        repoContext: baseRepoContext,
      })!;
      const key2 = buildChatCacheKey({
        message: 'Question 2',
        repoContext: {
          ...baseRepoContext,
          repo: 'other-repo',
        },
      })!;

      // Prime cache
      getCachedChatResponse(key1); // Miss
      invalidateResponseCache({ owner: 'acme-corp', repo: 'task-flow' });

      const stats = getResponseCacheStats();
      assert.strictEqual(stats.chatSize, 0);
    });

    it('evicts oldest entries when capacity exceeds MAX_CACHE_ENTRIES', () => {
      for (let i = 0; i < MAX_CACHE_ENTRIES + 5; i++) {
        const req: ChatApiRequest = {
          message: `Query item #${i}`,
          repoContext: baseRepoContext,
        };
        const key = buildChatCacheKey(req);
        if (key) {
          getCachedChatResponse(key);
        }
      }
      const stats = getResponseCacheStats();
      assert.ok(stats.chatSize <= MAX_CACHE_ENTRIES);
    });
  });

  describe('5. Client-Side Room Explanation Cache (RoomInternalsView)', () => {
    it('stores and retrieves room explanations with TTL', () => {
      const testKey = 'acme-corp/task-flow@head#room:room-auth#level:intermediate#diag:1';
      assert.strictEqual(getCachedRoomExplanation(testKey), null);

      setCachedRoomExplanation(testKey, {
        text: 'The authentication module handles tokens and middleware.',
      });

      const retrieved = getCachedRoomExplanation(testKey);
      assert.ok(retrieved !== null);
      assert.strictEqual(retrieved.text, 'The authentication module handles tokens and middleware.');

      clearRoomExplanationCache();
      assert.strictEqual(getCachedRoomExplanation(testKey), null);
    });
  });
});
