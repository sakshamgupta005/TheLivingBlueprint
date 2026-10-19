import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import type { CanvasGraph, CanvasNode, CanvasEdge, ViewportTransform, GraphViewMode } from '../domain/graph/types.ts';
import type { WorkflowDiagram } from '../server/types.ts';
import type { ArchitecturalRoom } from '../types.ts';
import type { CodeIndex } from '../domain/codeIndex/types.ts';
import type { ControlFlowGraph } from '../domain/cfg/types.ts';
import { buildControlFlowGraph } from '../domain/cfg/cfgBuilder.ts';
import type { DataFlowGraph } from '../domain/dataFlow/types.ts';
import { analyzeDataFlow } from '../domain/dataFlow/dataFlowAnalyzer.ts';
import {
  buildCanvasFromWorkflow,
  buildCanvasFromModules,
  buildCanvasFromCodeIndex,
  buildCanvasFromControlFlowGraph,
  buildCanvasFromDataFlow,
} from '../domain/graph/layoutEngine.ts';
import { CallSequenceView } from './CallSequenceView.tsx';
import { StaticSimulationWorkbench } from './StaticSimulationWorkbench.tsx';
import { buildArchitectureLensGraph } from '../domain/architectureViews/index.ts';
import { ExpandedVisualizationShell } from './ExpandedVisualizationShell.tsx';

export interface InteractiveGraphCanvasProps {
  diagram?: WorkflowDiagram;
  rooms?: ArchitecturalRoom[];
  codeIndex?: CodeIndex;
  cfg?: ControlFlowGraph;
  dfg?: DataFlowGraph;
  fileContents?: Record<string, string>;
  knownTests?: string[];
  initialViewMode?: GraphViewMode;
  initialRouteId?: string;
  onSelectRoom?: (roomId: string) => void;
  className?: string;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  isParentExpanded?: boolean;
}

