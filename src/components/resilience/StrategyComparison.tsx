import React, { useState } from 'react';
import type {
  AppliedOutcome,
  RecoveryScoreWeights,
  RecoveryStrategyId,
  StrategyOutcome,
} from '../../domain/resilience/types.ts';

interface StrategyComparisonProps {
  strategies: StrategyOutcome[];
  baseline?: StrategyOutcome | null;
  recommendedStrategyId: RecoveryStrategyId | null;
  recommendedReason: string;
  weights: RecoveryScoreWeights;
  onApplyStrategy: (strategyId: RecoveryStrategyId, targetServiceId: string) => void;
  onPreviewStrategy?: (strategyId: string | null) => void;
  appliedStrategyId?: RecoveryStrategyId | null;
  applied?: AppliedOutcome | null;
  onClearStrategy?: () => void;
}

const ICON: Record<string, string> = {
  restart: '↻',
  rollback: '⎌',
  scale_out: '⇲',
  isolate: '⛔',
  failover: '⇆',
  rate_limit: '⏳',
};

const riskLabel = (r: number) => (r < 0.25 ? 'Low' : r < 0.45 ? 'Medium' : 'High');

export const StrategyComparison: React.FC<StrategyComparisonProps> = ({
  strategies,
  baseline,
  recommendedStrategyId,
  recommendedReason,
  weights,
  onApplyStrategy,
  onPreviewStrategy,
  appliedStrategyId,
  applied,
  onClearStrategy,
}) => {
  const [showWeights, setShowWeights] = useState(false);
  const before = baseline?.affectedCount ?? 0;
  const scale = Math.max(1, before, ...strategies.map((s) => s.affectedCount));

  const appliedStatus = applied
    ? applied.state === 'contained'
      ? `Contained ✓ at t=${applied.containedAtTick ?? applied.tick}`
      : applied.state === 'spread'
        ? `Still down: ${applied.stillFailedServiceIds.join(', ') || 'none'}`
        : 'Applied · watching…'
    : 'Contained ✓';

  return (
    <section className="resilience-panel sc-panel" aria-label="Recovery strategies">
      <header className="sc-header">
        <div>
          <h3 className="cg-title">Recovery strategies</h3>
          <p className="cg-subtitle">Each fix is replayed on the simulated system. Compare blast reduction, recovery time, and tradeoffs.</p>
        </div>
        <button type="button" className="cg-btn" aria-expanded={showWeights} onClick={() => setShowWeights((v) => !v)}>
          ⚙ How we score
        </button>
      </header>

      {showWeights && (
        <p className="sc-weights">
          Score = {weights.blast} × fewer services down + {weights.residual} × less leftover damage + {weights.recovery} × faster recovery +{' '}
          {weights.sideEffect} × fewer side effects.
        </p>
      )}

      {/* Prominent Contained Status Banner if Fix Applied */}
      {applied?.state === 'contained' && (
        <div className="strategy-contained-hero-banner" role="status">
          <span>✓ <strong>Incident Contained:</strong> Contained ✓ at t={applied.containedAtTick ?? applied.tick} with {strategies.find(s => s.strategyId === applied.strategyId)?.name || 'recovery strategy'}.</span>
        </div>
      )}

      {strategies.length === 0 ? (
        <p className="sc-empty">{recommendedReason}</p>
      ) : (
        <>
          <p className="sc-why">
            <strong>Why the top pick:</strong> {recommendedReason}
          </p>
          <ul className="sc-list">
            {strategies.map((o) => {
              const id = o.strategyId as RecoveryStrategyId;
              const isBest = id === recommendedStrategyId;
              const isApplied = id === appliedStrategyId;
              const switching = Boolean(appliedStrategyId) && !isApplied;
              return (
                <li
                  key={id}
                  className={`sc-card ${isBest ? 'sc-card--best' : ''} ${isApplied ? `sc-card--applied sc-card--${applied?.state ?? 'watching'}` : ''}`}
                  onMouseEnter={() => onPreviewStrategy?.(id)}
                  onMouseLeave={() => onPreviewStrategy?.(null)}
                  onFocus={() => onPreviewStrategy?.(id)}
                  onBlur={() => onPreviewStrategy?.(null)}
                >
                  <div className="sc-card__head">
                    <span className="sc-card__icon" aria-hidden="true">
                      {ICON[id] ?? '•'}
                    </span>
                    <span className="sc-card__name">{o.name}</span>
                    <span className="sc-card__target">on {o.targetServiceId}</span>
                    {isBest && <span className="sc-chip sc-chip--best">★ Recommended</span>}
                  </div>

                  {/* before → after rooms */}
                  <div className="sc-card__rooms-flow">
                    <span className="rooms-flow-label">Affected rooms:</span>
                    <span className="rooms-flow-val">{before} → {o.affectedCount} rooms</span>
                    {o.servicesSaved > 0 && <span className="rooms-saved-pill">+{o.servicesSaved} saved</span>}
                  </div>

                  <div className="sc-bars" aria-label={`${before} services down without a fix, ${o.affectedCount} with ${o.name}`}>
                    <div className="sc-bar">
                      <span className="sc-bar__label">No fix</span>
                      <span className="sc-bar__track">
                        <span className="sc-bar__fill sc-bar__fill--before" style={{ width: `${(before / scale) * 100}%` }} />
                      </span>
                      <span className="sc-bar__num">{before}</span>
                    </div>
                    <div className="sc-bar">
                      <span className="sc-bar__label">With fix</span>
                      <span className="sc-bar__track">
                        <span className="sc-bar__fill sc-bar__fill--after" style={{ width: `${(o.affectedCount / scale) * 100}%` }} />
                      </span>
                      <span className="sc-bar__num">{o.affectedCount}</span>
                    </div>
                  </div>

                  <div className="sc-card__facts">
                    <span>{o.timeToRecoverTicks !== null ? `Recovers in ~${o.timeToRecoverTicks} ticks` : 'No recovery in 30 ticks'}</span>
                    <span className={`sc-chip sc-chip--risk-${riskLabel(o.sideEffectRisk).toLowerCase()}`}>
                      {riskLabel(o.sideEffectRisk)} side effect
                    </span>
                  </div>
                  <p className="sc-card__tradeoff" title={o.assumptions.join(' ')}>
                    {o.tradeoffs[0] || 'Clean containment with no side effects.'}
                  </p>

                  {isApplied ? (
                    <div className="sc-applied-row">
                      <span className="sc-apply sc-apply--status" role="status">
                        {appliedStatus}
                      </span>
                      {onClearStrategy && (
                        <button type="button" className="sc-undo" onClick={onClearStrategy}>
                          Undo
                        </button>
                      )}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={`sc-apply ${isBest && !switching ? 'sc-apply--primary' : ''}`}
                      onClick={() => onApplyStrategy(id, o.targetServiceId)}
                      title={switching && applied ? `Rewinds to t=${applied.tick} and replays with ${o.name}` : undefined}
                    >
                      {switching ? `Try ${o.name} instead` : `Apply ${o.name}`}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
};
