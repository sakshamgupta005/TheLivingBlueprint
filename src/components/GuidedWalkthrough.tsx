import React from 'react';
import type { WalkthroughEvaluationResult, WalkthroughStep } from '../domain/walkthrough/types.ts';

interface GuidedWalkthroughProps {
  evaluation: WalkthroughEvaluationResult;
  isOpen: boolean;
  onToggleOpen: () => void;
  onAction?: (actionId: NonNullable<WalkthroughStep['actionId']>) => void;
}

export const GuidedWalkthrough: React.FC<GuidedWalkthroughProps> = ({
  evaluation,
  isOpen,
  onToggleOpen,
  onAction,
}) => {
  const { steps, completedCount, totalCount, isAllCompleted } = evaluation;
  const progressPct = Math.round((completedCount / totalCount) * 100);

  if (!isOpen) {
    return (
      <div className="walkthrough-pill-dock" role="region" aria-label="Guided Walkthrough Trigger">
        <button
          type="button"
          className={`btn-walkthrough-pill ${isAllCompleted ? 'all-complete' : ''}`}
          onClick={onToggleOpen}
          title="Open guided demonstration walkthrough"
          aria-expanded="false"
        >
          <span className="pill-icon">📋</span>
          <span className="pill-label">Demo Walkthrough</span>
          <span className="pill-badge">
            {completedCount}/{totalCount}
          </span>
          <span className="pill-action-hint">Open guide →</span>
        </button>
      </div>
    );
  }

  return (
    <aside
      className="guided-walkthrough-panel"
      role="region"
      aria-label="Guided Demonstration Walkthrough"
    >
      <div className="walkthrough-header">
        <div className="walkthrough-header-left">
          <span className="walkthrough-icon">📋</span>
          <div>
            <h3 className="walkthrough-title">Presenter Demonstration Walkthrough</h3>
            <div className="walkthrough-progress-text">
              {completedCount} of {totalCount} steps completed ({progressPct}%)
            </div>
          </div>
        </div>

        <div className="walkthrough-header-actions">
          <button
            type="button"
            className="btn-minimize-walkthrough"
            onClick={onToggleOpen}
            title="Minimize walkthrough"
            aria-label="Minimize walkthrough"
          >
            — Minimize
          </button>
        </div>
      </div>

      <div className="walkthrough-progress-bar-track">
        <div
          className="walkthrough-progress-bar-fill"
          style={{ width: `${progressPct}%` }}
          role="progressbar"
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>

      <ol className="walkthrough-steps-list">
        {steps.map((step) => {
          const isDone = step.isComplete;
          return (
            <li
              key={step.id}
              className={`walkthrough-step-item ${isDone ? 'step-complete' : 'step-pending'}`}
            >
              <div className="step-indicator-col">
                <span className={`step-badge-circle ${isDone ? 'badge-done' : 'badge-pending'}`}>
                  {isDone ? '✓' : step.number}
                </span>
              </div>

              <div className="step-content-col">
                <div className="step-title-row">
                  <span className="step-title-text">{step.title}</span>
                  {isDone && <span className="step-verified-tag">Completed</span>}
                </div>

                <p className="step-description">{step.description}</p>

                <div className="step-status-note">
                  <span className="note-label">State:</span> {step.statusNote}
                </div>

                {!isDone && step.actionLabel && step.actionId && onAction && (
                  <div className="step-action-row">
                    <button
                      type="button"
                      className="btn-step-action"
                      onClick={() => step.actionId && onAction(step.actionId)}
                    >
                      {step.actionLabel} →
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="walkthrough-footer">
        <span className="walkthrough-footer-note">
          Tracks actual scan results, genuine CI check runs, and live AI responses without faking.
        </span>
        <button
          type="button"
          className="btn-dismiss-walkthrough"
          onClick={onToggleOpen}
          title="Dismiss walkthrough"
        >
          Dismiss
        </button>
      </div>
    </aside>
  );
};
