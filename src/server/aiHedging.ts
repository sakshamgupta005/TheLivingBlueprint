/**
 * aiHedging.ts — Fastest-wins provider execution with an optional OmniRoute gateway.
 *
 * executeAiWithFallback runs providers strictly one after another, so a slow
 * primary adds its full timeout before the fallback even starts. The hedged
 * strategy instead:
 *   - starts the primary immediately;
 *   - starts the next provider as soon as the primary fails, or after
 *     `hedgeDelayMs` if the primary is merely slow;
 *   - returns the first successful answer and cancels the others.
 * Each provider attempt reuses executeAiWithFallback with an environment that
 * contains only that provider, so request building, parsing and error
 * classification are unchanged. Cloudflare (tertiary) only starts after the
 * others have failed.
 *
 * OmniRoute (https://github.com/diegosouzapw/OmniRoute) is an optional,
 * OpenAI-compatible local gateway. It is used only when OMNIROUTE_MODEL is set.
 */

import {
  executeAiWithFallback,
  getProviderConfigs,
  isValidModelIdentifier,
  type AiExecutionRequest,
  type AiExecutionOutcome,
  type AiExecutionFailure,
} from './aiProviderRunner.ts';
import { classifyGroqError, classifyNetworkError } from './errorClassifier.ts';
import type { AiErrorInfo } from './types.ts';

export type HedgedProvider = 'gemini' | 'groq' | 'omniroute' | 'cloudflare';

export const DEFAULT_OMNIROUTE_BASE_URL = 'http://localhost:20128/v1';
export const DEFAULT_HEDGE_DELAY_MS = 4000;

export interface AiStrategyOptions {
  /** 'sequential' (default) keeps executeAiWithFallback behavior; 'hedged' is fastest-wins. */
  strategy?: 'sequential' | 'hedged';
  hedgeDelayMs?: number;
}

const PROVIDER_ENV_KEYS: Record<Exclude<HedgedProvider, 'omniroute'>, string[]> = {
  gemini: ['GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY', 'AI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cloudflare: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
};

const LABELS: Record<HedgedProvider, string> = {
  gemini: 'Gemini',
  groq: 'Groq',
  omniroute: 'OmniRoute',
  cloudflare: 'Cloudflare',
};

export interface OmniRouteConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  isConfigured: boolean;
}

export function getOmniRouteConfig(env: Record<string, string | undefined>): OmniRouteConfig {
  const baseUrl = (env.OMNIROUTE_BASE_URL?.trim() || DEFAULT_OMNIROUTE_BASE_URL).replace(/\/+$/, '');
  const model = env.OMNIROUTE_MODEL?.trim() || '';
  const apiKey = env.OMNIROUTE_API_KEY?.trim() || undefined;
  return { baseUrl, model, apiKey, isConfigured: Boolean(model) && isValidModelIdentifier(model) && /^https?:\/\//i.test(baseUrl) };
}

/** Configured providers in priority order: Gemini, Groq, OmniRoute, then Cloudflare. */
export function hedgedProviderOrder(env: Record<string, string | undefined>): HedgedProvider[] {
  const c = getProviderConfigs(env);
  const order: HedgedProvider[] = [];
  if (c.gemini.isConfigured && isValidModelIdentifier(c.gemini.model)) order.push('gemini');
  if (c.groq.isConfigured && isValidModelIdentifier(c.groq.model)) order.push('groq');
  if (getOmniRouteConfig(env).isConfigured) order.push('omniroute');
  if (c.cloudflare.isConfigured && isValidModelIdentifier(c.cloudflare.model)) order.push('cloudflare');
  return order;
}

function onlyProvider(env: Record<string, string | undefined>, keep: Exclude<HedgedProvider, 'omniroute'>) {
  const scoped: Record<string, string | undefined> = { ...env };
  for (const [provider, keys] of Object.entries(PROVIDER_ENV_KEYS)) {
    if (provider !== keep) for (const k of keys) scoped[k] = undefined;
  }
  return scoped;
}

/** fetch that is also cancelled when the hedged race is decided. */
function cancellableFetch(fetchFn: typeof fetch, race: AbortSignal): typeof fetch {
  const anySignal = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  const wrapped = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (race.aborted) return Promise.reject(Object.assign(new Error('Superseded by a faster provider'), { name: 'AbortError' }));
    const signal = init?.signal && anySignal ? anySignal([init.signal, race]) : init?.signal ?? race;
    return fetchFn(input, { ...init, signal });
  };
  return wrapped as typeof fetch;
}