export const InteractiveGraphCanvas: React.FC<InteractiveGraphCanvasProps> = ({
  diagram,
  rooms = [],
  codeIndex,
  cfg,
  dfg,
  fileContents = {},
  knownTests = [],
  initialViewMode = 'workflow',
  initialRouteId,
  onSelectRoom,
  className = '',
  isExpanded: externalExpanded,
  onToggleExpand,
  isParentExpanded = false,
}) => {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const isExpanded = externalExpanded ?? internalExpanded;
  const expandButtonRef = useRef<HTMLButtonElement | null>(null);
  const modalContainerRef = useRef<HTMLDivElement | null>(null);

  // 1. View Mode & Collapsed Groups State
  const [viewMode, setViewMode] = useState<GraphViewMode>(
    dfg ? 'data_flow' : cfg ? 'control_flow' : initialViewMode
  );
  const [activeRouteId, setActiveRouteId] = useState<string | undefined>(initialRouteId);
  const [activeCfg, setActiveCfg] = useState<ControlFlowGraph | null>(cfg || null);
  const [activeDfg, setActiveDfg] = useState<DataFlowGraph | null>(dfg || null);
  const [focusedPathOnly, setFocusedPathOnly] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'observed' | 'route' | 'storage' | 'decision'>('all');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [showSourceExcerpt, setShowSourceExcerpt] = useState(false);

  useEffect(() => {
    if (cfg) {
      setActiveCfg(cfg);
      setViewMode('control_flow');
    }
  }, [cfg]);

  useEffect(() => {
    if (dfg) {
      setActiveDfg(dfg);
      setViewMode('data_flow');
    }
  }, [dfg]);

  // 2. Viewport Transform (Pan & Zoom)
  const [transform, setTransform] = useState<ViewportTransform>({ x: 40, y: 40, zoom: 0.9 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; transX: number; transY: number }>({
    mouseX: 0,
    mouseY: 0,
    transX: 0,
    transY: 0,
  });

  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 3. Build Active Graph Model
  const graph: CanvasGraph = useMemo(() => {
    if (viewMode === 'data_flow' && activeDfg) {
      return buildCanvasFromDataFlow(activeDfg, {
        focusedNodeId: focusedPathOnly && selectedNodeId ? selectedNodeId : undefined,
      });
    }
    if (viewMode === 'control_flow' && activeCfg) {
      return buildCanvasFromControlFlowGraph(activeCfg);
    }
    if (viewMode === 'modules' && rooms.length > 0) {
      return buildCanvasFromModules(rooms);
    }
    if (viewMode === 'functions' && codeIndex) {
      return buildCanvasFromCodeIndex(codeIndex, { collapsedGroupIds: collapsedGroups });
    }
    if (
      viewMode === 'state_transitions' ||
      viewMode === 'data_schema' ||
      viewMode === 'config_wiring' ||
      viewMode === 'module_hierarchy' ||
      viewMode === 'error_paths'
    ) {
      const lensGraph = buildArchitectureLensGraph(viewMode, {
        files: fileContents,
        codeIndex,
      });
      if (lensGraph) return lensGraph;
    }
    if (diagram && diagram.nodes && diagram.nodes.length > 0) {
      return buildCanvasFromWorkflow(diagram);
    }
    if (activeDfg) {
      return buildCanvasFromDataFlow(activeDfg);
    }
    if (activeCfg) {
      return buildCanvasFromControlFlowGraph(activeCfg);
    }
    if (rooms.length > 0) {
      return buildCanvasFromModules(rooms);
    }
    return {
      id: 'empty-graph',
      title: 'Architecture Graph',
      viewMode,
      nodes: [],
      edges: [],
      bounds: { minX: 0, minY: 0, maxX: 600, maxY: 400, width: 600, height: 400 },
      explanation: 'No graph data or inspected code available.',
    };
  }, [viewMode, activeDfg, activeCfg, focusedPathOnly, selectedNodeId, diagram, rooms, codeIndex, collapsedGroups]);

  // 4. Fit-To-View Functionality
  const fitToView = useCallback(() => {
    const activeContainer = (isExpanded ? modalContainerRef.current : containerRef.current) || containerRef.current;
    if (!activeContainer || graph.nodes.length === 0) return;
    const { clientWidth, clientHeight } = activeContainer;
    if (clientWidth === 0 || clientHeight === 0) return;

    const graphWidth = graph.bounds.width;
    const graphHeight = graph.bounds.height;

    const scaleX = (clientWidth - 80) / graphWidth;
    const scaleY = (clientHeight - 80) / graphHeight;
    const nextZoom = Math.min(1.2, Math.max(0.35, Math.min(scaleX, scaleY)));

    const centerX = (clientWidth - graphWidth * nextZoom) / 2 - graph.bounds.minX * nextZoom;
    const centerY = (clientHeight - graphHeight * nextZoom) / 2 - graph.bounds.minY * nextZoom;

    setTransform({
      x: Math.round(centerX),
      y: Math.round(centerY),
      zoom: Number(nextZoom.toFixed(2)),
    });
  }, [graph, isExpanded]);

  // Auto-fit on graph view switch, first load, or expand toggle
  useEffect(() => {
    const timer = setTimeout(fitToView, 60);
    return () => clearTimeout(timer);
  }, [fitToView, viewMode, isExpanded]);

  // 5. Pan & Zoom Event Handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // primary button only
    setIsDragging(true);
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      transX: transform.x,
      transY: transform.y,
    };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartRef.current.mouseX;
    const dy = e.clientY - dragStartRef.current.mouseY;
    setTransform((prev) => ({
      ...prev,
      x: dragStartRef.current.transX + dx,
      y: dragStartRef.current.transY + dy,
    }));
  };

  const handleMouseUp = () => setIsDragging(false);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
    setTransform((prev) => {
      const nextZoom = Math.min(2.5, Math.max(0.25, prev.zoom * zoomFactor));
      return {
        ...prev,
        zoom: Number(nextZoom.toFixed(2)),
      };
    });
  };

  const handleZoomIn = () => {
    setTransform((prev) => ({
      ...prev,
      zoom: Number(Math.min(2.5, prev.zoom * 1.2).toFixed(2)),
    }));
  };

  const handleZoomOut = () => {
    setTransform((prev) => ({
      ...prev,
      zoom: Number(Math.max(0.25, prev.zoom / 1.2).toFixed(2)),
    }));
  };

  const handleResetZoom = () => {
    setTransform({ x: 40, y: 40, zoom: 1.0 });
  };

  // Keyboard navigation (+, -, 0, Arrow keys)
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === '+' || e.key === '=') {
      handleZoomIn();
    } else if (e.key === '-' || e.key === '_') {
      handleZoomOut();
    } else if (e.key === '0') {
      fitToView();
    } else if (e.key === 'ArrowRight') {
      setTransform((prev) => ({ ...prev, x: prev.x - 40 }));
    } else if (e.key === 'ArrowLeft') {
      setTransform((prev) => ({ ...prev, x: prev.x + 40 }));
    } else if (e.key === 'ArrowUp') {
      setTransform((prev) => ({ ...prev, y: prev.y + 40 }));
    } else if (e.key === 'ArrowDown') {
      setTransform((prev) => ({ ...prev, y: prev.y - 40 }));
    }
  };

  // 6. Selection & Group Toggling
  const handleNodeClick = (e: React.MouseEvent, node: CanvasNode) => {
    e.stopPropagation();
    if (node.isGroupCollapsed && node.groupId) {
      // Toggle collapsed group
      setCollapsedGroups((prev) => {
        const next = new Set(prev);
        next.delete(node.groupId!);
        return next;
      });
      return;
    }
    setSelectedEdgeId(null);
    setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
    setShowSourceExcerpt(false);
  };

  const selectedNode = graph.nodes.find((n) => n.id === selectedNodeId);
  const selectedEdge = graph.edges.find((e) => e.id === selectedEdgeId);

  // Filter & Search Evaluation
  const visibleNodes = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return graph.nodes.filter((node) => {
      if (activeFilter === 'observed' && node.classification !== 'observed') return false;
      if (activeFilter === 'route' && node.kind !== 'route') return false;
      if (activeFilter === 'storage' && node.kind !== 'storage') return false;
      if (activeFilter === 'decision' && node.kind !== 'decision') return false;
      if (q) {
        return (
          node.label.toLowerCase().includes(q) ||
          node.subLabel?.toLowerCase().includes(q) ||
          node.description?.toLowerCase().includes(q) ||
          node.filePath?.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [graph.nodes, searchQuery, activeFilter]);

  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

  const visibleEdges = useMemo(() => {
    return graph.edges.filter((e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target));
  }, [graph.edges, visibleNodeIds]);

  // Find node coordinates helper
  const nodeMap = useMemo(() => {
    const map = new Map<string, CanvasNode>();
    for (const node of graph.nodes) {
      map.set(node.id, node);
    }
    return map;
  }, [graph.nodes]);

  // Compute smooth curved edge paths (with smart routing for back-edges and loops)
  const getEdgePath = (edge: CanvasEdge): string => {
    const src = nodeMap.get(edge.source);
    const tgt = nodeMap.get(edge.target);
    if (!src || !tgt) return '';

    if (edge.isBackEdge || tgt.x <= src.x) {
      // Loop-back edge: curve arched above nodes to loop backward
      const loopOffsetY = Math.min(src.y, tgt.y) - 50;
      return `M ${src.x + src.width / 2} ${src.y} C ${src.x + src.width / 2} ${loopOffsetY}, ${tgt.x + tgt.width / 2} ${loopOffsetY}, ${tgt.x + tgt.width / 2} ${tgt.y}`;
    }

    const startX = src.x + src.width;
    const startY = src.y + src.height / 2;
    const endX = tgt.x;
    const endY = tgt.y + tgt.height / 2;

    const dx = Math.max(40, (endX - startX) * 0.45);
    return `M ${startX} ${startY} C ${startX + dx} ${startY}, ${endX - dx} ${endY}, ${endX} ${endY}`;
  };

  // Node Kind Styling Helper
  const getNodeColor = (kind: string, isObserved: boolean) => {
    if (!isObserved) return { bg: '#231812', border: '#7a5a40', text: '#e6ded3', icon: '◇' };
    switch (kind) {
      case 'source':
        return { bg: '#102626', border: '#2dd4bf', text: '#f0fdfa', icon: '📥' };
      case 'validation':
        return { bg: '#2b2310', border: '#e6b843', text: '#fffbf0', icon: '🛡️' };
      case 'sink':
        return { bg: '#281a2e', border: '#c084fc', text: '#faf5ff', icon: '📤' };
      case 'entry':
        return { bg: '#1c2419', border: '#48a868', text: '#ebfaee', icon: '▶' };
      case 'exit':
        return { bg: '#291717', border: '#e05252', text: '#faebeb', icon: '⏹' };
      case 'condition':
        return { bg: '#2b2310', border: '#e6b843', text: '#fffbf0', icon: '◇' };
      case 'loop':
        return { bg: '#221a2b', border: '#9b5de5', text: '#fbf5ff', icon: '🔄' };
      case 'return':
        return { bg: '#17222b', border: '#3a86ff', text: '#eff6ff', icon: '↵' };
      case 'throw':
        return { bg: '#2f1515', border: '#ff006e', text: '#fff0f5', icon: '⚠' };
      case 'route':
        return { bg: '#2c1e13', border: '#e5a963', text: '#fff9f0', icon: '🌐' };
      case 'storage':
        return { bg: '#1c2419', border: '#48a868', text: '#ebfaee', icon: '🗄' };
      case 'decision':
        return { bg: '#2b2310', border: '#e6b843', text: '#fffbf0', icon: '⚡' };
      case 'module':
        return { bg: '#271b14', border: '#c4824d', text: '#fbf4ea', icon: '🏛' };
      case 'group':
        return { bg: '#1e140f', border: '#9e6d42', text: '#eed8c4', icon: '📁' };
      default:
        return { bg: '#241a13', border: '#a87347', text: '#f5eedc', icon: '⚙' };
    }
  };

  // Handler to generate CFG for any inspected function or symbol
  const handleGenerateCfgForNode = (node: CanvasNode) => {
    if (!node.filePath) return;
    const content = fileContents[node.filePath] || (node.codeSnippet ? node.codeSnippet.code : undefined);
    if (!content) return;

    const funcName = node.functionName || (node.subLabel?.includes('FUNCTION') || node.kind === 'function' ? node.label : undefined);
    const generated = buildControlFlowGraph({
      sourcePath: node.filePath,
      content,
      functionName: funcName,
      targetLine: node.lineRange?.startLine,
    });

    if (generated) {
      setActiveCfg(generated);
      setViewMode('control_flow');
      setSelectedNodeId(null);
    }
  };

  // Handler to generate Data-Flow Graph for any inspected function or file (T27)
  const handleGenerateDfgForNode = (node: CanvasNode) => {
    if (!node.filePath) return;
    const content = fileContents[node.filePath] || (node.codeSnippet ? node.codeSnippet.code : undefined);
    if (!content) return;

    const funcName = node.functionName || (node.subLabel?.includes('FUNCTION') || node.kind === 'function' ? node.label : undefined);
    const generated = analyzeDataFlow({
      sourcePath: node.filePath,
      content,
      functionName: funcName,
      targetLine: node.lineRange?.startLine,
      codeIndex,
      rooms,
      knownTests,
    });

    if (generated && generated.nodes.length > 0) {
      setActiveDfg(generated);
      setViewMode('data_flow');
      setSelectedNodeId(null);
      setFocusedPathOnly(false);
    }
  };

  const renderCanvasBody = (isModal = false) => (
    <div
      ref={isModal ? modalContainerRef : containerRef}
      className={`interactive-graph-canvas-container ${className} ${isModal ? 'canvas-modal-mode' : ''}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      role="graphics-document"
      aria-label="Interactive Architecture Graph Canvas"
      style={isModal ? { width: '100%', height: '100%', flex: 1, border: 'none' } : undefined}
    >
      {/* 1. Canvas Top Toolbar */}
      <div className="canvas-top-toolbar" role="toolbar" aria-label="Graph canvas controls">
        {/* Mode Switcher */}
        <div className="canvas-view-mode-group">
          {diagram && diagram.nodes && (
            <button
              type="button"
              className={`btn-mode-pill ${viewMode === 'workflow' ? 'active' : ''}`}
              onClick={() => { setViewMode('workflow'); setSelectedNodeId(null); }}
              title="View sequential workflow steps"
            >
              🔄 Workflow Flow
            </button>
          )}
          {rooms.length > 0 && (
            <button
              type="button"
              className={`btn-mode-pill ${viewMode === 'modules' ? 'active' : ''}`}
              onClick={() => { setViewMode('modules'); setSelectedNodeId(null); }}
              title="View architectural rooms and layer dependencies"
            >
              🏛 Modules ({rooms.length})
            </button>
          )}
          {codeIndex && (
            <button
              type="button"
              className={`btn-mode-pill ${viewMode === 'functions' ? 'active' : ''}`}
              onClick={() => { setViewMode('functions'); setSelectedNodeId(null); }}
              title="View symbols, functions, routes, and call edges from inspected code"
            >
              ⚡ Code Structure ({codeIndex.stats.symbolsIndexed})
            </button>
          )}
          {activeCfg && (
            <button
              type="button"
              className={`btn-mode-pill ${viewMode === 'control_flow' ? 'active' : ''}`}
              onClick={() => { setViewMode('control_flow'); setSelectedNodeId(null); }}
              title={`View deterministic Control Flow Graph for ${activeCfg.functionName}()`}
            >
              🔀 Flow: {activeCfg.functionName}()
            </button>
          )}
          {activeCfg && (
            <button
              type="button"
              className={`btn-mode-pill ${viewMode === 'simulation' ? 'active' : ''}`}
              onClick={() => { setViewMode('simulation'); setSelectedNodeId(null); }}
              title={`Run deterministic static simulation workbench for ${activeCfg.functionName}()`}
            >
              🔬 Simulate: {activeCfg.functionName}()
            </button>
          )}
          {activeDfg && (
            <button
              type="button"
              className={`btn-mode-pill ${viewMode === 'data_flow' ? 'active' : ''}`}
              onClick={() => { setViewMode('data_flow'); setSelectedNodeId(null); setFocusedPathOnly(false); }}
              title={`View static Data Flow & Value Lineage for ${activeDfg.title}`}
            >
              💧 Data Flow: {activeDfg.functionName || 'Lineage'}
            </button>
          )}
          {codeIndex && (
            <button
              type="button"
              className={`btn-mode-pill ${viewMode === 'sequence' ? 'active' : ''}`}
              onClick={() => { setViewMode('sequence'); setSelectedNodeId(null); setSelectedEdgeId(null); }}
              title="View Request Journey and Call Sequence Diagram (T28)"
            >
              📶 Journey {codeIndex.routes?.length ? `(${codeIndex.routes.length})` : ''}
            </button>
          )}
          {(fileContents && Object.keys(fileContents).length > 0) && (
            <>
              <button
                type="button"
                className={`btn-mode-pill ${viewMode === 'state_transitions' ? 'active' : ''}`}
                onClick={() => { setViewMode('state_transitions'); setSelectedNodeId(null); setSelectedEdgeId(null); }}
                title="View State Transitions, Enums, and Lifecycles (T31)"
              >
                🔄 States
              </button>
              <button
                type="button"
                className={`btn-mode-pill ${viewMode === 'data_schema' ? 'active' : ''}`}
                onClick={() => { setViewMode('data_schema'); setSelectedNodeId(null); setSelectedEdgeId(null); }}
                title="View SQL Schemas, ORM Models, and Validation Schemas (T31)"
              >
                🗄 Schemas
              </button>
              <button
                type="button"
                className={`btn-mode-pill ${viewMode === 'config_wiring' ? 'active' : ''}`}
                onClick={() => { setViewMode('config_wiring'); setSelectedNodeId(null); setSelectedEdgeId(null); }}
                title="View Environment Variables and Configuration Wiring with Secret Redaction (T31)"
              >
                🔌 Config
              </button>
              <button
                type="button"
                className={`btn-mode-pill ${viewMode === 'module_hierarchy' ? 'active' : ''}`}
                onClick={() => { setViewMode('module_hierarchy'); setSelectedNodeId(null); setSelectedEdgeId(null); }}
                title="View Module Directory Hierarchy, Clusters, and Circular Dependencies (T31)"
              >
                📁 Hierarchy
              </button>
              <button
                type="button"
                className={`btn-mode-pill ${viewMode === 'error_paths' ? 'active' : ''}`}
                onClick={() => { setViewMode('error_paths'); setSelectedNodeId(null); setSelectedEdgeId(null); }}
                title="View Error Handlers, Throw Sites, and Failure Branches (T31)"
              >
                ⚠️ Errors
              </button>
            </>
          )}
        </div>

        {/* CFG Metric Stats Badge when in control_flow mode */}
        {viewMode === 'control_flow' && activeCfg && (
          <div className="canvas-cfg-stats-badge" title="Deterministic CFG Complexity & Metric Counts">
            <span>⚡ Complexity: <strong>{activeCfg.stats.cyclomaticComplexity}</strong></span>
            <span>Nodes: <strong>{activeCfg.stats.totalNodes}</strong></span>
            <span>Edges: <strong>{activeCfg.stats.totalEdges}</strong></span>
            <span>Branches: <strong>{activeCfg.stats.branchCount}</strong></span>
            <span>Loops: <strong>{activeCfg.stats.loopCount}</strong></span>
          </div>
        )}

        {/* Data-Flow Metric Stats Badge when in data_flow mode */}
        {viewMode === 'data_flow' && activeDfg && (
          <div className="canvas-cfg-stats-badge" title="Static Data-Flow Metrics & Verified Counts">
            <span>💧 Sources: <strong>{activeDfg.stats.totalSources}</strong></span>
            <span>Transforms: <strong>{activeDfg.stats.totalTransforms}</strong></span>
            <span>Validations: <strong>{activeDfg.stats.totalValidations}</strong></span>
            <span>Sinks: <strong>{activeDfg.stats.totalSinks}</strong></span>
            {activeDfg.stats.unvalidatedPathsCount > 0 && (
              <span className="unvalidated-warning-badge" style={{ color: '#ef4444', fontWeight: 'bold' }}>
                ⚠️ Unvalidated Paths: {activeDfg.stats.unvalidatedPathsCount}
              </span>
            )}
          </div>
        )}

        {/* Filter Pills */}
        <div className="canvas-filter-pills">
          <button
            type="button"
            className={`filter-pill ${activeFilter === 'all' ? 'active' : ''}`}
            onClick={() => setActiveFilter('all')}
          >
            All ({graph.nodes.length})
          </button>
          <button
            type="button"
            className={`filter-pill ${activeFilter === 'observed' ? 'active' : ''}`}
            onClick={() => setActiveFilter('observed')}
            title="Filter nodes with verified source code evidence"
          >
            Verified Only
          </button>
          <button
            type="button"
            className={`filter-pill ${activeFilter === 'route' ? 'active' : ''}`}
            onClick={() => setActiveFilter('route')}
          >
            Routes
          </button>
          <button
            type="button"
            className={`filter-pill ${activeFilter === 'storage' ? 'active' : ''}`}
            onClick={() => setActiveFilter('storage')}
          >
            Storage
          </button>
        </div>

        {/* Search Input */}
        <div className="canvas-search-box">
          <input
            type="text"
            placeholder="Search nodes & symbols..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="canvas-search-input"
            aria-label="Search graph nodes"
          />
          {searchQuery && (
            <button type="button" className="btn-clear-search" onClick={() => setSearchQuery('')}>
              ✕
            </button>
          )}
        </div>

        {/* Zoom Controls */}
        <div className="canvas-zoom-controls">
          <button type="button" className="btn-zoom" onClick={handleZoomIn} title="Zoom In (+)" aria-label="Zoom in">
            +
          </button>
          <button type="button" className="btn-zoom" onClick={handleZoomOut} title="Zoom Out (-)" aria-label="Zoom out">
            -
          </button>
          <button type="button" className="btn-zoom btn-zoom-fit" onClick={fitToView} title="Fit to View (0)" aria-label="Fit to view">
            ⛶ Fit
          </button>
          <button type="button" className="btn-zoom btn-zoom-reset" onClick={handleResetZoom} title="Reset Zoom (100%)" aria-label="Reset zoom">
            ↺ {Math.round(transform.zoom * 100)}%
          </button>
          {!isParentExpanded && (
            <button
              ref={expandButtonRef}
              type="button"
              className={`btn-zoom btn-zoom-expand ${isExpanded ? 'active' : ''}`}
              onClick={() => {
                if (onToggleExpand) {
                  onToggleExpand();
                } else {
                  setInternalExpanded((prev) => !prev);
                }
              }}
              title={isExpanded ? 'Collapse graph view (Esc)' : 'Expand graph to full-screen view'}
              aria-label={isExpanded ? 'Collapse graph view' : 'Expand graph to full-screen view'}
            >
              {isExpanded ? '⤢ Collapse' : '⛶ Expand'}
            </button>
          )}
        </div>
      </div>

      {/* 2. Interactive SVG Canvas Viewport, Simulation Workbench, or Sequence View */}
      {viewMode === 'simulation' && activeCfg ? (
        <div style={{ flex: 1, overflow: 'auto', padding: '16px', background: '#17100b' }}>
          <StaticSimulationWorkbench
            cfg={activeCfg}
            lineage={activeDfg}
            knownTests={knownTests.map((t) => ({ testName: t.split('/').pop() || t, filePath: t }))}
            onFocusRoom={onSelectRoom}
          />
        </div>
      ) : viewMode === 'sequence' ? (
        <CallSequenceView
          codeIndex={codeIndex}
          fileContents={fileContents}
          rooms={rooms}
          initialRouteId={activeRouteId}
          onNavigateToCfg={(path, func, line) => {
            const content = fileContents[path];
            if (content) {
              const generated = buildControlFlowGraph({
                sourcePath: path,
                content,
                functionName: func,
                targetLine: line,
              });
              if (generated) {
                setActiveCfg(generated);
                setViewMode('control_flow');
              }
            }
          }}
          onNavigateToDfg={(path, func, line) => {
            const content = fileContents[path];
            if (content) {
              const generated = analyzeDataFlow({
                sourcePath: path,
                content,
                functionName: func,
                targetLine: line,
                codeIndex,
                rooms,
                knownTests,
              });
              if (generated) {
                setActiveDfg(generated);
                setViewMode('data_flow');
              }
            }
          }}
          onSelectRoom={onSelectRoom}
        />
      ) : (
        <div
          className="canvas-viewport"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
        >
        <svg
          ref={svgRef}
          className="canvas-svg"
          width="100%"
          height="100%"
          onClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
        >
          <defs>
            {/* Background Grid Pattern */}
            <pattern id="coffee-dot-grid" width="24" height="24" patternUnits="userSpaceOnUse">
              <circle cx="2" cy="2" r="1.2" fill="#38281d" opacity="0.65" />
            </pattern>
            {/* Arrow Marker */}
            <marker
              id="canvas-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" fill="#d4a373" />
            </marker>
            <marker
              id="canvas-arrow-active"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" fill="#f59e0b" />
            </marker>
            <marker
              id="canvas-arrow-selected"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="8"
              markerHeight="8"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" fill="#38bdf8" />
            </marker>
            <marker
              id="canvas-arrow-true"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" fill="#10b981" />
            </marker>
            <marker
              id="canvas-arrow-false"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" fill="#ef4444" />
            </marker>
            <marker
              id="canvas-arrow-back"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" fill="#a855f7" />
            </marker>
            <marker
              id="canvas-arrow-return"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" fill="#3b82f6" />
            </marker>
          </defs>

          {/* Background Grid */}
          <rect width="100%" height="100%" fill="url(#coffee-dot-grid)" />

          {/* Canvas Transform G Layer */}
          <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.zoom})`}>
            {/* Edges */}
            {visibleEdges.map((edge) => {
              const isConnectedToSelected =
                selectedNodeId === edge.source || selectedNodeId === edge.target;
              const isSelectedEdge = selectedEdgeId === edge.id;
              const pathD = getEdgePath(edge);
              if (!pathD) return null;

              const getMarkerEnd = () => {
                if (isSelectedEdge) return 'url(#canvas-arrow-selected)';
                if (isConnectedToSelected) return 'url(#canvas-arrow-active)';
                if (edge.isTainted) return 'url(#canvas-arrow-false)';
                if (edge.edgeKind === 'condition_true' || edge.edgeKind === 'loop_enter') return 'url(#canvas-arrow-true)';
                if (edge.edgeKind === 'condition_false' || edge.edgeKind === 'exception') return 'url(#canvas-arrow-false)';
                if (edge.edgeKind === 'loop_back' || edge.isBackEdge) return 'url(#canvas-arrow-back)';
                if (edge.edgeKind === 'early_return') return 'url(#canvas-arrow-return)';
                return 'url(#canvas-arrow)';
              };

              const getEdgeStroke = () => {
                if (isSelectedEdge) return '#38bdf8';
                if (isConnectedToSelected) return '#f59e0b';
                if (edge.isTainted) return '#ef4444';
                if (edge.edgeKind === 'condition_true' || edge.edgeKind === 'loop_enter') return '#10b981';
                if (edge.edgeKind === 'condition_false' || edge.edgeKind === 'exception') return '#ef4444';
                if (edge.edgeKind === 'loop_back' || edge.isBackEdge) return '#a855f7';
                if (edge.edgeKind === 'early_return') return '#3b82f6';
                return edge.style === 'dashed' ? '#785b46' : '#a87e5b';
              };

              return (
                <g key={edge.id} className={`canvas-edge-group ${isSelectedEdge ? 'edge-selected' : isConnectedToSelected ? 'edge-highlighted' : ''}`}>
                  {/* Invisible wide hit-box for easy edge selection */}
                  <path
                    d={pathD}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={16}
                    style={{ cursor: 'pointer' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedEdgeId(edge.id);
                      setSelectedNodeId(null);
                    }}
                  />
                  {/* Visible edge line */}
                  <path
                    d={pathD}
                    fill="none"
                    stroke={getEdgeStroke()}
                    strokeWidth={isSelectedEdge ? 3.5 : isConnectedToSelected ? 3 : 1.8}
                    strokeDasharray={edge.style === 'dashed' ? '5 4' : undefined}
                    markerEnd={getMarkerEnd()}
                    style={{ cursor: 'pointer' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedEdgeId(edge.id);
                      setSelectedNodeId(null);
                    }}
                  />
                  {(edge.branchLabel || edge.label) && (
                    <text
                      className="canvas-edge-label"
                      fill={isSelectedEdge ? '#38bdf8' : '#d4a373'}
                      stroke="#17100b"
                      strokeWidth="3.5"
                      paintOrder="stroke"
                      strokeLinejoin="round"
                      fontSize="10"
                      textAnchor="middle"
                    >
                      <textPath
                        href={`#edge-path-${edge.id}`}
                        startOffset="50%"
                      >
                        {edge.branchLabel || edge.label}
                      </textPath>
                    </text>
                  )}
                </g>
              );
            })}

            {/* Nodes */}
            {visibleNodes.map((node) => {
              const isSelected = node.id === selectedNodeId;
              const isObserved = node.classification === 'observed';
              const styling = getNodeColor(node.kind, isObserved);

              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x}, ${node.y})`}
                  className={`canvas-node-g ${isSelected ? 'node-selected' : ''}`}
                  onClick={(e) => handleNodeClick(e, node)}
                >
                  {/* Node Box */}
                  <rect
                    width={node.width}
                    height={node.height}
                    rx="8"
                    ry="8"
                    fill={styling.bg}
                    stroke={isSelected ? '#f59e0b' : styling.border}
                    strokeWidth={isSelected ? 2.8 : 1.4}
                    strokeDasharray={!isObserved ? '4 3' : undefined}
                    filter={isSelected ? 'drop-shadow(0 0 10px rgba(245, 158, 11, 0.45))' : undefined}
                  />

                  {/* Header Kind Badge */}
                  <g transform="translate(10, 16)">
                    <text fill={styling.border} fontSize="13" fontWeight="bold">
                      {styling.icon}
                    </text>
                    <text x="18" fill="#a88d75" fontSize="10" fontWeight="600" letterSpacing="0.5">
                      {node.kind.toUpperCase()}
                    </text>
                    <text
                      x={node.width - 20}
                      fill={isObserved ? '#10b981' : '#a88d75'}
                      fontSize="9"
                      textAnchor="end"
                      fontWeight="600"
                    >
                      {isObserved ? 'VERIFIED' : 'INFERRED'}
                    </text>
                  </g>

                  {/* Node Title */}
                  <text
                    x="12"
                    y="42"
                    fill={styling.text}
                    fontSize="13"
                    fontWeight="bold"
                    className="canvas-node-title"
                  >
                    {node.label.length > 24 ? node.label.slice(0, 23) + '…' : node.label}
                  </text>

                  {/* Subtitle / Path */}
                  <text
                    x="12"
                    y="60"
                    fill="#b89d88"
                    fontSize="10"
                    className="canvas-node-subtitle"
                  >
                    {node.subLabel
                      ? node.subLabel.length > 30 ? node.subLabel.slice(0, 29) + '…' : node.subLabel
                      : node.filePath
                      ? node.filePath.split('/').pop()
                      : ''}
                  </text>

                  {/* Group Collapse Badge */}
                  {node.isGroupCollapsed && (
                    <text
                      x={node.width / 2}
                      y={node.height - 8}
                      fill="#e5a963"
                      fontSize="10"
                      textAnchor="middle"
                      fontWeight="bold"
                    >
                      {node.subLabel || 'Click to expand'}
                    </text>
                  )}

                  {/* Issue Warning Badge (T27) */}
                  {node.hasIssues && (
                    <g transform={`translate(${node.width - 24}, 8)`}>
                      <circle cx="8" cy="8" r="8" fill="#ef4444" />
                      <text x="8" y="12" fill="#ffffff" fontSize="10" fontWeight="bold" textAnchor="middle">!</text>
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* 3. Minimap Preview in Bottom Right */}
        {graph.nodes.length > 2 && (
          <div className="canvas-minimap-card" title="Minimap (Click to pan)">
            <svg
              width="140"
              height="90"
              viewBox={`${graph.bounds.minX} ${graph.bounds.minY} ${graph.bounds.width} ${graph.bounds.height}`}
            >
              {graph.nodes.map((n) => (
                <rect
                  key={n.id}
                  x={n.x}
                  y={n.y}
                  width={n.width}
                  height={n.height}
                  fill={n.classification === 'observed' ? '#e5a963' : '#6b4f3b'}
                  opacity={0.7}
                  rx="4"
                />
              ))}
              {/* Viewport Boundary Indicator */}
              <rect
                x={-transform.x / transform.zoom}
                y={-transform.y / transform.zoom}
                width={(containerRef.current?.clientWidth || 400) / transform.zoom}
                height={(containerRef.current?.clientHeight || 300) / transform.zoom}
                fill="#f59e0b"
                fillOpacity="0.15"
                stroke="#f59e0b"
                strokeWidth="2"
              />
            </svg>
          </div>
        )}
      </div>
      )}

      {/* 4. Inspection Drawer for Selected Node */}
      {selectedNode && (
        <div className="canvas-node-inspector-drawer" role="complementary" aria-label="Node details">
          <div className="inspector-drawer-header">
            <div className="drawer-title-group">
              <span className="drawer-kind-badge">{selectedNode.kind.toUpperCase()}</span>
              <h4 className="drawer-node-title">{selectedNode.label}</h4>
              <span className={`drawer-evidence-tag ${selectedNode.classification === 'observed' ? 'tag-observed' : 'tag-inferred'}`}>
                {selectedNode.classification === 'observed' ? '✓ Observed in source' : 'ℹ Inferred'}
              </span>
            </div>
            <button
              type="button"
              className="btn-close-drawer"
              onClick={() => setSelectedNodeId(null)}
              aria-label="Close inspector drawer"
            >
              ✕
            </button>
          </div>

          <div className="inspector-drawer-body">
            {/* T27: Issue advisory banner */}
            {selectedNode.hasIssues && (
              <div className="drawer-issue-banner error" style={{ margin: '8px 0', padding: '10px', background: '#3b1818', border: '1px solid #ef4444', borderRadius: '6px' }}>
                <span className="issue-icon" style={{ fontSize: '16px', marginRight: '6px' }}>⚠️</span>
                <div>
                  <strong style={{ color: '#fca5a5' }}>Data-Flow Advisory:</strong>
                  <p style={{ color: '#fecaca', margin: '4px 0 0', fontSize: '12px' }}>
                    {selectedNode.issuesSummary || 'Unvalidated input reaches sink or out-of-order normalization detected.'}
                  </p>
                </div>
              </div>
            )}

            {selectedNode.description && (
              <p className="drawer-description">{selectedNode.description}</p>
            )}

            <div className="drawer-meta-grid">
              {selectedNode.inputs && (
                <div className="drawer-meta-item">
                  <span className="meta-label">Inputs / Arguments:</span>
                  <span className="meta-val">{selectedNode.inputs}</span>
                </div>
              )}
              {selectedNode.outputs && (
                <div className="drawer-meta-item">
                  <span className="meta-label">Outputs / Returns:</span>
                  <span className="meta-val">{selectedNode.outputs}</span>
                </div>
              )}
              {selectedNode.filePath && (
                <div className="drawer-meta-item">
                  <span className="meta-label">Source File:</span>
                  <span className="meta-val code-path">
                    <code>{selectedNode.filePath}</code>
                    {selectedNode.lineRange && (
                      <span className="line-range-hint">
                        :L{selectedNode.lineRange.startLine}-{selectedNode.lineRange.endLine}
                      </span>
                    )}
                  </span>
                </div>
              )}
              {/* T27: Relevant Tests */}
              {selectedNode.relatedTests && selectedNode.relatedTests.length > 0 && (
                <div className="drawer-meta-item" style={{ gridColumn: 'span 2' }}>
                  <span className="meta-label">Relevant Tests ({selectedNode.relatedTests.length}):</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' }}>
                    {selectedNode.relatedTests.map((t, idx) => (
                      <span key={idx} style={{ background: '#241a13', border: '1px solid #785b46', padding: '2px 6px', borderRadius: '4px', fontSize: '11px', color: '#e5a963' }}>
                        🧪 {t.split('/').pop()}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Source Excerpt Preview */}
            {selectedNode.codeSnippet && (
              <div className="drawer-source-section">
                <button
                  type="button"
                  className="btn-toggle-excerpt"
                  onClick={() => setShowSourceExcerpt(!showSourceExcerpt)}
                >
                  {showSourceExcerpt ? '▼ Hide Code Excerpt' : '▶ View Source Code Excerpt'}
                </button>
                {showSourceExcerpt && (
                  <pre className="drawer-code-block">
                    <code>{selectedNode.codeSnippet.code}</code>
                  </pre>
                )}
              </div>
            )}
          </div>

          <div className="inspector-drawer-footer">
            {viewMode === 'data_flow' && (
              <button
                type="button"
                className={`btn-focus-path-drawer ${focusedPathOnly ? 'active' : ''}`}
                onClick={() => setFocusedPathOnly(!focusedPathOnly)}
                title="Toggle focus mode to only show ancestors and descendants of this node"
                style={{ background: focusedPathOnly ? '#f59e0b' : '#38281d', color: focusedPathOnly ? '#1a1008' : '#e5a963', border: '1px solid #f59e0b', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '12px' }}
              >
                {focusedPathOnly ? '🌐 Full Graph' : '🎯 Focus Path'}
              </button>
            )}
            {selectedNode.filePath && (
              <button
                type="button"
                className="btn-view-dfg-drawer"
                onClick={() => handleGenerateDfgForNode(selectedNode)}
                title="Generate static Data-Flow and Value-Lineage Graph"
                style={{ background: '#1c2929', color: '#2dd4bf', border: '1px solid #2dd4bf', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '12px' }}
              >
                💧 Data Flow
              </button>
            )}
            {selectedNode.filePath && (
              <button
                type="button"
                className="btn-view-cfg-drawer"
                onClick={() => handleGenerateCfgForNode(selectedNode)}
                title="Generate deterministic Control-Flow Graph (CFG) from AST"
              >
                ⚡ View CFG
              </button>
            )}
            {activeCfg && (
              <button
                type="button"
                className="btn-simulate-cfg-drawer"
                onClick={() => setViewMode('simulation')}
                title="Run deterministic static simulation workbench for this CFG"
                style={{ background: '#2e1d14', color: '#f59e0b', border: '1px solid #f59e0b', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '12px' }}
              >
                🔬 Simulate Path
              </button>
            )}
            {selectedNode.filePath && (
              <button
                type="button"
                className="btn-view-journey-drawer"
                onClick={() => {
                  if (selectedNode.kind === 'route' || selectedNode.label.startsWith('/')) {
                    const match = codeIndex?.routes.find((r) => r.routePath === selectedNode.label || selectedNode.label.includes(r.routePath));
                    if (match) setActiveRouteId(match.id);
                  }
                  setViewMode('sequence');
                  setSelectedNodeId(null);
                }}
                title="View Request Journey and Call Sequence for this route or symbol"
                style={{ background: '#2d1f14', color: '#e5a963', border: '1px solid #785b46', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '12px' }}
              >
                📶 Journey
              </button>
            )}
            {selectedNode.roomId && onSelectRoom && (
              <button
                type="button"
                className="btn-focus-house"
                onClick={() => onSelectRoom(selectedNode.roomId!)}
              >
                Focus Room ↗
              </button>
            )}
          </div>
        </div>
      )}

      {/* 4b. Inspection Drawer for Selected Edge (Requirement 3: Evidence & Locations) */}
      {selectedEdge && !selectedNode && (
        <div className="canvas-node-inspector-drawer edge-inspector" role="complementary" aria-label="Edge details">
          <div className="inspector-drawer-header">
            <div className="drawer-title-group">
              <span className="drawer-kind-badge">{selectedEdge.edgeKind?.toUpperCase() || 'DATA FLOW'}</span>
              <h4 className="drawer-node-title">
                {selectedEdge.label || `${nodeMap.get(selectedEdge.source)?.label || selectedEdge.source} → ${nodeMap.get(selectedEdge.target)?.label || selectedEdge.target}`}
              </h4>
              <span className={`drawer-evidence-tag ${selectedEdge.confidence === 'directly_observed' ? 'tag-observed' : selectedEdge.confidence === 'inferred' ? 'tag-inferred' : 'tag-unresolved'}`}>
                {selectedEdge.confidence === 'directly_observed' ? '✓ Directly Observed' : selectedEdge.confidence === 'inferred' ? 'ℹ Inferred' : '⚠ Unresolved'}
              </span>
            </div>
            <button
              type="button"
              className="btn-close-drawer"
              onClick={() => setSelectedEdgeId(null)}
              aria-label="Close edge inspector drawer"
            >
              ✕
            </button>
          </div>

          <div className="inspector-drawer-body">
            {selectedEdge.isTainted && (
              <div className="drawer-issue-banner error" style={{ margin: '8px 0', padding: '10px', background: '#3b1818', border: '1px solid #ef4444', borderRadius: '6px' }}>
                <span className="issue-icon" style={{ fontSize: '16px', marginRight: '6px' }}>⚠️</span>
                <div>
                  <strong style={{ color: '#fca5a5' }}>Unvalidated Flow Risk:</strong>
                  <p style={{ color: '#fecaca', margin: '4px 0 0', fontSize: '12px' }}>
                    Unvalidated input traverses this edge directly to a downstream sink without proof of validation.
                  </p>
                </div>
              </div>
            )}

            <div className="drawer-evidence-box" style={{ margin: '8px 0', padding: '10px', background: '#241a13', border: '1px solid #4a3628', borderRadius: '6px' }}>
              <span className="meta-label" style={{ color: '#d4a373', fontWeight: 'bold' }}>Supporting Evidence:</span>
              <p className="drawer-evidence-text" style={{ color: '#eed8c4', margin: '4px 0 0', fontSize: '12px', lineHeight: '1.4' }}>
                {selectedEdge.evidence || 'Identified via local syntax traversal and AST symbol resolution.'}
              </p>
            </div>

            <div className="drawer-meta-grid">
              <div className="drawer-meta-item">
                <span className="meta-label">Origin (Source):</span>
                <span className="meta-val">
                  <strong>{nodeMap.get(selectedEdge.source)?.label || selectedEdge.source}</strong>
                  {nodeMap.get(selectedEdge.source)?.filePath && (
                    <span className="line-range-hint">
                      {' '}({nodeMap.get(selectedEdge.source)?.filePath}:{nodeMap.get(selectedEdge.source)?.lineRange?.startLine || 1})
                    </span>
                  )}
                </span>
              </div>
              <div className="drawer-meta-item">
                <span className="meta-label">Destination (Target):</span>
                <span className="meta-val">
                  <strong>{nodeMap.get(selectedEdge.target)?.label || selectedEdge.target}</strong>
                  {nodeMap.get(selectedEdge.target)?.filePath && (
                    <span className="line-range-hint">
                      {' '}({nodeMap.get(selectedEdge.target)?.filePath}:{nodeMap.get(selectedEdge.target)?.lineRange?.startLine || 1})
                    </span>
                  )}
                </span>
              </div>
              <div className="drawer-meta-item">
                <span className="meta-label">Confidence Level:</span>
                <span className="meta-val">
                  {selectedEdge.confidence === 'directly_observed'
                    ? 'Directly Observed (local AST scope)'
                    : selectedEdge.confidence === 'inferred'
                    ? 'Inferred (cross-function call symbol match)'
                    : 'Unresolved (external/global/dynamic)'}
                </span>
              </div>
            </div>
          </div>

          <div className="inspector-drawer-footer">
            <button
              type="button"
              className="btn-focus-house"
              onClick={() => setSelectedEdgeId(null)}
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* 5. Empty State */}
      {graph.nodes.length === 0 && (
        <div className="canvas-empty-state">
          <span className="empty-icon">📊</span>
          <h4>No Graph Evidence Available</h4>
          <p>{graph.explanation || 'Inspect a repository to establish code architecture graphs.'}</p>
        </div>
      )}
    </div>
  );

  return (
    <>
      {renderCanvasBody(false)}
      {!isParentExpanded && internalExpanded && (
        <ExpandedVisualizationShell
          isOpen={internalExpanded}
          onClose={() => setInternalExpanded(false)}
          title={graph.title || 'Architecture & Flow Graph'}
          subtitle={graph.explanation}
          eyebrow={`EXPANDED ARCHITECTURE VIEW · ${viewMode.toUpperCase().replace('_', ' ')}`}
          triggerRef={expandButtonRef}
          badges={
            <>
              <span className="expanded-status-badge">
                {graph.nodes.filter((n) => n.classification === 'observed').length} / {graph.nodes.length} Observed
              </span>
              {viewMode === 'control_flow' && activeCfg && (
                <span className="timing-pill">Complexity: {activeCfg.stats.cyclomaticComplexity}</span>
              )}
              {viewMode === 'data_flow' && activeDfg && (
                <span className="timing-pill">Transforms: {activeDfg.stats.totalTransforms}</span>
              )}
            </>
          }
          footer={
            <div className="expanded-graph-footer-content">
              <span className="footer-tip">
                💡 Shortcuts: <strong>+</strong>/<strong>-</strong> zoom, <strong>0</strong> fit to view, <strong>Drag</strong> pan, <strong>Esc</strong> close
              </span>
              {selectedNode && (
                <span className="footer-selected-node">
                  Selected: <strong>{selectedNode.label}</strong> ({selectedNode.kind})
                </span>
              )}
            </div>
          }
        >
          {renderCanvasBody(true)}
        </ExpandedVisualizationShell>
      )}
    </>
  );
};
