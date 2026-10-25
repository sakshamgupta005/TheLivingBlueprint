import React from 'react';
import { scaleLinear, line, area, curveMonotoneX } from 'd3';
import type { ResilienceSnapshot, ServiceView, SignalPoint } from '../../domain/resilience/types.ts';
import { relatedServiceIds } from '../../domain/resilience/index.ts';
import './SignalTimeline.css';

interface SignalTimelineProps {
  snapshot: ResilienceSnapshot;
  selectedRoomId?: string | null;
  onSelectRoom?: (roomId: string) => void;
  /** Kept for caller compatibility; rows are derived with relatedServiceIds. */
  focusedRelatedIds?: string[] | null;
}

const PLOT_HEIGHT = 220;
const TOP = 16;
const AXIS = 20;
const GUTTER = 128;
const RIGHT = 12;
const MAX_ROWS = 6;

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function storySentence(snapshot: ResilienceSnapshot): string {
  const { firstWarningTick, actualFirstFailureTick, leadTimeTicks, leadTimeSeconds } = snapshot.selfCheck;
  if (leadTimeTicks !== null && firstWarningTick !== null && actualFirstFailureTick !== null) {
    const secs = leadTimeSeconds ?? leadTimeTicks * snapshot.scenario.tickSeconds;
    if (leadTimeTicks <= 0) {
      return `First failure at t=${actualFirstFailureTick}, warning came at t=${firstWarningTick} (no lead time)`;
    }
    return `Warned at t=${firstWarningTick}, first failure at t=${actualFirstFailureTick} — ${leadTimeTicks} ticks (${formatDuration(secs)}) early`;
  }
  if (firstWarningTick !== null) return `Warned at t=${firstWarningTick} · watching… no failure yet`;
  return 'Watching… no failure yet';
}

const TIER_COLOR: Record<ServiceView['tier'], string> = {
  healthy: 'var(--risk-healthy)',
  watch: 'var(--risk-watch)',
  high: 'var(--risk-high)',
  critical: 'var(--risk-critical)',
  failed: 'var(--risk-failed)',
};

function useWidth(ref: React.RefObject<HTMLDivElement>): number {
  const [width, setWidth] = React.useState(640);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || 640);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w > 0) setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

