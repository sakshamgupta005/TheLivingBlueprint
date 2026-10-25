import React, { useEffect, useRef, useState } from 'react';
import type { PlaybackAction, RecoveryStrategyId, ResilienceSnapshot } from '../../domain/resilience/types.ts';

/** One stage of the story. `until` is checked on every tick; `say` is shown once it is reached. */
interface Stage {
  waiting: string;
  until: (s: ResilienceSnapshot) => boolean;
  say: (s: ResilienceSnapshot) => string;
  onReach?: (s: ResilienceSnapshot, dispatch: React.Dispatch<PlaybackAction>) => void;
}

const nameOf = (s: ResilienceSnapshot, id: string | null | undefined) => s.services.find((v) => v.id === id)?.name ?? id ?? '';

const STAGES: Stage[] = [
  {
    waiting: 'Watching normal traffic to learn what healthy looks like…',
    until: (s) => s.rootCause.status !== 'insufficient_evidence',
    say: (s) => `Baseline learned from ${s.tick} ticks of simulated logs and metrics. Now watching for drift.`,
  },
  {
    waiting: 'Scanning every service for drift…',
    until: (s) => s.selfCheck.firstWarningTick !== null,
    say: (s) =>
      `Early warning at t=${s.selfCheck.firstWarningTick}: ${nameOf(s, s.rootCause.candidates[0]?.serviceId)} is drifting away from its baseline. Nothing has failed yet.`,
  },
  {
    waiting: 'Projecting where this is heading…',
    until: (s) => s.forecast.next?.etaTicks != null,
    say: (s) =>
      `Forecast: ${nameOf(s, s.forecast.next?.serviceId)} will fail in ~${s.forecast.next?.etaTicks} ticks. If nothing is done: ${s.cascade.path.map((id) => nameOf(s, id)).join(' → ')}.`,
  },
  {
    waiting: 'Letting the incident play out…',
    until: (s) => s.shouldAutoPause,
    say: (s) =>
      `First failure at t=${s.selfCheck.actualFirstFailureTick}. The engine warned ${s.selfCheck.leadTimeTicks ?? '?'} ticks earlier and named ${nameOf(s, s.rootCause.candidates[0]?.serviceId)} as the root cause.`,
    onReach: (s, dispatch) => {
      const best = s.recovery.outcomes[0];
      if (!best) return;
      dispatch({ type: 'applyStrategy', strategyId: best.strategyId as RecoveryStrategyId, targetServiceId: best.targetServiceId });
    },
  },
  {
    waiting: 'Applying the recommended fix…',
    until: (s) => s.applied?.state === 'contained' || s.applied?.state === 'spread' || s.isFinished,
    say: (s) => {
      const fix = s.recovery.outcomes.find((o) => o.strategyId === s.applied?.strategyId);
      return s.applied?.state === 'contained'
        ? `${fix?.name ?? 'The fix'} contained it at t=${s.applied.containedAtTick}: ${s.recovery.baseline?.affectedCount ?? '?'} → ${fix?.affectedCount ?? '?'} failed services. Try another fix from the list to compare.`
        : 'The fix did not fully contain the spread. Try another strategy from the list.';
    },
  },
];

const HOLD_MS = 3500;

/** Plays the scenario with captions, pausing briefly at each milestone. All numbers come from the snapshot. */
export function useGuidedDemo(snapshot: ResilienceSnapshot, dispatch: React.Dispatch<PlaybackAction>) {
  const [stage, setStage] = useState<number | null>(null);
  const [caption, setCaption] = useState('');
  const holding = useRef(false);

  const start = (scenarioId: string) => {
    dispatch({ type: 'selectScenario', scenarioId });
    dispatch({ type: 'setSpeed', speed: 4 });
    dispatch({ type: 'play' });
    holding.current = false;
    setStage(0);
    setCaption(STAGES[0].waiting);
  };
  const stop = () => {
    holding.current = false;
    setStage(null);
    setCaption('');
  };

  useEffect(() => {
    if (stage === null || stage >= STAGES.length || holding.current) return;
    const current = STAGES[stage];
    if (!current.until(snapshot)) return;
    holding.current = true;
    dispatch({ type: 'pause' });
    setCaption(current.say(snapshot));
    current.onReach?.(snapshot, dispatch);
    const next = stage + 1;
    window.setTimeout(() => {
      if (!holding.current) return; // stopped meanwhile
      holding.current = false;
      setStage(next);
      if (next < STAGES.length) {
        setCaption(STAGES[next].waiting);
        dispatch({ type: 'play' });
      }
    }, HOLD_MS);
  }, [snapshot, stage, dispatch]);

  return {
    active: stage !== null,
    finished: stage === STAGES.length,
    step: Math.min(stage ?? 0, STAGES.length - 1) + 1,
    total: STAGES.length,
    caption,
    start,
    stop,
  };
}

export const GuidedDemoBanner: React.FC<{ demo: ReturnType<typeof useGuidedDemo> }> = ({ demo }) =>
  demo.active ? (
    <div className="gd" role="status" aria-live="polite">
      <span className="gd__step">{demo.finished ? 'Done' : `Step ${demo.step}/${demo.total}`}</span>
      <span className="gd__caption">{demo.caption}</span>
      <button type="button" className="ib__link" onClick={demo.stop}>
        {demo.finished ? 'Close' : 'Stop demo'}
      </button>
    </div>
  ) : null;
