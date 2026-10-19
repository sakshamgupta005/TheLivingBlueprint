import type { WorkflowDiagram } from '../../server/types.ts';
import type { ArchitecturalRoom } from '../../types.ts';
import type { CodeIndex } from '../codeIndex/types.ts';
import type { ControlFlowGraph } from '../cfg/types.ts';
import type { DataFlowGraph } from '../dataFlow/types.ts';
import type {
  CanvasGraph,
  CanvasNode,
  CanvasEdge,
  GraphBounds,
  CanvasNodeKind,
} from './types.ts';

const DEFAULT_NODE_WIDTH = 220;
const DEFAULT_NODE_HEIGHT = 88;
const RANK_SPACING = 280;
const NODE_SPACING = 120;
const PADDING = 60;

/**
 * Calculates a bounding box encompassing all nodes with padding
 */
export function calculateBounds(nodes: CanvasNode[]): GraphBounds {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 800, maxY: 600, width: 800, height: 600 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of nodes) {
    const nx = Number.isFinite(node.x) ? node.x : 0;
    const ny = Number.isFinite(node.y) ? node.y : 0;
    const nw = Number.isFinite(node.width) ? node.width : DEFAULT_NODE_WIDTH;
    const nh = Number.isFinite(node.height) ? node.height : DEFAULT_NODE_HEIGHT;

    minX = Math.min(minX, nx);
    minY = Math.min(minY, ny);
    maxX = Math.max(maxX, nx + nw);
    maxY = Math.max(maxY, ny + nh);
  }

  minX -= PADDING;
  minY -= PADDING;
  maxX += PADDING;
  maxY += PADDING;

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(400, maxX - minX),
    height: Math.max(300, maxY - minY),
  };
}

/**
 * Assigns ranks to directed graph nodes using cycle-breaking topological layering
 */
export function computeLayerRanks(
  nodeIds: string[],
  edges: Array<{ source: string; target: string }>
): Map<string, number> {
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adjList.set(id, []);
  }

  for (const edge of edges) {
    if (adjList.has(edge.source) && inDegree.has(edge.target)) {
      adjList.get(edge.source)!.push(edge.target);
      inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
    }
  }

  const ranks = new Map<string, number>();
  const queue: string[] = [];

  // Roots get rank 0
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      ranks.set(id, 0);
      queue.push(id);
    }
  }

  // If there are cycles and queue is empty, initialize first node
  if (queue.length === 0 && nodeIds.length > 0) {
    ranks.set(nodeIds[0], 0);
    queue.push(nodeIds[0]);
  }

  let visitedCount = 0;
  while (visitedCount < nodeIds.length) {
    if (queue.length === 0) {
      // Break cycles: pick unranked node with lowest remaining in-degree
      let bestNode: string | null = null;
      let lowestDeg = Infinity;
      for (const id of nodeIds) {
        if (!ranks.has(id)) {
          const deg = inDegree.get(id) || 0;
          if (deg < lowestDeg) {
            lowestDeg = deg;
            bestNode = id;
          }
        }
      }
      if (!bestNode) break;
      const maxExisting = ranks.size > 0 ? Math.max(...ranks.values()) : 0;
      ranks.set(bestNode, maxExisting + 1);
      queue.push(bestNode);
    }

    const curr = queue.shift()!;
    visitedCount++;
    const currRank = ranks.get(curr) || 0;

    for (const neighbor of adjList.get(curr) || []) {
      const existingRank = ranks.get(neighbor) || 0;
      const nextRank = Math.max(existingRank, currRank + 1);
      ranks.set(neighbor, nextRank);

      const deg = (inDegree.get(neighbor) || 1) - 1;
      inDegree.set(neighbor, deg);
      if (deg <= 0 && !queue.includes(neighbor)) {
        queue.push(neighbor);
      }
    }
  }

  // Handle any remaining disconnected nodes
  for (const id of nodeIds) {
    if (!ranks.has(id)) {
      ranks.set(id, visitedCount);
    }
  }

  return ranks;
}

export interface LayoutRankOptions {
  viewportWidth?: number;
  viewportHeight?: number;
  isExpanded?: boolean;
}

