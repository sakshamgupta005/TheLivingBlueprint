import type { ResilienceSnapshot } from '../types.ts';
import { runResilienceStep, createPlayback } from '../index.ts';

export const sample = (id: string, tick: number): ResilienceSnapshot =>
  runResilienceStep({ ...createPlayback(id), tick });

export const SNAPSHOT_HEALTHY = sample('shop-payment-db-pool', 5);
export const SNAPSHOT_RISING_RISK = sample('shop-payment-db-pool', 32);
export const SNAPSHOT_ACTIVE_INCIDENT = sample('shop-payment-db-pool', 45);
export const SNAPSHOT_RECOVERY_APPLIED = runResilienceStep({
  ...createPlayback('shop-payment-db-pool'),
  tick: 48,
  applied: { strategyId: 'failover', targetServiceId: 'payment-db', tick: 45 },
});

export const SAMPLE_SNAPSHOTS_BY_STATE: Record<string, ResilienceSnapshot> = {
  healthy: SNAPSHOT_HEALTHY,
  rising_risk: SNAPSHOT_RISING_RISK,
  active_incident: SNAPSHOT_ACTIVE_INCIDENT,
  recovery_applied: SNAPSHOT_RECOVERY_APPLIED,
};
