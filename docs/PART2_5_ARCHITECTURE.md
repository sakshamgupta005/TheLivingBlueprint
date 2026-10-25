# Part 2.5 — Cascading Failure Forecasting: Architecture & Plan

Status: plan only, no code changed. Grounded in a read of `main` @ `e94fdc7`.
Note: the brief I received was cut off after research item 4 (OpenTelemetry Demo). Anything after that was not seen.

## 0. One-line design

Each **room becomes a service**. A **deterministic resilience engine** (pure TS, no AI) reads simulated logs and the room dependency graph. It scores each room's failure risk, traces how a failure spreads, ranks root causes, and replays recovery strategies on the same graph to compare them. **AI only narrates** the engine's result inside the existing *Investigate this room* flow. This keeps the project's core rule: AI inference never decides status.

---

## 1. What exists today (real files)

| Concern | Where | Notes for 2.5 |
|---|---|---|
| Repo scan | `src/domain/github/scanner.ts` → `scanGitHubRepository()` | Reuse as-is. |
| Rooms from scan | `src/domain/github/architectureMapper.ts` → `mapScanResultToHouse()` | Fixed room kinds (`room-server`, `room-auth`, `room-db`, `room-ui`, `room-tests`, `room-core`, …). Returns `project.dependencies: DependencyConnection[]`. |
| Dependency edges | same file, ~L611 | **Heuristic**: an edge is added when a file excerpt contains another room's path or folder name, and is then marked `status: 'verified'`. That is too weak to drive failure prediction alone. See §4.3. |
| Status engine | `src/domain/statusEngine.ts` → `evaluateRequirement`, `deriveRoomStatus`, `deriveProjectStatus` | Room colour = `RoomStatus` (`verified` green / `implemented` yellow / `blocked` red / `planned` / `unknown`). Driven only by `EvidenceRecord` + `verificationResult`. Rule: AI-only evidence never gives `verified`. **Do not change.** Add risk as a separate overlay. |
| Domain types | `src/domain/types.ts` (`Project`, `RoomModule`, `DependencyConnection`, `EvidenceRecord`); UI room `src/types.ts` → `ArchitecturalRoom` (has `dependencies?: string[]`, `metrics`) | Extend through new types, not edits to the existing ones. |
| Investigate | UI `src/components/RoomInspector.tsx` → `handleInvestigate()` (3-stage spinner); API `api/investigate.ts` → `src/server/investigateHandler.ts` → `src/server/investigationProvider.ts` → `executeRoomInvestigation()`; types `src/domain/investigation/types.ts` | Main integration point. Add an optional `resilienceContext` to `InvestigateApiRequest`. |
| AI providers | `src/server/aiHedging.ts` → `executeAiWithStrategy()` (Gemini / Groq / OmniRoute / Cloudflare, hedged), `aiProviderRunner.ts`, `errorClassifier.ts`, `responseCache.ts` | Reuse unchanged. |
| Chat | `src/components/ChatPanel.tsx`, `api/chat.ts`, `src/server/contextBuilder.ts` → `buildSystemPrompt()` | Later: add a forecast summary block to context. |
| Static simulation | `src/domain/simulation/interpreter.ts` → `runStaticSimulation()`, `deriveScenarios()` | Different scope (input scenarios through code paths). Reuse only the UI pattern of `StaticSimulationWorkbench.tsx`. |
| Error paths | `src/domain/architectureViews/errorPathAnalyzer.ts` → `analyzeErrorPaths()` | Adapter: static evidence of missing try/catch, retries, timeouts → raises edge propagation weight. |
| Graph / viz | `InteractiveGraphCanvas.tsx`, `RoomFlowVisualizer.tsx` (reactflow), `src/domain/graph/layoutEngine.ts`, `IsometricHouse.tsx`; d3 in deps | Reuse reactflow for the cascade graph and d3 for the timeline sparklines. No new chart library. |
| Persistence | `src/domain/workspace/workspaceStorage.ts` | Persist the last scenario + forecast per workspace. |
| Tests | `node --experimental-strip-types --test test/*.test.ts` (root), separate suite in `vscode-extension/test` | New engine tests go in `test/resilience*.test.ts`, same runner. |
| Deploy | `vercel.json`, `api/*.ts`, `maxDuration 30`; 4 functions today | 0 new functions needed (see §3.3). |
| Extension | `vscode-extension/` (own build `build.js`, VSIX served by `src/server/extensionDownloadHandler.ts`) | **Out of scope for 2.5.** The engine is pure TS, so it can be wired in later. |