export const SignalTimeline: React.FC<SignalTimelineProps> = ({ snapshot, selectedRoomId, onSelectRoom }) => {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const width = Math.max(320, useWidth(wrapRef));
  const { totalTicks } = snapshot.scenario;
  const tick = snapshot.tick;
  const rootId = snapshot.rootCause.candidates[0]?.serviceId ?? null;

  // Row selection depends only on graph shape, focus, and risk ordering.
  const riskKey = snapshot.services.map((s) => `${s.id}:${s.risk.toFixed(2)}`).join('|');
  const rows: ServiceView[] = React.useMemo(() => {
    const byId = new Map(snapshot.services.map((s) => [s.id, s]));
    let ids: string[];
    if (selectedRoomId && byId.has(selectedRoomId)) {
      const related = relatedServiceIds(snapshot, selectedRoomId).filter((id) => id !== selectedRoomId);
      ids = [selectedRoomId, ...related].slice(0, MAX_ROWS);
    } else {
      ids = [...snapshot.services].sort((a, b) => b.risk - a.risk).slice(0, 5).map((s) => s.id);
      if (rootId && byId.has(rootId) && !ids.includes(rootId)) ids[ids.length - 1] = rootId;
    }
    return ids.map((id) => byId.get(id)!).filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRoomId, rootId, riskKey, snapshot.graph.edges]);

  const rowH = PLOT_HEIGHT / Math.max(rows.length, 1);
  const height = TOP + PLOT_HEIGHT + AXIS;

  const x = React.useMemo(
    () => scaleLinear().domain([0, Math.max(1, totalTicks)]).range([GUTTER, width - RIGHT]),
    [totalTicks, width],
  );
  const xTicks = React.useMemo(() => x.ticks(Math.max(3, Math.floor((width - GUTTER) / 90))), [x, width]);

  const generators = React.useMemo(() => {
    const inner = rowH - 10;
    const y = scaleLinear().domain([0, 1]).range([inner, 0]).clamp(true);
    return {
      inner,
      err: line<SignalPoint>().x((p) => x(p.tick)).y((p) => y(p.errorRate)).curve(curveMonotoneX),
      anom: area<SignalPoint>().x((p) => x(p.tick)).y0(inner).y1((p) => y(p.anomalyScore)).curve(curveMonotoneX),
    };
  }, [x, rowH]);

  const nowX = x(Math.min(tick, totalTicks));
  const sentence = storySentence(snapshot);
  const hasLead = snapshot.selfCheck.leadTimeTicks !== null && snapshot.selfCheck.leadTimeTicks > 0;

  return (
    <div className="panel-card signal-timeline">
      <div className="panel-header">
        <div className="panel-header-left">
          <span className="panel-title">Signal timeline</span>
          <span className="panel-subtitle">
            {selectedRoomId ? 'Focused service and its direct neighbours' : 'Top 5 services by risk, root cause included'}
          </span>
        </div>
        <div className="st-legend" aria-hidden="true">
          <span><i className="st-key st-key-line" />error rate</span>
          <span><i className="st-key st-key-area" />anomaly</span>
          <span><i className="st-key st-key-warn" />warned</span>
          <span><i className="st-key st-key-fail" />failed</span>
          <span><i className="st-key st-key-eta" />forecast ETA</span>
        </div>
      </div>

      <p className={`st-story${hasLead ? ' is-lead' : ''}`} role="status" aria-live="polite">
        {sentence}
      </p>

      <div className="st-plot" ref={wrapRef}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Signal timeline. ${sentence}`}>
          {xTicks.map((t) => (
            <g key={`x-${t}`}>
              <line className="st-grid" x1={x(t)} x2={x(t)} y1={TOP} y2={TOP + PLOT_HEIGHT} />
              <text className="st-axis" x={x(t)} y={TOP + PLOT_HEIGHT + 14} textAnchor="middle">
                t={t}
              </text>
            </g>
          ))}

          {rows.map((svc, i) => {
            const y0 = TOP + i * rowH;
            const points = snapshot.signals[svc.id] ?? [];
            const color = TIER_COLOR[svc.tier];
            const warnTick = svc.onsetTick;
            const failTick = snapshot.anomalies[svc.id]?.firstObservedFailureTick ?? null;
            const fc = snapshot.forecast.byService[svc.id];
            const isSel = svc.id === selectedRoomId;
            const isRoot = svc.id === rootId;
            const mid = y0 + 5 + generators.inner / 2;

            let band: React.ReactNode = null;
            if (fc && fc.etaTicks !== null && failTick === null) {
              const lo = Math.min(totalTicks, tick + (fc.band?.lowTicks ?? fc.etaTicks));
              const hi = Math.min(totalTicks, tick + (fc.band?.highTicks ?? fc.etaTicks));
              const eta = Math.min(totalTicks, tick + fc.etaTicks);
              band = (
                <g className="st-eta">
                  <rect x={x(lo)} y={y0 + 4} width={Math.max(2, x(hi) - x(lo))} height={rowH - 8} rx={3} />
                  <line x1={x(eta)} x2={x(eta)} y1={y0 + 4} y2={y0 + rowH - 4} />
                  <title>{`Forecast: fails in ~${fc.etaTicks} ticks (t=${tick + fc.etaTicks})`}</title>
                </g>
              );
            }

            return (
              <g key={svc.id} className={`st-row${isSel ? ' is-selected' : ''}`}>
                <rect className="st-row-bg" x={0} y={y0} width={width} height={rowH} />
                <line className="st-row-sep" x1={GUTTER} x2={width - RIGHT} y1={y0 + rowH} y2={y0 + rowH} />

                <g
                  className="st-label"
                  role="button"
                  tabIndex={0}
                  aria-label={`Focus ${svc.name}`}
                  onClick={() => onSelectRoom?.(svc.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectRoom?.(svc.id);
                    }
                  }}
                >
                  <rect x={4} y={y0 + 2} width={GUTTER - 10} height={rowH - 4} rx={4} className="st-label-hit" />
                  <text x={10} y={mid - 2} className="st-name">
                    {svc.name.length > 16 ? `${svc.name.slice(0, 15)}…` : svc.name}
                  </text>
                  <text x={10} y={mid + 11} className="st-tier" style={{ fill: color }}>
                    {svc.tier}
                    {isRoot ? ' · root cause' : ''}
                  </text>
                </g>

                {band}

                <g transform={`translate(0, ${y0 + 5})`}>
                  {points.length > 1 && (
                    <>
                      <path className="st-anom" d={generators.anom(points) ?? undefined} style={{ fill: color }} />
                      <path className="st-err" d={generators.err(points) ?? undefined} style={{ stroke: color }} />
                    </>
                  )}
                </g>

                {warnTick !== null && failTick !== null && failTick > warnTick && (
                  <line className="st-lead" x1={x(warnTick)} x2={x(failTick)} y1={y0 + rowH - 5} y2={y0 + rowH - 5} />
                )}
                {warnTick !== null && (
                  <g className="st-mark st-mark-warn" transform={`translate(${x(warnTick)}, ${y0})`}>
                    <line y1={3} y2={rowH - 3} />
                    <path d="M-4,3 L4,3 L0,9 Z" />
                    <title>{`Warned at t=${warnTick}`}</title>
                  </g>
                )}
                {failTick !== null && (
                  <g className="st-mark st-mark-fail" transform={`translate(${x(failTick)}, ${y0})`}>
                    <line y1={3} y2={rowH - 3} />
                    <rect x={-3.5} y={3} width={7} height={7} rx={1} />
                    <title>{`Failed at t=${failTick}`}</title>
                  </g>
                )}
              </g>
            );
          })}

          <g className="st-now" transform={`translate(${nowX}, 0)`}>
            <line y1={TOP - 2} y2={TOP + PLOT_HEIGHT} />
            <text y={TOP - 5} textAnchor={nowX > width - 50 ? 'end' : nowX < GUTTER + 40 ? 'start' : 'middle'}>now t={tick}</text>
          </g>
        </svg>
      </div>
    </div>
  );
};
