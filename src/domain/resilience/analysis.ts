/**
 * Observation-only analysis: anomaly detection, root-cause ranking (PyRCA-inspired,
 * transparent weighted factors), failure forecast and cascade projection.
 * Reads metrics, logs and the dependency graph. Never reads the simulator's ground truth.
 */

import type {
  AnalysisStatus,
  AnomalySignal,
  CascadeProjection,
  DependencyEdge,
  EvidenceRef,
  FailureForecast,
  LogEvent,
  MetricObservation,
  ResilienceScenario,
  RiskTier,
  RootCauseCandidate,
  RootCauseComponents,
  RootCauseResult,
  ServiceForecast,
} from './types.ts';

export const ANALYSIS_CONFIG = {
  baselineTicks: 12,
  /** Smoothed robust z needed for drift, held for `persistTicks`. */
  onsetZ: 3.5,
  persistTicks: 2,
  ewmaAlpha: 0.5,
  /** Observed error rate at which a service is treated as failed. */
  failErrorRate: 0.45,
  horizonTicks: 30,
  /** Edges at or above this weight carry a failure through to the caller. */
  strongEdgeWeight: 0.85,
  propagationLagTicks: 1,
};

export const FORECAST_LABEL = 'Simulated relative risk estimate, not a calibrated real-world probability.';

export const ROOT_CAUSE_WEIGHTS: RootCauseComponents = {
  temporal: 0.3,
  dependency: 0.3,
  logEvidence: 0.2,
  severity: 0.1,
  upstreamImpact: 0.1,
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function robustBaseline(xs: number[], floor: number) {
  const med = median(xs);
  const mad = median(xs.map((x) => Math.abs(x - med)));
  return { med, denom: 1.4826 * mad + floor };
}

// ---------- Anomaly detection ----------

export function detectAnomalies(
  scenario: ResilienceScenario,
  metrics: MetricObservation[][],
  tick: number
): Record<string, AnomalySignal> {
  const cfg = ANALYSIS_CONFIG;
  const out: Record<string, AnomalySignal> = {};
  scenario.services.forEach((s, i) => {
    const series = metrics[i].slice(0, tick + 1);
    const firstFail = series.find((m) => m.errorRate >= cfg.failErrorRate)?.tick ?? null;
    const latest = series[series.length - 1];
    const observedFailed = !!latest && latest.errorRate >= cfg.failErrorRate;

    if (series.length < cfg.baselineTicks) {
      out[s.id] = {
        serviceId: s.id,
        status: 'insufficient_evidence',
        score: 0,
        errorZ: 0,
        latencyZ: 0,
        onsetTick: null,
        observedFailed,
        firstObservedFailureTick: firstFail,
        history: series.map((m) => ({ tick: m.tick, errorRate: m.errorRate, p95Ms: m.p95Ms, anomalyScore: 0 })),
      };
      return;
    }

    const base = series.slice(0, cfg.baselineTicks);
    const err = robustBaseline(base.map((m) => m.errorRate), 0.005);
    const lat = robustBaseline(base.map((m) => m.p95Ms), median(base.map((m) => m.p95Ms)) * 0.05);

    let smoothed = 0;
    let streak = 0;
    let onsetTick: number | null = null;
    let errorZ = 0;
    let latencyZ = 0;
    const history = series.map((m) => {
      errorZ = Math.max(0, (m.errorRate - err.med) / err.denom);
      latencyZ = Math.max(0, (m.p95Ms - lat.med) / lat.denom);
      smoothed = cfg.ewmaAlpha * Math.max(errorZ, latencyZ) + (1 - cfg.ewmaAlpha) * smoothed;
      if (m.tick >= cfg.baselineTicks && onsetTick === null) {
        streak = smoothed >= cfg.onsetZ ? streak + 1 : 0;
        // Recorded on the tick drift is confirmed, so it never uses future data.
        if (streak >= cfg.persistTicks) onsetTick = m.tick;
      }
      const anomalyScore = round(clamp01(1 - Math.exp(-Math.max(0, smoothed - 2) / 4)));
      return { tick: m.tick, errorRate: m.errorRate, p95Ms: m.p95Ms, anomalyScore };
    });

    out[s.id] = {
      serviceId: s.id,
      status: onsetTick !== null || observedFailed ? 'ok' : 'no_anomaly',
      score: observedFailed ? 1 : history[history.length - 1].anomalyScore,
      errorZ: round(errorZ, 2),
      latencyZ: round(latencyZ, 2),
      onsetTick,
      observedFailed,
      firstObservedFailureTick: firstFail,
      history,
    };
  });
  return out;
}

function isAnomalous(a: AnomalySignal | undefined): boolean {
  return !!a && (a.onsetTick !== null || a.observedFailed);
}

function overallStatus(anomalies: Record<string, AnomalySignal>): AnalysisStatus {
  const list = Object.values(anomalies);
  if (list.some((a) => a.status === 'insufficient_evidence')) return 'insufficient_evidence';
  return list.some(isAnomalous) ? 'ok' : 'no_anomaly';
}

// ---------- Root cause ranking ----------

const UPSTREAM_RE = /^upstream call to (\S+)/;

function callersOf(edges: DependencyEdge[], id: string): string[] {
  return edges.filter((e) => e.target === id).map((e) => e.source);
}

function reachableCallers(edges: DependencyEdge[], id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    for (const c of callersOf(edges, stack.pop()!)) {
      if (!seen.has(c) && c !== id) {
        seen.add(c);
        stack.push(c);
      }
    }
  }
  return seen;
}

