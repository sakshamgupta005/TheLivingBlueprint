import { getThinkingConfig } from './aiProvider.ts';
import {
  classifyGeminiError,
  classifyGroqError,
  classifyCloudflareError,
  classifyNetworkError,
} from './errorClassifier.ts';
import type { AiErrorInfo } from './types.ts';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const DEFAULT_GROQ_MODEL = 'qwen/qwen3.8-27b';
export const DEFAULT_CLOUDFLARE_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const GROQ_API_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

export function isValidModelIdentifier(model: string): boolean {
  return Boolean(model && /^[@a-zA-Z0-9_./-]+$/.test(model));
}

export interface ProviderConfigs {
  gemini: {
    apiKey?: string;
    model: string;
    isConfigured: boolean;
    thinkingLevel: 'low' | 'high';
  };
  groq: {
    apiKey?: string;
    model: string;
    isConfigured: boolean;
  };
  cloudflare: {
    accountId?: string;
    apiToken?: string;
    model: string;
    isConfigured: boolean;
  };
}

export function getProviderConfigs(
  env: Record<string, string | undefined> = process.env
): ProviderConfigs {
  const geminiKey = env.GEMINI_API_KEY || env.GOOGLE_GENAI_API_KEY || env.AI_API_KEY;
  const geminiModel = (env.AI_MODEL || DEFAULT_GEMINI_MODEL).trim();
  const thinkingConfig = getThinkingConfig(env);

  const groqKey = env.GROQ_API_KEY;
  const groqModel = (env.GROQ_MODEL || DEFAULT_GROQ_MODEL).trim();

  const cfAccountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const cfApiToken = env.CLOUDFLARE_API_TOKEN?.trim();
  const cfModel = (env.CLOUDFLARE_AI_MODEL || DEFAULT_CLOUDFLARE_MODEL).trim();

  return {
    gemini: {
      apiKey: geminiKey && geminiKey.trim().length > 0 ? geminiKey.trim() : undefined,
      model: geminiModel,
      isConfigured: Boolean(geminiKey && geminiKey.trim().length > 0),
      thinkingLevel: thinkingConfig.thinkingLevel,
    },
    groq: {
      apiKey: groqKey && groqKey.trim().length > 0 ? groqKey.trim() : undefined,
      model: groqModel,
      isConfigured: Boolean(groqKey && groqKey.trim().length > 0),
    },
    cloudflare: {
      accountId: cfAccountId && cfAccountId.length > 0 ? cfAccountId : undefined,
      apiToken: cfApiToken && cfApiToken.length > 0 ? cfApiToken : undefined,
      model: cfModel,
      isConfigured: Boolean(cfAccountId && cfAccountId.length > 0 && cfApiToken && cfApiToken.length > 0),
    },
  };
}

export interface AiProviderMessage {
  role: 'user' | 'model';
  text: string;
}

export interface AiExecutionRequest {
  systemInstruction: string;
  messages: AiProviderMessage[];
  temperature: number;
  responseSchema?: unknown;
  feature: 'chat' | 'investigation';
  overallTimeoutMs?: number;
  perProviderTimeoutMs?: number;
  maxOutputTokens?: number;
}

export interface AiExecutionSuccess {
  success: true;
  rawText: string;
  providerUsed: 'gemini' | 'groq' | 'cloudflare';
  upstreamMs: number;
  fallbackMs?: number;
  promptTokens?: number;
  candidatesTokens?: number;
  totalTokens?: number;
  finishReason?: string;
  thinkingLevel?: 'low' | 'high';
}

export interface AiExecutionFailure {
  success: false;
  code: 'CONFIG_REQUIRED' | 'RATE_LIMITED' | 'PROVIDER_ERROR' | 'INVALID_REQUEST';
  error: string;
  errorInfo: AiErrorInfo;
  upstreamMs: number;
  fallbackMs?: number;
}

export type AiExecutionOutcome = AiExecutionSuccess | AiExecutionFailure;

