import React, { useState, useEffect } from 'react';
import type { AiErrorInfo } from '../server/types.ts';

export interface AiUsageLimitNoticeProps {
  errorInfo?: AiErrorInfo | null;
  errorMessage?: string | null;
  onRetry?: () => void;
  onDismiss?: () => void;
  isLoading?: boolean;
  onExploreRoom?: () => void;
  onViewEvidence?: () => void;
  hasSelectedRoom?: boolean;
  selectedRoomName?: string;
  contextType?: 'chat' | 'investigation';
}

export const AiUsageLimitNotice: React.FC<AiUsageLimitNoticeProps> = ({
  errorInfo,
  errorMessage,
  onRetry,
  onDismiss,
  isLoading = false,
  onExploreRoom,
  onViewEvidence,
  hasSelectedRoom = false,
  selectedRoomName,
  contextType = 'chat',
}) => {
  const [countdown, setCountdown] = useState<number | null>(() => {
    return errorInfo?.retryAfterSeconds && errorInfo.retryAfterSeconds > 0
      ? errorInfo.retryAfterSeconds
      : null;
  });

  useEffect(() => {
    if (errorInfo?.retryAfterSeconds && errorInfo.retryAfterSeconds > 0) {
      setCountdown(errorInfo.retryAfterSeconds);
      const interval = setInterval(() => {
        setCountdown((prev) => {
          if (prev === null || prev <= 1) {
            clearInterval(interval);
            return null;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(interval);
    } else {
      setCountdown(null);
    }
  }, [errorInfo?.retryAfterSeconds]);

  // Determine presentation level: rate limit / quota vs. genuine failure
  const isRateLimitOrQuota =
    errorInfo?.kind === 'rate_limit_short' ||
    errorInfo?.kind === 'quota_exceeded_daily' ||
    errorInfo?.kind === 'billing_limit';

  const isUnavailable = errorInfo?.kind === 'service_unavailable';
  const isTimeout = errorInfo?.kind === 'timeout';

  const isMutedUsageState = isRateLimitOrQuota || isUnavailable || isTimeout;

  const title =
    errorInfo?.title ||
    (isRateLimitOrQuota ? 'AI is taking a short break' : 'AI Request Notice');

  const message =
    errorInfo?.message ||
    errorMessage ||
    "We've reached the current AI usage limit. Your project and saved progress are safe. You can continue exploring the house and reviewing existing evidence while AI access recovers.";

  const isRetryable = errorInfo ? errorInfo.retryable : true;
  const retryDisabled = isLoading || (countdown !== null && countdown > 0);

  const retryButtonClass =
    contextType === 'investigation' ? 'btn-retry-investigate' : 'btn-retry-chat';

  return (
    <div
      className={`ai-usage-limit-card ${isMutedUsageState ? 'kind-usage-limit' : 'kind-failure'} ${
        contextType === 'investigation' ? 'room-error-banner' : 'chat-error-toast'
      }`}
      role="alert"
      aria-live="polite"
    >
      <div className="ai-usage-limit-header">
        <div className="ai-usage-limit-title">
          <span className="ai-usage-icon" aria-hidden="true">
            {isRateLimitOrQuota ? '☕' : isUnavailable ? '⏳' : '⚠️'}
          </span>
          <span>{title}</span>
        </div>
        {onDismiss && (
          <button
            type="button"
            className="error-dismiss-btn"
            onClick={onDismiss}
            aria-label="Dismiss notice"
            title="Dismiss notice"
          >
            ✕
          </button>
        )}
      </div>

      <p className="ai-usage-limit-message">{message}</p>

      {/* Reset timing information */}
      {countdown !== null && countdown > 0 ? (
        <div className="ai-usage-limit-timing">
          <span className="timing-countdown">⏳ Retry available in {countdown}s</span>
        </div>
      ) : isRateLimitOrQuota && errorInfo?.retryAfterSeconds === undefined ? (
        <div className="ai-usage-limit-timing">
          <span className="timing-note">Note: Provider did not supply a specific reset window.</span>
        </div>
      ) : null}

      {/* Action buttons: Try Again & Local Actions */}
      <div className="ai-usage-limit-actions">
        {isRetryable && onRetry && (
          <button
            type="button"
            className={retryButtonClass}
            onClick={onRetry}
            disabled={retryDisabled}
            title={
              retryDisabled && countdown !== null
                ? `Retry will unlock in ${countdown}s`
                : 'Retry sending this request'
            }
          >
            {isLoading ? 'Retrying...' : countdown !== null ? `Try again (${countdown}s)` : 'Try again'}
          </button>
        )}

        {hasSelectedRoom && onExploreRoom && (
          <button
            type="button"
            className="btn-local-explore"
            onClick={onExploreRoom}
            title={`Focus on ${selectedRoomName || 'this room'}`}
          >
            Explore {selectedRoomName ? selectedRoomName : 'this room'} →
          </button>
        )}

        {onViewEvidence && (
          <button
            type="button"
            className="btn-local-explore"
            onClick={onViewEvidence}
            title="Review inspected files and verification status"
          >
            View existing evidence →
          </button>
        )}
      </div>

      {/* Planned Pro Plan informational element */}
      {errorInfo?.proHint && (
        <div className="pro-plan-notice" role="note" aria-label="Pro plan information">
          <div className="pro-plan-header">
            <span className="pro-plan-badge">Pro plan coming soon</span>
          </div>
          <p className="pro-plan-text">Designed for people who need higher AI usage limits.</p>
        </div>
      )}

      {/* Diagnostic details disclosure without exposing secrets */}
      <details className="ai-diagnostic-disclosure">
        <summary className="ai-diagnostic-summary">Diagnostic details</summary>
        <div className="ai-diagnostic-content">
          <div className="diagnostic-row">
            <span className="diagnostic-label">Category:</span>
            <span className="diagnostic-value">
              {errorInfo?.kind === 'rate_limit_short'
                ? 'Short-term rate limit (per-minute or burst)'
                : errorInfo?.kind === 'quota_exceeded_daily'
                ? 'Daily quota exhausted'
                : errorInfo?.kind === 'billing_limit'
                ? 'Billing or credit restriction'
                : errorInfo?.kind === 'service_unavailable'
                ? 'Provider service temporarily unavailable'
                : errorInfo?.kind === 'config_required'
                ? 'Configuration or API key required'
                : errorInfo?.kind === 'timeout'
                ? 'Request timed out'
                : errorInfo?.kind || 'Standard rate limit'}
            </span>
          </div>
          <div className="diagnostic-row">
            <span className="diagnostic-label">Reset info:</span>
            <span className="diagnostic-value">
              {errorInfo?.retryAfterSeconds !== undefined
                ? `${errorInfo.retryAfterSeconds}s (from provider metadata)`
                : 'No reset window supplied by provider'}
            </span>
          </div>
          {errorInfo?.detailSafe && (
            <div className="diagnostic-row">
              <span className="diagnostic-label">Provider diagnosis:</span>
              <span className="diagnostic-value">{errorInfo.detailSafe}</span>
            </div>
          )}
        </div>
      </details>
    </div>
  );
};