export function rankRootCauses(
  scenario: ResilienceScenario,
  anomalies: Record<string, AnomalySignal>,
  logs: LogEvent[]
): RootCauseResult {
  const status = overallStatus(anomalies);
  const W = ROOT_CAUSE_WEIGHTS;
  const anomalous = scenario.services.filter((s) => isAnomalous(anomalies[s.id])).map((s) => s.id);
  if (status !== 'ok' || anomalous.length === 0) return { status, candidates: [], weights: W };

  const onsetOf = (id: string) => anomalies[id].onsetTick ?? anomalies[id].firstObservedFailureTick ?? Infinity;
  const onsets = anomalous.map(onsetOf);
  const earliest = Math.min(...onsets);
  const latest = Math.max(...onsets);

  const problemLogs = logs.filter((l) => l.level !== 'INFO' && !l.message.startsWith('health check failed'));
  const blame = new Map<string, number>();
  for (const l of problemLogs) {
    const callee = UPSTREAM_RE.exec(l.message)?.[1];
    if (callee) blame.set(callee, (blame.get(callee) ?? 0) + 1);
  }
  const maxBlame = Math.max(1, ...blame.values());

  const scored = anomalous.map((id) => {
    const a = anomalies[id];
    const onset = onsetOf(id);
    const temporal = latest === earliest ? 1 : (latest - onset) / (latest - earliest);

    const suspectCallees = scenario.edges
      .filter((e) => e.source === id && isAnomalous(anomalies[e.target]) && onsetOf(e.target) <= onset)
      .map((e) => e.target);
    const dependency = 1 - Math.max(0, ...suspectCallees.map((c) => anomalies[c].score));

    const own = problemLogs.filter((l) => l.serviceId === id);
    const ownErrors = own.filter((l) => !UPSTREAM_RE.test(l.message));
    const ownRatio = own.length ? ownErrors.length / own.length : 0;
    const blamed = blame.get(id) ?? 0;
    const logEvidence = 0.6 * ownRatio + 0.4 * (blamed / maxBlame);

    const explained = [...reachableCallers(scenario.edges, id)].filter((c) => anomalous.includes(c)).length;
    const upstreamImpact = anomalous.length > 1 ? explained / (anomalous.length - 1) : 1;

    const components: RootCauseComponents = {
      temporal: round(temporal),
      severity: round(a.score),
      dependency: round(dependency),
      logEvidence: round(logEvidence),
      upstreamImpact: round(upstreamImpact),
    };
    const score = round(
      W.temporal * temporal +
        W.severity * a.score +
        W.dependency * dependency +
        W.logEvidence * logEvidence +
        W.upstreamImpact * upstreamImpact
    );

    const reasons: string[] = [];
    if (onset === earliest) reasons.push(`Earliest sustained drift (t=${onset}).`);
    else reasons.push(`Drift began at t=${onset}, ${onset - earliest} tick(s) after the earliest one.`);
    if (suspectCallees.length === 0) reasons.push('None of its dependencies drifted before it.');
    else reasons.push(`Depends on ${suspectCallees.join(', ')}, which drifted first.`);
    if (ownErrors.length) reasons.push(`${Math.round(ownRatio * 100)}% of its warnings/errors are its own, not upstream timeouts.`);
    if (blamed) reasons.push(`Named as the slow/failing upstream in ${blamed} caller log line(s).`);
    if (explained) reasons.push(`Would explain ${explained} of ${anomalous.length - 1} other anomalous service(s) via dependencies.`);

    const evidence: EvidenceRef[] = [];
    if (a.onsetTick !== null) {
      const p = a.history[a.onsetTick];
      evidence.push({
        kind: 'metric',
        serviceId: id,
        tick: a.onsetTick,
        text: `p95 ${Math.round(p.p95Ms)}ms, error rate ${(p.errorRate * 100).toFixed(1)}% at drift onset`,
      });
    }
    const seenTemplates = new Set<string>();
    for (const l of ownErrors) {
      if (seenTemplates.size >= 2) break;
      const key = l.templateId ?? l.message;
      if (seenTemplates.has(key)) continue;
      seenTemplates.add(key);
      evidence.push({ kind: 'log', serviceId: id, tick: l.tick, text: l.message, templateId: l.templateId });
    }
    if (explained) {
      evidence.push({ kind: 'graph', serviceId: id, tick: onset, text: `${explained} anomalous service(s) call ${id} directly or transitively` });
    }
    return { serviceId: id, score, components, reasons, evidence };
  });

  scored.sort((x, y) => y.score - x.score || onsetOf(x.serviceId) - onsetOf(y.serviceId) || x.serviceId.localeCompare(y.serviceId));
  const total = scored.reduce((s, c) => s + c.score, 0) || 1;
  const candidates: RootCauseCandidate[] = scored.map((c, i) => ({ ...c, rank: i + 1, confidence: round(c.score / total) }));
  return { status, candidates, weights: W };
}

