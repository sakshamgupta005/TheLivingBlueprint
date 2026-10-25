/**
 * Deterministic world simulator. The world knows the injected faults; the analysis
 * never reads this module's internals, only the metrics and logs `observe` emits.
 */

import type {
  AppliedStrategy,
  DependencyEdge,
  FaultInjection,
  FaultType,
  LogEvent,
  LogLevel,
  MetricObservation,
  ResilienceScenario,
} from './types.ts';

/** A service counts as down at or above this degradation. */
export const FAIL_DEGRADATION = 0.85;
/** Callers of an isolated (circuit-broken) service only feel this share of its degradation. */
export const ISOLATION_FACTOR = 0.15;

export interface WorldRun {
  ids: string[];
  /** degradation[tick][serviceIndex], 0..1 */
  degradation: number[][];
  ownIntensity: number[][];
  ownFaultType: Array<Array<FaultType | null>>;
  /** Callee index that pushes the most propagated pressure, or -1. */
  worstCallee: number[][];
}

/** Stateless deterministic noise in [0, 1). */
export function hashNoise(seed: number, a: number, b: number, c: number): number {
  let h = (seed | 0) ^ Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b) ^ Math.imul(c + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function entryServiceIds(scenario: ResilienceScenario): string[] {
  const called = new Set(scenario.edges.map((e) => e.target));
  return scenario.services.map((s) => s.id).filter((id) => !called.has(id));
}

function faultIntensity(f: FaultInjection, t: number, applied: AppliedStrategy | null): number {
  if (t < f.startTick) return 0;
  let start = f.startTick;
  let k = 1;
  if (applied && t >= applied.tick) {
    const onTarget = applied.targetServiceId === f.serviceId;
    const since = t - applied.tick;
    switch (applied.strategyId) {
      case 'restart':
        // Clears pools/heap, so the ramp starts over. Bad code comes straight back.
        if (onTarget && f.faultType !== 'bad_deploy') start = Math.max(start, applied.tick + 1);
        break;
      case 'rollback':
        if (onTarget && f.faultType === 'bad_deploy' && since >= 2) return 0;
        break;
      case 'scale_out':
        if (onTarget && since >= 3) k = f.faultType === 'connection_pool_exhaustion' ? 0.35 : f.faultType === 'memory_leak' ? 0.75 : 1;
        break;
      case 'failover':
        if (onTarget && since >= 2 && f.faultType !== 'bad_deploy') k = 0.1;
        break;
      case 'rate_limit':
        if (since >= 1 && f.faultType === 'connection_pool_exhaustion') k = 0.6;
        break;
      case 'isolate':
        break;
    }
  }
  const progress = Math.min(1, Math.max(0, (t - start + 1) / f.rampTicks));
  return Math.pow(progress, 1.3) * k;
}

function edgeWeight(e: DependencyEdge, t: number, applied: AppliedStrategy | null): number {
  if (applied?.strategyId === 'isolate' && e.target === applied.targetServiceId && t >= applied.tick + 1) {
    return e.weight * ISOLATION_FACTOR;
  }
  return e.weight;
}

export function simulateWorld(
  scenario: ResilienceScenario,
  faults: FaultInjection[],
  applied: AppliedStrategy | null,
  untilTick: number
): WorldRun {
  const ids = scenario.services.map((s) => s.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const callees = ids.map((id) => scenario.edges.filter((e) => e.source === id && index.has(e.target)));
  const run: WorldRun = { ids, degradation: [], ownIntensity: [], ownFaultType: [], worstCallee: [] };

  for (let t = 0; t <= untilTick; t++) {
    const deg: number[] = [];
    const own: number[] = [];
    const ownType: Array<FaultType | null> = [];
    const worst: number[] = [];
    for (let i = 0; i < ids.length; i++) {
      let healthy = 1;
      let type: FaultType | null = null;
      let strongest = 0;
      for (const f of faults) {
        if (f.serviceId !== ids[i]) continue;
        const x = faultIntensity(f, t, applied);
        healthy *= 1 - x;
        if (x > strongest) {
          strongest = x;
          type = f.faultType;
        }
      }
      let o = 1 - healthy;
      if (applied?.strategyId === 'restart' && applied.targetServiceId === ids[i] && t === applied.tick) o = 1;

      let prop = 0;
      let w = -1;
      if (t > 0) {
        for (const e of callees[i]) {
          const j = index.get(e.target)!;
          const v = edgeWeight(e, t, applied) * run.degradation[t - 1][j];
          if (v > prop) {
            prop = v;
            w = j;
          }
        }
      }
      own.push(o);
      ownType.push(o >= prop ? type : null);
      worst.push(w);
      deg.push(Math.min(1, Math.max(o, prop)));
    }
    run.degradation.push(deg);
    run.ownIntensity.push(own);
    run.ownFaultType.push(ownType);
    run.worstCallee.push(worst);
  }
  return run;
}

/** Services down for at least 2 consecutive ticks inside [from, to]. */
export function sustainedFailures(run: WorldRun, from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < run.ids.length; i++) {
    for (let t = Math.max(1, from); t <= Math.min(to, run.degradation.length - 1); t++) {
      if (run.degradation[t][i] >= FAIL_DEGRADATION && run.degradation[t - 1][i] >= FAIL_DEGRADATION) {
        out.push(run.ids[i]);
        break;
      }
    }
  }
  return out;
}

/** First tick any service is down. A restart's own planned outage of its target is not a failure. */
export function firstFailureTick(run: WorldRun, upTo: number, applied: AppliedStrategy | null = null): number | null {
  const plannedOutage = applied?.strategyId === 'restart' ? run.ids.indexOf(applied.targetServiceId) : -1;
  for (let t = 0; t <= Math.min(upTo, run.degradation.length - 1); t++) {
    if (run.degradation[t].some((d, i) => d >= FAIL_DEGRADATION && !(i === plannedOutage && t === applied!.tick))) return t;
  }
  return null;
}

function reqId(seed: number, t: number, i: number, k: number): string {
  return Math.floor(hashNoise(seed, t, i, k) * 0xfffffff).toString(16).padStart(7, '0') + (t % 10);
}

function faultMessage(type: FaultType, own: number, r: number): { level: LogLevel; message: string } {
  switch (type) {
    case 'connection_pool_exhaustion':
      return own < 0.6
        ? { level: 'WARN', message: `connection pool wait ${Math.round(40 + own * 900)}ms active=${Math.min(50, Math.round(20 + own * 30))}/50` }
        : { level: 'ERROR', message: 'could not acquire connection from pool within 5000ms (active=50/50)' };
    case 'memory_leak':
      return own < 0.6
        ? { level: 'WARN', message: `heap usage ${Math.round(55 + own * 44)}% gc pause ${Math.round(20 + own * 600)}ms` }
        : { level: 'ERROR', message: `OutOfMemoryError: heap space exhausted in worker-${1 + Math.floor(r * 4)}` };
    case 'bad_deploy':
      return {
        level: 'ERROR',
        message: "TypeError: cannot read properties of undefined (reading 'claims') in request handler build=9f3c2a1",
      };
  }
}

export interface Observations {
  /** metrics[serviceIndex][tick] */
  metrics: MetricObservation[][];
  logs: LogEvent[];
}

export function observe(
  scenario: ResilienceScenario,
  run: WorldRun,
  applied: AppliedStrategy | null,
  untilTick: number
): Observations {
  const { seed } = scenario;
  const metrics: MetricObservation[][] = scenario.services.map(() => []);
  const logs: LogEvent[] = [];
  const last = Math.min(untilTick, run.degradation.length - 1);

  for (let t = 0; t <= last; t++) {
    const rateLimited = applied?.strategyId === 'rate_limit' && t >= applied.tick + 1;
    scenario.services.forEach((s, i) => {
      const r = (k: number) => hashNoise(seed, t, i, k);
      const d = run.degradation[t][i];
      const errorRate = Math.min(0.99, s.baseErrorRate * (0.7 + 0.6 * r(1)) + 0.62 * d * d * (0.9 + 0.2 * r(2)));
      const p95Ms = s.baseP95Ms * (1 + 3.5 * d) * (0.92 + 0.16 * r(3));
      const rps = s.baseRps * (1 - 0.5 * d) * (rateLimited ? 0.6 : 1) * (0.95 + 0.1 * r(4));
      metrics[i].push({ tick: t, serviceId: s.id, rps, errorRate, p95Ms });

      const push = (k: number, level: LogLevel, message: string) =>
        logs.push({ id: `${t}.${i}.${k}`, tick: t, serviceId: s.id, level, message });

      push(0, 'INFO', `GET /api/${s.id} 200 in ${Math.round(p95Ms * (0.4 + 0.4 * r(5)))}ms req=${reqId(seed, t, i, 6)}`);

      const own = run.ownIntensity[t][i];
      const type = run.ownFaultType[t][i];
      if (type && own >= 0.1 && r(7) < 0.35 + own) {
        const m = faultMessage(type, own, r(8));
        push(1, m.level, m.message);
      }
      const worst = run.worstCallee[t][i];
      if (!type && worst >= 0 && d >= 0.15 && r(9) < d + 0.25) {
        const callee = run.ids[worst];
        if (d < 0.5) push(2, 'WARN', `upstream call to ${callee} slow: ${Math.round(p95Ms)}ms`);
        else push(2, 'ERROR', `upstream call to ${callee} timed out after 3000ms req=${reqId(seed, t, i, 11)}`);
      }
      if (d >= FAIL_DEGRADATION && r(10) < 0.7) push(3, 'ERROR', `health check failed: ${s.id} returning 503`);
      if (applied && t === applied.tick && applied.targetServiceId === s.id) {
        push(4, 'INFO', `operator action: ${applied.strategyId} on ${s.id}`);
      }
    });
  }
  return { metrics, logs };
}
