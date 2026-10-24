import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  executeAiHedged,
  executeAiWithStrategy,
  getOmniRouteConfig,
  hedgedProviderOrder,
  DEFAULT_OMNIROUTE_BASE_URL,
} from '../src/server/aiHedging.ts';
import { executeAiChat } from '../src/server/aiProvider.ts';
import type { AiExecutionRequest } from '../src/server/aiProviderRunner.ts';

const REQ: AiExecutionRequest = {
  systemInstruction: 'sys',
  messages: [{ role: 'user', text: 'hi' }],
  temperature: 0.3,
  feature: 'chat',
  overallTimeoutMs: 5000,
  perProviderTimeoutMs: 4000,
};

const ENV_BOTH = { GEMINI_API_KEY: 'fake-g', GROQ_API_KEY: 'fake-q' };

type Behavior = { delayMs?: number; status?: number; text?: string };

/** Fake providers keyed by URL; slow responses honor abort signals. */
function fakeFetch(behaviors: { gemini?: Behavior; groq?: Behavior; omniroute?: Behavior }) {
  const calls: Array<{ provider: string; url: string; headers: Record<string, string>; body: string; aborted: () => boolean }> = [];
  const fn = ((url: string, init: RequestInit = {}) => {
    const u = String(url);
    const provider = u.includes('generativelanguage') ? 'gemini' : u.includes('api.groq.com') ? 'groq' : 'omniroute';
    const b = behaviors[provider as keyof typeof behaviors] ?? { status: 500 };
    const signal = init.signal as AbortSignal | undefined;
    calls.push({ provider, url: u, headers: (init.headers ?? {}) as Record<string, string>, body: String(init.body ?? ''), aborted: () => Boolean(signal?.aborted) });

    const respond = () => {
      if (b.status && b.status !== 200) {
        return new Response(JSON.stringify({ error: { message: 'fake failure' } }), { status: b.status, headers: { 'content-type': 'application/json' } });
      }
      const text = b.text ?? JSON.stringify({ replies: [{ speaker: 'dog', text: `from ${provider}` }] });
      const body =
        provider === 'gemini'
          ? { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }
          : { choices: [{ message: { content: text }, finish_reason: 'stop' }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    if (!b.delayMs) return Promise.resolve(respond());
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(respond()), b.delayMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('AI hedged execution (fastest wins)', () => {
  it('a slow primary loses to a fast fallback started after the hedge delay; the loser is cancelled', async () => {
    const { fn, calls } = fakeFetch({ gemini: { delayMs: 2000 }, groq: {} });
    const start = Date.now();
    const out = await executeAiHedged(REQ, ENV_BOTH, fn, { hedgeDelayMs: 50 });
    const elapsed = Date.now() - start;
    assert.strictEqual(out.success, true);
    if (!out.success) return;
    assert.strictEqual(out.providerUsed, 'groq');
    assert.ok(elapsed < 1000, `answered in ${elapsed}ms instead of waiting for the slow primary`);
    assert.ok(calls.find((c) => c.provider === 'gemini')!.aborted(), 'slow primary request was cancelled');
  });

  it('a failing primary starts the fallback immediately (no hedge wait)', async () => {
    const { fn } = fakeFetch({ gemini: { status: 503 }, groq: {} });
    const start = Date.now();
    const out = await executeAiHedged(REQ, ENV_BOTH, fn, { hedgeDelayMs: 4000 });
    assert.ok(out.success && out.providerUsed === 'groq');
    assert.ok(Date.now() - start < 1500);
  });

  it('a fast primary answers alone; the fallback is never called', async () => {
    const { fn, calls } = fakeFetch({ gemini: {}, groq: {} });
    const out = await executeAiHedged(REQ, ENV_BOTH, fn, { hedgeDelayMs: 1000 });
    assert.ok(out.success && out.providerUsed === 'gemini');
    assert.deepStrictEqual(calls.map((c) => c.provider), ['gemini']);
  });

  it('when every provider fails the error names each one and nothing is invented', async () => {
    const { fn } = fakeFetch({ gemini: { status: 503 }, groq: { status: 503 } });
    const out = await executeAiHedged(REQ, ENV_BOTH, fn, { hedgeDelayMs: 50 });
    assert.strictEqual(out.success, false);
    if (out.success) return;
    assert.match(out.error, /Gemini: .*Groq: /);
    assert.strictEqual(out.errorInfo.title, 'AI providers unavailable');
  });

  it('the default strategy stays sequential: the fallback does not start while the primary is still working', async () => {
    const { fn, calls } = fakeFetch({ gemini: { delayMs: 150 }, groq: {} });
    const out = await executeAiWithStrategy(REQ, ENV_BOTH, fn);
    assert.ok(out.success && out.providerUsed === 'gemini');
    assert.deepStrictEqual(calls.map((c) => c.provider), ['gemini']);
  });

  it('executeAiChat opts in via { strategy: "hedged" }', async () => {
    const { fn } = fakeFetch({ gemini: { delayMs: 2000 }, groq: {} });
    const res = await executeAiChat({ message: 'Explain the server', bypassCache: true }, ENV_BOTH, fn, { strategy: 'hedged', hedgeDelayMs: 50 });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.providerUsed, 'groq');
  });
});

describe('Groq JSON-mode recovery', () => {
  const groqJsonFailure = ((url: string) =>
    Promise.resolve(
      String(url).includes('api.groq.com')
        ? new Response(
            JSON.stringify({
              error: {
                message: "Failed to generate JSON. Please adjust your prompt. See 'failed_generation' for more details.",
                type: 'invalid_request_error',
                code: 'json_validate_failed',
                failed_generation: 'Hey! Barkley here, doing great. What would you like to explore?',
              },
            }),
            { status: 400, headers: { 'content-type': 'application/json' } }
          )
        : new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503, headers: { 'content-type': 'application/json' } })
    )) as unknown as typeof fetch;

  it('a plain-text reply rejected by JSON mode is shown instead of an error', async () => {
    const res = await executeAiChat({ message: 'hi lol how are you two', bypassCache: true }, ENV_BOTH, groqJsonFailure, { strategy: 'hedged', hedgeDelayMs: 50 });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.providerUsed, 'groq');
    assert.match(res.replies?.[0]?.text ?? '', /Barkley here/);
  });

  it('other Groq 400s are still reported as errors', async () => {
    const plain400 = (() =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: 'bad request', code: 'invalid_request' } }), { status: 400, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch;
    const res = await executeAiChat({ message: 'hi', bypassCache: true }, { GROQ_API_KEY: 'fake-q' }, plain400);
    assert.strictEqual(res.success, false);
  });
});

describe('Optional OmniRoute provider', () => {
  it('is off unless a model is set', () => {
    assert.strictEqual(getOmniRouteConfig({}).isConfigured, false);
    assert.strictEqual(getOmniRouteConfig({ OMNIROUTE_BASE_URL: 'http://localhost:20128/v1' }).isConfigured, false);
    assert.deepStrictEqual(hedgedProviderOrder({ OMNIROUTE_MODEL: 'combo-1' }), ['omniroute']);
    assert.strictEqual(getOmniRouteConfig({ OMNIROUTE_MODEL: 'combo-1' }).baseUrl, DEFAULT_OMNIROUTE_BASE_URL);
    assert.strictEqual(getOmniRouteConfig({ OMNIROUTE_MODEL: 'x', OMNIROUTE_BASE_URL: 'ftp://h/v1' }).isConfigured, false);
  });

  it('calls the OpenAI-compatible /chat/completions endpoint with the gateway key', async () => {
    const { fn, calls } = fakeFetch({ omniroute: {} });
    const env = { OMNIROUTE_MODEL: 'combo-1', OMNIROUTE_BASE_URL: 'http://localhost:20128/v1/', OMNIROUTE_API_KEY: 'fake-omni' };
    const out = await executeAiHedged(REQ, env, fn);
    assert.ok(out.success && out.providerUsed === 'omniroute');
    assert.strictEqual(calls[0].url, 'http://localhost:20128/v1/chat/completions');
    assert.strictEqual(calls[0].headers.Authorization, 'Bearer fake-omni');
    const body = JSON.parse(calls[0].body);
    assert.strictEqual(body.model, 'combo-1');
    assert.strictEqual(body.messages[0].role, 'system');
  });

  it('races alongside other providers and errors never leak the gateway key', async () => {
    const { fn } = fakeFetch({ gemini: { status: 503 }, groq: { status: 429 }, omniroute: { status: 401 } });
    const env = { ...ENV_BOTH, OMNIROUTE_MODEL: 'combo-1', OMNIROUTE_API_KEY: 'fake-omni-secret' };
    assert.deepStrictEqual(hedgedProviderOrder(env), ['gemini', 'groq', 'omniroute']);
    const out = await executeAiHedged(REQ, env, fn, { hedgeDelayMs: 50 });
    assert.strictEqual(out.success, false);
    if (out.success) return;
    assert.match(out.error, /OmniRoute: /);
    assert.ok(!JSON.stringify(out).includes('fake-omni-secret'));
  });
});