interface ProviderAttemptFailure {
  status?: number;
  errorInfo: AiErrorInfo;
  errorMsg: string;
}

export function isRetryableProviderError(failure: ProviderAttemptFailure | null): boolean {
  if (!failure) return false;
  if (failure.status === 429) return true;
  if (failure.status && failure.status >= 500 && failure.status <= 599) return true;
  if (
    failure.errorInfo?.kind === 'timeout' ||
    failure.errorInfo?.kind === 'network_error' ||
    failure.errorInfo?.kind === 'service_unavailable' ||
    failure.errorInfo?.kind === 'rate_limit_short' ||
    failure.errorInfo?.kind === 'quota_exceeded_daily'
  ) {
    return true;
  }
  if (failure.errorInfo?.title === 'Empty AI response') return true;
  return Boolean(failure.errorInfo?.retryable);
}

export async function executeAiWithFallback(
  req: AiExecutionRequest,
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch
): Promise<AiExecutionOutcome> {
  const startTime = Date.now();
  const configs = getProviderConfigs(env);

  // Validate model formats
  if (configs.gemini.isConfigured && !isValidModelIdentifier(configs.gemini.model)) {
    if (!configs.groq.isConfigured && !configs.cloudflare.isConfigured) {
      return {
        success: false,
        code: 'CONFIG_REQUIRED',
        error: `Invalid AI_MODEL configuration: "${configs.gemini.model}". Expected a valid model identifier like "gemini-3.8-flash".`,
        errorInfo: {
          kind: 'config_required',
          title: 'AI model configuration error',
          message: `Invalid AI_MODEL configuration: "${configs.gemini.model}". Expected a valid model identifier like "gemini-3.8-flash".`,
          retryable: false,
          proHint: false,
        },
        upstreamMs: 0,
      };
    }
  }

  if (configs.groq.isConfigured && !isValidModelIdentifier(configs.groq.model)) {
    if (!configs.gemini.isConfigured && !configs.cloudflare.isConfigured) {
      return {
        success: false,
        code: 'CONFIG_REQUIRED',
        error: `Invalid GROQ_MODEL configuration: "${configs.groq.model}". Expected a valid model identifier like "${DEFAULT_GROQ_MODEL}".`,
        errorInfo: {
          kind: 'config_required',
          title: 'AI model configuration error',
          message: `Invalid GROQ_MODEL configuration: "${configs.groq.model}". Expected a valid model identifier like "${DEFAULT_GROQ_MODEL}".`,
          retryable: false,
          proHint: false,
        },
        upstreamMs: 0,
      };
    }
  }

  if (configs.cloudflare.isConfigured && !isValidModelIdentifier(configs.cloudflare.model)) {
    if (!configs.gemini.isConfigured && !configs.groq.isConfigured) {
      return {
        success: false,
        code: 'CONFIG_REQUIRED',
        error: `Invalid CLOUDFLARE_AI_MODEL configuration: "${configs.cloudflare.model}". Expected a valid model identifier like "${DEFAULT_CLOUDFLARE_MODEL}".`,
        errorInfo: {
          kind: 'config_required',
          title: 'AI model configuration error',
          message: `Invalid CLOUDFLARE_AI_MODEL configuration: "${configs.cloudflare.model}". Expected a valid model identifier like "${DEFAULT_CLOUDFLARE_MODEL}".`,
          retryable: false,
          proHint: false,
        },
        upstreamMs: 0,
      };
    }
  }

  // None configured
  if (!configs.gemini.isConfigured && !configs.groq.isConfigured && !configs.cloudflare.isConfigured) {
    const hint =
      req.feature === 'investigation'
        ? 'Add GEMINI_API_KEY, GROQ_API_KEY, or CLOUDFLARE_API_TOKEN to your environment variables or .env file to enable room investigation.'
        : 'Add GEMINI_API_KEY, GROQ_API_KEY, or CLOUDFLARE_API_TOKEN to your environment variables or .env file to activate Barkley and Cleo.';
    return {
      success: false,
      code: 'CONFIG_REQUIRED',
      error: `AI provider is not configured. ${hint}`,
      errorInfo: {
        kind: 'config_required',
        title: 'AI configuration required',
        message: `AI provider is not configured. ${hint}`,
        retryable: false,
        proHint: false,
      },
      upstreamMs: 0,
    };
  }

  const overallTimeoutMs = req.overallTimeoutMs ?? (req.feature === 'chat' ? 20000 : 25000);
  const perProviderTimeoutMs = req.perProviderTimeoutMs ?? (req.feature === 'chat' ? 10000 : 12000);
  const secrets = [
    configs.gemini.apiKey,
    configs.groq.apiKey,
    configs.cloudflare.apiToken,
    configs.cloudflare.accountId,
  ].filter(Boolean) as string[];

  // Sequential order: Gemini first (if configured and valid), Groq second (if configured and valid), Cloudflare third
  const providersToAttempt: Array<'gemini' | 'groq' | 'cloudflare'> = [];
  if (configs.gemini.isConfigured && isValidModelIdentifier(configs.gemini.model)) {
    providersToAttempt.push('gemini');
  }
  if (configs.groq.isConfigured && isValidModelIdentifier(configs.groq.model)) {
    providersToAttempt.push('groq');
  }
  if (configs.cloudflare.isConfigured && isValidModelIdentifier(configs.cloudflare.model)) {
    providersToAttempt.push('cloudflare');
  }

  let geminiFailure: ProviderAttemptFailure | null = null;
  let groqFailure: ProviderAttemptFailure | null = null;
  let cloudflareFailure: ProviderAttemptFailure | null = null;
  let totalUpstreamMs = 0;
  let fallbackMs = 0;

  for (let i = 0; i < providersToAttempt.length; i++) {
    const provider = providersToAttempt[i];
    const remainingBudget = overallTimeoutMs - (Date.now() - startTime);

    if (remainingBudget < 1000) {
      // Deadline expired before attempting next provider
      break;
    }

    // Cloudflare fallback only after Gemini and Groq fail with retryable provider errors
    if (provider === 'cloudflare') {
      const isGeminiRetryable = !geminiFailure || isRetryableProviderError(geminiFailure);
      const isGroqRetryable = !groqFailure || isRetryableProviderError(groqFailure);
      if (!isGeminiRetryable || !isGroqRetryable) {
        break;
      }
    }

    const attemptTimeout = Math.min(perProviderTimeoutMs, remainingBudget);

    if (provider === 'gemini') {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), attemptTimeout);
      const attemptStart = Date.now();

      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${configs.gemini.model}:generateContent?key=${configs.gemini.apiKey}`;
        const payload = {
          systemInstruction: { parts: [{ text: req.systemInstruction }] },
          contents: req.messages.map((m) => ({
            role: m.role,
            parts: [{ text: m.text }],
          })),
          generationConfig: {
            temperature: req.temperature,
            maxOutputTokens: req.maxOutputTokens ?? 4096,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingLevel: configs.gemini.thinkingLevel },
            ...(req.responseSchema ? { responseSchema: req.responseSchema } : {}),
          },
        };

        const res = await fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const elapsed = Date.now() - attemptStart;
        totalUpstreamMs += elapsed;

        if (res.ok) {
          const data = await res.json();
          const candidate = data.candidates?.[0];
          const textPart = candidate?.content?.parts?.[0]?.text;

          if (textPart && textPart.trim().length > 0) {
            return {
              success: true,
              rawText: textPart,
              providerUsed: 'gemini',
              upstreamMs: totalUpstreamMs,
              fallbackMs: 0,
              promptTokens: data.usageMetadata?.promptTokenCount,
              candidatesTokens: data.usageMetadata?.candidatesTokenCount,
              totalTokens: data.usageMetadata?.totalTokenCount,
              thinkingLevel: configs.gemini.thinkingLevel,
              finishReason: candidate?.finishReason,
            };
          }

          // Empty response from Gemini
          geminiFailure = {
            status: res.status,
            errorInfo: {
              kind: 'unknown',
              title: 'Empty AI response',
              message: 'AI model returned an empty response.',
              retryable: false,
            },
            errorMsg: 'AI model returned an empty response.',
          };
        } else {
          let errorData: unknown;
          try {
            errorData = await res.json();
          } catch {
            // fallback
          }

          const errorInfo = classifyGeminiError(
            res.status,
            res.statusText,
            errorData,
            res.headers,
            secrets
          );

          let errorMsg = errorInfo.detailSafe || `AI provider error: ${errorInfo.message}`;
          if (res.status === 429) {
            errorMsg = `AI provider rate limit reached. ${errorInfo.title}: ${errorInfo.message}`;
          } else if (res.status === 404) {
            errorMsg = `AI model "${configs.gemini.model}" is not found or unsupported by the provider: ${errorInfo.detailSafe || errorInfo.message}`;
          } else if (res.status === 400 || res.status === 413) {
            errorMsg = errorInfo.detailSafe || `AI provider rejected request (HTTP ${res.status})`;
          }

          geminiFailure = { status: res.status, errorInfo, errorMsg };
        }
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        const elapsed = Date.now() - attemptStart;
        totalUpstreamMs += elapsed;
        const networkInfo = classifyNetworkError(fetchErr, secrets);
        geminiFailure = {
          errorInfo: networkInfo,
          errorMsg:
            networkInfo.kind === 'timeout'
              ? `AI provider request timed out (${Math.round(attemptTimeout / 1000)}s limit). Please try again.`
              : `Failed to communicate with AI provider: ${networkInfo.detailSafe || 'Network failure'}`,
        };
      }
    } else if (provider === 'groq') {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), attemptTimeout);
      const attemptStart = Date.now();

      try {
        const groqMessages = [
          { role: 'system', content: req.systemInstruction },
          ...req.messages.map((m) => ({
            role: m.role === 'model' ? 'assistant' : 'user',
            content: m.text,
          })),
        ];

        const payload = {
          model: configs.groq.model,
          messages: groqMessages,
          temperature: req.temperature,
          max_tokens: req.maxOutputTokens ?? 4096,
          response_format: { type: 'json_object' },
        };

        const res = await fetchFn(GROQ_API_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${configs.groq.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const elapsed = Date.now() - attemptStart;
        totalUpstreamMs += elapsed;
        fallbackMs += elapsed;

        if (res.ok) {
          const data = await res.json();
          const choice = data.choices?.[0];
          const textPart = choice?.message?.content;

          if (textPart && textPart.trim().length > 0) {
            return {
              success: true,
              rawText: textPart,
              providerUsed: 'groq',
              upstreamMs: totalUpstreamMs,
              fallbackMs,
              promptTokens: data.usage?.prompt_tokens,
              candidatesTokens: data.usage?.completion_tokens,
              totalTokens: data.usage?.total_tokens,
              finishReason: choice?.finish_reason,
            };
          }

          groqFailure = {
            status: res.status,
            errorInfo: {
              kind: 'unknown',
              title: 'Empty AI response',
              message: 'Fallback AI model returned an empty response.',
              retryable: false,
            },
            errorMsg: 'Fallback AI model returned an empty response.',
          };
        } else {
          let errorData: unknown;
          try {
            errorData = await res.json();
          } catch {
            // fallback
          }

          const errorInfo = classifyGroqError(
            res.status,
            res.statusText,
            errorData,
            res.headers,
            secrets
          );

          let errorMsg = errorInfo.detailSafe || `Fallback AI provider error: ${errorInfo.message}`;
          if (res.status === 429) {
            errorMsg = `Fallback AI provider rate limit reached. ${errorInfo.title}: ${errorInfo.message}`;
          } else if (res.status === 404) {
            errorMsg = `Fallback AI model "${configs.groq.model}" is not found or unsupported by the provider: ${errorInfo.detailSafe || errorInfo.message}`;
          }

          groqFailure = { status: res.status, errorInfo, errorMsg };
        }
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        const elapsed = Date.now() - attemptStart;
        totalUpstreamMs += elapsed;
        fallbackMs += elapsed;
        const networkInfo = classifyNetworkError(fetchErr, secrets);
        groqFailure = {
          errorInfo: networkInfo,
          errorMsg:
            networkInfo.kind === 'timeout'
              ? `Fallback AI provider request timed out (${Math.round(attemptTimeout / 1000)}s limit).`
              : `Failed to communicate with fallback AI provider: ${networkInfo.detailSafe || 'Network failure'}`,
        };
      }
    } else if (provider === 'cloudflare') {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), attemptTimeout);
      const attemptStart = Date.now();

      try {
        const cfMessages = [
          { role: 'system', content: req.systemInstruction },
          ...req.messages.map((m) => ({
            role: m.role === 'model' ? 'assistant' : 'user',
            content: m.text,
          })),
        ];

        const payload = {
          messages: cfMessages,
          temperature: req.temperature,
          max_tokens: req.maxOutputTokens ?? 4096,
        };

        const url = `https://api.cloudflare.com/client/v4/accounts/${configs.cloudflare.accountId}/ai/run/${configs.cloudflare.model}`;

        const res = await fetchFn(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${configs.cloudflare.apiToken}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const elapsed = Date.now() - attemptStart;
        totalUpstreamMs += elapsed;
        fallbackMs += elapsed;

        if (res.ok) {
          const data = await res.json();
          let textPart: string | undefined;
          if (typeof data.result === 'string') {
            textPart = data.result;
          } else if (
            data.result &&
            typeof data.result === 'object' &&
            typeof (data.result as Record<string, unknown>).response === 'string'
          ) {
            textPart = (data.result as Record<string, unknown>).response as string;
          } else if (Array.isArray(data.choices) && data.choices[0]?.message?.content) {
            textPart = data.choices[0].message.content;
          }

          if (textPart && textPart.trim().length > 0) {
            return {
              success: true,
              rawText: textPart,
              providerUsed: 'cloudflare',
              upstreamMs: totalUpstreamMs,
              fallbackMs,
              promptTokens: data.result?.usage?.prompt_tokens ?? data.usage?.prompt_tokens,
              candidatesTokens: data.result?.usage?.completion_tokens ?? data.usage?.completion_tokens,
              totalTokens: data.result?.usage?.total_tokens ?? data.usage?.total_tokens,
              finishReason: data.result?.finish_reason ?? data.choices?.[0]?.finish_reason,
            };
          }

          cloudflareFailure = {
            status: res.status,
            errorInfo: {
              kind: 'unknown',
              title: 'Empty AI response',
              message: 'Tertiary AI model returned an empty response.',
              retryable: false,
            },
            errorMsg: 'Tertiary AI model returned an empty response.',
          };
        } else {
          let errorData: unknown;
          try {
            errorData = await res.json();
          } catch {
            // fallback
          }

          const errorInfo = classifyCloudflareError(
            res.status,
            res.statusText,
            errorData,
            res.headers,
            secrets
          );

          let errorMsg = errorInfo.detailSafe || `Tertiary AI provider error: ${errorInfo.message}`;
          if (res.status === 429) {
            errorMsg = `Tertiary AI provider rate limit reached. ${errorInfo.title}: ${errorInfo.message}`;
          } else if (res.status === 404) {
            errorMsg = `Tertiary AI model "${configs.cloudflare.model}" is not found or unsupported by the provider: ${errorInfo.detailSafe || errorInfo.message}`;
          }

          cloudflareFailure = { status: res.status, errorInfo, errorMsg };
        }
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        const elapsed = Date.now() - attemptStart;
        totalUpstreamMs += elapsed;
        fallbackMs += elapsed;
        const networkInfo = classifyNetworkError(fetchErr, secrets);
        cloudflareFailure = {
          errorInfo: networkInfo,
          errorMsg:
            networkInfo.kind === 'timeout'
              ? `Tertiary AI provider request timed out (${Math.round(attemptTimeout / 1000)}s limit).`
              : `Failed to communicate with tertiary AI provider: ${networkInfo.detailSafe || 'Network failure'}`,
        };
      }
    }
  }

  // All attempted providers failed
  const failures: ProviderAttemptFailure[] = [];
  if (geminiFailure) failures.push(geminiFailure);
  if (groqFailure) failures.push(groqFailure);
  if (cloudflareFailure) failures.push(cloudflareFailure);

  if (failures.length > 0) {
    if (failures.length === 1) {
      const f = failures[0];
      const code =
        f.status === 429
          ? 'RATE_LIMITED'
          : f.status === 404
          ? 'PROVIDER_ERROR'
          : f.errorInfo.kind === 'config_required'
          ? 'CONFIG_REQUIRED'
          : f.status === 400 || f.status === 413
          ? 'INVALID_REQUEST'
          : 'PROVIDER_ERROR';

      return {
        success: false,
        code,
        error: f.errorMsg,
        errorInfo: f.errorInfo,
        upstreamMs: totalUpstreamMs,
        fallbackMs,
      };
    }

    const isAllRateLimited = failures.every(
      (f) =>
        f.errorInfo.kind === 'rate_limit_short' ||
        f.errorInfo.kind === 'quota_exceeded_daily'
    );

    const code = isAllRateLimited ? 'RATE_LIMITED' : 'PROVIDER_ERROR';

    let combinedError: string;
    if (geminiFailure && groqFailure && !cloudflareFailure) {
      combinedError = `All configured AI providers (Gemini primary and Groq fallback) failed. Primary: ${geminiFailure.errorMsg} Fallback: ${groqFailure.errorMsg}`;
    } else {
      const providerNames: string[] = [];
      if (geminiFailure) providerNames.push(`Primary: ${geminiFailure.errorMsg}`);
      if (groqFailure) providerNames.push(`Fallback: ${groqFailure.errorMsg}`);
      if (cloudflareFailure) providerNames.push(`Tertiary: ${cloudflareFailure.errorMsg}`);
      combinedError = `All configured AI providers failed. ${providerNames.join(' ')}`;
    }

    const lastFailure = failures[failures.length - 1];
    const errorInfo: AiErrorInfo = {
      kind: lastFailure.errorInfo.kind !== 'unknown' ? lastFailure.errorInfo.kind : failures[0].errorInfo.kind,
      title: isAllRateLimited ? 'AI providers currently rate-limited' : 'AI providers unavailable',
      message: isAllRateLimited
        ? (cloudflareFailure
            ? 'All configured AI providers (Gemini, Groq, and Cloudflare) have reached their rate limits. Your saved architecture and evidence are safe.'
            : 'Both primary (Gemini) and fallback (Groq) providers have reached their rate limits. Your saved architecture and evidence are safe.')
        : 'All configured AI providers failed to process your request. Your saved project and evidence remain safe.',
      retryable: true,
      detailSafe: combinedError,
      proHint: isAllRateLimited,
    };

    return {
      success: false,
      code,
      error: combinedError,
      errorInfo,
      upstreamMs: totalUpstreamMs,
      fallbackMs,
    };
  }

  // Fallback if loop didn't run (e.g. deadline expired)
  return {
    success: false,
    code: 'PROVIDER_ERROR',
    error: 'AI request timed out before provider could respond.',
    errorInfo: {
      kind: 'timeout',
      title: 'AI request timed out',
      message: 'The AI request timed out before provider could respond.',
      retryable: true,
    },
    upstreamMs: totalUpstreamMs,
    fallbackMs,
  };
}
