import React, { useEffect, useState } from 'react';
import type { RecoveryStrategyId, ResilienceSnapshot } from '../../domain/resilience/types.ts';
import { buildIncidentReport, evaluateScenarios } from '../../domain/resilience/index.ts';

interface IncidentBriefProps {
  snapshot: ResilienceSnapshot;
  focusId: string | null;
  onClearFocus: () => void;
  onApply: (strategyId: RecoveryStrategyId, targetServiceId: string) => void;
  onCompare: () => void;
  onUndo?: () => void;
  onAsk?: (question: string) => void;
  isPlaying?: boolean;
  onPlay?: () => void;
  /** Present only when the focused service is a room on the house. */
  onOpenRoom?: () => void;
}

const fmt = (ticks: number, tickSeconds: number) => {
  const s = ticks * tickSeconds;
  return s >= 60 ? `~${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}` : `~${s}s`;
};

/** The problem statement in one place: what will fail, why, and the fix to apply. Display only. */
export const IncidentBrief: React.FC<IncidentBriefProps> = ({ snapshot, focusId, onClearFocus, onApply, onCompare, onUndo, onAsk, onOpenRoom, isPlaying, onPlay }) => {
  const { forecast, rootCause, recovery, cascade, scenario } = snapshot;
  const nameOf = (id: string | null | undefined) => snapshot.services.find((s) => s.id === id)?.name ?? id ?? '';
  const focus = focusId ? snapshot.services.find((s) => s.id === focusId) ?? null : null;
  const top = rootCause.candidates[0] ?? null;
  const focusCandidate = focus ? rootCause.candidates.find((c) => c.serviceId === focus.id) ?? null : null;
  // Root cause is always the top candidate; a focused non-root service explains how it is affected.
  const affectedBy = focusCandidate && focusCandidate.rank !== 1 ? focusCandidate : null;
  const reasonSource = affectedBy ?? top;
  const evidence = top?.evidence.find((e) => e.kind === 'log') ?? top?.evidence[0];
  // Engine reasons use service ids; show names.
  const readable = (text: string) =>
    snapshot.services.reduce((t, s) => t.split(s.id).join(s.name), text);
  const best = recovery.outcomes[0] ?? null;
  const base = recovery.baseline;
  const applied = snapshot.applied;
  const learning = rootCause.status === 'insufficient_evidence';
  // Measured once: every built-in scenario replayed against its known root cause.
  const [evals, setEvals] = useState<ReturnType<typeof evaluateScenarios>>([]);
  useEffect(() => {
    const timer = window.setTimeout(() => setEvals(evaluateScenarios()), 300);
    return () => window.clearTimeout(timer);
  }, []);
  const [showEvals, setShowEvals] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(buildIncidentReport(snapshot));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      downloadReport(); // clipboard blocked: fall back to a file
    }
  };
  const downloadReport = () => {
    const url = URL.createObjectURL(new Blob([buildIncidentReport(snapshot)], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `incident-${scenario.id}-t${snapshot.tick}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const rcOk = evals.filter((e) => e.rootCauseCorrect).length;
  const leads = evals.map((e) => e.leadTimeSeconds ?? 0);
  const avgLead = Math.round(leads.reduce((a, b) => a + b, 0) / Math.max(1, leads.length));
  const without = evals.reduce((a, e) => a + e.failuresWithoutAction, 0);
  const withFix = evals.reduce((a, e) => a + e.failuresWithFix, 0);

  // Column 1: what will fail.
  let riskHead: string;
  let riskSub: string;
  if (focus) {
    riskHead = focus.observedFailed
      ? `${focus.name} is down`
      : focus.etaTicks !== null
        ? `${focus.name} fails in ${fmt(focus.etaTicks, scenario.tickSeconds)}`
        : `${focus.name}: ${focus.tier === 'healthy' ? 'healthy' : `${focus.tier} risk, no failure expected yet`}`;
    riskSub = `Risk ${Math.round(focus.risk * 100)}% (relative)`;
  } else if (learning) {
    riskHead = 'Learning normal traffic…';
    riskSub = 'Warnings start once a baseline is known.';
  } else if (forecast.next) {
    const n = forecast.next;
    riskHead = n.etaTicks !== null ? `${nameOf(n.serviceId)} fails in ${fmt(n.etaTicks, scenario.tickSeconds)}` : `${nameOf(n.serviceId)} is drifting`;
    riskSub = n.basis;
  } else {
    const down = snapshot.services.filter((s) => s.observedFailed);
    riskHead = down.length ? `${down.map((d) => d.name).join(', ')} down` : 'No failure expected';
    riskSub = down.length
      ? recovery.outcomes.length
        ? 'Apply a fix to stop the spread.'
        : 'Failing in the analyzed logs.'
      : 'All services are within their normal range.';
  }

  return (
    <section className="ib" aria-label="Incident brief">
      <header className="ib__head">
        <span className="ib__title">Incident brief</span>
        <span className="ib__meta">
          {scenario.name} · t={snapshot.tick} · {scenario.id === 'uploaded-logs' ? 'analyzed' : 'simulated'}
        </span>
        <span className="ib__report">
          <button type="button" className="ib__link" onClick={copyReport}>
            {copied ? 'Copied ✓' : 'Copy report'}
          </button>
          <button type="button" className="ib__link" onClick={downloadReport}>
            Download .md
          </button>
        </span>
        {focus && (
          <span className="ib__focus">
            Focused on {focus.name}
            {onOpenRoom && (
              <button type="button" className="ib__link" onClick={onOpenRoom}>
                Room details
              </button>
            )}
            <button type="button" className="ib__link" onClick={onClearFocus} aria-label="Clear focus">
              ✕
            </button>
          </span>
        )}
      </header>

      {evals.length > 0 && (
      <p className="ib__check">
        Engine check on {evals.length} scenarios: root cause {rcOk}/{evals.length} · warns {fmt(avgLead / scenario.tickSeconds, scenario.tickSeconds)} early on average ·
        recommended fix {without} → {withFix} failed services{' '}
        <button type="button" className="ib__link" aria-expanded={showEvals} onClick={() => setShowEvals((v) => !v)}>
          {showEvals ? 'Hide' : 'Details'}
        </button>
      </p>
      )}
      {showEvals && (
        <table className="ib__table">
          <thead>
            <tr>
              <th>Scenario</th>
              <th>Root cause</th>
              <th>Warning before failure</th>
              <th>Failed services: no fix → fix</th>
              <th>Fix used</th>
            </tr>
          </thead>
          <tbody>
            {evals.map((e) => (
              <tr key={e.scenarioId}>
                <td>{e.name}</td>
                <td>{e.rootCauseCorrect ? '✓ correct' : '✗ missed'}</td>
                <td>{e.leadTimeSeconds !== null ? fmt(e.leadTimeSeconds / scenario.tickSeconds, scenario.tickSeconds) : 'none'}</td>
                <td>
                  {e.failuresWithoutAction} → {e.failuresWithFix}
                </td>
                <td>{e.recommendedId?.replace('_', ' ') ?? 'none'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!isPlaying && snapshot.tick === 0 && onPlay && (
        <p className="ib__hint">
          Paused at the start.{' '}
          <button type="button" className="ib__apply" onClick={onPlay}>
            ▶ Start simulation
          </button>
        </p>
      )}
      {scenario.isScannedRepo && (
        <p className="ib__check">
          Your repo: links between rooms are inferred from code (or assumed from layers), so they are treated as weak. Expect risk to
          ripple outward rather than every room failing.
        </p>
      )}
      <div className="ib__cols">
        <div className={`ib__col ib__col--${focus?.tier ?? forecast.next?.tier ?? 'healthy'}`}>
          <span className="ib__label">What will fail</span>
          <p className="ib__headline">{riskHead}</p>
          {riskSub && <p className="ib__text">{riskSub}</p>}
          {cascade.path.length > 1 && (
            <p className="ib__text">
              Spread if nothing is done: {cascade.path.map(nameOf).join(' → ')} ({cascade.affectedCount} of {cascade.totalServices})
            </p>
          )}
        </div>

        <div className="ib__col">
          <span className="ib__label">Why</span>
          {top && reasonSource ? (
            <>
              <p className="ib__headline">
                Root cause: {nameOf(top.serviceId)} <span className="ib__muted">({Math.round(top.confidence * 100)}% of evidence)</span>
              </p>
              {affectedBy && <p className="ib__text">How {nameOf(affectedBy.serviceId)} is affected:</p>}
              <ul className="ib__reasons">
                {reasonSource.reasons.slice(0, 2).map((r) => (
                  <li key={r}>{readable(r)}</li>
                ))}
              </ul>
              {evidence && (
                <code className="ib__evidence" title={evidence.text}>
                  t={evidence.tick} {evidence.text}
                </code>
              )}
              {onAsk && (
                <button
                  type="button"
                  className="ib__link ib__ask"
                  onClick={() =>
                    onAsk(
                      `Explain in plain English why ${nameOf(top.serviceId)} is the root cause${focus && focus.id !== top.serviceId ? ` and how it affects ${focus.name}` : ''}, how the failure spreads, and why ${best ? best.name : 'the recommended fix'} is the best fix.`
                    )
                  }
                >
                  Ask Barkley why →
                </button>
              )}
            </>
          ) : (
            <p className="ib__text">{learning ? 'Not enough data yet.' : 'No anomaly detected.'}</p>
          )}
        </div>

        <div className="ib__col">
          <span className="ib__label">Fix</span>
          {best && base ? (
            <>
              <p className="ib__headline">
                {best.name} <span className="ib__muted">on {nameOf(best.targetServiceId)}</span>
              </p>
              <p className="ib__text">
                {base.affectedCount} → {best.affectedCount} services down
                {best.timeToRecoverTicks !== null ? ` · recovers in ~${best.timeToRecoverTicks} ticks` : ''}
              </p>
              <p className="ib__text ib__muted">{best.tradeoffs[0]}</p>
              <div className="ib__actions">
                {applied ? (
                  <span className={`ib__status ib__status--${applied.state}`}>
                    {applied.state === 'contained'
                      ? `✓ Contained at t=${applied.containedAtTick}`
                      : applied.state === 'spread'
                        ? '✗ Did not stop the spread'
                        : `Applying ${applied.strategyId.replace('_', ' ')}…`}
                  </span>
                ) : (
                  <button type="button" className="ib__apply" onClick={() => onApply(best.strategyId as RecoveryStrategyId, best.targetServiceId)}>
                    Apply fix
                  </button>
                )}
                {applied && onUndo && (
                  <button type="button" className="ib__link" onClick={onUndo}>
                    Undo
                  </button>
                )}
                <button type="button" className="ib__link" onClick={onCompare}>
                  {applied ? 'Try another fix →' : `Compare all ${recovery.outcomes.length} →`}
                </button>
              </div>
            </>
          ) : (
            <p className="ib__text">{recovery.recommendedReason}</p>
          )}
        </div>
      </div>
    </section>
  );
};
