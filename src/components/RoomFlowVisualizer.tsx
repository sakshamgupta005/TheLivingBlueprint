import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  type Node,
  type Edge,
  type NodeProps,
  BackgroundVariant,
} from 'reactflow';
import 'reactflow/dist/style.css';
import * as d3 from 'd3';
import type { WorkflowDiagram, WorkflowNode, WorkflowEdge } from '../server/types.ts';

// ---------------------------------------------------------------------------
// 1. Custom React Flow Node Component
// ---------------------------------------------------------------------------

interface RoomFlowNodeData {
  node: WorkflowNode;
  stepIndex: number;
  isActive: boolean;
  isSelected: boolean;
  onSelect: () => void;
}

const RoomFlowNode: React.FC<NodeProps<RoomFlowNodeData>> = ({ data }) => {
  const { node, stepIndex, isActive, isSelected, onSelect } = data;
  const isObserved = node.classification === 'observed';

  const getNodeTypeTheme = (type?: string) => {
    switch (type) {
      case 'decision':
        return {
          icon: '◇',
          label: 'Decision',
          border: '#ab82e6',
          bg: 'rgba(171, 130, 230, 0.12)',
          text: '#c49bf5',
        };
      case 'storage':
        return {
          icon: '🗄',
          label: 'Storage',
          border: '#e5a963',
          bg: 'rgba(229, 169, 99, 0.12)',
          text: '#f2c58a',
        };
      case 'external':
        return {
          icon: '🌐',
          label: 'External',
          border: '#5ba3c6',
          bg: 'rgba(91, 163, 198, 0.12)',
          text: '#7ec3e6',
        };
      default:
        return {
          icon: '⚙',
          label: 'Component',
          border: '#5ea878',
          bg: 'rgba(94, 168, 120, 0.12)',
          text: '#72c78e',
        };
    }
  };

  const theme = getNodeTypeTheme(node.nodeType);

  return (
    <div
      onClick={onSelect}
      className={`rf-room-node ${isActive ? 'rf-active-pulse' : ''} ${
        isSelected ? 'rf-selected-glow' : ''
      }`}
      style={{
        background: isActive
          ? 'linear-gradient(135deg, #2b3a2f 0%, #1c2720 100%)'
          : isSelected
          ? 'linear-gradient(135deg, #35271d 0%, #201712 100%)'
          : 'linear-gradient(135deg, #241a14 0%, #19120e 100%)',
        borderColor: isActive ? '#5ea878' : isSelected ? '#e5a963' : '#4d382b',
      }}
      title={`Stage ${stepIndex + 1}: ${node.label} (${node.classification})`}
    >
      {/* Target input handle on left */}
      <Handle
        type="target"
        position={Position.Left}
        id="target-left"
        className="rf-handle rf-handle-left"
        style={{ background: isActive ? '#5ea878' : '#8c6a5a' }}
      />
      {/* Optional top handle for branching flows */}
      <Handle
        type="target"
        position={Position.Top}
        id="target-top"
        className="rf-handle rf-handle-top"
      />

      <div className="rf-node-header">
        <div className="rf-step-badge" style={{ background: isActive ? '#5ea878' : '#453328' }}>
          <span>{stepIndex + 1}</span>
        </div>
        <div
          className="rf-type-pill"
          style={{ background: theme.bg, color: theme.text, borderColor: theme.border }}
        >
          <span className="rf-type-icon">{theme.icon}</span>
          <span className="rf-type-name">{theme.label}</span>
        </div>
        <div className={`rf-badge-chip ${isObserved ? 'rf-chip-obs' : 'rf-chip-inf'}`}>
          {isObserved ? 'Observed' : 'Inferred'}
        </div>
      </div>

      <div className="rf-node-body">
        <div className="rf-node-title" title={node.label}>
          {node.label}
        </div>
        {node.role && <div className="rf-node-role">{node.role}</div>}
      </div>

      {isActive && (
        <div className="rf-active-indicator">
          <span className="rf-pulse-dot" />
          <span className="rf-pulse-label">Simulating Stage {stepIndex + 1}</span>
        </div>
      )}

      {/* Source output handle on right */}
      <Handle
        type="source"
        position={Position.Right}
        id="source-right"
        className="rf-handle rf-handle-right"
        style={{ background: isActive ? '#5ea878' : '#8c6a5a' }}
      />
      {/* Optional bottom handle for decision false/branch flows */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="source-bottom"
        className="rf-handle rf-handle-bottom"
      />
    </div>
  );
};

const nodeTypes = {
  roomNode: RoomFlowNode,
};

// ---------------------------------------------------------------------------
// 2. D3.js Pipeline Analytics & Timeline Chart
// ---------------------------------------------------------------------------

interface D3PipelineChartProps {
  nodes: WorkflowNode[];
  edges?: WorkflowEdge[];
  currentStepIndex: number;
  onSelectStep: (idx: number) => void;
  isSimulating: boolean;
}

const D3PipelineChart: React.FC<D3PipelineChartProps> = ({
  nodes,
  edges = [],
  currentStepIndex,
  onSelectStep,
  isSimulating,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Synthesize realistic execution latency and payload sizes from node properties
  const stageMetrics = useMemo(() => {
    return nodes.map((node, idx) => {
      let baseLatency = 24;
      if (node.nodeType === 'storage') baseLatency = 68;
      else if (node.nodeType === 'decision') baseLatency = 14;
      else if (node.nodeType === 'external') baseLatency = 95;
      else if (node.nodeType === 'component') baseLatency = 38;

      // Deterministic variation based on label length
      const jitter = (node.label.length % 7) * 4;
      const durationMs = baseLatency + jitter;

      // Correlate connecting edge label
      const inEdge = edges.find((e) => e.to === node.id);

      return {
        id: node.id,
        label: node.label,
        type: node.nodeType || 'component',
        classification: node.classification,
        index: idx,
        durationMs,
        edgeLabel: inEdge?.label || inEdge?.branchLabel || undefined,
        inputs: node.inputs || 'req payload',
        outputs: node.outputs || 'res state',
        filePath: node.filePath,
      };
    });
  }, [nodes, edges]);

  useEffect(() => {
    if (!containerRef.current || nodes.length === 0) return;

    const container = containerRef.current;
    const width = container.clientWidth || 700;
    const barHeight = 44;
    const margin = { top: 32, right: 90, bottom: 30, left: 190 };
    const height = Math.max(240, nodes.length * barHeight + margin.top + margin.bottom);

    d3.select(container).selectAll('*').remove();

    const svg = d3
      .select(container)
      .append('svg')
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('style', 'max-width: 100%; height: auto; display: block;');

    // Defs for gradients & filters
    const defs = svg.append('defs');

    // Glow filter
    const filter = defs.append('filter').attr('id', 'd3-glow').attr('x', '-20%').attr('y', '-20%').attr('width', '140%').attr('height', '140%');
    filter.append('feGaussianBlur').attr('stdDeviation', '3.5').attr('result', 'coloredBlur');
    const feMerge = filter.append('feMerge');
    feMerge.append('feMergeNode').attr('in', 'coloredBlur');
    feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // Gradient for active stage
    const activeGrad = defs.append('linearGradient').attr('id', 'd3-active-grad').attr('x1', '0%').attr('y1', '0%').attr('x2', '100%').attr('y2', '0%');
    activeGrad.append('stop').attr('offset', '0%').attr('stop-color', '#5ea878');
    activeGrad.append('stop').attr('offset', '100%').attr('stop-color', '#72c78e');

    // Gradient for standard stages
    const normalGrad = defs.append('linearGradient').attr('id', 'd3-normal-grad').attr('x1', '0%').attr('y1', '0%').attr('x2', '100%').attr('y2', '0%');
    normalGrad.append('stop').attr('offset', '0%').attr('stop-color', '#3d2c22');
    normalGrad.append('stop').attr('offset', '100%').attr('stop-color', '#5c4333');

    const maxDuration = d3.max(stageMetrics, (d) => d.durationMs) || 100;
    const xScale = d3
      .scaleLinear()
      .domain([0, maxDuration * 1.25])
      .range([margin.left, width - margin.right]);

    const yScale = d3
      .scaleBand<number>()
      .domain(nodes.map((_, i) => i))
      .range([margin.top, height - margin.bottom])
      .padding(0.28);

    // Grid lines
    svg
      .append('g')
      .attr('class', 'd3-grid')
      .attr('transform', `translate(0, ${height - margin.bottom})`)
      .call(
        d3
          .axisBottom(xScale)
          .ticks(5)
          .tickSize(-(height - margin.top - margin.bottom))
          .tickFormat((d) => `${d}ms`)
      )
      .call((g) => g.select('.domain').remove())
      .call((g) => g.selectAll('.tick line').attr('stroke', 'rgba(255, 255, 255, 0.06)'))
      .call((g) => g.selectAll('.tick text').attr('fill', '#9e8a78').attr('font-size', '10px'));

    // Connecting workflow flow curve path in background
    const curvePoints: Array<[number, number]> = stageMetrics.map((d, i) => {
      const y = (yScale(i) || 0) + yScale.bandwidth() / 2;
      return [xScale(d.durationMs / 2), y];
    });

    const lineGenerator = d3.line().curve(d3.curveMonotoneY);
    svg
      .append('path')
      .datum(curvePoints)
      .attr('d', lineGenerator)
      .attr('fill', 'none')
      .attr('stroke', 'rgba(94, 168, 120, 0.22)')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '4 4');

    // Stage Row Groups
    const rows = svg
      .selectAll('.d3-stage-row')
      .data(stageMetrics)
      .enter()
      .append('g')
      .attr('class', 'd3-stage-row')
      .attr('transform', (d) => `translate(0, ${yScale(d.index) || 0})`)
      .style('cursor', 'pointer')
      .on('click', (_, d) => onSelectStep(d.index));

    // Hover background highlight
    rows
      .append('rect')
      .attr('x', 4)
      .attr('y', 0)
      .attr('width', width - 8)
      .attr('height', yScale.bandwidth())
      .attr('rx', 6)
      .attr('fill', (d) =>
        d.index === currentStepIndex
          ? 'rgba(94, 168, 120, 0.12)'
          : 'rgba(255, 255, 255, 0.02)'
      )
      .attr('stroke', (d) => (d.index === currentStepIndex ? '#5ea878' : 'transparent'))
      .attr('stroke-width', 1);

    // Stage Index Pill
    const pillG = rows.append('g').attr('transform', 'translate(14, 0)');
    pillG
      .append('circle')
      .attr('cx', 12)
      .attr('cy', yScale.bandwidth() / 2)
      .attr('r', 11)
      .attr('fill', (d) => (d.index === currentStepIndex ? '#5ea878' : '#3d2c22'))
      .attr('filter', (d) => (d.index === currentStepIndex ? 'url(#d3-glow)' : null));

    pillG
      .append('text')
      .attr('x', 12)
      .attr('y', yScale.bandwidth() / 2 + 3.5)
      .attr('text-anchor', 'middle')
      .attr('font-size', '10px')
      .attr('font-weight', '700')
      .attr('fill', (d) => (d.index === currentStepIndex ? '#17100b' : '#cbbcae'))
      .text((d) => d.index + 1);

    // Stage Label Text
    rows
      .append('text')
      .attr('x', 44)
      .attr('y', yScale.bandwidth() / 2 - 2)
      .attr('font-size', '12px')
      .attr('font-weight', (d) => (d.index === currentStepIndex ? '700' : '500'))
      .attr('fill', (d) => (d.index === currentStepIndex ? '#f0e5de' : '#cbbcae'))
      .text((d) => (d.label.length > 18 ? `${d.label.substring(0, 18)}…` : d.label));

    // Type Badge Text
    rows
      .append('text')
      .attr('x', 44)
      .attr('y', yScale.bandwidth() / 2 + 11)
      .attr('font-size', '9px')
      .attr('font-family', 'monospace')
      .attr('fill', (d) => (d.classification === 'observed' ? '#72c78e' : '#deb46f'))
      .text((d) => `${d.type.toUpperCase()} • ${d.classification.toUpperCase()}`);

    // Latency Bar
    rows
      .append('rect')
      .attr('x', margin.left)
      .attr('y', (yScale.bandwidth() - 16) / 2)
      .attr('width', 0) // animate in
      .attr('height', 16)
      .attr('rx', 4)
      .attr('fill', (d) => (d.index === currentStepIndex ? 'url(#d3-active-grad)' : 'url(#d3-normal-grad)'))
      .attr('filter', (d) => (d.index === currentStepIndex ? 'url(#d3-glow)' : null))
      .transition()
      .duration(450)
      .attr('width', (d) => Math.max(12, xScale(d.durationMs) - margin.left));

    // Duration value label
    rows
      .append('text')
      .attr('x', (d) => xScale(d.durationMs) + 8)
      .attr('y', yScale.bandwidth() / 2 + 4)
      .attr('font-size', '11px')
      .attr('font-family', 'monospace')
      .attr('font-weight', '600')
      .attr('fill', (d) => (d.index === currentStepIndex ? '#72c78e' : '#9e8a78'))
      .text((d) => `~${d.durationMs}ms`);

    // Title Header in SVG
    svg
      .append('text')
      .attr('x', 14)
      .attr('y', 18)
      .attr('font-size', '11px')
      .attr('font-weight', '700')
      .attr('fill', '#e5a963')
      .attr('letter-spacing', '0.06em')
      .text('PIPELINE STAGE EXECUTION & LATENCY WATERFALL (D3.JS)');
  }, [stageMetrics, currentStepIndex, isSimulating, nodes.length, onSelectStep]);

  return (
    <div className="d3-chart-wrapper">
      <div ref={containerRef} className="d3-svg-container" />
      <div className="d3-chart-caption">
        <span>⚡ Interactive D3 timeline: Click any stage to inspect payload contracts and static execution timing.</span>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 3. Main RoomFlowVisualizer Component
// ---------------------------------------------------------------------------

export interface RoomFlowVisualizerProps {
  currentFlow: WorkflowDiagram;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  activeNode: WorkflowNode | undefined;
  simulationStep: number;
  isSimulating: boolean;
  onSelectNode: (node: WorkflowNode, index: number) => void;
  onStartSimulation: () => void;
  onPauseSimulation: () => void;
  onStepForward: () => void;
  onStepBack: () => void;
  onRestartSimulation: () => void;
  onFocusRoom?: (roomId?: string) => void;
  isModal?: boolean;
}

export const RoomFlowVisualizer: React.FC<RoomFlowVisualizerProps> = ({
  currentFlow,
  nodes,
  edges,
  activeNode,
  simulationStep,
  isSimulating,
  onSelectNode,
  onStartSimulation,
  onPauseSimulation,
  onStepForward,
  onStepBack,
  onRestartSimulation,
  onFocusRoom,
  isModal = false,
}) => {
  const [visualizerMode, setVisualizerMode] = useState<'flow' | 'd3' | 'dual' | 'sequence'>('flow');
  const [simulationSpeed, setSimulationSpeed] = useState<number>(1);
  const reactFlowWrapperRef = useRef<HTMLDivElement | null>(null);

  const currentStepIndex = isSimulating
    ? simulationStep
    : nodes.findIndex((n) => n.id === activeNode?.id);

  // Controlled React Flow nodes with interactive mouse drag-and-spring-back
  const [nodesState, setNodesState, onNodesChange] = useNodesState<RoomFlowNodeData>([]);
  const originalPositionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const isDraggingRef = useRef<Record<string, boolean>>({});
  const animationFrameRef = useRef<Record<string, number>>({});

  // Synchronize React Flow nodes with diagram nodes and layout positions
  useEffect(() => {
    const spacingX = isModal ? 260 : 220;
    const startX = 40;
    const startY = 70;

    const newPositions: Record<string, { x: number; y: number }> = {};
    const initialNodes: Node<RoomFlowNodeData>[] = nodes.map((node, idx) => {
      const isDecision = node.nodeType === 'decision';
      const posX = startX + idx * spacingX;
      const posY = startY + (isDecision && idx % 2 === 1 ? 20 : 0);
      newPositions[node.id] = { x: posX, y: posY };

      const isActive = idx === currentStepIndex;
      const isSelected = node.id === activeNode?.id;

      return {
        id: node.id,
        type: 'roomNode',
        position: { x: posX, y: posY },
        data: {
          node,
          stepIndex: idx,
          isActive,
          isSelected,
          onSelect: () => onSelectNode(node, idx),
        },
      };
    });

    originalPositionsRef.current = newPositions;

    setNodesState((prev) => {
      if (prev.length !== initialNodes.length) {
        return initialNodes;
      }
      return initialNodes.map((newNode) => {
        const existing = prev.find((p) => p.id === newNode.id);
        if (!existing) return newNode;
        const isDragging = isDraggingRef.current[newNode.id];
        const isSnapping = Boolean(animationFrameRef.current[newNode.id]);
        return {
          ...newNode,
          position: isDragging || isSnapping ? existing.position : newNode.position,
        };
      });
    });
  }, [nodes, currentStepIndex, activeNode?.id, onSelectNode, isModal, setNodesState]);

  // Mouse interaction: drag start
  const handleNodeDragStart = useCallback((_: React.MouseEvent, node: Node) => {
    isDraggingRef.current[node.id] = true;
    if (animationFrameRef.current[node.id]) {
      cancelAnimationFrame(animationFrameRef.current[node.id]);
      delete animationFrameRef.current[node.id];
    }
  }, []);

  // Mouse interaction: bring nodes back smoothly when released
  const handleNodeDragStop = useCallback(
    (_: React.MouseEvent, node: Node) => {
      isDraggingRef.current[node.id] = false;
      const origin = originalPositionsRef.current[node.id];
      if (!origin) return;

      const startX = node.position.x;
      const startY = node.position.y;
      const targetX = origin.x;
      const targetY = origin.y;

      if (Math.abs(startX - targetX) < 1 && Math.abs(startY - targetY) < 1) {
        return;
      }

      const startTime = performance.now();
      const duration = 380; // Smooth spring snap duration in ms

      const animate = (currentTime: number) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(1, elapsed / duration);
        // Cubic ease-out: starts fast, lands gently
        const ease = 1 - Math.pow(1 - progress, 3);

        const currentX = startX + (targetX - startX) * ease;
        const currentY = startY + (targetY - startY) * ease;

        setNodesState((nds) =>
          nds.map((n) =>
            n.id === node.id ? { ...n, position: { x: currentX, y: currentY } } : n
          )
        );

        if (progress < 1) {
          animationFrameRef.current[node.id] = requestAnimationFrame(animate);
        } else {
          delete animationFrameRef.current[node.id];
          setNodesState((nds) =>
            nds.map((n) =>
              n.id === node.id ? { ...n, position: { x: targetX, y: targetY } } : n
            )
          );
        }
      };

      animationFrameRef.current[node.id] = requestAnimationFrame(animate);
    },
    [setNodesState]
  );

  // Clean up any running spring-back animation frames on unmount
  useEffect(() => {
    return () => {
      Object.values(animationFrameRef.current).forEach((frameId) => {
        cancelAnimationFrame(frameId);
      });
      animationFrameRef.current = {};
    };
  }, []);

  // Compute React Flow edges with dynamic glow for active stage transitions
  const rfEdges: Edge[] = useMemo(() => {
    return edges.map((edge, idx) => {
      const fromIndex = nodes.findIndex((n) => n.id === edge.from);
      const toIndex = nodes.findIndex((n) => n.id === edge.to);

      // Animate edge when simulation is transitioning across it
      const isEdgeActive =
        isSimulating && fromIndex === currentStepIndex - 1 && toIndex === currentStepIndex;

      const isObserved = edge.classification === 'observed';

      return {
        id: `rf-edge-${edge.from}-${edge.to}-${idx}`,
        source: edge.from,
        target: edge.to,
        sourceHandle: 'source-right',
        targetHandle: 'target-left',
        type: 'smoothstep',
        animated: isEdgeActive,
        label: edge.label || edge.branchLabel || undefined,
        style: {
          stroke: isEdgeActive ? '#5ea878' : isObserved ? '#8c6a5a' : '#c49b52',
          strokeWidth: isEdgeActive ? 3 : 2,
          strokeDasharray: !isObserved && !isEdgeActive ? '5 5' : undefined,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isEdgeActive ? '#5ea878' : isObserved ? '#8c6a5a' : '#c49b52',
          width: 16,
          height: 16,
        },
        labelStyle: {
          fill: '#e5a963',
          fontWeight: 600,
          fontSize: 10,
          fontFamily: 'monospace',
        },
        labelBgStyle: {
          fill: '#1c130d',
          fillOpacity: 0.88,
          stroke: '#4d382b',
          strokeWidth: 1,
          rx: 4,
          ry: 4,
        },
      };
    });
  }, [edges, nodes, currentStepIndex, isSimulating]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const idx = nodes.findIndex((n) => n.id === node.id);
      if (idx !== -1) {
        onSelectNode(nodes[idx], idx);
      }
    },
    [nodes, onSelectNode]
  );

  return (
    <div className={`room-flow-visualizer-root ${isModal ? 'expanded-mode-visualizer' : ''}`}>
      {/* Visualizer Top Bar: View Mode Selector, Simulation Controls & Progress */}
      <div className="rf-visualizer-toolbar">
        {/* View Mode Tabs */}
        <div className="rf-mode-tabs" role="group" aria-label="Visualizer Display Styles">
          <button
            type="button"
            className={`rf-mode-btn ${visualizerMode === 'flow' ? 'active-mode' : ''}`}
            onClick={() => setVisualizerMode('flow')}
            title="Interactive React Flow graph with pan, zoom, and pulsating nodes"
          >
            ⚡ React Flow
          </button>
          <button
            type="button"
            className={`rf-mode-btn ${visualizerMode === 'd3' ? 'active-mode' : ''}`}
            onClick={() => setVisualizerMode('d3')}
            title="D3.js Pipeline Waterfall & Stage Latency Chart"
          >
            📊 D3 Analytics
          </button>
          <button
            type="button"
            className={`rf-mode-btn ${visualizerMode === 'dual' ? 'active-mode' : ''}`}
            onClick={() => setVisualizerMode('dual')}
            title="Side-by-side Command Center (React Flow Canvas + D3 Timeline)"
          >
            ◫ Dual View
          </button>
          <button
            type="button"
            className={`rf-mode-btn ${visualizerMode === 'sequence' ? 'active-mode' : ''}`}
            onClick={() => setVisualizerMode('sequence')}
            title="Classic linear step cards"
          >
            📋 Sequence
          </button>
        </div>

        {/* Current Flow Title Indicator */}
        {currentFlow?.title && (
          <div className="rf-flow-title-badge" title={currentFlow.explanation || currentFlow.title}>
            <span className="rf-flow-dot">◈</span>
            <span className="rf-flow-name">{currentFlow.title.split(': ')[1] || currentFlow.title}</span>
          </div>
        )}

        {/* Simulation Controls Group */}
        <div className="rf-sim-controls">
          {isSimulating ? (
            <button
              type="button"
              className="btn-sim-action btn-sim-pause"
              onClick={onPauseSimulation}
              title="Pause flow simulation"
            >
              ⏸ Pause
            </button>
          ) : (
            <button
              type="button"
              className="btn-sim-action btn-sim-play"
              onClick={onStartSimulation}
              title="Start auto-stepping through stages"
            >
              ▶ Simulate Flow
            </button>
          )}

          <button
            type="button"
            className="btn-sim-step"
            onClick={onStepBack}
            disabled={currentStepIndex <= 0}
            title="Step back to previous stage"
          >
            ◀ Back
          </button>

          <button
            type="button"
            className="btn-sim-step"
            onClick={onStepForward}
            disabled={currentStepIndex >= nodes.length - 1}
            title="Advance one stage"
          >
            Step ▶
          </button>

          <button
            type="button"
            className="btn-sim-restart"
            onClick={onRestartSimulation}
            title="Reset simulation to beginning"
          >
            ↺ Reset
          </button>

          {/* Speed Selector */}
          <div className="rf-speed-select">
            <button
              type="button"
              className={`rf-speed-btn ${simulationSpeed === 1 ? 'active' : ''}`}
              onClick={() => setSimulationSpeed(1)}
              title="Normal speed (1.8s)"
            >
              1x
            </button>
            <button
              type="button"
              className={`rf-speed-btn ${simulationSpeed === 1.5 ? 'active' : ''}`}
              onClick={() => setSimulationSpeed(1.5)}
              title="Fast speed (1.2s)"
            >
              1.5x
            </button>
          </div>
        </div>

        {/* Live Stage Counter & Progress Bar */}
        <div className="rf-progress-container">
          <div className="rf-progress-label">
            {isSimulating ? (
              <span className="rf-live-badge">⚡ Simulating Stage {currentStepIndex + 1} of {nodes.length}</span>
            ) : (
              <span>Stage <strong>{Math.max(1, currentStepIndex + 1)}</strong> of <strong>{nodes.length}</strong></span>
            )}
          </div>
          <div className="rf-progress-track">
            <div
              className="rf-progress-bar"
              style={{
                width: `${((currentStepIndex + 1) / Math.max(1, nodes.length)) * 100}%`,
              }}
            />
          </div>
        </div>
      </div>

      {/* Main Graph / Chart Surface */}
      <div className={`rf-surface-viewport ${isModal ? 'rf-expanded-surface' : ''}`}>
        {/* Mode 1: React Flow Interactive Canvas */}
        {visualizerMode === 'flow' && (
          <div ref={reactFlowWrapperRef} className="rf-canvas-wrapper" style={{ height: isModal ? '440px' : '280px' }}>
            <ReactFlow
              nodes={nodesState}
              edges={rfEdges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onNodeDragStart={handleNodeDragStart}
              onNodeDragStop={handleNodeDragStop}
              onNodeClick={handleNodeClick}
              nodesDraggable={true}
              elementsSelectable={true}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.4}
              maxZoom={1.8}
              attributionPosition="bottom-right"
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#3e2d21" />
              <Controls position="top-right" showInteractive={false} />
              <MiniMap
                nodeColor={(n) => {
                  if (n.data.isActive) return '#5ea878';
                  if (n.data.node.classification === 'observed') return '#72c78e';
                  return '#deb46f';
                }}
                maskColor="rgba(23, 16, 11, 0.75)"
                style={{
                  background: '#1c130d',
                  border: '1px solid #4d382b',
                  borderRadius: '6px',
                  height: 80,
                  width: 120,
                }}
              />
            </ReactFlow>
          </div>
        )}

        {/* Mode 2: D3 Pipeline Analytics Chart */}
        {visualizerMode === 'd3' && (
          <div className="rf-d3-wrapper" style={{ minHeight: isModal ? '440px' : '280px' }}>
            <D3PipelineChart
              nodes={nodes}
              edges={edges}
              currentStepIndex={currentStepIndex}
              onSelectStep={(idx) => onSelectNode(nodes[idx], idx)}
              isSimulating={isSimulating}
            />
          </div>
        )}

        {/* Mode 3: Dual View (React Flow + D3 Analytics) */}
        {visualizerMode === 'dual' && (
          <div className="rf-dual-grid" style={{ height: isModal ? '460px' : '340px' }}>
            <div className="rf-dual-left">
              <div className="rf-pane-header">⚡ Interactive Canvas (React Flow)</div>
              <div style={{ height: 'calc(100% - 28px)' }}>
                <ReactFlow
                  nodes={nodesState}
                  edges={rfEdges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onNodeDragStart={handleNodeDragStart}
                  onNodeDragStop={handleNodeDragStop}
                  onNodeClick={handleNodeClick}
                  nodesDraggable={true}
                  elementsSelectable={true}
                  fitView
                  fitViewOptions={{ padding: 0.15 }}
                  minZoom={0.3}
                  maxZoom={1.5}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background variant={BackgroundVariant.Dots} gap={14} size={1} color="#3e2d21" />
                  <Controls position="top-right" showInteractive={false} />
                </ReactFlow>
              </div>
            </div>

            <div className="rf-dual-right">
              <div className="rf-pane-header">📊 Latency Waterfall & Pipeline Metrics (D3.js)</div>
              <div style={{ height: 'calc(100% - 28px)', overflowY: 'auto' }}>
                <D3PipelineChart
                  nodes={nodes}
                  edges={edges}
                  currentStepIndex={currentStepIndex}
                  onSelectStep={(idx) => onSelectNode(nodes[idx], idx)}
                  isSimulating={isSimulating}
                />
              </div>
            </div>
          </div>
        )}

        {/* Mode 4: Classic Sequence Row */}
        {visualizerMode === 'sequence' && (
          <div className="internals-graph-viewport">
            <div className="internals-sequence-row" role="list">
              {nodes.map((node, idx) => {
                const isSelected = node.id === activeNode?.id;
                const isCurrentSimStep = idx === currentStepIndex;
                const isObserved = node.classification === 'observed';

                const nextNode = nodes[idx + 1];
                const connectingEdge = nextNode
                  ? edges.find((e) => e.from === node.id && e.to === nextNode.id)
                  : undefined;

                return (
                  <React.Fragment key={node.id}>
                    <div
                      role="listitem"
                      className={`internals-node-card ${isSelected ? 'selected-card' : ''} ${
                        isCurrentSimStep ? 'sim-active-card' : ''
                      } ${isObserved ? 'observed-card' : 'inferred-card'} node-type-${node.nodeType || 'component'}`}
                      onClick={() => onSelectNode(node, idx)}
                      title={`Click to inspect details for ${node.label} (${node.classification})`}
                    >
                      <div className="node-card-top">
                        <span className="node-number-pill">{idx + 1}</span>
                        <span className={`node-type-label type-${node.nodeType || 'comp'}`}>
                          {node.nodeType || 'component'}
                        </span>
                        <span className={`node-badge-tag ${isObserved ? 'tag-obs' : 'tag-inf'}`}>
                          {isObserved ? 'Observed' : 'Inferred'}
                        </span>
                      </div>
                      <div className="node-card-title">{node.label}</div>
                      {node.role && <div className="node-card-role">{node.role}</div>}
                    </div>

                    {idx < nodes.length - 1 && (
                      <div
                        className={`internals-edge-connector ${
                          idx === currentStepIndex || idx === currentStepIndex - 1 ? 'edge-highlighted' : ''
                        }`}
                      >
                        <svg className="connector-svg" width="36" height="18" viewBox="0 0 36 18" fill="none">
                          <line
                            x1="2"
                            y1="9"
                            x2="28"
                            y2="9"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeDasharray={connectingEdge?.classification === 'inferred' ? '3 3' : undefined}
                          />
                          <polygon points="26,5 34,9 26,13" fill="currentColor" />
                        </svg>
                        {connectingEdge?.label && (
                          <span className="connector-label-tag" title={connectingEdge.label}>
                            {connectingEdge.label}
                          </span>
                        )}
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Selected Node Details Card (Updates Dynamically at Every Step!) */}
      {activeNode && (
        <div className="node-details-card rf-details-card" role="region" aria-label="Component Details">
          <div className="node-details-header">
            <div className="details-header-title">
              <span className="details-eyebrow">STAGE {currentStepIndex + 1} OF {nodes.length} DETAILS</span>
              <h5 className="details-name">{activeNode.label}</h5>
            </div>

            <div className="details-badges">
              <span className={`pill-badge ${activeNode.classification === 'observed' ? 'pill-obs' : 'pill-inf'}`}>
                {activeNode.classification === 'observed' ? '✓ Observed Code' : '○ Inferred Architecture'}
              </span>
              {activeNode.roomId && (
                <button
                  type="button"
                  className="btn-crosslink-room"
                  onClick={() => onFocusRoom?.(activeNode.roomId)}
                  title={`Focus mapped room "${activeNode.roomId}" in isometric house`}
                >
                  Focus Room in House ↗
                </button>
              )}
            </div>
          </div>

          <div className="node-details-grid">
            <div className="details-grid-item">
              <span className="item-label">Responsibility:</span>
              <span className="item-value">{activeNode.description}</span>
            </div>

            <div className="details-grid-item">
              <span className="item-label">What Enters:</span>
              <span className="item-value">{activeNode.inputs || 'Input data / request payload'}</span>
            </div>

            <div className="details-grid-item">
              <span className="item-label">What Leaves:</span>
              <span className="item-value">{activeNode.outputs || 'Processed state / response payload'}</span>
            </div>

            {activeNode.importance && (
              <div className="details-grid-item">
                <span className="item-label">Why It Matters:</span>
                <span className="item-value">{activeNode.importance}</span>
              </div>
            )}

            {activeNode.filePath && (
              <div className="details-grid-item full-width">
                <span className="item-label">Supporting File:</span>
                <span className="item-value code-ref">
                  <code>{activeNode.filePath}</code>
                  {activeNode.codeSnippet?.line && (
                    <span className="line-hint"> (Line {activeNode.codeSnippet.line})</span>
                  )}
                </span>
              </div>
            )}
          </div>

          {/* Validated Code Excerpt */}
          {activeNode.codeSnippet && (
            <div className="node-code-snippet-box">
              <div className="snippet-header">
                <span>Validated Code Excerpt:</span>
                <code>{activeNode.filePath}</code>
              </div>
              <pre className="snippet-pre">
                <code>{activeNode.codeSnippet.code}</code>
              </pre>
              {activeNode.codeSnippet.explanation && (
                <div className="snippet-explanation">{activeNode.codeSnippet.explanation}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
