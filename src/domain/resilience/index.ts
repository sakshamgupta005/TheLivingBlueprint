/**
 * Resilience engine entry point: playback reducer, one-call snapshot, and the compact
 * context sent with /api/investigate. Pure and deterministic for a given PlaybackState.
 */

import { ANALYSIS_CONFIG, FORECAST_LABEL, detectAnomalies, forecastFailures, projectCascade, rankRootCauses } from './analysis.ts';
import { mineTemplates } from './logTemplates.ts';
import { STRATEGIES, compareStrategies } from './recovery.ts';
import { BUILTIN_SCENARIOS, DEFAULT_RAMP_TICKS, getScenario } from './scenarios.ts';
import { FAIL_DEGRADATION, firstFailureTick, observe, simulateWorld, sustainedFailures } from './simulator.ts';
import type {
  AppliedOutcome,
  PlaybackAction,
  PlaybackState,
  RecoveryStrategyId,
  ResilienceInvestigationContext,
  ResilienceScenario,
  ResilienceSnapshot,
  RiskTier,
  SelfCheck,
  ServiceView,
} from './types.ts';

export * from './types.ts';
export { BUILTIN_SCENARIOS, getScenario, createScannedRepoScenario } from './scenarios.ts';
export { STRATEGIES } from './recovery.ts';
export { FORECAST_LABEL } from './analysis.ts';
export { analyzeLogText, exportScenarioLogs, parseLogText, type LogAnalysis } from './logAnalyzer.ts';

const LOG_TAIL = 200;

export function createPlayback(scenarioId: string = BUILTIN_SCENARIOS[0].id): PlaybackState {
  return { scenarioId, tick: 0, playing: false, speed: 1, injectedFaults: [], applied: null };
}

/** For useReducer. `step` stops at the last tick and pauses there. */
export function playbackReducer(state: PlaybackState, action: PlaybackAction, scenario?: ResilienceScenario): PlaybackState {
  const sc = scenario ?? getScenario(state.scenarioId);
  switch (action.type) {
    case 'play':
      return state.tick >= sc.totalTicks - 1 ? state : { ...state, playing: true };
    case 'pause':
      return { ...state, playing: false };
    case 'step': {
      const tick = Math.min(state.tick + 1, sc.totalTicks - 1);
      return { ...state, tick, playing: state.playing && tick < sc.totalTicks - 1 };
    }
    case 'reset':
      return { ...createPlayback(state.scenarioId), speed: state.speed };
    case 'setSpeed':
      return { ...state, speed: action.speed };
    case 'selectScenario':
      return { ...createPlayback(action.scenarioId), speed: state.speed };
    case 'inject':
      return {
        ...state,
        injectedFaults: [
          ...state.injectedFaults,
          { serviceId: action.serviceId, faultType: action.faultType, startTick: state.tick, rampTicks: DEFAULT_RAMP_TICKS[action.faultType] },
        ],
      };
    case 'applyStrategy': {
      const tick = state.applied?.tick ?? state.tick;
      return { ...state, tick, applied: { strategyId: action.strategyId, targetServiceId: action.targetServiceId, tick } };
    }
    case 'clearStrategy':
      return state.applied ? { ...state, tick: state.applied.tick, applied: null } : state;
  }
}

