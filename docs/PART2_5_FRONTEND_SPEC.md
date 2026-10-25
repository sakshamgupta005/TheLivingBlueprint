# Part 2.5 — Resilience Dashboard: Frontend Spec

Owner of the spec and visual sign-off: Claude. Implementer: AntiGravity.
Read with [PART2_5_ARCHITECTURE.md](PART2_5_ARCHITECTURE.md). If this spec and the code disagree, follow this spec and raise the conflict. Do not invent new behaviour.

## 0. Hard rules

1. **Components only render.** All numbers come from `ResilienceSnapshot` (`src/domain/resilience/types.ts`). No scoring, forecasting or sorting logic in `.tsx` files, except sorting for display.
2. **No new dependencies.** Use `reactflow` (already used in `RoomFlowVisualizer.tsx`) and `d3` (already in deps). No chart library, no animation library, no icon package.
3. **No raw hex in components.** Use the CSS tokens in §2 only.
4. **Do not restyle or refactor existing components.** Allowed edits outside `src/components/resilience/` are listed in §6. Nothing else.
5. **Works with AI off.** No component may wait on `/api/*` to render.
6. **Never show colour alone.** Every risk colour is paired with a text label and a number.
7. Build against the fixture `src/domain/resilience/fixtures/sampleSnapshots.ts` (Claude provides it in M0). Do not wait for the engine.

## 1. Visual language

The app is dark and warm (`--bg-main #2B2222`, brown surfaces, muted text). Room **fill colour already means build status**: green verified, amber in progress, red blocked. Risk must not compete with that.

- **Risk uses a different channel:** an outer **ring and glow** around a room or node, never a fill.
- Risk hues are brighter than the status hues so they read as "live" on top of the muted house.
- Monospace (`--font-mono`) for numbers, ticks, log lines. Sans for labels.
- Density: tight like a NOC screen, but every panel has a one-line title and one-line subtitle that says what it shows in plain words.

## 2. New tokens (add to `:root` in `src/index.css`, in a block headed `/* Resilience (Part 2.5) */`)

```css
--risk-healthy: #6F8A8C;   /* calm slate-teal, ring only on hover/selection */
--risk-watch:   #C49A52;
--risk-high:    #D9733F;
--risk-critical:#E5534B;
--risk-failed:  #8A8380;   /* used with the hatch pattern below */
--risk-glow-critical: rgba(229, 83, 75, 0.45);
--risk-glow-high:     rgba(217, 115, 63, 0.35);
--root-cause:   #E8C872;   /* crown marker + root-cause outline */
--recommend:    #7FB38A;   /* recommended strategy accent */
--panel-gap: 12px;
--panel-radius: 10px;
--tile-min-h: 84px;
```

Tiers (the engine provides `tier`; the UI only maps it):

| tier | p range | ring | glow | pulse | label |
|---|---|---|---|---|---|
| `healthy` | < 0.30 | none (hover: 1px `--risk-healthy`) | none | none | Healthy |
| `watch` | 0.30–0.55 | 2px `--risk-watch` | none | none | Watch |
| `high` | 0.55–0.80 | 3px `--risk-high` | `--risk-glow-high` 8px | 2.0s | High risk |
| `critical` | ≥ 0.80 | 3px `--risk-critical` | `--risk-glow-critical` 14px | 1.2s | Critical |
| `failed` | down | 3px dashed `--risk-failed` + 45° hatch fill overlay at 35% | none | none | Failed |

Hatch: one shared SVG `<pattern id="risk-hatch">` in the dashboard root. Do not define it per node.

## 3. Layout

Entry: a segmented control in the existing app header, **Blueprint | Resilience**. Default is Blueprint. The choice is kept in `localStorage` key `lb.view`, wrapped in try/catch.

In Resilience view the left canvas section shows the dashboard. `ChatPanel` stays on the right as today. `RoomInspector` keeps working as the existing drawer and opens when a room or node is clicked.

```
┌ ControlBar ───────────────────────────────────────────────────────────┐
│ Scenario ▾ │ ▶ ❚❚ ⏭ ⟲ │ 1× 2× 4× │ t=042 · 00:07:00 │ Inject fault ▾ │ ✓ Self-check │
├ KpiStrip (4 tiles) ───────────────────────────────────────────────────┤
│ Next likely failure │ Blast radius │ Top root cause │ Recommended fix │
├───────────────────────────────────────────┬───────────────────────────┤
│ CascadeGraph   [Graph | House] toggle     │ StrategyComparison         │
│ (≈ 60%)                                   │ (≈ 40%)                    │
├───────────────────────────────────────────┼───────────────────────────┤
│ SignalTimeline                            │ LogStream                  │
└───────────────────────────────────────────┴───────────────────────────┘
```

- CSS grid, `gap: var(--panel-gap)`. Columns `minmax(0,3fr) minmax(0,2fr)`. Rows: auto, auto, `minmax(360px, 1fr)`, `280px`.
- Below 1100px of available width, use one column in this order: KPIs, CascadeGraph, StrategyComparison, SignalTimeline, LogStream.
- Panels use the existing surface: `--bg-surface`, `1px solid --border-subtle`, `--panel-radius`.

