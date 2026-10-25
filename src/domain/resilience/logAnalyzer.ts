/**
 * Bring-your-own-logs: parse pasted server logs, turn them into per-service metrics per time window,
 * infer call dependencies from the messages, then reuse the same anomaly / root-cause / forecast code.
 */

import { ANALYSIS_CONFIG, detectAnomalies, forecastFailures, projectCascade, rankRootCauses } from './analysis.ts';
import { mineTemplates } from './logTemplates.ts';
import { getScenario } from './scenarios.ts';
import { observe, simulateWorld } from './simulator.ts';
import type {
  AnomalySignal,
  CascadeProjection,
  DependencyEdge,
  FailureForecast,
  LogEvent,
  LogLevel,
  LogTemplate,
  MetricObservation,
  ResilienceScenario,
  ResilienceSnapshot,
  RiskTier,
  RootCauseResult,
} from './types.ts';

export interface ParsedLogLine {
  /** Seconds (real timestamps) or ticks (t=N lines); see `timeUnit`. */
  t: number;
  serviceId: string;
  level: LogLevel;
  message: string;
}

export interface LogAnalysis {
  lineCount: number;
  parsedCount: number;
  skippedCount: number;
  timeUnit: 'tick' | 'second';
  windowCount: number;
  /** Seconds (or ticks) covered by one analysis window. */
  windowSize: number;
  services: string[];
  edges: DependencyEdge[];
  templates: LogTemplate[];
  anomalies: Record<string, AnomalySignal>;
  rootCause: RootCauseResult;
  forecast: FailureForecast;
  cascade: CascadeProjection;
  notes: string[];
  /** Dashboard-ready view of the pasted logs (no recovery replay: there is no model of your system). */
  snapshot: ResilienceSnapshot | null;
}

const LEVEL = '(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|SEVERE)';
const ISO = '(\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?|\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?)';
const SVC = '([A-Za-z][\\w.-]*)';
const PATTERNS: Array<{ re: RegExp; order: 'tick' | 'tls' | 'tsl' }> = [
  { re: new RegExp(`^t=(\\d+)\\s+${SVC}\\s+${LEVEL}\\s+(.*)$`, 'i'), order: 'tick' },
  { re: new RegExp(`^\\[?${ISO}\\]?\\s+\\[?${LEVEL}\\]?:?\\s+\\[?${SVC}\\]?:?\\s+(.*)$`, 'i'), order: 'tls' },
  { re: new RegExp(`^\\[?${ISO}\\]?\\s+\\[?${SVC}\\]?:?\\s+\\[?${LEVEL}\\]?:?\\s+(.*)$`, 'i'), order: 'tsl' },
];

function normalizeLevel(raw: string): LogLevel {
  const l = raw.toUpperCase();
  if (l.startsWith('WARN')) return 'WARN';
  if (['ERROR', 'ERR', 'FATAL', 'CRITICAL', 'SEVERE'].includes(l)) return 'ERROR';
  return 'INFO';
}

function toSeconds(ts: string): number | null {
  if (/^\d{2}:\d{2}:\d{2}/.test(ts)) {
    const [h, m, s] = ts.replace(',', '.').split(':').map(Number);
    return h * 3600 + m * 60 + s;
  }
  // Timestamps without a zone are treated as UTC so mixed formats line up.
  const iso = ts.replace(' ', 'T').replace(',', '.');
  const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function parseJsonLine(line: string): ParsedLogLine | null {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    const ts = o.timestamp ?? o.time ?? o.ts ?? o['@timestamp'];
    const svc = o.service ?? o.svc ?? o.app ?? o.logger;
    const lvl = o.level ?? o.severity ?? o.lvl;
    const msg = o.message ?? o.msg;
    const t = typeof ts === 'number' ? ts : typeof ts === 'string' ? toSeconds(ts) : null;
    if (t === null || typeof svc !== 'string' || typeof msg !== 'string') return null;
    return { t, serviceId: svc, level: normalizeLevel(String(lvl ?? 'INFO')), message: msg };
  } catch {
    return null;
  }
}

export function parseLogText(text: string): { lines: ParsedLogLine[]; skipped: number; timeUnit: 'tick' | 'second' } {
  const lines: ParsedLogLine[] = [];
  let skipped = 0;
  let ticks = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('{')) {
      const j = parseJsonLine(line);
      if (j) lines.push(j);
      else skipped++;
      continue;
    }
    let parsed: ParsedLogLine | null = null;
    for (const { re, order } of PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      if (order === 'tick') {
        parsed = { t: Number(m[1]), serviceId: m[2], level: normalizeLevel(m[3]), message: m[4] };
        ticks++;
      } else {
        const t = toSeconds(m[1]);
        if (t === null) continue;
        const [svc, lvl] = order === 'tls' ? [m[3], m[2]] : [m[2], m[3]];
        parsed = { t, serviceId: svc, level: normalizeLevel(lvl), message: m[4] };
      }
      break;
    }
    if (parsed) lines.push(parsed);
    else skipped++;
  }
  return { lines, skipped, timeUnit: ticks > lines.length / 2 ? 'tick' : 'second' };
}

