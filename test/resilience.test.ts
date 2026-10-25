import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_SCENARIOS,
  buildResilienceContext,
  createPlayback,
  createScannedRepoScenario,
  playbackReducer,
  runResilienceStep,
} from '../src/domain/resilience/index.ts';
import { buildInvestigationSystemPrompt } from '../src/server/investigationProvider.ts';
import { buildInvestigationCacheKey } from '../src/server/responseCache.ts';
import type { InvestigateApiRequest } from '../src/domain/investigation/types.ts';

const at = (scenarioId: string, tick: number) => runResilienceStep({ ...createPlayback(scenarioId), tick });

for (const sc of BUILTIN_SCENARIOS) {
  test(`${sc.id}: ranks the true root cause first and warns before the crash`, () => {
    const crash = at(sc.id, sc.totalTicks - 1).selfCheck.actualFirstFailureTick;
    assert.ok(crash !== null, 'scenario should reach a failure');
    const snap = at(sc.id, crash);
    assert.equal(snap.selfCheck.rootCauseCorrect, true);
    assert.equal(snap.rootCause.candidates[0].serviceId, sc.groundTruth.rootServiceId);
    assert.ok(snap.rootCause.candidates[0].evidence.length > 0);
    assert.ok((snap.selfCheck.leadTimeTicks ?? 0) > 0, 'warning must precede failure');
    assert.equal(snap.shouldAutoPause, true);
  });

  test(`${sc.id}: recommended strategy beats doing nothing`, () => {
    const snap = at(sc.id, at(sc.id, sc.totalTicks - 1).selfCheck.actualFirstFailureTick! - 3);
    const { baseline, outcomes, recommendedId } = snap.recovery;
    assert.equal(outcomes.length, 6);
    assert.ok(baseline);
    assert.ok(new Set(outcomes.map((o) => o.affectedCount)).size > 1, 'strategies must change propagation');
    const best = outcomes.find((o) => o.strategyId === recommendedId)!;
    assert.ok(best.affectedCount <= baseline.affectedCount);
    assert.ok(best.score > baseline.score);
  });
}

test('quiet before the fault and insufficient evidence during the baseline', () => {
  assert.equal(at('shop-payment-db-pool', 5).rootCause.status, 'insufficient_evidence');
  const quiet = at('shop-payment-db-pool', 16);
  assert.equal(quiet.rootCause.status, 'no_anomaly');
  assert.equal(quiet.forecast.next, null);
});

test('deterministic for the same playback state', () => {
  assert.deepEqual(at('orders-auth-bad-deploy', 30), at('orders-auth-bad-deploy', 30));
});

test('applying the recommended strategy reduces affected services in the world', () => {
  const id = 'shop-payment-db-pool';
  let s = { ...createPlayback(id), tick: 36 };
  const rec = runResilienceStep(s).recovery;
  s = playbackReducer(s, { type: 'applyStrategy', strategyId: rec.recommendedId!, targetServiceId: rec.targetServiceId! });
  const end = runResilienceStep({ ...s, tick: 79 });
  assert.ok(end.selfCheck.affectedWithApplied! < end.selfCheck.affectedWithoutAction);
  assert.equal(end.applied?.state, 'contained');
});

test('scanned-repo edges are weak and do not cascade', () => {
  const sc = createScannedRepoScenario([
    { id: 'room-server', name: 'Server', layer: 'gateway', dependencies: ['room-db'] },
    { id: 'room-db', name: 'DB', layer: 'foundation' },
  ]);
  assert.equal(sc.edges[0].provenance, 'scan-heuristic');
  assert.ok(sc.edges[0].weight < 0.5);
  const snap = runResilienceStep({ ...createPlayback(sc.id), tick: 79 }, sc);
  assert.equal(snap.selfCheck.affectedWithoutAction, 1);
});

test('investigate prompt and cache key work with and without resilienceContext', () => {
  const base: InvestigateApiRequest = {
    roomId: 'payment-db',
    roomName: 'payment-db',
    roomLayer: 'foundation',
    roomStatus: 'implemented',
    roomEvidence: 'x',
    repoContext: { owner: 'o', repo: 'r', branch: 'main', inspectedFiles: [], detectedTechnologies: [] },
  };
  const plain = buildInvestigationSystemPrompt(base);
  assert.ok(!plain.includes('RESILIENCE ENGINE FINDINGS'));
  const ctx = buildResilienceContext(at('shop-payment-db-pool', 40), 'payment-db');
  const withCtx = { ...base, resilienceContext: ctx };
  assert.ok(buildInvestigationSystemPrompt(withCtx).includes('RESILIENCE ENGINE FINDINGS'));
  assert.notEqual(buildInvestigationCacheKey(base), buildInvestigationCacheKey(withCtx));
  assert.ok(JSON.stringify(withCtx).length < 150 * 1024);
});

import { simulateWorld, sustainedFailures } from '../src/domain/resilience/simulator.ts';