/** One OpenAI-compatible chat call to an OmniRoute gateway. */
export async function callOmniRoute(
  req: AiExecutionRequest,
  env: Record<string, string | undefined>,
  fetchFn: typeof fetch
): Promise<AiExecutionOutcome> {
  const cfg = getOmniRouteConfig(env);
  const secrets = cfg.apiKey ? [cfg.apiKey] : [];
  const timeoutMs = req.perProviderTimeoutMs ?? 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  const fail = (errorInfo: AiErrorInfo, status?: number): AiExecutionFailure => ({
    success: false,
    code: status === 429 ? 'RATE_LIMITED' : status === 400 || status === 413 ? 'INVALID_REQUEST' : 'PROVIDER_ERROR',
    error: `OmniRoute: ${errorInfo.detailSafe || errorInfo.message}`,
    errorInfo,
    upstreamMs: Date.now() - start,
  });

  try {
    const res = await fetchFn(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: req.systemInstruction },
          ...req.messages.map((m) => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text })),
        ],
        temperature: req.temperature,
        max_tokens: req.maxOutputTokens ?? 4096,
        // No response_format: routed models differ in JSON-mode support; the
        // shared response validator already handles plain-text replies.
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        // non-JSON error body
      }
      return fail(classifyGroqError(res.status, res.statusText, body, res.headers, secrets), res.status);
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      return fail({ kind: 'unknown', title: 'Empty AI response', message: 'OmniRoute returned an empty response.', retryable: true });
    }
    return {
      success: true,
      rawText: text,
      providerUsed: 'omniroute',
      upstreamMs: Date.now() - start,
      promptTokens: data.usage?.prompt_tokens,
      candidatesTokens: data.usage?.completion_tokens,
      totalTokens: data.usage?.total_tokens,
      finishReason: choice?.finish_reason,
    };
  } catch (err) {
    clearTimeout(timer);
    return fail(classifyNetworkError(err, secrets));
  }
}

function combineFailures(failures: Array<{ provider: HedgedProvider; outcome: AiExecutionFailure }>, startedAt: number): AiExecutionFailure {
  if (failures.length === 1) return { ...failures[0].outcome, upstreamMs: Date.now() - startedAt };
  const allRateLimited = failures.every((f) => ['rate_limit_short', 'quota_exceeded_daily'].includes(f.outcome.errorInfo.kind));
  const detail = `All configured AI providers failed. ${failures.map((f) => `${LABELS[f.provider]}: ${f.outcome.error}`).join(' ')}`;
  const last = failures[failures.length - 1].outcome.errorInfo;
  return {
    success: false,
    code: allRateLimited ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
    error: detail,
    errorInfo: {
      kind: last.kind !== 'unknown' ? last.kind : failures[0].outcome.errorInfo.kind,
      title: allRateLimited ? 'AI providers currently rate-limited' : 'AI providers unavailable',
      message: allRateLimited
        ? 'Every configured AI provider has reached its rate limit. Your saved architecture and evidence are safe.'
        : 'All configured AI providers failed to process your request. Your saved project and evidence remain safe.',
      retryable: true,
      detailSafe: detail,
      proHint: allRateLimited,
    },
    upstreamMs: Date.now() - startedAt,
  };
}