## 4. Components (`src/components/resilience/`)

Every component takes the narrowest props it needs, not the whole snapshot, so each one can be tested and memoised alone.

### 4.1 `ResilienceDashboard.tsx`
- Owns the clock: `useReducer` with state `{ scenarioId, tick, playing, speed, appliedStrategyId?, injectedFaults[] }` and actions `play | pause | step | reset | setSpeed | selectScenario | inject | applyStrategy`.
- One `setInterval` at `1000 / speed` ms while playing. Each tick calls `runResilienceStep(state)` from `src/domain/resilience/index.ts` and stores the snapshot. Clear the interval on pause and unmount.
- Auto-pause on the tick where the first room becomes `failed`, and show a toast: "Cascade reached {room}. Compare recovery strategies →". The toast focuses StrategyComparison.
- Keyboard: `Space` play/pause, `→` step, `R` reset. Only when focus is not in an input.
- Passes `riskByRoomId` up through `onRiskChange` so `App.tsx` can give it to `IsometricHouse`.

### 4.2 `ControlBar.tsx`
- Scenario `<select>`: lists `BUILTIN_SCENARIOS` names, plus "Scanned repo (inferred topology)" when a scan exists.
- Buttons are real `<button>`s with `aria-label` and `aria-pressed` for play and speed.
- Clock: `t=042 · 00:07:00`. One tick = 10 simulated seconds. Show this as a `title` tooltip.
- "Inject fault ▾" is a menu of `{room} → {faultType}`. Disabled while a strategy replay is running.
- **Self-check badge:** `✓ Root cause correct · lead time 14 ticks` or `✗ Root cause missed`. The values come from `snapshot.selfCheck`. Hidden for the scanned-repo scenario, because there is no ground truth.

### 4.3 `KpiStrip.tsx`
Four tiles, each `min-height: var(--tile-min-h)`. Every tile has a label, a large number in mono, and one context line.

| Tile | Big value | Context line | Empty state |
|---|---|---|---|
| Next likely failure | room name | `p=0.78 · in ~6 ticks (1 min)` | "No room at risk" |
| Blast radius | `46%` | `7 of 15 services if nothing is done` | `0%` |
| Top root cause | room name + crown | `confidence 0.64 · onset t=031` | "Not enough signal yet" |
| Recommended fix | strategy name | `blast 46% → 8% · recover ~4 ticks` | "Nothing to fix" |

- Numbers tween over 300ms (`requestAnimationFrame`). Skip the tween under `prefers-reduced-motion`.
- Tiles are buttons. Clicking one selects that room in the graph, or scrolls to StrategyComparison.

### 4.4 `CascadeGraph.tsx` (reactflow)
- Nodes = rooms. Edges = `snapshot.graph.edges`. Layout: left-to-right by call depth. Reuse `src/domain/graph/layoutEngine.ts` if its API fits. If not, use a simple layered layout computed **once per scenario** and memoised. Do not re-layout on each tick.
- Node card (custom node): room name, layer chip, `p=0.78`, tier label, and a tiny 20-point sparkline of the anomaly score (inline SVG). Ring and glow follow §2. Root cause: `--root-cause` 2px outline + a ♛ glyph at top right.
- Edges: default 1px `--border-subtle`. Edges on `snapshot.cascade.path` are 2px `--risk-high` and animated (`stroke-dasharray: 6 4`, animate `stroke-dashoffset`). Edge width scales with propagation weight (1–3px). Hover tooltip: `calls · weight 0.72 · retries 3 · no breaker`, plus the provenance text "from scenario" or "inferred from code references".
- `[Graph | House]` toggle: House mounts the existing `IsometricHouse` with the risk overlay (§6). Both views select the same room.
- Clicking a node selects the room (existing `onSelectRoom`), which opens `RoomInspector`.
- When a strategy is being previewed (hover on a row in 4.5), dim to 40% the nodes that strategy saves and outline the ones that still fail. This shows "what this fix changes" before applying it.

### 4.5 `StrategyComparison.tsx`
- Table, one row per strategy, sorted by `score`, best first. Columns: Strategy · Blast after · Rooms saved · Time to recover · Risk · Score.
- Under the table: a horizontal bar chart (d3 or plain divs) of blast radius before (ghost bar) vs after (solid bar) for each strategy.
- The recommended row is pinned at the top with a 3px left border in `--recommend` and a "Recommended" chip. Below the table, one line: `Why: {snapshot.recovery.recommendedReason}`.
- "Score weights" is a disclosure that shows the weights the engine used (from the snapshot). Read-only.
- Each row has an **Apply** button. It dispatches `applyStrategy`. The dashboard then replays from the current tick with that strategy, and the row shows `Applied · watching…` until the replay settles. The result is either `✓ Contained at t=051` or `✗ Still spread to 3 rooms`.
- Row hover (or focus) sets the graph preview from 4.4.

