/**
 * Recovery comparison by what-if replay on the scenario twin: each strategy is applied
 * to the engine's top-ranked candidate (not the ground truth) and the world is re-simulated.
 * Nothing here touches a real system.
 */

import { entryServiceIds, simulateWorld, sustainedFailures, type WorldRun } from './simulator.ts';
import type {
  AnalysisStatus,
  AppliedStrategy,
  FaultInjection,
  RecoveryComparison,
  RecoveryScoreWeights,
  RecoveryStrategyId,
  ResilienceScenario,
  StrategyOutcome,
} from './types.ts';

export const RECOVERY_HORIZON_TICKS = 30;
export const RECOVERY_WEIGHTS: RecoveryScoreWeights = { blast: 0.45, residual: 0.25, recovery: 0.15, sideEffect: 0.15 };
const RECOVERED_DEGRADATION = 0.5;

interface StrategyMeta {
  name: string;
  sideEffectRisk: number;
  tradeoffs: string[];
  assumptions: string[];
}

export const STRATEGIES: Record<RecoveryStrategyId, StrategyMeta> = {
  restart: {
    name: 'Restart',
    sideEffectRisk: 0.2,
    tradeoffs: ['Target is down for ~1 tick while it restarts.', 'Does not remove the cause; a leak or load problem builds up again.'],
    assumptions: ['Restart clears pools and heap after 1 tick.', 'A bad build is not fixed by restarting it.'],
  },
  rollback: {
    name: 'Rollback deploy',
    sideEffectRisk: 0.3,
    tradeoffs: ['Loses the features shipped in the latest release.', 'Takes ~2 ticks to roll out.'],
    assumptions: ['Only helps when the fault came from a recent deploy.'],
  },
  scale_out: {
    name: 'Scale out',
    sideEffectRisk: 0.15,
    tradeoffs: ['Extra capacity cost.', '~3 ticks of warm-up before it helps.'],
    assumptions: ['Load-driven faults drop to 35% intensity, memory leaks to 75%; code bugs are unchanged.'],
  },
  isolate: {
    name: 'Isolate (circuit-break)',
    sideEffectRisk: 0.45,
    tradeoffs: ["The target's feature is unavailable to callers (graceful degradation).", 'The target itself is not fixed.'],
    assumptions: ['Circuit breakers on calls into the target cut propagated degradation to 15%.'],
  },
  failover: {
    name: 'Failover to replica',
    sideEffectRisk: 0.35,
    tradeoffs: ['Replica may serve slightly stale data.', 'The replica runs the same build, so code bugs move with it.'],
    assumptions: ['Node-local faults (pool, heap) drop to 10% after 2 ticks.'],
  },
  rate_limit: {
    name: 'Rate-limit at the edge',
    sideEffectRisk: 0.5,
    tradeoffs: ['Rejects ~40% of incoming user traffic.', 'Applied at the entry service, not the target.'],
    assumptions: ['Load-driven faults drop to 60% intensity system-wide.'],
  },
};

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

function timeToRecover(run: WorldRun, from: number, to: number): number | null {
  for (let t = from; t <= to; t++) {
    let ok = true;
    for (let k = t; k <= to && ok; k++) ok = run.degradation[k].every((d) => d < RECOVERED_DEGRADATION);
    if (ok) return t - from;
  }
  return null;
}

function evaluate(
  scenario: ResilienceScenario,
  faults: FaultInjection[],
  applied: AppliedStrategy | null,
  from: number,
  to: number
) {
  const run = simulateWorld(scenario, faults, applied, to);
  const affected = sustainedFailures(run, from, to);
  const end = run.degradation[to];
  return {
    affected,
    ttr: timeToRecover(run, from, to),
    residual: round(end.reduce((a, b) => a + b, 0) / end.length),
  };
}

function outcome(
  scenario: ResilienceScenario,
  id: RecoveryStrategyId | 'do_nothing',
  target: string,
  r: ReturnType<typeof evaluate>,
  baselineCount: number
): StrategyOutcome {
  const total = scenario.services.length;
  const meta = id === 'do_nothing' ? null : STRATEGIES[id];
  const sideEffectRisk = meta?.sideEffectRisk ?? 0;
  const blastFrac = r.affected.length / total;
  const W = RECOVERY_WEIGHTS;
  const score = round(
    W.blast * (1 - blastFrac) +
      W.residual * (1 - r.residual) +
      W.recovery * (r.ttr === null ? 0 : 1 - r.ttr / RECOVERY_HORIZON_TICKS) +
      W.sideEffect * (1 - sideEffectRisk)
  );
  return {
    strategyId: id,
    name: meta?.name ?? 'Do nothing',
    targetServiceId: target,
    affectedServiceIds: r.affected,
    affectedCount: r.affected.length,
    blastRadiusPct: Math.round(blastFrac * 100),
    servicesSaved: baselineCount - r.affected.length,
    timeToRecoverTicks: r.ttr,
    residualRisk: r.residual,
    sideEffectRisk,
    score,
    contained: r.ttr !== null,
    tradeoffs: meta?.tradeoffs ?? ['Failure keeps spreading along strong dependencies.'],
    assumptions: meta?.assumptions ?? ['No operator action.'],
  };
}

export function compareStrategies(
  scenario: ResilienceScenario,
  faults: FaultInjection[],
  status: AnalysisStatus,
  targetServiceId: string | null,
  applyAtTick: number
): RecoveryComparison {
  const base: RecoveryComparison = {
    status,
    method: 'scenario-twin-replay',
    note: `What-if replay of the simulated scenario for ${RECOVERY_HORIZON_TICKS} ticks, targeting the top-ranked root-cause candidate. Simulated outcome, not a production action.`,
    applyAtTick,
    horizonTicks: RECOVERY_HORIZON_TICKS,
    targetServiceId,
    baseline: null,
    outcomes: [],
    recommendedId: null,
    recommendedReason:
      status === 'insufficient_evidence'
        ? 'Not enough observations yet to choose a recovery strategy.'
        : 'No anomaly detected, so nothing to recover.',
    weights: RECOVERY_WEIGHTS,
  };
  if (status !== 'ok' || !targetServiceId) return base;

  const to = applyAtTick + RECOVERY_HORIZON_TICKS;
  const entry = entryServiceIds(scenario)[0] ?? targetServiceId;
  const baseRun = evaluate(scenario, faults, null, applyAtTick, to);
  const baseline = outcome(scenario, 'do_nothing', targetServiceId, baseRun, baseRun.affected.length);

  const outcomes = (Object.keys(STRATEGIES) as RecoveryStrategyId[])
    .map((id) => {
      const target = id === 'rate_limit' ? entry : targetServiceId;
      const r = evaluate(scenario, faults, { strategyId: id, targetServiceId: target, tick: applyAtTick }, applyAtTick, to);
      return outcome(scenario, id, target, r, baseline.affectedCount);
    })
    .sort((a, b) => b.score - a.score || a.sideEffectRisk - b.sideEffectRisk);

  const best = outcomes[0];
  const recommendedReason =
    `${best.name} on ${best.targetServiceId}: ${baseline.affectedCount} → ${best.affectedCount} failed service(s)` +
    (best.timeToRecoverTicks !== null ? `, recovers in ~${best.timeToRecoverTicks} tick(s)` : ', does not fully recover in the horizon') +
    `, side-effect risk ${best.sideEffectRisk}. Highest weighted score (${best.score}).`;

  return { ...base, baseline, outcomes, recommendedId: best.strategyId as RecoveryStrategyId, recommendedReason };
}