function simTime(tick: number, tickSeconds: number): string {
  const s = tick * tickSeconds;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export function runResilienceStep(playback: PlaybackState, scenarioOverride?: ResilienceScenario): ResilienceSnapshot {
  const scenario = scenarioOverride ?? getScenario(playback.scenarioId);
  const tick = Math.max(0, Math.min(playback.tick, scenario.totalTicks - 1));
  const faults = [...scenario.faults, ...playback.injectedFaults];
  const applied = playback.applied && playback.applied.tick <= tick ? playback.applied : null;

  // World (ground truth) up to now; observations are all the analysis sees.
  const world = simulateWorld(scenario, faults, applied, tick);
  const obs = observe(scenario, world, applied, tick);
  const mined = mineTemplates(obs.logs, tick, ANALYSIS_CONFIG.baselineTicks);

  const anomalies = detectAnomalies(scenario, obs.metrics, tick);
  const rootCause = rankRootCauses(scenario, anomalies, mined.logs);
  const forecast = forecastFailures(scenario, anomalies);
  const cascade = projectCascade(scenario, forecast, rootCause);
  const top = rootCause.candidates[0]?.serviceId ?? null;
  // Once a strategy is applied, freeze the comparison at that decision point.
  const recoveryTarget = applied && applied.strategyId !== 'rate_limit' ? applied.targetServiceId : top;
  const recovery = compareStrategies(scenario, faults, rootCause.status, recoveryTarget, applied?.tick ?? tick);

  // Self-check against ground truth, measured from the twin.
  const end = scenario.totalTicks - 1;
  const firstWarningTick = Object.values(anomalies).reduce<number | null>(
    (min, a) => (a.onsetTick !== null && (min === null || a.onsetTick < min) ? a.onsetTick : min),
    null
  );
  const actualFirstFailureTick = firstFailureTick(world, tick, applied);
  const leadTimeTicks =
    firstWarningTick !== null && actualFirstFailureTick !== null && firstWarningTick <= actualFirstFailureTick
      ? actualFirstFailureTick - firstWarningTick
      : null;
  const noActionRun = simulateWorld(scenario, faults, null, end);
  // Ground truth is the earliest-starting fault, so a fault injected before the scenario's own one is scored correctly.
  const truthRootId = faults.length
    ? faults.reduce((first, f) => (f.startTick < first.startTick ? f : first)).serviceId
    : scenario.groundTruth.rootServiceId;
  const selfCheck: SelfCheck = {
    available: !scenario.isScannedRepo,
    groundTruthRootId: truthRootId,
    topCandidateId: top,
    rootCauseCorrect: top === null ? null : top === truthRootId,
    firstWarningTick,
    actualFirstFailureTick,
    leadTimeTicks,
    leadTimeSeconds: leadTimeTicks === null ? null : leadTimeTicks * scenario.tickSeconds,
    affectedWithoutAction: sustainedFailures(noActionRun, 0, end).length,
    affectedWithApplied: playback.applied
      ? sustainedFailures(simulateWorld(scenario, faults, playback.applied, end), 0, end).length
      : null,
  };

  let appliedOutcome: AppliedOutcome | null = null;
  if (applied) {
    const now = world.degradation[tick];
    const stillFailed = world.ids.filter((_, i) => now[i] >= FAIL_DEGRADATION);
    let containedAtTick: number | null = null;
    for (let t = applied.tick; t <= tick && containedAtTick === null; t++) {
      let ok = true;
      for (let k = t; k <= tick && ok; k++) ok = world.degradation[k].every((d) => d < 0.5);
      if (ok) containedAtTick = t;
    }
    const settled = tick - applied.tick >= recovery.horizonTicks || tick >= end;
    appliedOutcome = {
      ...applied,
      state: containedAtTick !== null && tick - containedAtTick >= 2 ? 'contained' : settled ? 'spread' : 'watching',
      containedAtTick,
      stillFailedServiceIds: stillFailed,
    };
  }

  const rankOf = new Map(rootCause.candidates.map((c) => [c.serviceId, c.rank]));
  const services: ServiceView[] = scenario.services.map((s, i) => {
    const a = anomalies[s.id];
    const f = forecast.byService[s.id];
    return {
      id: s.id,
      name: s.name,
      layer: s.layer,
      tier: f.tier,
      risk: f.risk,
      anomalyScore: a.score,
      sparkline: a.history.slice(-20).map((h) => h.anomalyScore),
      onsetTick: a.onsetTick,
      observedFailed: a.observedFailed,
      etaTicks: f.etaTicks,
      rootCauseRank: rankOf.get(s.id) ?? null,
      latest: obs.metrics[i][tick] ?? null,
    };
  });

  return {
    scenario: {
      id: scenario.id,
      name: scenario.name,
      description: scenario.description,
      totalTicks: scenario.totalTicks,
      tickSeconds: scenario.tickSeconds,
      isScannedRepo: scenario.isScannedRepo,
    },
    tick,
    simTimeLabel: simTime(tick, scenario.tickSeconds),
    isFinished: tick >= end,
    shouldAutoPause: actualFirstFailureTick === tick,
    services,
    riskByRoomId: Object.fromEntries(services.map((s) => [s.id, s.tier])) as Record<string, RiskTier>,
    graph: { nodes: scenario.services, edges: scenario.edges },
    signals: Object.fromEntries(Object.values(anomalies).map((a) => [a.serviceId, a.history])),
    anomalies,
    forecast,
    cascade,
    rootCause,
    recovery,
    logs: mined.logs.slice(-LOG_TAIL),
    templates: mined.templates,
    injectedFaults: playback.injectedFaults,
    applied: appliedOutcome,
    selfCheck,
  };
}

/** Compact engine findings for one room, for the investigation prompt. No raw world state. */
export function buildResilienceContext(snapshot: ResilienceSnapshot, roomId: string): ResilienceInvestigationContext {
  const view = snapshot.services.find((s) => s.id === roomId);
  const top = snapshot.rootCause.candidates[0]?.serviceId;
  return {
    scenarioId: snapshot.scenario.id,
    tick: snapshot.tick,
    roomRisk: view ? { tier: view.tier, risk: view.risk, etaTicks: view.etaTicks, rootCauseRank: view.rootCauseRank } : null,
    forecast: Object.values(snapshot.forecast.byService)
      .sort((a, b) => b.risk - a.risk)
      .slice(0, 5)
      .map((f) => ({ roomId: f.serviceId, risk: f.risk, etaTicks: f.etaTicks })),
    rootCauses: snapshot.rootCause.candidates.slice(0, 3).map((c) => ({
      roomId: c.serviceId,
      score: c.score,
      confidence: c.confidence,
      reasons: c.reasons,
    })),
    cascadePath: snapshot.cascade.path,
    blastRadiusPct: snapshot.cascade.blastRadiusPct,
    strategies: snapshot.recovery.outcomes.map((o) => ({
      id: o.strategyId,
      score: o.score,
      blastAfterPct: o.blastRadiusPct,
      ttrTicks: o.timeToRecoverTicks,
      tradeoffs: o.tradeoffs,
    })),
    recommendedStrategy: snapshot.recovery.recommendedId,
    sampleLogs: snapshot.logs
      .filter((l) => l.level !== 'INFO' && (l.serviceId === roomId || l.serviceId === top))
      .slice(-20)
      .map((l) => `t=${l.tick} ${l.serviceId} ${l.level} ${l.message}`.slice(0, 200)),
    label: FORECAST_LABEL,
  };
}

/** The room plus its direct dependencies and callers, for "Focused on: <room>" filtering. */
export function relatedServiceIds(snapshot: ResilienceSnapshot, roomId: string): string[] {
  const ids = new Set([roomId]);
  for (const e of snapshot.graph.edges) {
    if (e.source === roomId) ids.add(e.target);
    if (e.target === roomId) ids.add(e.source);
  }
  return snapshot.services.map((s) => s.id).filter((id) => ids.has(id));
}

export type PetMood = 'calm' | 'worried' | 'alarmed' | 'relieved';

export interface SnapshotSummary {
  nextFailure: string;
  blastRadius: string;
  rootCause: string;
  bestFix: string;
  /** Null until a failure happened after a warning. */
  leadTime: string | null;
  petMood: PetMood;
  petLine: string;
}

function duration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m${s ? ` ${s}s` : ''}` : `${s}s`;
}

/** Plain-language lines for KPI cards and the pets. Every phrase is built from engine fields only. */
export function summarizeSnapshot(snapshot: ResilienceSnapshot): SnapshotSummary {
  const nameOf = (id: string | null | undefined) => snapshot.services.find((s) => s.id === id)?.name ?? id ?? '';
  const status = snapshot.rootCause.status;
  const failed = snapshot.services.filter((s) => s.observedFailed);
  const next = snapshot.forecast.next;
  const top = snapshot.rootCause.candidates[0];
  const best = snapshot.recovery.outcomes[0];
  const base = snapshot.recovery.baseline;
  const sc = snapshot.selfCheck;

  const nextFailure =
    status === 'insufficient_evidence'
      ? 'Watching normal traffic to learn a baseline…'
      : next?.etaSeconds != null
        ? `${nameOf(next.serviceId)} will likely fail in ~${duration(next.etaSeconds)}`
        : failed.length
          ? `${failed.map((s) => s.name).join(', ')} ${failed.length === 1 ? 'is' : 'are'} down`
          : next
            ? `${nameOf(next.serviceId)} is drifting, no failure expected soon`
            : 'All rooms look healthy';
  const blastRadius = `${snapshot.cascade.affectedCount} of ${snapshot.cascade.totalServices} rooms at risk`;
  const rootCause = top ? `Root cause: ${nameOf(top.serviceId)} (${Math.round(top.confidence * 100)}% of the evidence)` : 'Root cause: not enough signal yet';
  const bestFix =
    best && base
      ? `Best fix: ${best.name} → ${base.affectedCount} → ${best.affectedCount} rooms down`
      : snapshot.recovery.recommendedReason;
  const leadTime =
    sc.leadTimeTicks !== null && sc.leadTimeSeconds !== null
      ? `Warned ${sc.leadTimeTicks} ticks (${duration(sc.leadTimeSeconds)}) before the first failure`
      : null;

  let petMood: PetMood = 'calm';
  let petLine = status === 'insufficient_evidence' ? 'Sniffing around while I learn what normal looks like.' : 'All quiet. Every room is behaving.';
  if (snapshot.applied?.state === 'contained') {
    petMood = 'relieved';
    petLine = `Phew! ${STRATEGIES[snapshot.applied.strategyId].name} contained it.`;
  } else if (failed.length) {
    petMood = 'alarmed';
    petLine = snapshot.recovery.recommendedId ? snapshot.recovery.recommendedReason : `${failed[0].name} is down.`;
  } else if (next && top) {
    petMood = 'worried';
    petLine = next.basis;
  }
  return { nextFailure, blastRadius, rootCause, bestFix, leadTime, petMood, petLine };
}

export interface ScenarioEvaluation {
  scenarioId: string;
  name: string;
  rootCauseCorrect: boolean;
  leadTimeTicks: number | null;
  leadTimeSeconds: number | null;
  /** Services that fail by the end with no action. */
  failuresWithoutAction: number;
  /** Same, when the recommended fix is applied 3 ticks before the first failure. */
  failuresWithFix: number;
  recommendedId: string | null;
}

/**
 * Runs every built-in scenario and measures the engine against its ground truth.
 * Nothing here is hard-coded: each number comes from a fresh replay.
 */
export function evaluateScenarios(scenarios: ResilienceScenario[] = BUILTIN_SCENARIOS): ScenarioEvaluation[] {
  return scenarios.map((sc) => {
    const end = sc.totalTicks - 1;
    const atEnd = runResilienceStep({ ...createPlayback(sc.id), tick: end }, sc);
    const crash = atEnd.selfCheck.actualFirstFailureTick;
    const atCrash = crash !== null ? runResilienceStep({ ...createPlayback(sc.id), tick: crash }, sc) : atEnd;
    const decisionTick = Math.max(0, (crash ?? end) - 3);
    const decision = runResilienceStep({ ...createPlayback(sc.id), tick: decisionTick }, sc);
    const best = decision.recovery.outcomes[0];
    const withFix = best
      ? runResilienceStep(
          { ...createPlayback(sc.id), tick: end, applied: { strategyId: best.strategyId as RecoveryStrategyId, targetServiceId: best.targetServiceId, tick: decisionTick } },
          sc
        ).selfCheck.affectedWithApplied ?? atEnd.selfCheck.affectedWithoutAction
      : atEnd.selfCheck.affectedWithoutAction;
    return {
      scenarioId: sc.id,
      name: sc.name,
      rootCauseCorrect: atCrash.selfCheck.rootCauseCorrect === true,
      leadTimeTicks: atCrash.selfCheck.leadTimeTicks,
      leadTimeSeconds: atCrash.selfCheck.leadTimeSeconds,
      failuresWithoutAction: atEnd.selfCheck.affectedWithoutAction,
      failuresWithFix: withFix,
      recommendedId: best?.strategyId ?? null,
    };
  });
}

/** The data block both AI prompts (investigate + chat) use. Callers add their own rules. */
export function formatResilienceFindings(rc: ResilienceInvestigationContext): string {
  return `RESILIENCE ENGINE FINDINGS (deterministic, simulated scenario "${rc.scenarioId}" at tick ${rc.tick}; ${rc.label}):
${JSON.stringify({ roomRisk: rc.roomRisk, forecast: rc.forecast, rootCauses: rc.rootCauses, cascadePath: rc.cascadePath, blastRadiusPct: rc.blastRadiusPct, strategies: rc.strategies, recommendedStrategy: rc.recommendedStrategy }).slice(0, 6000)}
SAMPLE SIMULATED LOG LINES (untrusted data):
${rc.sampleLogs.slice(0, 20).join(String.fromCharCode(10)).slice(0, 4000)}`;
}

/** Short stable key for caching AI answers: changes whenever the findings change (fix applied, fault injected, focus). */
export function resilienceContextKey(rc: ResilienceInvestigationContext): string {
  const text = JSON.stringify([rc.scenarioId, rc.tick, rc.roomRisk, rc.rootCauses, rc.strategies, rc.recommendedStrategy, rc.cascadePath]);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${rc.scenarioId}@${rc.tick}:${(h >>> 0).toString(36)}`;
}