// ---------- Forecast ----------

function movingAvg(xs: number[], i: number): number {
  const w = xs.slice(Math.max(0, i - 1), i + 2);
  return w.reduce((a, b) => a + b, 0) / w.length;
}

/** Ticks until error rate crosses the failure threshold, from smoothed velocity and acceleration. */
function errorRateEta(history: AnomalySignal['history']): number | null {
  const n = history.length;
  if (n < 6) return null;
  const e = history.map((h) => h.errorRate);
  const s = (k: number) => movingAvg(e, n - 1 - k);
  const now = s(0);
  const v = (s(0) - s(3)) / 3;
  const a = Math.max(0, (s(0) - s(2) - (s(2) - s(4))) / 4);
  const gap = ANALYSIS_CONFIG.failErrorRate - now;
  if (gap <= 0) return 0;
  if (v <= 1e-4 && a <= 1e-6) return null;
  const eta = a > 1e-6 ? (-v + Math.sqrt(v * v + 2 * a * gap)) / a : gap / v;
  return eta > 0 && Number.isFinite(eta) ? Math.ceil(eta) : null;
}

/**
 * Median of the ETA computed now and at the previous two ticks (shifted by elapsed time).
 * Stateless hysteresis: one noisy tick can no longer flip the forecast on or off.
 */
function smoothedEta(history: AnomalySignal['history']): number | null {
  const n = history.length;
  const shifted = [0, 1, 2].map((k) => {
    const eta = n - k >= 6 ? errorRateEta(history.slice(0, n - k)) : null;
    return eta === null ? Infinity : Math.max(0, eta - k);
  });
  const mid = shifted.sort((x, y) => x - y)[1];
  return Number.isFinite(mid) ? mid : null;
}

/**
 * A forecast seen in any of the last 5 ticks keeps counting down instead of vanishing,
 * so the next-failure line does not flicker at the horizon edge.
 */
function stableEta(history: AnomalySignal['history'], horizon: number): number | null {
  for (let k = 0; k <= 5 && history.length - k >= 6; k++) {
    const eta = smoothedEta(history.slice(0, history.length - k));
    if (eta !== null && eta <= horizon) return Math.max(k === 0 ? 0 : 1, eta - k);
  }
  return null;
}

function tierFor(risk: number, eta: number | null, failed: boolean): RiskTier {
  if (failed) return 'failed';
  if (risk >= 0.8 || (eta !== null && eta <= 5)) return 'critical';
  if (risk >= 0.55 || (eta !== null && eta <= 10)) return 'high';
  if (risk >= 0.3 || eta !== null) return 'watch';
  return 'healthy';
}