---

## 2. Open-source research → what we take

I took these from what I already know about each project. I did not re-fetch them in this session.

| Project | What it is | What we take | What we leave |
|---|---|---|---|
| **Drain3** (logpai, MIT, Python) | Online log template mining with a fixed-depth parse tree and similarity threshold | Port a **Drain-lite** in TS (~150 LOC): tokenise → mask numbers/IDs/IPs → tree by token count + first tokens → merge by similarity ≥ 0.5. Gives `templateId` per line, so "new template" and "template rate spike" become anomaly signals. | Persistence, Kafka/Redis adapters, Python runtime. |
| **PyRCA** (Salesforce, Python) | RCA library: graph-based (random walk, Bayesian) and anomaly-based (ε-Diagnosis) methods on metrics | The **random-walk-on-dependency-graph** idea (MicroCause / RCD style): personalised PageRank on the *reversed* call graph, weighted by anomaly correlation. The root cause is the node where the walk settles. Plus a simple **ε-diagnosis-style** z-score of each signal between a normal and an abnormal window. | Bayesian structure learning (too slow and data-hungry for a demo), the Python sidecar. |
| **OpenRCA** (Microsoft, ICLR'25 benchmark) | Benchmark of LLM agents doing RCA on real telemetry. LLMs score low without structured tools. | Product lesson: **an LLM alone is a weak RCA engine**. Give it a computed, structured result and ask it to explain, not to diagnose. The output schema is {root-cause component, time, reason}. We mirror that. | Datasets (large, licensing). Agent harness. |
| **OpenTelemetry Demo** (Astronomy Shop) | ~15 polyglot microservices + flagd feature flags for fault injection (e.g. `paymentFailure`, `cartFailure`, `adFailure`, `productCatalogFailure`, `recommendationCacheFailure`, `kafkaQueueProblems`) | The **reference topology** and **fault catalog** for our simulated scenarios: frontend → checkout → payment/cart/currency/shipping/email, cart → valkey, checkout → kafka → accounting/fraud. Flag names map to our fault types. | Running the real stack (Docker, ~6 GB). We only simulate its shape. |

**Decision: everything in TypeScript, in-process.** No Python sidecar. Why: Vercel serverless functions are TS, tests use `node --test`, and a hackathon demo must run with `npm run dev` alone. The algorithms we need are small enough to port.

---

## 3. Architecture

```
            ┌───────────── Scenario source ─────────────┐
            │ A) Built-in scenarios (OTel-shaped)        │
            │ B) Scanned repo rooms + synthetic logs     │
            │ C) Pasted/uploaded log file (stretch)      │
            └───────────────┬───────────────────────────┘
                            ▼
  src/domain/resilience/  (pure TS, deterministic, seeded)
  ┌────────────────────────────────────────────────────────────┐
  │ logSimulator  → LogEvent[] per tick (seeded PRNG)          │
  │ logTemplates  → Drain-lite: templateId, new-template flags │
  │ signals       → per room per window: errorRate, p95, rps,  │
  │                 saturation, newTemplates, restarts         │
  │ anomaly       → EWMA + z-score → anomalyScore 0..1         │
  │ topology      → ServiceGraph from DependencyConnection[]   │
  │                 + edge weights (type, retries, timeout,    │
  │                 breaker, errorPath evidence)               │
  │ forecast      → failureProbability(room, horizon) =        │
  │                 own trend ⊕ upstream pressure; ETA         │
  │ cascade       → Monte-Carlo/BFS spread → blast radius,     │
  │                 per-room P(fail), ordered failure path     │
  │ rootCause     → personalised PageRank on reversed graph    │
  │                 → ranked candidates + evidence lines       │
  │ recovery      → apply strategy to graph copy → re-run      │
  │                 cascade → StrategyOutcome scorecard        │
  └──────────────┬─────────────────────────────┬───────────────┘
                 │ ResilienceSnapshot          │ compact summary
                 ▼                             ▼
  UI: Resilience dashboard           /api/investigate (existing)
  (house overlay, cascade graph,     + optional resilienceContext
   timeline, strategy comparison)    → AI narrates RCA in room finding
```

### 3.1 New module: `src/domain/resilience/`

| File | Main export | Notes |
|---|---|---|
| `types.ts` | `LogEvent`, `ServiceSignals`, `ServiceGraph`, `FailureForecast`, `CascadeResult`, `RootCauseCandidate`, `RecoveryStrategy`, `StrategyOutcome`, `ResilienceSnapshot` | Separate from `RoomStatus`. |
| `prng.ts` | `mulberry32(seed)` | Same seed gives the same demo every time. Required for tests and an honest demo. |
| `scenarios.ts` | `BUILTIN_SCENARIOS` | 3 to 4 scenarios: *payment DB connection-pool exhaustion*, *cache failure → DB overload*, *queue backlog → consumer OOM*, *bad deploy in auth*. Each has a topology, a fault (room, type, start tick, ramp) and a "ground-truth" root cause for self-checks. |
| `logSimulator.ts` | `simulateTick(scenario, state, rng)` | Emits realistic log lines (`WARN pool wait 812ms`, `ERROR upstream timeout payment:8080`, `circuit OPEN`). Faults degrade a room. Degradation reaches callers through edge weights. |
| `logTemplates.ts` | `createTemplateMiner()` → `.add(line)` | Drain-lite. |
| `signals.ts` | `aggregateWindow(events, windowMs)` | Rolling 10-tick windows. |
| `anomaly.ts` | `scoreAnomaly(history)` | EWMA baseline. Clamped z-score, then a logistic into 0..1. |
| `topology.ts` | `buildServiceGraph(rooms, deps, overrides?)` | Adapter over `DependencyConnection`. Each edge carries `provenance: 'scenario' \| 'scan-heuristic' \| 'error-path'`. |
| `forecast.ts` | `forecastFailures(graph, signals, horizonTicks)` | Per room: `p = 1 − (1−p_self)·Π(1 − w_e·p_upstream)`. `p_self` comes from the slope of the anomaly score. ETA = ticks until the extrapolated score crosses 0.9. Output is "Next likely failure: X in ~N min (p=0.78)". |
| `cascade.ts` | `simulateCascade(graph, seedFailures, runs=200, rng)` | Monte-Carlo spread over edge weights. Returns per-room P(fail), median ordering, and blast radius (% of rooms / % of gateway traffic). |
| `rootCause.ts` | `rankRootCauses(graph, signals)` | Personalised PageRank on the reversed graph. Teleport is weighted by anomaly score. Ties break on the earliest anomaly onset. Top-3 with evidence: anomaly onset tick, first new template, sample log lines. |
| `recovery.ts` | `STRATEGIES`, `compareStrategies(graph, state, rng)` | Strategies: **restart**, **rollback deploy**, **scale out**, **circuit-break / isolate**, **failover to replica**, **load-shed / rate-limit**. Each is a graph transform plus a time cost and a risk factor. Re-run cascade per strategy. Outcome: blast radius after, time-to-recover, rooms saved, side-effect risk. **Recommended = best weighted score.** The score weights are shown in the UI, so the choice is not a black box. |
| `index.ts` | `runResilienceStep(state)` → `ResilienceSnapshot` | The one call the UI makes per tick. |

Expected size: ~900 to 1,100 LOC with tests. No new runtime dependencies.

### 3.2 How a room turns red (two separate axes)

- **Build status (existing, unchanged):** `deriveRoomStatus` → planned / implemented / verified / blocked / unknown. Shown as the room colour, as today.
- **Runtime risk (new overlay):** `healthy` < 0.3 ≤ `at-risk` < 0.7 ≤ `critical`, and `failed` once the simulated room is down. Shown as a glow or pulse ring plus a pet mood on `IsometricHouse`, and a badge in `RoomInspector`.

Optional bridge, behind a flag: when a room is `failed` in the simulation, emit an `EvidenceRecord` with `sourceType: 'test_result'`, `verificationResult.failed`, and `description: 'Simulated runtime failure (scenario X)'`. The existing engine then turns it `blocked` with no change to its rules. This is real reuse, and the evidence is clearly labelled *simulated*.

### 3.3 API — no new serverless function

Extend `InvestigateApiRequest` (`src/domain/investigation/types.ts`) with:

```ts
resilienceContext?: {
  scenarioId: string; tick: number;
  forecast: { roomId: string; p: number; etaTicks?: number }[];   // top 5
  rootCauses: { roomId: string; score: number; evidence: string[] }[]; // top 3
  cascadePath: string[]; blastRadiusPct: number;
  strategies: { id: string; score: number; blastAfterPct: number; ttrTicks: number }[];
  sampleLogs: string[];  // ≤ 20 lines, redacted
}
```

`buildInvestigationSystemPrompt()` adds a section when `resilienceContext` is present. The instruction is to explain and challenge the computed RCA, never to replace it, and to label each claim as `observed` (from logs) or `inferred` (use the existing `EvidenceClassification`). Add `'cascade_risk'` to `IssueCategory`. `buildInvestigationCacheKey` must include `scenarioId + tick`. The payload stays well under the 150 KB limit in `investigateHandler`.

Engine runs client-side, so the dashboard works **with AI off**. This also covers the `AiUsageLimitNotice` path and provider outages.

### 3.4 Frontend

**Full, binding UI spec: [PART2_5_FRONTEND_SPEC.md](PART2_5_FRONTEND_SPEC.md).** Summary below.

New top-level view toggle in `App.tsx`: **Blueprint | Resilience**. This is one state flag. Rooms, selection, `RoomInspector` and `ChatPanel` are shared.

`src/components/resilience/`:
- `ResilienceDashboard.tsx` — layout plus the simulation clock (`useReducer` + `setInterval`: play / pause / step / speed / reset, and an "Inject fault" picker).
- `RiskOverlay` — props passed to `IsometricHouse` (`riskByRoomId`). This is a small additive prop.
- `CascadeGraph.tsx` — reactflow. Nodes coloured by P(fail). Animated edges along the predicted path. Root cause gets a crown marker.
- `SignalTimeline.tsx` — d3 sparklines per room (error rate, p95), forecast cone, and a "failure predicted here" marker.
- `LogStream.tsx` — virtualised tail. Lines are grouped by Drain template. New templates are highlighted.
- `StrategyComparison.tsx` — table and bar chart: blast radius before vs after, TTR, risk, score. The recommended one is pinned. "Apply" replays the simulation with that strategy, so the user sees it work or fail.
- `RoomInspector` gets a "Runtime risk" block above the Investigate button. Investigate then sends `resilienceContext` automatically.

CSS: extend the tokens in `src/index.css`. It is 8k lines, so add a scoped `resilience` section and keep the visual language.

### 3.5 Scanned repos (secondary path)

For a scanned repo, `buildServiceGraph` uses `mapScanResultToHouse` rooms and edges, tagged `scan-heuristic`. The UI shows a note: "topology inferred from code references". Synthetic logs come from a generic fault profile per room kind (db → pool/latency, auth → token errors, server → 5xx/timeouts). This keeps the "analyse *your* repo" story without claiming real telemetry.

---

## 4. Risks and how they are handled

1. **"Prediction" on simulated data looks fake.** → Each scenario has a ground-truth root cause and fault-start tick. A test and a visible "engine self-check" badge report whether the engine named the right root cause and how many ticks of lead time it gave before the crash. Only real, measured numbers are shown.
2. **Monte-Carlo cost in the browser.** → 200 runs × ~15 nodes is trivial. Recompute cascade/strategies every 5 ticks, not every tick.
3. **Heuristic scan edges marked `verified`.** → Do not trust them for forecasting. Use `provenance` and lower the weight. Fixing the mapper's `status` label is a separate, later change. It is not touched in 2.5.
4. **Scope creep into the extension.** → Excluded.
5. **AI contradicts the engine.** → The prompt tells it to flag disagreement as an `uncertainty`. The UI still shows the engine's answer as primary.

---

## 5. Reuse map

| Reuse directly | Adapter | New |
|---|---|---|
| `scanGitHubRepository`, `mapScanResultToHouse`, `deriveRoomStatus`, `executeAiWithStrategy`, `responseCache`, `errorClassifier.redactSensitiveInfo`, reactflow / d3 / layoutEngine, `workspaceStorage`, `IsometricHouse`, `PixelPetAvatar`, `RoomInspector` investigate flow | `topology.buildServiceGraph` (over `DependencyConnection`), `analyzeErrorPaths` → edge weights, `InvestigateApiRequest.resilienceContext`, `buildInvestigationSystemPrompt` section, optional simulated-failure `EvidenceRecord` bridge | `src/domain/resilience/*`, `src/components/resilience/*`, `test/resilience*.test.ts` |

---

## 6. Build order (my plan, per milestone; each one ends green)

| # | Milestone | Owner suggestion | Done when |
|---|---|---|---|
| M0 | Frontend spec (done), resilience CSS tokens, `fixtures/sampleSnapshots.ts` (one snapshot per UI state in spec §8) | Claude | AntiGravity can build every panel without the engine. |
| M1 | `resilience/types`, `prng`, `scenarios`, `logSimulator`, `logTemplates`, `signals`, `anomaly` + tests | Claude | Same seed gives identical logs. Drain-lite groups the fixture lines into the expected templates. Anomaly score rises after the fault tick. |
| M2 | `topology`, `forecast`, `cascade`, `rootCause` + tests | Claude | On every built-in scenario, the true root cause ranks #1 and the forecast fires ≥ N ticks before the first crash (N measured and reported). |
| M3 | `recovery.compareStrategies` + tests | Claude | Scorecard is deterministic. The recommended strategy reduces blast radius on each scenario. |
| M4 | Dashboard shell, clock, view toggle, risk overlay on the house (spec §10 steps 1, 2, 4) | AntiGravity implements · Claude reviews | Play/pause/inject works with AI disabled. |
| M5 | CascadeGraph, SignalTimeline, LogStream, StrategyComparison (spec §10 step 3) | AntiGravity implements · Claude reviews | All four driven by `ResilienceSnapshot` only. No logic in components. |
| M5.5 | Visual QA pass in the browser against spec §9; Claude fixes polish issues directly (small diffs) | Claude | All 8 acceptance checks pass. |
| M6 | `resilienceContext` in investigate + prompt section + `cascade_risk` category + cache key | Claude | Handler test with a mocked provider passes. Payload < 150 KB. |
| M7 | Demo polish: runbook in `docs/DEMO_RUNBOOK.md`, self-check badge, `npm run build` + full test run | both | Build and tests pass with real counts reported. |

Contract between the two agents: **`src/domain/resilience/types.ts` is frozen after M1.** UI work codes against it with a fixture `ResilienceSnapshot`, so M4–M5 can run in parallel with M2–M3.

## 7. Out of scope for 2.5
VS Code extension integration, real telemetry ingestion (OTLP/Prometheus), Python PyRCA sidecar, changing the existing status rules, a new serverless function.