const LATENCY_RE = /(\d+(?:\.\d+)?)\s*ms\b/i;
const MAX_WINDOWS = 80;

/** Edges from messages that name another service (e.g. "upstream call to payment timed out"). */
function inferEdges(lines: ParsedLogLine[], services: string[]): DependencyEdge[] {
  const counts = new Map<string, number>();
  const patterns = services.map((s) => ({ s, re: new RegExp(`(^|[^\\w.-])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`) }));
  for (const l of lines) {
    for (const { s, re } of patterns) {
      if (s !== l.serviceId && re.test(l.message)) {
        const key = `${l.serviceId}->${s}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .map(([id]) => {
      const [source, target] = id.split('->');
      return { id, source, target, kind: 'sync' as const, weight: 0.9, provenance: 'log-inferred' as const, retries: 0, hasBreaker: false };
    });
}

export function analyzeLogText(text: string): LogAnalysis {
  const { lines, skipped, timeUnit } = parseLogText(text);
  const notes: string[] = [];
  const empty = (): LogAnalysis => ({
    lineCount: lines.length + skipped,
    parsedCount: lines.length,
    skippedCount: skipped,
    timeUnit,
    windowCount: 0,
    windowSize: 0,
    services: [],
    edges: [],
    templates: [],
    anomalies: {},
    rootCause: { status: 'insufficient_evidence', candidates: [], weights: { temporal: 0, severity: 0, dependency: 0, logEvidence: 0, upstreamImpact: 0 } },
    forecast: { status: 'insufficient_evidence', label: '', horizonTicks: 0, next: null, byService: {} },
    cascade: { status: 'insufficient_evidence', seedServiceId: null, path: [], pathEdgeIds: [], affectedServiceIds: [], affectedCount: 0, totalServices: 0, blastRadiusPct: 0, byService: {} },
    notes,
    snapshot: null,
  });
  if (lines.length === 0) {
    notes.push('No lines matched a known format. Use "t=12 service LEVEL message", "<ISO time> service LEVEL message", "<ISO time> LEVEL service message" or JSON lines.');
    return empty();
  }

  const t0 = Math.min(...lines.map((l) => l.t));
  const span = Math.max(...lines.map((l) => l.t)) - t0;
  const windowSize = timeUnit === 'tick' ? Math.max(1, Math.ceil((span + 1) / MAX_WINDOWS)) : Math.max(1, Math.ceil((span + 1) / 60));
  const windowCount = Math.floor(span / windowSize) + 1;
  if (windowCount < ANALYSIS_CONFIG.baselineTicks) {
    notes.push(`Only ${windowCount} time windows; at least ${ANALYSIS_CONFIG.baselineTicks} are needed to learn a baseline. Paste a longer stretch of logs.`);
  }

  const services = [...new Set(lines.map((l) => l.serviceId))].sort();
  const edges = inferEdges(lines, services);
  if (edges.length === 0) notes.push('No dependencies could be inferred (messages never name another service), so spread and dependency ranking are limited.');

  // Per service, per window: error share (ERROR = 1, WARN = 0.5) and a latency estimate from "...ms" values.
  const metrics: MetricObservation[][] = services.map(() => []);
  const bucket = services.map(() => Array.from({ length: windowCount }, () => ({ n: 0, bad: 0, lat: [] as number[] })));
  const idx = new Map(services.map((s, i) => [s, i]));
  for (const l of lines) {
    const w = Math.min(windowCount - 1, Math.floor((l.t - t0) / windowSize));
    const b = bucket[idx.get(l.serviceId)!][w];
    b.n++;
    b.bad += l.level === 'ERROR' ? 1 : l.level === 'WARN' ? 0.5 : 0;
    const lat = LATENCY_RE.exec(l.message);
    if (lat) b.lat.push(Number(lat[1]));
  }
  services.forEach((s, i) => {
    const allLat = bucket[i].flatMap((b) => b.lat).sort((a, b) => a - b);
    let lastErr = 0;
    let lastLat = allLat.length ? allLat[Math.floor(allLat.length / 2)] : 100;
    bucket[i].forEach((b, w) => {
      if (b.n) lastErr = Math.min(1, b.bad / b.n);
      if (b.lat.length) {
        const sorted = [...b.lat].sort((a, c) => a - c);
        lastLat = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
      }
      metrics[i].push({ tick: w, serviceId: s, rps: b.n, errorRate: lastErr, p95Ms: lastLat });
    });
  });

  const scenario: ResilienceScenario = {
    id: 'uploaded-logs',
    name: 'Your logs',
    description: 'Pasted logs',
    seed: 0,
    totalTicks: windowCount,
    tickSeconds: timeUnit === 'tick' ? windowSize * 10 : windowSize,
    services: services.map((id) => ({ id, name: id, layer: 'service', baseRps: 1, baseP95Ms: 100, baseErrorRate: 0 })),
    edges,
    faults: [],
    groundTruth: { rootServiceId: '', faultType: 'connection_pool_exhaustion', faultStartTick: 0 },
    isScannedRepo: true,
  };
  const last = windowCount - 1;
  const events: LogEvent[] = lines
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((l, i) => ({ id: String(i), tick: Math.min(last, Math.floor((l.t - t0) / windowSize)), serviceId: l.serviceId, level: l.level, message: l.message }));
  const mined = mineTemplates(events, last, ANALYSIS_CONFIG.baselineTicks);
  const anomalies = detectAnomalies(scenario, metrics, last);
  const rootCause = rankRootCauses(scenario, anomalies, mined.logs);
  const forecast = forecastFailures(scenario, anomalies);
  const cascade = projectCascade(scenario, forecast, rootCause);

  return {
    lineCount: lines.length + skipped,
    parsedCount: lines.length,
    skippedCount: skipped,
    timeUnit,
    windowCount,
    windowSize,
    services,
    edges,
    templates: mined.templates,
    anomalies,
    rootCause,
    forecast,
    cascade,
    notes,
    snapshot: toSnapshot(scenario, metrics, anomalies, forecast, cascade, rootCause, mined),
  };
}

function toSnapshot(
  scenario: ResilienceScenario,
  metrics: MetricObservation[][],
  anomalies: Record<string, AnomalySignal>,
  forecast: FailureForecast,
  cascade: CascadeProjection,
  rootCause: RootCauseResult,
  mined: { logs: LogEvent[]; templates: LogTemplate[] }
): ResilienceSnapshot {
  const last = scenario.totalTicks - 1;
  const rank = new Map(rootCause.candidates.map((c) => [c.serviceId, c.rank]));
  const services = scenario.services.map((s, i) => {
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
      rootCauseRank: rank.get(s.id) ?? null,
      latest: metrics[i][last] ?? null,
    };
  });
  const onsets = Object.values(anomalies).map((a) => a.onsetTick).filter((t): t is number => t !== null);
  const fails = Object.values(anomalies).map((a) => a.firstObservedFailureTick).filter((t): t is number => t !== null);
  const firstWarningTick = onsets.length ? Math.min(...onsets) : null;
  const actualFirstFailureTick = fails.length ? Math.min(...fails) : null;
  const lead = firstWarningTick !== null && actualFirstFailureTick !== null && firstWarningTick <= actualFirstFailureTick ? actualFirstFailureTick - firstWarningTick : null;
  const secs = last * scenario.tickSeconds;
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    scenario: { id: scenario.id, name: scenario.name, description: scenario.description, totalTicks: scenario.totalTicks, tickSeconds: scenario.tickSeconds, isScannedRepo: true },
    tick: last,
    simTimeLabel: `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`,
    isFinished: true,
    shouldAutoPause: false,
    services,
    riskByRoomId: Object.fromEntries(services.map((s) => [s.id, s.tier])) as Record<string, RiskTier>,
    graph: { nodes: scenario.services, edges: scenario.edges },
    signals: Object.fromEntries(Object.values(anomalies).map((a) => [a.serviceId, a.history])),
    anomalies,
    forecast,
    cascade,
    rootCause,
    recovery: {
      status: rootCause.status,
      method: 'scenario-twin-replay',
      note: 'Fix comparison replays fixes on a model of the system. Pasted logs have no such model, so no fixes are compared.',
      applyAtTick: last,
      horizonTicks: 0,
      targetServiceId: rootCause.candidates[0]?.serviceId ?? null,
      baseline: null,
      outcomes: [],
      recommendedId: null,
      recommendedReason: 'Fix comparison is only available for simulated scenarios; pasted logs have no system model to replay fixes on.',
      weights: { blast: 0, residual: 0, recovery: 0, sideEffect: 0 },
    },
    logs: mined.logs.slice(-200),
    templates: mined.templates,
    injectedFaults: [],
    applied: null,
    selfCheck: {
      available: false,
      groundTruthRootId: '',
      topCandidateId: rootCause.candidates[0]?.serviceId ?? null,
      rootCauseCorrect: null,
      firstWarningTick,
      actualFirstFailureTick,
      leadTimeTicks: lead,
      leadTimeSeconds: lead === null ? null : lead * scenario.tickSeconds,
      affectedWithoutAction: services.filter((s) => s.observedFailed).length,
      affectedWithApplied: null,
    },
  };
}

/** The simulated logs of a built-in scenario up to `tick`, in the analyzer's "t=N service LEVEL message" format. */
export function exportScenarioLogs(scenarioId: string, tick: number): string {
  const sc = getScenario(scenarioId);
  const upTo = Math.min(tick, sc.totalTicks - 1);
  const world = simulateWorld(sc, sc.faults, null, upTo);
  return observe(sc, world, null, upTo)
    .logs.map((l) => `t=${l.tick} ${l.serviceId} ${l.level} ${l.message}`)
    .join('\n');
}