for (const sc of BUILTIN_SCENARIOS) {
  const end = sc.totalTicks - 1;
  const truth = sustainedFailures(simulateWorld(sc, sc.faults, null, end), 0, end).sort();
  const crash = at(sc.id, end).selfCheck.actualFirstFailureTick!;

  test(`${sc.id}: ground truth is the scenario's single fault`, () => {
    assert.equal(sc.faults.length, 1);
    assert.equal(sc.groundTruth.rootServiceId, sc.faults[0].serviceId);
    assert.equal(sc.groundTruth.faultStartTick, sc.faults[0].startTick);
    assert.ok(truth.includes(sc.groundTruth.rootServiceId));
  });

  test(`${sc.id}: cascade projection matches the simulated failures and real edges`, () => {
    const snap = at(sc.id, crash - 3);
    assert.deepEqual([...snap.cascade.affectedServiceIds].sort(), truth);
    assert.equal(snap.cascade.path[0], sc.groundTruth.rootServiceId);
    assert.equal(snap.cascade.blastRadiusPct, Math.round((truth.length / sc.services.length) * 100));
    for (const id of snap.cascade.pathEdgeIds) {
      const e = sc.edges.find((x) => x.id === id);
      assert.ok(e && snap.cascade.path.includes(e.source) && snap.cascade.path.includes(e.target), id);
    }
  });

  test(`${sc.id}: self-check numbers come from the simulation`, () => {
    const s = at(sc.id, end).selfCheck;
    assert.equal(s.affectedWithoutAction, truth.length);
    assert.ok(s.firstWarningTick! > sc.groundTruth.faultStartTick, 'no warning before the fault exists');
    assert.equal(s.leadTimeTicks, s.actualFirstFailureTick! - s.firstWarningTick!);
    assert.equal(at(sc.id, crash - 1).selfCheck.actualFirstFailureTick, null);
  });

  test(`${sc.id}: strategy outcomes carry assumptions and honest side effects`, () => {
    for (const o of at(sc.id, crash - 3).recovery.outcomes) {
      assert.ok(o.assumptions.length > 0 && o.tradeoffs.length > 0, o.strategyId);
      assert.ok(o.sideEffectRisk > 0 && o.sideEffectRisk <= 1, o.strategyId);
    }
  });
}

test('rollback does not fix a non-deploy fault; it does fix a bad deploy', () => {
  const pool = at('shop-payment-db-pool', 45).recovery;
  assert.equal(pool.outcomes.find((o) => o.strategyId === 'rollback')!.affectedCount, pool.baseline!.affectedCount);
  const auth = at('orders-auth-bad-deploy', 29).recovery;
  assert.equal(auth.outcomes.find((o) => o.strategyId === 'rollback')!.affectedCount, 0);
});

test("a restart's planned outage is not reported as the first failure", () => {
  let p = { ...createPlayback('shop-payment-db-pool'), tick: 40 };
  p = playbackReducer(p, { type: 'applyStrategy', strategyId: 'restart', targetServiceId: 'payment-db' });
  const snap = runResilienceStep(p);
  assert.equal(snap.selfCheck.actualFirstFailureTick, null);
  assert.equal(snap.shouldAutoPause, false);
});

import { relatedServiceIds, summarizeSnapshot } from '../src/domain/resilience/index.ts';

test('summary lines and focus set come from the snapshot', () => {
  const early = summarizeSnapshot(at('booknook-catalog-pool', 5));
  assert.equal(early.petMood, 'calm');
  assert.equal(early.leadTime, null);
  const crash = at('booknook-catalog-pool', 79).selfCheck.actualFirstFailureTick!;
  const warn = summarizeSnapshot(at('booknook-catalog-pool', crash - 3));
  assert.equal(warn.petMood, 'worried');
  assert.match(warn.rootCause, /Book Catalog/);
  assert.match(warn.bestFix, /→ 4 → 0 rooms down/);
  assert.equal(summarizeSnapshot(at('booknook-catalog-pool', crash + 2)).petMood, 'alarmed');
  assert.deepEqual(relatedServiceIds(at('booknook-catalog-pool', 0), 'room-catalog').sort(), ['reviews', 'room-catalog', 'room-checkout', 'room-recommendations']);
});

test('once a failure is forecast, the forecast does not vanish before the crash', () => {
  for (const sc of BUILTIN_SCENARIOS) {
    const crash = at(sc.id, sc.totalTicks - 1).selfCheck.actualFirstFailureTick!;
    let seen = false;
    for (let t = 12; t <= crash; t++) {
      const hasEta = at(sc.id, t).forecast.next?.etaTicks != null;
      if (seen) assert.ok(hasEta, `${sc.id}: forecast dropped at t=${t}`);
      seen ||= hasEta;
    }
    assert.ok(seen, `${sc.id}: no forecast before the crash`);
  }
});