/**
 * Applies deterministic layered 2D coordinates to nodes based on computed ranks.
 * Incorporates Archify-style adaptive spacing based on node count and viewport size.
 */
export function layoutNodesByRank(
  rawNodes: Array<Omit<CanvasNode, 'x' | 'y'>>,
  edges: Array<{ source: string; target: string }>,
  options?: LayoutRankOptions
): CanvasNode[] {
  if (rawNodes.length === 0) return [];

  const nodeIds = rawNodes.map((n) => n.id);
  const ranks = computeLayerRanks(nodeIds, edges);

  // Group nodes by their rank layer
  const layers = new Map<number, Array<Omit<CanvasNode, 'x' | 'y'>>>();
  for (const node of rawNodes) {
    const rank = ranks.get(node.id) || 0;
    const list = layers.get(rank) || [];
    list.push(node);
    layers.set(rank, list);
  }

  const laidOutNodes: CanvasNode[] = [];
  const sortedRanks = Array.from(layers.keys()).sort((a, b) => a - b);
  const targetHeight = options?.viewportHeight || (options?.isExpanded ? 800 : 600);

  // Archify-style adaptive spacing: roomier for small graphs, balanced for large graphs
  const isSmallGraph = rawNodes.length <= 4;
  const rankSpacing = options?.isExpanded ? (isSmallGraph ? 330 : 300) : RANK_SPACING;
  const nodeSpacing = options?.isExpanded ? (isSmallGraph ? 140 : 125) : NODE_SPACING;

  for (const rank of sortedRanks) {
    const rankNodes = layers.get(rank) || [];
    const totalHeight = rankNodes.length * nodeSpacing;
    const startY = Math.max(PADDING, (targetHeight - totalHeight) / 2);

    rankNodes.forEach((node, idx) => {
      laidOutNodes.push({
        ...node,
        x: PADDING + rank * rankSpacing,
        y: startY + idx * nodeSpacing,
      });
    });
  }

  return laidOutNodes;
}

/**
 * Builds a CanvasGraph from a WorkflowDiagram (preserving existing flowcharts)
 */
export function buildCanvasFromWorkflow(diagram: WorkflowDiagram): CanvasGraph {
  const rawNodes: Array<Omit<CanvasNode, 'x' | 'y'>> = diagram.nodes.map((n) => {
    let kind: CanvasNodeKind = 'component';
    if (n.nodeType === 'decision') kind = 'decision';
    else if (n.nodeType === 'storage') kind = 'storage';
    else if (n.nodeType === 'external') kind = 'external';

    return {
      id: n.id,
      label: n.label,
      subLabel: n.role,
      kind,
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
      roomId: n.roomId,
      filePath: n.filePath,
      lineRange: (n as any).lineRange || (n.codeSnippet?.line ? { startLine: n.codeSnippet.line, endLine: n.codeSnippet.line } : undefined),
      classification: n.classification,
      codeSnippet: n.codeSnippet || ((n as any).snippet ? { code: (n as any).snippet, line: (n as any).startLine || 1 } : undefined),
      inputs: n.inputs,
      outputs: n.outputs,
      description: n.description,
      importance: n.importance,
    };
  });

  const edges: CanvasEdge[] = (diagram.edges || []).map((e, idx) => ({
    id: `wf-edge-${idx}-${e.from}-${e.to}`,
    source: e.from,
    target: e.to,
    label: e.label,
    branchLabel: e.branchLabel,
    classification: e.classification,
    style: e.classification === 'inferred' ? 'dashed' : 'solid',
  }));

  const nodes = layoutNodesByRank(rawNodes, edges);
  const bounds = calculateBounds(nodes);

  return {
    id: diagram.id || 'workflow-graph',
    title: diagram.title,
    viewMode: 'workflow',
    nodes,
    edges,
    bounds,
    explanation: diagram.explanation,
    uncertainties: diagram.uncertainties,
  };
}

/**
 * Builds a CanvasGraph from Architectural Rooms (Module Graph View)
 */