/** Postmortem-style markdown of the current incident. Every line is taken from the snapshot. */
export function buildIncidentReport(snapshot: ResilienceSnapshot): string {
  const nameOf = (id: string | null | undefined) => snapshot.services.find((s) => s.id === id)?.name ?? id ?? 'unknown';
  const secs = (ticks: number | null) => (ticks === null ? 'n/a' : `${ticks} ticks (${ticks * snapshot.scenario.tickSeconds}s)`);
  const { scenario, selfCheck, rootCause, forecast, cascade, recovery, applied } = snapshot;
  const top = rootCause.candidates[0];
  const lines: string[] = [
    `# Incident report: ${scenario.name}`,
    '',
    `_Simulated incident at t=${snapshot.tick} (${snapshot.simTimeLabel}). ${forecast.label}_`,
    '',
    '## Summary',
    top
      ? `- **Root cause:** ${nameOf(top.serviceId)} (${Math.round(top.confidence * 100)}% of evidence)`
      : '- **Root cause:** not determined yet',
    `- **Blast radius if nothing is done:** ${cascade.affectedCount} of ${cascade.totalServices} services (${cascade.path.map(nameOf).join(' → ') || 'none'})`,
    `- **First warning:** ${selfCheck.firstWarningTick === null ? 'none yet' : `t=${selfCheck.firstWarningTick}`}`,
    `- **First failure:** ${selfCheck.actualFirstFailureTick === null ? 'none yet' : `t=${selfCheck.actualFirstFailureTick}`}`,
    `- **Warning lead time:** ${secs(selfCheck.leadTimeTicks)}`,
  ];
  if (forecast.next) lines.push(`- **Next likely failure:** ${nameOf(forecast.next.serviceId)}${forecast.next.etaTicks !== null ? ` in ~${forecast.next.etaTicks} ticks` : ''}. ${forecast.next.basis}`);
  if (top) {
    lines.push('', '## Why this is the root cause', ...top.reasons.map((r) => `- ${r}`), '', '### Evidence');
    for (const e of top.evidence) lines.push(`- \`t=${e.tick}\` (${e.kind}) ${e.text}`);
    const others = rootCause.candidates.slice(1, 4);
    if (others.length) lines.push('', '### Other candidates', ...others.map((c) => `- ${nameOf(c.serviceId)}: score ${c.score} (${c.reasons[0] ?? ''})`));
  }
  if (recovery.outcomes.length && recovery.baseline) {
    lines.push(
      '',
      '## Recovery options',
      `_${recovery.note}_`,
      '',
      '| Strategy | Target | Services down (no fix → fix) | Recovers in | Side effects | Score |',
      '|---|---|---|---|---|---|',
      ...recovery.outcomes.map(
        (o) =>
          `| ${o.name}${o.strategyId === recovery.recommendedId ? ' **(recommended)**' : ''} | ${nameOf(o.targetServiceId)} | ${recovery.baseline!.affectedCount} → ${o.affectedCount} | ${o.timeToRecoverTicks === null ? 'not within horizon' : `~${o.timeToRecoverTicks} ticks`} | ${o.tradeoffs[0] ?? ''} | ${o.score} |`
      ),
      '',
      `**Why the recommendation:** ${recovery.recommendedReason}`
    );
  }
  if (applied) {
    lines.push(
      '',
      '## Action taken',
      `- Applied **${recovery.outcomes.find((o) => o.strategyId === applied.strategyId)?.name ?? applied.strategyId}** on ${nameOf(applied.targetServiceId)} at t=${applied.tick}.`,
      `- Result: ${applied.state === 'contained' ? `contained at t=${applied.containedAtTick}` : applied.state === 'spread' ? `did not contain; still down: ${applied.stillFailedServiceIds.map(nameOf).join(', ') || 'none'}` : 'still being watched'}.`
    );
  }
  if (selfCheck.available) {
    lines.push(
      '',
      '## Engine self-check (against the scenario ground truth)',
      `- Root cause correct: ${selfCheck.rootCauseCorrect === null ? 'n/a' : selfCheck.rootCauseCorrect ? 'yes' : 'no'} (truth: ${nameOf(selfCheck.groundTruthRootId)})`,
      `- Services that fail with no action (full run): ${selfCheck.affectedWithoutAction}`,
      ...(selfCheck.affectedWithApplied !== null ? [`- With the applied fix: ${selfCheck.affectedWithApplied}`] : [])
    );
  }
  return lines.join('\n') + '\n';
}
