import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_SCENARIOS,
  createPlayback,
  playbackReducer,
  runResilienceStep,
  relatedServiceIds,
  summarizeSnapshot,
} from '../src/domain/resilience/index.ts';
import { SAMPLE_ROOMS } from '../src/data/sampleData.ts';

test('Default scenario is booknook-catalog-pool and aligns with house rooms', () => {
  const defaultScenario = BUILTIN_SCENARIOS[0];
  assert.equal(defaultScenario.id, 'booknook-catalog-pool');

  // Every house room is a service in the scenario (the scenario also has supporting services).
  const scenarioServiceIds = new Set(defaultScenario.services.map((s) => s.id));
  for (const room of SAMPLE_ROOMS) assert.ok(scenarioServiceIds.has(room.id), room.id);
});

test('Live Risk flow: starts, reaches failure threshold with auto-pause, and calms after fix', () => {
  const sc = BUILTIN_SCENARIOS[0];
  let state = createPlayback(sc.id);

  // Early state (t < 12)
  const snap0 = runResilienceStep(state);
  assert.equal(snap0.tick, 0);
  assert.equal(snap0.shouldAutoPause, false);

  // Discover actualFirstFailureTick from full simulation
  const crashTick = runResilienceStep({ ...state, tick: sc.totalTicks - 1 }).selfCheck.actualFirstFailureTick;
  assert.ok(crashTick !== null && crashTick > 0);

  // Step up to the failure tick
  state = { ...state, tick: crashTick };
  const snapCrash = runResilienceStep(state);
  assert.equal(snapCrash.shouldAutoPause, true);

  // Check top root cause is room-catalog
  assert.equal(snapCrash.rootCause.candidates[0].serviceId, 'room-catalog');

  // Verify early warning lead time
  assert.ok((snapCrash.selfCheck.leadTimeTicks ?? 0) > 0);

  // Apply best recovery strategy
  const rec = snapCrash.recovery;
  assert.ok(rec.recommendedId !== null);
  assert.ok(rec.targetServiceId !== null);

  state = playbackReducer(state, {
    type: 'applyStrategy',
    strategyId: rec.recommendedId!,
    targetServiceId: rec.targetServiceId!,
  });

  // Verify containment at scenario horizon
  const snapEnd = runResilienceStep({ ...state, tick: sc.totalTicks - 1 });
  assert.equal(snapEnd.applied?.state, 'contained');
  assert.ok((snapEnd.selfCheck.affectedWithApplied ?? 0) < snapEnd.selfCheck.affectedWithoutAction);
});

test('Context bar focused room filtering correctly isolates related rooms', () => {
  const snap = runResilienceStep({ ...createPlayback('booknook-catalog-pool'), tick: 20 });
  const relatedCatalog = relatedServiceIds(snap, 'room-catalog');
  assert.ok(relatedCatalog.includes('room-catalog'));
  assert.ok(relatedCatalog.includes('room-checkout'));

  const summary = summarizeSnapshot(snap);
  assert.ok(summary.nextFailure.length > 0);
  assert.ok(summary.blastRadius.includes('rooms at risk'));
});