export function buildCanvasFromModules(
  rooms: ArchitecturalRoom[],
  title = 'Module Architecture Graph'
): CanvasGraph {
  const rawNodes: Array<Omit<CanvasNode, 'x' | 'y'>> = rooms.map((room) => {
    let kind: CanvasNodeKind = 'module';
    if (room.layer === 'foundation') kind = 'storage';
    else if (room.layer === 'gateway') kind = 'route';

    const firstFile = room.filePaths?.[0];
    const isObserved = Boolean(room.metrics?.filesCount && room.metrics.filesCount > 0);

    return {
      id: room.id,
      label: room.name,
      subLabel: `${room.layer.toUpperCase()} · ${room.status.toUpperCase()}`,
      kind,
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
      roomId: room.id,
      filePath: firstFile,
      classification: isObserved ? 'observed' : 'inferred',
      description: room.description,
      importance: room.status,
    };
  });

  const edges: CanvasEdge[] = [];
  let edgeCounter = 1;

  for (const room of rooms) {
    for (const depId of room.dependencies || []) {
      if (rooms.some((r) => r.id === depId)) {
        edges.push({
          id: `mod-edge-${edgeCounter++}`,
          source: room.id,
          target: depId,
          label: 'depends on',
          classification: 'observed',
          style: 'solid',
        });
      }
    }
  }

  const nodes = layoutNodesByRank(rawNodes, edges);
  const bounds = calculateBounds(nodes);

  return {
    id: 'module-architecture-graph',
    title,
    viewMode: 'modules',
    nodes,
    edges,
    bounds,
    explanation: 'Module-level dependencies and architectural rooms established from scanned source files.',
  };
}

/**
 * Builds a CanvasGraph from CodeIndex (Code Structure / Functions View)
 * Supports collapsing large groups by file or directory
 */
export function buildCanvasFromCodeIndex(
  codeIndex: CodeIndex,
  options?: {
    collapsedGroupIds?: Set<string>;
    maxNodes?: number;
    title?: string;
  }
): CanvasGraph {
  const collapsed = options?.collapsedGroupIds || new Set<string>();
  const maxNodes = options?.maxNodes ?? 35; // keep visual clarity per rule 7
  const title = options?.title || 'Code Structure & Dependency Graph';

  // Group symbols and routes by file
  const fileGroups = new Map<string, CanvasNode[]>();
  const rawNodes: Array<Omit<CanvasNode, 'x' | 'y'>> = [];

  // Add route registrations as entry nodes
  for (const route of codeIndex.routes.slice(0, 10)) {
    const routeNode: Omit<CanvasNode, 'x' | 'y'> = {
      id: route.id,
      label: `${route.method} ${route.routePath}`,
      subLabel: route.framework,
      kind: 'route',
      width: 240,
      height: 80,
      filePath: route.sourcePath,
      lineRange: route.lineRange,
      classification: 'observed',
      description: `HTTP ${route.method} Route Endpoint: ${route.routePath}`,
    };
    rawNodes.push(routeNode);
  }

  // Add key symbol definitions (functions, classes) up to maxNodes limit
  for (const sym of codeIndex.symbols) {
    if (rawNodes.length >= maxNodes) break;
    if (sym.kind !== 'function' && sym.kind !== 'class' && sym.kind !== 'method') continue;

    const fileDir = sym.path.includes('/') ? sym.path.slice(0, sym.path.lastIndexOf('/')) : 'root';
    const isGroupCollapsed = collapsed.has(fileDir);

    const symNode: Omit<CanvasNode, 'x' | 'y'> = {
      id: sym.id,
      label: sym.name,
      subLabel: `${sym.kind} (${sym.path.split('/').pop()})`,
      kind: sym.kind === 'class' ? 'storage' : 'function',
      width: DEFAULT_NODE_WIDTH,
      height: 75,
      filePath: sym.path,
      lineRange: sym.lineRange,
      classification: 'observed',
      groupId: fileDir,
      groupName: fileDir,
      description: `${sym.isExported ? 'Exported' : 'Internal'} ${sym.kind} declared in ${sym.path}`,
    };

    if (!isGroupCollapsed) {
      rawNodes.push(symNode);
    }

    const groupList = fileGroups.get(fileDir) || [];
    groupList.push(symNode as CanvasNode);
    fileGroups.set(fileDir, groupList);
  }

  // If a group is collapsed, add a summary group node instead
  for (const [groupId, members] of fileGroups.entries()) {
    if (collapsed.has(groupId) && members.length > 0) {
      rawNodes.push({
        id: `group-${groupId}`,
        label: `📁 ${groupId}`,
        subLabel: `[+${members.length} items collapsed]`,
        kind: 'group',
        width: 240,
        height: 85,
        filePath: members[0].filePath,
        classification: 'observed',
        groupId,
        groupName: groupId,
        isGroupCollapsed: true,
        groupMemberCount: members.length,
        description: `Collapsed module folder containing ${members.length} indexed symbols. Click to expand.`,
      });
    }
  }

  // Filter edges based on active visible nodes
  const activeNodeIds = new Set(rawNodes.map((n) => n.id));
  const edges: CanvasEdge[] = [];

  for (const rel of codeIndex.relationships) {
    if (rel.provenance !== 'syntax') continue; // only confirmed syntactic relationships!

    const sourceId = rel.source.symbol || rel.source.path;
    const targetId = rel.target.symbol || rel.target.path;

    if (activeNodeIds.has(sourceId) && activeNodeIds.has(targetId)) {
      edges.push({
        id: `rel-${rel.id}`,
        source: sourceId,
        target: targetId,
        label: rel.type,
        classification: 'observed',
        style: 'solid',
      });
    }
  }

  const nodes = layoutNodesByRank(rawNodes, edges);
  const bounds = calculateBounds(nodes);

  return {
    id: 'code-structure-graph',
    title,
    viewMode: 'functions',
    nodes,
    edges,
    bounds,
    explanation: `Syntactic symbol call and import graph containing ${nodes.length} verified code entities.`,
  };
}