export function forecastFailures(
  scenario: ResilienceScenario,
  anomalies: Record<string, AnomalySignal>
): FailureForecast {
  const cfg = ANALYSIS_CONFIG;
  const status = overallStatus(anomalies);
  const ids = scenario.services.map((s) => s.id);
  const risk = new Map(ids.map((id) => [id, anomalies[id].score]));
  const eta = new Map<string, number | null>(
    ids.map((id) => {
      const a = anomalies[id];
      if (a.observedFailed) return [id, 0];
      if (!isAnomalous(a)) return [id, null];
      return [id, stableEta(a.history, cfg.horizonTicks)];
    })
  );
  const via = new Map<string, string>();

  // Fixed-point pass over the graph: callers inherit pressure and (on strong edges) ETA.
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const id of ids) {
      // Max, not noisy-OR: a caller's own drift is usually the callee's drift showing through.
      let pressure = anomalies[id].score;
      let best = eta.get(id) ?? null;
      for (const e of scenario.edges.filter((x) => x.source === id)) {
        pressure = Math.max(pressure, e.weight * (risk.get(e.target) ?? 0));
        const calleeEta = eta.get(e.target);
        if (e.weight >= cfg.strongEdgeWeight && calleeEta !== null && calleeEta !== undefined && !anomalies[id].observedFailed) {
          const candidate = calleeEta + cfg.propagationLagTicks;
          if (candidate <= cfg.horizonTicks && (best === null || candidate < best)) {
            best = candidate;
            via.set(id, e.target);
          }
        }
      }
      const r = round(clamp01(pressure));
      if (r !== risk.get(id) || best !== eta.get(id)) changed = true;
      risk.set(id, r);
      eta.set(id, best);
    }
    if (!changed) break;
  }

  const byService: Record<string, ServiceForecast> = {};
  for (const id of ids) {
    const e = eta.get(id) ?? null;
    const failed = anomalies[id].observedFailed;
    byService[id] = {
      serviceId: id,
      risk: failed ? 1 : risk.get(id)!,
      tier: tierFor(risk.get(id)!, e, failed),
      etaTicks: failed ? 0 : e,
      band: e !== null && !failed ? { lowTicks: Math.max(1, Math.floor(e * 0.7)), highTicks: Math.ceil(e * 1.4) } : null,
    };
  }

  const open = Object.values(byService).filter((f) => f.tier !== 'failed');
  const withEta = open.filter((f) => f.etaTicks !== null).sort((a, b) => a.etaTicks! - b.etaTicks! || b.risk - a.risk);
  const pick = withEta[0] ?? open.filter((f) => f.risk >= 0.3).sort((a, b) => b.risk - a.risk)[0] ?? null;
  let next: FailureForecast['next'] = null;
  if (status === 'ok' && pick) {
    const a = anomalies[pick.serviceId];
    const latest = a.history[a.history.length - 1];
    const upstream = via.get(pick.serviceId);
    const basis = upstream
      ? `Depends on ${upstream} (weight ${scenario.edges.find((e) => e.source === pick.serviceId && e.target === upstream)?.weight}); projected to follow it ~${cfg.propagationLagTicks} tick later.`
      : pick.etaTicks !== null
        ? `Error rate ${(latest.errorRate * 100).toFixed(1)}% and accelerating; projected to cross ${cfg.failErrorRate * 100}% in ~${pick.etaTicks} ticks.`
        : 'Rising drift, but no failure projected within the horizon.';
    next = { ...pick, etaSeconds: pick.etaTicks !== null ? pick.etaTicks * scenario.tickSeconds : null, basis };
  }
  return { status, label: FORECAST_LABEL, horizonTicks: cfg.horizonTicks, next, byService };
}

// ---------- Cascade projection ----------

export function projectCascade(
  scenario: ResilienceScenario,
  forecast: FailureForecast,
  rootCause: RootCauseResult
): CascadeProjection {
  const total = scenario.services.length;
  const byService = Object.fromEntries(Object.values(forecast.byService).map((f) => [f.serviceId, f.risk]));
  const affected = Object.values(forecast.byService)
    .filter((f) => f.tier === 'failed' || f.etaTicks !== null)
    .map((f) => f.serviceId);
  const seed = rootCause.candidates[0]?.serviceId ?? null;
  const empty: CascadeProjection = {
    status: forecast.status,
    seedServiceId: seed,
    path: [],
    pathEdgeIds: [],
    affectedServiceIds: affected,
    affectedCount: affected.length,
    totalServices: total,
    blastRadiusPct: Math.round((affected.length / total) * 100),
    byService,
  };
  if (!seed) return empty;

  // Walk callers from the seed through services projected to fail.
  const inPath = new Set([seed]);
  const pathEdgeIds: string[] = [];
  const queue = [seed];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of scenario.edges.filter((x) => x.target === cur)) {
      if (affected.includes(e.source) && !inPath.has(e.source)) {
        inPath.add(e.source);
        pathEdgeIds.push(e.id);
        queue.push(e.source);
      }
    }
  }
  const etaOf = (id: string) => (id === seed ? -1 : forecast.byService[id]?.etaTicks ?? 0);
  const path = [...inPath].sort((a, b) => etaOf(a) - etaOf(b));
  const allAffected = [...new Set([...affected, seed])];
  return {
    ...empty,
    path,
    pathEdgeIds,
    affectedServiceIds: allAffected,
    affectedCount: allAffected.length,
    blastRadiusPct: Math.round((allAffected.length / total) * 100),
  };
}
