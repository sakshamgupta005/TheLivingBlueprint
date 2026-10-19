/**
 * Classification, sanitization, and retry parsing for AI Provider Errors (Gemini API)
 * Follows zero-leak security rules: credentials and raw URLs are strictly redacted.
 */

import type { AiErrorInfo } from './types.ts';

export function redactSensitiveInfo(text: string, secrets: string[] = []): string {
  if (!text) return '';
  let sanitized = text;

  // Redact explicit secrets passed in
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      sanitized = sanitized.split(secret).join('[REDACTED]');
    }
  }

  // Redact query parameter API keys (e.g. ?key=AIzaSy... or &key=...)
  sanitized = sanitized.replace(/([?&]key=)[^&\s"'>]+/gi, '$1[REDACTED]');

  // Redact authorization headers / bearer tokens
  sanitized = sanitized.replace(/(Bearer\s+)[^&\s"'>]+/gi, '$1[REDACTED]');

  // Redact env var patterns like GEMINI_API_KEY=..., GROQ_API_KEY=..., CLOUDFLARE_API_TOKEN=..., etc.
  sanitized = sanitized.replace(/((?:GEMINI|GROQ|AI|GOOGLE|CLOUDFLARE)_API_KEY\s*[:=]\s*)[^\s"'>]+/gi, '$1[REDACTED]');
  sanitized = sanitized.replace(/((?:CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)\s*[:=]\s*)[^\s"'>]+/gi, '$1[REDACTED]');

  // Redact Groq API key tokens (e.g. gsk_...)
  sanitized = sanitized.replace(/(gsk_[a-zA-Z0-9_-]{16,})/gi, '[REDACTED]');

  // Redact Cloudflare account IDs in REST API paths (/accounts/{id}/ai/)
  sanitized = sanitized.replace(/(\/accounts\/)[a-zA-Z0-9_-]+(\/ai\/)/gi, '$1[REDACTED]$2');

  return sanitized;
}

export function parseRetryDelay(
  retryHeader?: string | null,
  errorDetails?: unknown[]
): number | undefined {
  // 1. Check HTTP Retry-After header
  if (retryHeader && typeof retryHeader === 'string') {
    const trimmed = retryHeader.trim();
    const parsedInt = parseInt(trimmed, 10);
    // If it's a direct integer number of seconds
    if (!isNaN(parsedInt) && parsedInt > 0 && parsedInt <= 86400) {
      return parsedInt;
    }
    // If it's an HTTP-Date format (e.g. "Wed, 21 Oct 2026 07:28:00 GMT")
    const dateParsed = Date.parse(trimmed);
    if (!isNaN(dateParsed)) {
      const deltaSec = Math.round((dateParsed - Date.now()) / 1000);
      if (deltaSec > 0 && deltaSec <= 86400) {
        return deltaSec;
      }
    }
  }

  // 2. Check structured Google RPC RetryInfo in error.details
  if (Array.isArray(errorDetails)) {
    for (const item of errorDetails) {
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        const typeStr = String(obj['@type'] || '');
        if (typeStr.includes('RetryInfo') && typeof obj.retryDelay === 'string') {
          // Format is typically "43s" or "43.123s"
          const match = obj.retryDelay.match(/^([\d.]+)s$/);
          if (match) {
            const seconds = Math.round(parseFloat(match[1]));
            if (!isNaN(seconds) && seconds > 0 && seconds <= 86400) {
              return seconds;
            }
          }
        }
      }
    }
  }

  // Return undefined if not provided. Never invent or guess a reset time!
  return undefined;
}

export function classifyGeminiError(
  status: number,
  statusText: string,
  errorBody: unknown,
  headers?: Headers | Record<string, string>,
  secrets: string[] = []
): AiErrorInfo {
  let rawMessage = '';
  let statusStr = '';
  let details: unknown[] | undefined;

  if (errorBody && typeof errorBody === 'object') {
    const obj = errorBody as Record<string, unknown>;
    const errorObj = (obj.error && typeof obj.error === 'object' ? obj.error : obj) as Record<string, unknown>;
    rawMessage = typeof errorObj.message === 'string' ? errorObj.message : '';
    statusStr = typeof errorObj.status === 'string' ? errorObj.status : '';
    if (Array.isArray(errorObj.details)) {
      details = errorObj.details;
    }
  } else if (typeof errorBody === 'string') {
    rawMessage = errorBody;
  }

  if (!rawMessage) {
    rawMessage = statusText || `HTTP ${status}`;
  }

  // Redact secrets and URLs immediately
  const sanitizedMessage = redactSensitiveInfo(rawMessage, secrets);
  const lowerMsg = sanitizedMessage.toLowerCase();
  const lowerStatus = statusStr.toLowerCase();

  // Extract Retry-After header
  let retryHeader: string | null = null;
  if (headers) {
    if (typeof (headers as Headers).get === 'function') {
      retryHeader = (headers as Headers).get('retry-after');
    } else {
      const rec = headers as Record<string, string>;
      retryHeader = rec['retry-after'] || rec['Retry-After'] || null;
    }
  }

  const retryAfterSeconds = parseRetryDelay(retryHeader, details);

  // 1. Invalid credentials, permission, or unconfigured model
  if (
    status === 400 &&
    (lowerMsg.includes('api key') || lowerMsg.includes('api_key_invalid') || lowerMsg.includes('key not valid'))
  ) {
    return {
      kind: 'config_required',
      title: 'AI configuration required',
      message: 'AI provider key is invalid or expired. Add a valid GEMINI_API_KEY to your environment variables or .env file.',
      retryable: false,
      detailSafe: `HTTP 400 API_KEY_INVALID: ${sanitizedMessage}`,
      proHint: false,
    };
  }

  if (
    status === 403 &&
    (lowerMsg.includes('permission') || lowerMsg.includes('permission_denied') || lowerStatus.includes('permission_denied'))
  ) {
    return {
      kind: 'config_required',
      title: 'AI configuration required',
      message: 'AI provider permission denied. Verify that your API key is enabled for the Generative Language API.',
      retryable: false,
      detailSafe: 'HTTP 403 PERMISSION_DENIED: Service account or API key lack permission.',
      proHint: false,
    };
  }

  if (status === 404 && (lowerMsg.includes('models/') || lowerMsg.includes('not found'))) {
    return {
      kind: 'config_required',
      title: 'AI model configuration error',
      message: `The configured AI model was not found or is unsupported by the provider: ${sanitizedMessage}`,
      retryable: false,
      detailSafe: sanitizedMessage,
      proHint: false,
    };
  }

  // 2. Rate limit vs. Quota Exhaustion vs. Billing
  if (status === 429) {
    // Check for daily quota exhaustion
    const isDailyQuota =
      lowerMsg.includes('per day') ||
      lowerMsg.includes('daily') ||
      lowerMsg.includes('requests_per_day') ||
      lowerMsg.includes('freetierperday') ||
      lowerMsg.includes('quota exceeded for quota metric') && lowerMsg.includes('day');

    if (isDailyQuota) {
      return {
        kind: 'quota_exceeded_daily',
        title: 'Daily AI usage limit reached',
        message: 'The daily usage quota for this AI model has been reached. Your scanned architecture and evidence are saved. You can continue exploring the house while AI access recovers.',
        retryAfterSeconds,
        retryable: retryAfterSeconds !== undefined,
        detailSafe: 'HTTP 429 RESOURCE_EXHAUSTED: Daily request quota exhausted.',
        proHint: true,
      };
    }

    // Check for spend or billing limits
    const isBillingLimit =
      lowerMsg.includes('billing') ||
      lowerMsg.includes('spend') ||
      lowerMsg.includes('billing_disabled') ||
      lowerMsg.includes('credit');

    if (isBillingLimit) {
      return {
        kind: 'billing_limit',
        title: 'AI billing or quota restriction',
        message: 'The AI provider account has reached its billing or spend limit. Your saved architecture and evidence are safe.',
        retryAfterSeconds: undefined,
        retryable: false,
        detailSafe: 'HTTP 429 RESOURCE_EXHAUSTED: Billing or spend quota restriction.',
        proHint: true,
      };
    }

    // Default short-term rate limit (RPM/TPM or burst rate limit)
    return {
      kind: 'rate_limit_short',
      title: 'AI is taking a short break',
      message: "We've reached the current AI usage limit. Your project and saved progress are safe. You can continue exploring the house and reviewing existing evidence while AI access recovers.",
      retryAfterSeconds,
      retryable: true,
      detailSafe: retryAfterSeconds
        ? `HTTP 429 RESOURCE_EXHAUSTED (Rate limit reached; retry delay: ${retryAfterSeconds}s)`
        : 'HTTP 429 RESOURCE_EXHAUSTED (Short-term rate limit reached)',
      proHint: true,
    };
  }

  // 3. Temporary provider overload or service unavailability
  if (status === 503 || status === 502 || status === 504 || lowerStatus.includes('unavailable')) {
    return {
      kind: 'service_unavailable',
      title: 'AI provider temporarily unavailable',
      message: 'The AI provider is experiencing temporary overload or maintenance. Your project is safe, and existing evidence remains available.',
      retryAfterSeconds,
      retryable: true,
      detailSafe: `HTTP ${status} UNAVAILABLE: Provider service temporarily overloaded.`,
      proHint: false,
    };
  }

  // 4. Bad request or payload too large
  if (status === 400 || status === 413) {
    return {
      kind: 'invalid_request',
      title: 'Request could not be processed',
      message: `The AI provider rejected the request (HTTP ${status}): ${sanitizedMessage.slice(0, 150)}`,
      retryable: false,
      detailSafe: `HTTP ${status}: ${sanitizedMessage.slice(0, 150)}`,
      proHint: false,
    };
  }

  // 5. Fallback unknown provider error
  return {
    kind: 'unknown',
    title: 'AI request could not be completed',
    message: `The AI provider was unable to complete the request (HTTP ${status}). Your saved project and evidence remain safe.`,
    retryAfterSeconds,
    retryable: true,
    detailSafe: `HTTP ${status}: ${sanitizedMessage.slice(0, 150)}`,
    proHint: false,
  };
}

export function classifyNetworkError(err: unknown, secrets: string[] = []): AiErrorInfo {
  if (err instanceof Error && err.name === 'AbortError') {
    return {
      kind: 'timeout',
      title: 'AI request timed out',
      message: 'The AI provider took too long to respond. Your workspace and findings are safe, and you can try again.',
      retryable: true,
      detailSafe: 'Request aborted due to timeout threshold.',
      proHint: false,
    };
  }

  const rawMsg = err instanceof Error ? err.message : 'Network error';
  const sanitized = redactSensitiveInfo(rawMsg, secrets);

  return {
    kind: 'network_error',
    title: 'Network connection issue',
    message: 'Unable to reach the AI provider network. Please check your internet connection.',
    retryable: true,
    detailSafe: `Network failure: ${sanitized.slice(0, 150)}`,
    proHint: false,
  };
}

export function isTransientError(errorInfo: AiErrorInfo): boolean {
  if (errorInfo.kind === 'service_unavailable') {
    return true;
  }
  if (errorInfo.kind === 'rate_limit_short' && errorInfo.retryAfterSeconds !== undefined && errorInfo.retryAfterSeconds <= 2) {
    return true;
  }
  return false;
}

export function calculateBackoffWithJitter(attempt: number, baseMs = 500, maxMs = 2000): number {
  const exp = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1));
  const jitter = Math.floor(Math.random() * 150);
  return exp + jitter;
}

export function classifyGroqError(
  status: number,
  statusText: string,
  errorBody: unknown,
  headers?: Headers | Record<string, string>,
  secrets: string[] = []
): AiErrorInfo {
  let rawMessage = '';
  let errorCode = '';

  if (errorBody && typeof errorBody === 'object') {
    const obj = errorBody as Record<string, unknown>;
    const errorObj = (obj.error && typeof obj.error === 'object' ? obj.error : obj) as Record<string, unknown>;
    rawMessage = typeof errorObj.message === 'string' ? errorObj.message : '';
    errorCode = typeof errorObj.code === 'string' ? errorObj.code : '';
  } else if (typeof errorBody === 'string') {
    rawMessage = errorBody;
  }

  if (!rawMessage) {
    rawMessage = statusText || `HTTP ${status}`;
  }

  const sanitizedMessage = redactSensitiveInfo(rawMessage, secrets);
  const lowerMsg = sanitizedMessage.toLowerCase();

  let retryHeader: string | null = null;
  if (headers) {
    if (typeof (headers as Headers).get === 'function') {
      retryHeader = (headers as Headers).get('retry-after');
    } else {
      const rec = headers as Record<string, string>;
      retryHeader = rec['retry-after'] || rec['Retry-After'] || null;
    }
  }

  const retryAfterSeconds = parseRetryDelay(retryHeader);

  // 1. Invalid API key or unauthorized
  if (
    status === 401 ||
    (status === 400 && (lowerMsg.includes('api key') || errorCode === 'invalid_api_key'))
  ) {
    return {
      kind: 'config_required',
      title: 'Groq configuration required',
      message: 'Groq API key is invalid or unauthorized. Add a valid GROQ_API_KEY to your environment variables or .env file.',
      retryable: false,
      detailSafe: `HTTP ${status} UNAUTHORIZED: ${sanitizedMessage}`,
      proHint: false,
    };
  }

  // 2. Model not found
  if (status === 404 || lowerMsg.includes('model_not_found') || errorCode === 'model_not_found') {
    return {
      kind: 'config_required',
      title: 'Groq model configuration error',
      message: `The configured Groq model was not found or is unsupported: ${sanitizedMessage}`,
      retryable: false,
      detailSafe: sanitizedMessage,
      proHint: false,
    };
  }

  // 3. Rate limiting and quota
  if (status === 429 || errorCode === 'rate_limit_exceeded') {
    const isDaily = lowerMsg.includes('day') || lowerMsg.includes('daily') || lowerMsg.includes('rpd');
    if (isDaily) {
      return {
        kind: 'quota_exceeded_daily',
        title: 'Daily Groq usage limit reached',
        message: 'The daily usage quota for Groq has been reached. Your scanned architecture and evidence are saved.',
        retryAfterSeconds,
        retryable: retryAfterSeconds !== undefined,
        detailSafe: 'HTTP 429: Daily request quota exhausted on Groq.',
        proHint: true,
      };
    }

    return {
      kind: 'rate_limit_short',
      title: 'Groq is taking a short break',
      message: "Groq's short-term rate limit has been reached. Your project and saved progress are safe.",
      retryAfterSeconds,
      retryable: true,
      detailSafe: retryAfterSeconds
        ? `HTTP 429 RATE_LIMIT_EXCEEDED (Retry delay: ${retryAfterSeconds}s)`
        : 'HTTP 429 RATE_LIMIT_EXCEEDED',
      proHint: true,
    };
  }

  // 4. Overload or temporary unavailability
  if (status === 503 || status === 502 || status === 504 || status === 500) {
    return {
      kind: 'service_unavailable',
      title: 'Groq temporarily unavailable',
      message: 'Groq is experiencing temporary overload or maintenance. Your project is safe.',
      retryAfterSeconds,
      retryable: true,
      detailSafe: `HTTP ${status}: Groq service temporarily unavailable.`,
      proHint: false,
    };
  }

  // 5. Bad request
  if (status === 400 || status === 413) {
    return {
      kind: 'invalid_request',
      title: 'Groq request could not be processed',
      message: `Groq rejected the request (HTTP ${status}): ${sanitizedMessage.slice(0, 150)}`,
      retryable: false,
      detailSafe: `HTTP ${status}: ${sanitizedMessage.slice(0, 150)}`,
      proHint: false,
    };
  }

  // 6. Fallback unknown error
  return {
    kind: 'unknown',
    title: 'Groq request could not be completed',
    message: `Groq was unable to complete the request (HTTP ${status}). Your saved project and evidence remain safe.`,
    retryAfterSeconds,
    retryable: true,
    detailSafe: `HTTP ${status}: ${sanitizedMessage.slice(0, 150)}`,
    proHint: false,
  };
}

export function classifyCloudflareError(
  status: number,
  statusText: string,
  errorBody: unknown,
  headers?: Headers | Record<string, string>,
  secrets: string[] = []
): AiErrorInfo {
  let rawMessage = '';
  let errorCode = '';

  if (errorBody && typeof errorBody === 'object') {
    const obj = errorBody as Record<string, unknown>;
    if (Array.isArray(obj.errors) && obj.errors.length > 0) {
      const errs = obj.errors as Array<Record<string, unknown>>;
      rawMessage = errs.map((e) => String(e.message || '')).filter(Boolean).join('; ');
      errorCode = String(errs[0]?.code || '');
    } else if (obj.error) {
      rawMessage = typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error);
    } else if (typeof obj.message === 'string') {
      rawMessage = obj.message;
    }
  } else if (typeof errorBody === 'string') {
    rawMessage = errorBody;
  }

  if (!rawMessage) {
    rawMessage = statusText || `HTTP ${status}`;
  }

  const sanitizedMessage = redactSensitiveInfo(rawMessage, secrets);
  const lowerMsg = sanitizedMessage.toLowerCase();

  let retryHeader: string | null = null;
  if (headers) {
    if (typeof (headers as Headers).get === 'function') {
      retryHeader = (headers as Headers).get('retry-after');
    } else {
      const rec = headers as Record<string, string>;
      retryHeader = rec['retry-after'] || rec['Retry-After'] || null;
    }
  }

  const retryAfterSeconds = parseRetryDelay(retryHeader);

  // 1. Invalid API token, account ID, unauthorized or forbidden
  if (
    status === 401 ||
    status === 403 ||
    (status === 400 && (lowerMsg.includes('auth') || lowerMsg.includes('token') || errorCode === '10000'))
  ) {
    return {
      kind: 'config_required',
      title: 'Cloudflare configuration required',
      message: 'Cloudflare API token or account ID is invalid or unauthorized. Add valid CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to your environment variables or .env file.',
      retryable: false,
      detailSafe: `HTTP ${status} UNAUTHORIZED: ${sanitizedMessage}`,
      proHint: false,
    };
  }

  // 2. Model not found or account not found
  if (status === 404 || lowerMsg.includes('not found') || lowerMsg.includes('unknown model') || errorCode === '7000') {
    return {
      kind: 'config_required',
      title: 'Cloudflare model configuration error',
      message: `The configured Cloudflare AI model or account was not found: ${sanitizedMessage}`,
      retryable: false,
      detailSafe: sanitizedMessage,
      proHint: false,
    };
  }

  // 3. Rate limiting and quota
  if (status === 429 || errorCode === 'rate_limit' || errorCode === '10014') {
    const isDaily = lowerMsg.includes('day') || lowerMsg.includes('daily') || lowerMsg.includes('quota');
    if (isDaily) {
      return {
        kind: 'quota_exceeded_daily',
        title: 'Daily Cloudflare usage limit reached',
        message: 'The daily usage quota for Cloudflare Workers AI has been reached. Your scanned architecture and evidence are saved.',
        retryAfterSeconds,
        retryable: retryAfterSeconds !== undefined,
        detailSafe: 'HTTP 429: Daily request quota exhausted on Cloudflare Workers AI.',
        proHint: true,
      };
    }

    return {
      kind: 'rate_limit_short',
      title: 'Cloudflare is taking a short break',
      message: "Cloudflare Workers AI rate limit has been reached. Your project and saved progress are safe.",
      retryAfterSeconds,
      retryable: true,
      detailSafe: retryAfterSeconds
        ? `HTTP 429 RATE_LIMIT_EXCEEDED (Retry delay: ${retryAfterSeconds}s)`
        : 'HTTP 429 RATE_LIMIT_EXCEEDED',
      proHint: true,
    };
  }

  // 4. Overload, capacity or temporary unavailability
  if (status === 503 || status === 502 || status === 504 || status === 500) {
    return {
      kind: 'service_unavailable',
      title: 'Cloudflare temporarily unavailable',
      message: 'Cloudflare Workers AI is experiencing temporary overload or capacity issues. Your project is safe.',
      retryAfterSeconds,
      retryable: true,
      detailSafe: `HTTP ${status}: Cloudflare Workers AI service temporarily unavailable.`,
      proHint: false,
    };
  }

  // 5. Bad request / invalid input
  if (status === 400 || status === 413) {
    return {
      kind: 'invalid_request',
      title: 'Cloudflare request could not be processed',
      message: `Cloudflare Workers AI rejected the request (HTTP ${status}): ${sanitizedMessage.slice(0, 150)}`,
      retryable: false,
      detailSafe: `HTTP ${status}: ${sanitizedMessage.slice(0, 150)}`,
      proHint: false,
    };
  }

  // 6. Fallback unknown error
  return {
    kind: 'unknown',
    title: 'Cloudflare request could not be completed',
    message: `Cloudflare Workers AI was unable to complete the request (HTTP ${status}). Your saved project and evidence remain safe.`,
    retryAfterSeconds,
    retryable: true,
    detailSafe: `HTTP ${status}: ${sanitizedMessage.slice(0, 150)}`,
    proHint: false,
  };
}