/**
 * Builds an interactive CanvasGraph directly from a deterministic ControlFlowGraph (T26).
 */
export function buildCanvasFromControlFlowGraph(cfg: ControlFlowGraph): CanvasGraph {
  const rawNodes: CanvasNode[] = cfg.nodes.map((n) => {
    let kind: CanvasNodeKind = 'component';
    if (n.kind === 'entry') kind = 'entry';
    else if (n.kind === 'exit') kind = 'exit';
    else if (n.kind === 'condition' || n.kind === 'switch_header') kind = 'condition';
    else if (n.kind === 'loop_header' || n.kind === 'loop_exit') kind = 'loop';
    else if (n.kind === 'return') kind = 'return';
    else if (n.kind === 'throw') kind = 'throw';
    else if (n.kind === 'try_block' || n.kind === 'catch_block' || n.kind === 'finally_block') kind = 'decision';
    else if (n.kind === 'statement') kind = 'component';

    return {
      id: n.id,
      label: n.label,
      subLabel: n.kind.toUpperCase(),
      kind,
      x: 0,
      y: 0,
      width: n.kind === 'entry' || n.kind === 'exit' ? 180 : DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
      filePath: cfg.sourcePath,
      lineRange: n.lineRange,
      classification: 'observed',
      codeSnippet: {
        code: n.codeExcerpt,
        line: n.lineRange.startLine,
        explanation: n.unsupportedReason,
      },
      description: n.unsupportedReason ? `[Unsupported] ${n.unsupportedReason}` : n.codeExcerpt,
      unsupportedReason: n.unsupportedReason,
      importance: n.kind === 'entry' || n.kind === 'exit' ? 'high' : 'normal',
    };
  });

  const edges: CanvasEdge[] = cfg.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    branchLabel: e.label,
    edgeKind: e.kind,
    isBackEdge: e.isBackEdge,
    classification: 'observed',
    style: e.isBackEdge ? 'dashed' : 'solid',
  }));

  const nodes = layoutNodesByRank(rawNodes, edges);
  const bounds = calculateBounds(nodes);

  return {
    id: `cfg-${cfg.functionName}`,
    title: `Control Flow: ${cfg.functionName}()`,
    viewMode: 'control_flow',
    nodes,
    edges,
    bounds,
    explanation: `Deterministic AST control-flow graph for ${cfg.functionName}() in ${cfg.sourcePath} (${cfg.stats.totalNodes} nodes, ${cfg.stats.totalEdges} edges, complexity ${cfg.stats.cyclomaticComplexity}).`,
  };
}

