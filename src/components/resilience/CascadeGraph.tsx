import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  ControlButton,
  Handle,
  MarkerType,
  Position,
  applyNodeChanges,
  type Edge,
  type NodeChange,
  type ReactFlowInstance,
  type Node,
  type NodeProps,
} from 'reactflow';
import 'reactflow/dist/style.css';
import type { ResilienceSnapshot, RiskTier, ServiceView } from '../../domain/resilience/types.ts';
import type { ArchitecturalRoom } from '../../types.ts';
import { IsometricHouse } from '../IsometricHouse.tsx';

interface CascadeGraphProps {
  snapshot: ResilienceSnapshot;
  allRooms: ArchitecturalRoom[];
  selectedRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  previewStrategyId?: string | null;
}

const TIER_LABEL: Record<RiskTier, string> = {
  healthy: 'Healthy',
  watch: 'Watch',
  high: 'High risk',
  critical: 'Critical',
  failed: 'Down',
};

const TIER_COLOR: Record<RiskTier, string> = {
  healthy: 'var(--risk-healthy)',
  watch: 'var(--risk-watch)',
  high: 'var(--risk-high)',
  critical: 'var(--risk-critical)',
  failed: 'var(--risk-failed)',
};

interface ServiceNodeData {
  view: ServiceView;
  isRoot: boolean;
  hop: number | null;
  rippling: boolean;
  preview: 'saved' | 'still' | null;
  selected: boolean;
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <svg className="cg-spark" viewBox="0 0 60 16" aria-hidden="true" />;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 60},${15 - v * 14}`).join(' ');
  return (
    <svg className="cg-spark" viewBox="0 0 60 16" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

const ServiceNode: React.FC<NodeProps<ServiceNodeData>> = ({ data }) => {
  const { view, isRoot, hop, rippling, preview, selected } = data;
  const eta = view.observedFailed ? 'down now' : view.etaTicks !== null ? `fails in ~${view.etaTicks} ticks` : null;
  return (
    <div
      className={[
        'cg-node',
        `cg-node--${view.tier}`,
        isRoot && 'cg-node--root',
        rippling && 'cg-node--ripple',
        preview && `cg-node--${preview}`,
        selected && 'cg-node--selected',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ color: TIER_COLOR[view.tier] }}
    >
      <Handle type="target" position={Position.Left} className="cg-handle" />
      <div className="cg-node__top">
        <span className="cg-node__name" title={view.name}>
          {view.name}
        </span>
        {isRoot && (
          <span className="cg-node__crown" title="Top-ranked root cause">
            ♛
          </span>
        )}
        {hop !== null && hop > 0 && <span className="cg-node__hop">hop {hop}</span>}
      </div>
      <div className="cg-node__meta">
        <span className="cg-node__layer">{view.layer}</span>
        <span className="cg-node__tier">{TIER_LABEL[view.tier]}</span>
      </div>
      <div className="cg-node__bottom">
        <span className="cg-node__risk">{Math.round(view.risk * 100)}%</span>
        <Sparkline values={view.sparkline} />
      </div>
      {eta && <div className="cg-node__eta">{eta}</div>}
      {preview === 'saved' && <div className="cg-node__badge cg-node__badge--saved">saved by fix</div>}
      {preview === 'still' && <div className="cg-node__badge cg-node__badge--still">still fails</div>}
      <Handle type="source" position={Position.Right} className="cg-handle" />
    </div>
  );
};

const nodeTypes = { service: ServiceNode };

/** Callers on the left, dependencies to the right. Computed once per scenario. */
function layeredPositions(snapshot: ResilienceSnapshot): Record<string, { x: number; y: number }> {
  const ids = snapshot.graph.nodes.map((n) => n.id);
  const depth: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    for (const e of snapshot.graph.edges) {
      if (depth[e.source] !== undefined && depth[e.target] !== undefined && depth[e.target] < depth[e.source] + 1) {
        depth[e.target] = Math.min(ids.length, depth[e.source] + 1);
      }
    }
  }
  const columns: Record<number, string[]> = {};
  ids.forEach((id) => (columns[depth[id]] ??= []).push(id));
  const tallest = Math.max(...Object.values(columns).map((c) => c.length));
  const pos: Record<string, { x: number; y: number }> = {};
  for (const [d, col] of Object.entries(columns)) {
    const offset = ((tallest - col.length) * 130) / 2;
    col.forEach((id, i) => (pos[id] = { x: Number(d) * 250, y: offset + i * 130 }));
  }
  return pos;
}

export const CascadeGraph: React.FC<CascadeGraphProps> = ({
  snapshot,
  allRooms,
  selectedRoomId,
  onSelectRoom,
  previewStrategyId,
}) => {
  const [viewMode, setViewMode] = useState<'graph' | 'house'>('graph');
  const [rippleHop, setRippleHop] = useState<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Re-fit the map when its box changes size (e.g. the room panel opens beside it, or toggling fullscreen).
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const fit = () => flowRef.current?.fitView({ padding: 0.2, maxZoom: 0.9, duration: 250 });

  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen]);

  useEffect(() => {
    const timer = window.setTimeout(fit, 80);
    return () => window.clearTimeout(timer);
  }, [isFullscreen]);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let timer = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(fit, 150);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, []);
  const { cascade, rootCause, recovery } = snapshot;
  const scenarioId = snapshot.scenario.id;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const positions = useMemo(() => layeredPositions(snapshot), [scenarioId]);

  // Replay the predicted spread hop by hop; also plays once whenever the path grows.
  const pathKey = cascade.path.join('>');
  const replay = () => setRippleHop(0);
  useEffect(() => {
    if (cascade.path.length > 1) setRippleHop(0);
  }, [pathKey, cascade.path.length]);
  useEffect(() => {
    if (rippleHop === null) return;
    if (rippleHop >= cascade.path.length) {
      const done = window.setTimeout(() => setRippleHop(null), 900);
      return () => window.clearTimeout(done);
    }
    const t = window.setTimeout(() => setRippleHop(rippleHop + 1), 450);
    return () => window.clearTimeout(t);
  }, [rippleHop, cascade.path.length]);

  const preview = recovery.outcomes.find((o) => o.strategyId === previewStrategyId);
  const baselineAffected = new Set(recovery.baseline?.affectedServiceIds ?? []);
  const rootId = rootCause.candidates[0]?.serviceId ?? null;
  const pathEdges = new Set(cascade.pathEdgeIds);

  const nodes: Node<ServiceNodeData>[] = snapshot.services.map((view) => {
    const hopIndex = cascade.path.indexOf(view.id);
    const previewState = preview
      ? preview.affectedServiceIds.includes(view.id)
        ? 'still'
        : baselineAffected.has(view.id)
          ? 'saved'
          : null
      : null;
    return {
      id: view.id,
      type: 'service',
      position: positions[view.id] ?? { x: 0, y: 0 },
      data: {
        view,
        isRoot: view.id === rootId,
        hop: hopIndex >= 0 ? hopIndex : null,
        rippling: rippleHop !== null && hopIndex >= 0 && hopIndex <= rippleHop,
        preview: previewState,
        selected: view.id === selectedRoomId,
      },
    };
  });

  const tierOf = (id: string) => snapshot.riskByRoomId[id] ?? 'healthy';
  // React Flow keeps nodes hidden until it has measured them, so it must own the node objects
  // (sizes, dragged positions). Each tick only refreshes `data`; a new scenario starts fresh.
  const [flowNodes, setFlowNodes] = useState<Node<ServiceNodeData>[]>(nodes);
  const flowScenario = useRef(scenarioId);
  useEffect(() => {
    setFlowNodes((prev) => {
      if (flowScenario.current !== scenarioId) {
        flowScenario.current = scenarioId;
        return nodes;
      }
      const byId = new Map(prev.map((n) => [n.id, n]));
      return nodes.map((n) => {
        const old = byId.get(n.id);
        return old ? { ...old, data: n.data } : n;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, rippleHop, previewStrategyId, selectedRoomId]);
  const onNodesChange = (changes: NodeChange[]) => setFlowNodes((ns) => applyNodeChanges(changes, ns));

  const edges: Edge[] = snapshot.graph.edges.map((e) => {
    const onPath = pathEdges.has(e.id);
    const hot = onPath ? TIER_COLOR[tierOf(e.target)] : 'var(--border-subtle)';
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'smoothstep',
      animated: onPath,
      className: onPath ? 'cg-edge cg-edge--path' : 'cg-edge',
      style: {
        stroke: hot,
        strokeWidth: 1 + e.weight * 2,
        strokeDasharray: e.provenance === 'scan-heuristic' || e.kind === 'async' ? '4 4' : undefined,
        opacity: onPath || !cascade.path.length ? 1 : 0.55,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: onPath ? undefined : '#6b5a4f', width: 14, height: 14 },
      label: onPath ? `${Math.round(e.weight * 100)}%` : undefined,
      labelStyle: { fill: 'var(--text-secondary)', fontSize: 10, fontFamily: 'var(--font-mono)' },
      labelBgStyle: { fill: 'var(--bg-surface)' },
      data: e,
    };
  });

  return (
    <section
      className={`resilience-panel cg-panel ${isFullscreen ? 'cg-panel--fullscreen' : ''}`}
      aria-label="How failure spreads"
    >
      <header className="cg-header">
        <div>
          <h3 className="cg-title">How failure spreads</h3>
          <p className="cg-subtitle">
            Arrows point to what each service depends on. When a dependency breaks, the failure ripples back against the
            arrows.
          </p>
        </div>
        <div className="cg-header__actions">
          <span className={`cg-extent ${cascade.affectedCount > 1 ? 'cg-extent--hot' : ''}`}>
            {cascade.affectedCount}/{cascade.totalServices} at risk · {cascade.blastRadiusPct}%
          </span>
          <button type="button" className="cg-btn" onClick={replay} disabled={cascade.path.length < 2}>
            ↻ Replay spread
          </button>
          <div className="cg-toggle" role="tablist" aria-label="Cascade view">
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'house'}
              className={viewMode === 'house' ? 'is-active' : ''}
              onClick={() => setViewMode('house')}
            >
              Architectural House
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'graph'}
              className={viewMode === 'graph' ? 'is-active' : ''}
              onClick={() => setViewMode('graph')}
            >
              Dependency map
            </button>
          </div>
          <button
            type="button"
            className={`cg-btn cg-btn--fullscreen ${isFullscreen ? 'cg-btn--active' : ''}`}
            onClick={() => setIsFullscreen((prev) => !prev)}
            title={isFullscreen ? 'Exit full screen (Esc)' : 'Expand map to full screen'}
            aria-label={isFullscreen ? 'Exit full screen' : 'Expand map to full screen'}
          >
            {isFullscreen ? '✕ Exit full screen' : '⛶ Full screen'}
          </button>
        </div>
      </header>

      <div ref={canvasRef} className={`cg-canvas ${snapshot.applied?.state === 'contained' ? 'cg-canvas--calm' : ''}`}>
        {snapshot.applied && (
          <div className={`cg-applied cg-applied--${snapshot.applied.state}`} role="status">
            {snapshot.applied.state === 'contained'
              ? `✓ ${snapshot.applied.strategyId.replace('_', ' ')} contained the failure at t=${snapshot.applied.containedAtTick}`
              : snapshot.applied.state === 'spread'
                ? `✗ ${snapshot.applied.strategyId.replace('_', ' ')} did not stop the spread`
                : `Applying ${snapshot.applied.strategyId.replace('_', ' ')} to ${snapshot.applied.targetServiceId}…`}
          </div>
        )}
        {viewMode === 'house' ? (
          <div className="cg-house">
            <IsometricHouse
              rooms={allRooms}
              selectedRoomId={selectedRoomId}
              onSelectRoom={(r) => onSelectRoom(r.id)}
              riskByRoomId={snapshot.riskByRoomId}
              cascadePath={snapshot.cascade.path}
              isCalming={snapshot.applied?.state === 'contained'}
              containedLabel={
                snapshot.applied?.state === 'contained'
                  ? `Contained ✓ at t=${snapshot.applied.containedAtTick ?? snapshot.applied.tick}`
                  : null
              }
              isEarlyState={snapshot.tick < 12}
            />
          </div>
        ) : (
          <ReactFlow
            key={scenarioId}
            style={{ width: '100%', height: '100%' }}
            nodes={flowNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onInit={(inst) => {
              flowRef.current = inst;
              window.setTimeout(fit, 50);
            }}
            onNodeClick={(_, n) => onSelectRoom(n.id)}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 0.9 }}
            minZoom={0.3}
            maxZoom={1.4}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#3e2d21" />
            <Controls position="bottom-left" showInteractive={false} showFitView={false}>
              <ControlButton
                onClick={() => setIsFullscreen((prev) => !prev)}
                title={isFullscreen ? 'Exit full screen (Esc)' : 'Expand to full screen'}
                aria-label={isFullscreen ? 'Exit full screen' : 'Expand to full screen'}
              >
                {isFullscreen ? (
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                    <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-14v3h3v2h-5V5h2z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                    <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                  </svg>
                )}
              </ControlButton>
              <ControlButton
                onClick={fit}
                title="Fit view to window"
                aria-label="Fit view to window"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" fill="currentColor" />
                  <path d="M12 2v3m0 14v3M2 12h3m14 0h3" />
                </svg>
              </ControlButton>
            </Controls>
          </ReactFlow>
        )}
        <ul className="cg-legend" aria-label="Risk legend">
          {(Object.keys(TIER_LABEL) as RiskTier[]).map((t) => (
            <li key={t}>
              <span className="cg-legend__dot" style={{ background: TIER_COLOR[t] }} />
              {TIER_LABEL[t]}
            </li>
          ))}
          <li>
            <span className="cg-legend__crown">♛</span> Root cause
          </li>
        </ul>
      </div>
    </section>
  );
};