/**
 * Fastest-wins execution across configured providers. With a single non-OmniRoute
 * provider (or none) this is exactly executeAiWithFallback.
 */
export async function executeAiHedged(
  req: AiExecutionRequest,
  env: Record<string, string | undefined>,
  fetchFn: typeof fetch,
  options: AiStrategyOptions = {}
): Promise<AiExecutionOutcome> {
  const order = hedgedProviderOrder(env);
  if (order.length === 0 || (order.length === 1 && order[0] !== 'omniroute')) {
    return executeAiWithFallback(req, env, fetchFn);
  }

  const startedAt = Date.now();
  const overall = req.overallTimeoutMs ?? 25000;
  const hedgeDelayMs = options.hedgeDelayMs ?? DEFAULT_HEDGE_DELAY_MS;
  const race = new AbortController();
  const raceFetch = cancellableFetch(fetchFn, race.signal);

  return new Promise<AiExecutionOutcome>((resolve) => {
    const failures: Array<{ provider: HedgedProvider; outcome: AiExecutionFailure }> = [];
    let next = 0;
    let running = 0;
    let settled = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: AiExecutionOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      race.abort();
      resolve(outcome);
    };

    const launch = (viaHedge: boolean) => {
      if (settled || next >= order.length) return;
      // Tertiary Cloudflare never races; it only starts after the others failed.
      if (viaHedge && order[next] === 'cloudflare') return;
      const provider = order[next++];
      const remaining = overall - (Date.now() - startedAt);
      if (remaining < 1000) {
        if (running === 0) finish(failures.length ? combineFailures(failures, startedAt) : timeoutFailure(startedAt));
        return;
      }
      running++;
      const scopedReq: AiExecutionRequest = {
        ...req,
        overallTimeoutMs: remaining,
        perProviderTimeoutMs: Math.min(req.perProviderTimeoutMs ?? remaining, remaining),
      };
      const attempt =
        provider === 'omniroute'
          ? callOmniRoute(scopedReq, env, raceFetch)
          : executeAiWithFallback(scopedReq, onlyProvider(env, provider), raceFetch);

      // A slow (not failed) provider lets the next one start in parallel once.
      if (!viaHedge && next < order.length) {
        clearTimeout(hedgeTimer);
        hedgeTimer = setTimeout(() => launch(true), hedgeDelayMs);
      }

      attempt.then(
        (outcome) => {
          running--;
          if (settled) return;
          if (outcome.success) {
            finish({ ...outcome, fallbackMs: provider === order[0] ? outcome.fallbackMs : Date.now() - startedAt, upstreamMs: Date.now() - startedAt });
            return;
          }
          failures.push({ provider, outcome });
          clearTimeout(hedgeTimer);
          if (next < order.length) launch(false);
          else if (running === 0) finish(combineFailures(failures, startedAt));
        },
        () => {
          running--;
          if (!settled && running === 0 && next >= order.length) finish(combineFailures(failures, startedAt));
        }
      );
    };

    launch(false);
  });
}

function timeoutFailure(startedAt: number): AiExecutionFailure {
  return {
    success: false,
    code: 'PROVIDER_ERROR',
    error: 'AI request timed out before a provider could respond.',
    errorInfo: { kind: 'timeout', title: 'AI request timed out', message: 'The AI request timed out before a provider could respond.', retryable: true },
    upstreamMs: Date.now() - startedAt,
  };
}

/** Selects the execution strategy; sequential (the default) is unchanged behavior. */
export function executeAiWithStrategy(
  req: AiExecutionRequest,
  env: Record<string, string | undefined>,
  fetchFn: typeof fetch,
  options?: AiStrategyOptions
): Promise<AiExecutionOutcome> {
  return options?.strategy === 'hedged' ? executeAiHedged(req, env, fetchFn, options) : executeAiWithFallback(req, env, fetchFn);
}