/**
 * Builds an interactive CanvasGraph from a static DataFlowGraph (T27),
 * with support for focused path selection mode (upstream origins + downstream destinations).
 */
export function buildCanvasFromDataFlow(
  dfg: DataFlowGraph,
  options?: { focusedNodeId?: string }
): CanvasGraph {
  let targetNodeIds = new Set(dfg.nodes.map((n) => n.id));

  // Focused Path Mode (Req 7 & prompt)
  if (options?.focusedNodeId && targetNodeIds.has(options.focusedNodeId)) {
    const focusedId = options.focusedNodeId;
    const pathSet = new Set<string>([focusedId]);

    // Upstream BFS (ancestors)
    const upstreamQueue = [focusedId];
    while (upstreamQueue.length > 0) {
      const curr = upstreamQueue.shift()!;
      for (const edge of dfg.edges) {
        if (edge.target === curr && !pathSet.has(edge.source)) {
          pathSet.add(edge.source);
          upstreamQueue.push(edge.source);
        }
      }
    }

    // Downstream BFS (descendants)
    const downstreamQueue = [focusedId];
    while (downstreamQueue.length > 0) {
      const curr = downstreamQueue.shift()!;
      for (const edge of dfg.edges) {
        if (edge.source === curr && !pathSet.has(edge.target)) {
          pathSet.add(edge.target);
          downstreamQueue.push(edge.target);
        }
      }
    }

    targetNodeIds = pathSet;
  }

  const filteredDataNodes = dfg.nodes.filter((n) => targetNodeIds.has(n.id));

  const rawNodes: CanvasNode[] = filteredDataNodes.map((n) => {
    let kind: CanvasNodeKind = 'component';
    if (n.kind === 'source') kind = 'source';
    else if (n.kind === 'validation') kind = 'validation';
    else if (n.kind === 'sink') kind = 'sink';
    else if (n.kind === 'call_arg') kind = 'function';
    else if (n.kind === 'unresolved') kind = 'external';

    const hasIssues = Boolean(n.issues && n.issues.length > 0);
    const issuesSummary = hasIssues ? n.issues!.map((i) => i.message).join(' | ') : undefined;

    return {
      id: n.id,
      label: n.label,
      subLabel: `${n.kind.toUpperCase()} (${n.confidence.replace('_', ' ')})`,
      kind,
      x: 0,
      y: 0,
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
      filePath: dfg.sourcePath,
      lineRange: n.lineRange,
      roomId: n.roomId,
      functionName: n.functionName,
      relatedTests: n.relatedTests,
      hasIssues,
      issuesSummary,
      classification: n.confidence === 'directly_observed' ? 'observed' : 'inferred',
      codeSnippet: {
        code: n.codeExcerpt,
        line: n.lineRange.startLine,
        explanation: issuesSummary,
      },
      description: issuesSummary || n.codeExcerpt,
      importance: hasIssues ? 'high' : 'normal',
    };
  });

  const edges: CanvasEdge[] = dfg.edges
    .filter((e) => targetNodeIds.has(e.source) && targetNodeIds.has(e.target))
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      branchLabel: e.label,
      evidence: e.evidence,
      isTainted: e.isTainted,
      confidence: e.confidence,
      classification: e.confidence === 'directly_observed' ? 'observed' : 'inferred',
      style: e.confidence === 'unresolved' ? 'dashed' : 'solid',
      edgeKind: e.isTainted ? 'exception' : 'normal',
    }));

  const nodes = layoutNodesByRank(rawNodes, edges);
  const bounds = calculateBounds(nodes);

  return {
    id: dfg.id,
    title: dfg.title,
    viewMode: 'data_flow',
    nodes,
    edges,
    bounds,
    explanation: dfg.explanation,
  };
}

export {
  buildCanvasFromStateTransitions,
  buildCanvasFromDataSchemas,
  buildCanvasFromConfigWiring,
  buildCanvasFromModuleHierarchy,
  buildCanvasFromErrorPaths,
} from '../architectureViews/viewGraphBuilder.ts';