### 4.6 `SignalTimeline.tsx` (d3, one SVG)
- Small multiples: one row per room in the top 5 at-risk rooms, plus the selected room, without duplicates. Each row: name, error-rate line, p95 latency line (secondary, dashed), and the anomaly score as a filled area at 15% opacity in the room's tier colour.
- Shared x-axis in ticks. A vertical "now" line. A forecast cone from now to the horizon (from `snapshot.forecast[room].band`), drawn as an area at 12% opacity.
- Markers: ▲ "fault injected" at the fault tick, ◆ "predicted failure" at the ETA, ✕ "failed" at the actual failure tick. Lead time is the visible gap between ◆ and ✕. That gap is the core demo moment, so label it: `predicted 14 ticks early`.
- Redraw with d3 inside `useEffect`, keyed on the tick. Keep scales stable across ticks; do not rescale y on every tick unless the max grows.

### 4.7 `LogStream.tsx`
- A tail of the last 200 lines in mono, 12px. Fixed row height 18px with simple windowing (render only the visible rows + 10). No library.
- Each line: `t=042  payment  ERROR  upstream timeout payment:8080 after <*>ms`. The level is coloured with text tokens (ERROR uses `--risk-critical` text, WARN uses `--risk-watch`).
- Toggle **Lines | Patterns**. Patterns lists the Drain templates with count, first-seen tick and a `NEW` chip when first seen in the last 10 ticks. This view shows "log mining" to judges.
- Filter chip: "Selected room only".
- Auto-scroll sticks to the bottom unless the user has scrolled up. When scrolled up, show a "↓ 12 new" pill.
- `aria-live="off"`. This must not flood screen readers.

## 5. RoomInspector addition

Add a **Runtime risk** block in `src/components/RoomInspector.tsx`, directly above the "Investigate this room" button. It shows only when the Resilience view is active.

- Tier chip, `p`, ETA, "root-cause rank #2 of 15", and the 3 most recent anomaly evidence lines.
- One line of copy: "Investigate will include this forecast so the AI can explain it."
- `handleInvestigate()` adds `resilienceContext` to the request body when it exists. This is the only logic change in this file. Claude owns this edit (M6).

## 6. Allowed edits outside `src/components/resilience/`

| File | Change |
|---|---|
| `src/App.tsx` | view toggle state, render `ResilienceDashboard` in place of the canvas section when active, keep `riskByRoomId` state, pass it to `IsometricHouse` |
| `src/components/IsometricHouse.tsx` | optional prop `riskByRoomId?: Record<string, RiskTier>`. Draw the ring/glow/hatch as an extra layer per room. With no prop, output is pixel-identical to today. |
| `src/components/RoomInspector.tsx` | §5 block (UI by AntiGravity, request change by Claude) |
| `src/components/PixelPetAvatar.tsx` | optional: pet mood `worried` when the selected room is `high`/`critical`. Only if a mood prop already exists. Otherwise skip. |
| `src/index.css` | §2 tokens + one `/* Resilience */` section at the end of the file |

## 7. Motion and accessibility

- Pulse = `box-shadow`/`filter: drop-shadow` keyframe on the ring only, at the durations in §2. Under `@media (prefers-reduced-motion: reduce)`: no pulse, no dash animation, no number tween. The static ring stays.
- When a room fails: one 180ms 2px horizontal shake of its node. Never repeat it.
- Focus ring on every interactive element: 2px `--border-focus`, offset 2px.
- Contrast: all text ≥ 4.5:1 on `--bg-surface`. Check `--text-muted` on tiles; use `--text-secondary` if it fails.
- Graph nodes are reachable by keyboard (reactflow `nodesFocusable`), and Enter selects.

## 8. States every panel must handle

`no scenario selected` (first load: show "Pick a scenario to start", with the first scenario preselected) · `t=0, nothing anomalous` · `running` · `paused on failure` · `strategy replay` · `scanned repo, no ground truth`. Each panel shows a helpful line in each state, never a blank box.

## 9. Acceptance (Claude checks in the browser before sign-off)

1. Blueprint view unchanged: same rooms, colours, inspector, chat.
2. Pick scenario 1, press ▶. Within the first 40 ticks: KPI "Next likely failure" names the true root-cause room's downstream victim, the ◆ marker appears before ✕, and the self-check is ✓.
3. Auto-pause on the first failure. The toast focuses StrategyComparison. **Apply** on the recommended strategy contains the cascade, and the graph shows it.
4. Graph ↔ House toggle keeps the selection. House shows the risk rings.
5. Clicking a node opens RoomInspector with the Runtime risk block. Investigate still works with AI on, and the dashboard still works with AI off.
6. Window 1024px wide: single column, no horizontal scroll.
7. Reduced motion: nothing pulses.
8. `npm run build` passes. No new entries in `package.json` dependencies.

## 10. Order of work for AntiGravity

1. Tokens + `ResilienceDashboard` shell + `ControlBar` + clock on the fixture.
2. `KpiStrip`, then `CascadeGraph`.
3. `StrategyComparison` (+ graph preview), then `SignalTimeline`, then `LogStream`.
4. `IsometricHouse` overlay + `App.tsx` toggle + RoomInspector block.
5. Switch from the fixture to the real `runResilienceStep` once Claude's M2–M3 land.