test('switching fixes rewinds to the decision tick; clearing removes the fix', () => {
  let p = { ...createPlayback('booknook-catalog-pool'), tick: 40 };
  p = playbackReducer(p, { type: 'applyStrategy', strategyId: 'failover', targetServiceId: 'room-catalog' });
  p = { ...p, tick: 55 };
  p = playbackReducer(p, { type: 'applyStrategy', strategyId: 'scale_out', targetServiceId: 'room-catalog' });
  assert.equal(p.tick, 40);
  assert.deepEqual(p.applied, { strategyId: 'scale_out', targetServiceId: 'room-catalog', tick: 40 });
  p = playbackReducer({ ...p, tick: 50 }, { type: 'clearStrategy' });
  assert.equal(p.tick, 40);
  assert.equal(p.applied, null);
});

import { evaluateScenarios } from '../src/domain/resilience/index.ts';

test('accuracy scorecard is measured per scenario and the recommended fix reduces failures', () => {
  const rows = evaluateScenarios();
  assert.equal(rows.length, BUILTIN_SCENARIOS.length);
  for (const r of rows) {
    assert.equal(r.rootCauseCorrect, true, r.scenarioId);
    assert.ok((r.leadTimeTicks ?? 0) > 0, r.scenarioId);
    assert.ok(r.failuresWithFix < r.failuresWithoutAction, `${r.scenarioId}: ${r.failuresWithFix} vs ${r.failuresWithoutAction}`);
  }
});

test('self-check scores an earlier injected fault as the ground truth', () => {
  let p = { ...createPlayback('booknook-catalog-pool'), tick: 8 };
  p = playbackReducer(p, { type: 'inject', serviceId: 'room-auth', faultType: 'bad_deploy' });
  const snap = runResilienceStep({ ...p, tick: 24 });
  assert.equal(snap.selfCheck.groundTruthRootId, 'room-auth');
  assert.equal(snap.rootCause.candidates[0].serviceId, 'room-auth');
  assert.equal(snap.selfCheck.rootCauseCorrect, true);
});

import { buildSystemPrompt } from '../src/server/contextBuilder.ts';
import { buildChatCacheKey } from '../src/server/responseCache.ts';

test('chat prompt carries engine findings only when the Live Risk context is sent', () => {
  const repoContext = { owner: 'o', repo: 'r', branch: 'main', inspectedFiles: [], detectedTechnologies: [], totalFiles: 0 };
  const base = { message: 'why is checkout failing?', repoContext } as unknown as Parameters<typeof buildSystemPrompt>[0];
  assert.ok(!buildSystemPrompt(base).includes('LIVE RISK RULES'));
  const ctx = buildResilienceContext(at('booknook-catalog-pool', 40), 'room-checkout');
  const withCtx = { ...base, resilienceContext: ctx };
  const prompt = buildSystemPrompt(withCtx);
  assert.ok(prompt.includes('LIVE RISK RULES') && prompt.includes('room-catalog'));
  assert.notEqual(buildChatCacheKey(base), buildChatCacheKey(withCtx));
});

import { analyzeLogText, exportScenarioLogs, parseLogText } from '../src/domain/resilience/index.ts';

test('log analyzer finds the true root cause from exported logs alone', () => {
  for (const sc of BUILTIN_SCENARIOS) {
    const crash = at(sc.id, sc.totalTicks - 1).selfCheck.actualFirstFailureTick!;
    const a = analyzeLogText(exportScenarioLogs(sc.id, crash + 3));
    assert.equal(a.rootCause.candidates[0]?.serviceId, sc.groundTruth.rootServiceId, sc.id);
    assert.ok(a.edges.length > 0 && a.edges.every((e) => e.provenance === 'log-inferred'), sc.id);
  }
});

test('log parser accepts ISO, level-first and JSON lines, and explains short input', () => {
  const text = [
    '2024-05-01T10:00:00Z api INFO GET / 200 in 40ms',
    '2024-05-01 10:00:01,250 ERROR db could not connect',
    '{"timestamp":"2024-05-01T10:00:02Z","service":"cache","level":"warn","message":"evicting"}',
    'garbage line',
  ].join('\n');
  const p = parseLogText(text);
  assert.deepEqual(p.lines.map((l) => [l.serviceId, l.level]), [['api', 'INFO'], ['db', 'ERROR'], ['cache', 'WARN']]);
  assert.equal(p.skipped, 1);
  assert.ok(analyzeLogText(text).notes.some((n) => n.includes('baseline')));
});

import { buildIncidentReport } from '../src/domain/resilience/index.ts';

test('incident report reflects the snapshot (root cause, fixes, action)', () => {
  let p = { ...createPlayback('booknook-catalog-pool'), tick: 43 };
  const rec = runResilienceStep(p).recovery;
  p = playbackReducer(p, { type: 'applyStrategy', strategyId: rec.recommendedId!, targetServiceId: rec.outcomes[0].targetServiceId });
  const md = buildIncidentReport(runResilienceStep({ ...p, tick: 60 }));
  assert.match(md, /\*\*Root cause:\*\* Book Catalog & Inventory/);
  assert.match(md, /\(recommended\)/);
  assert.match(md, /## Action taken[\s\S]*contained at t=\d+/);
  assert.match(md, /Root cause correct: yes/);
});
