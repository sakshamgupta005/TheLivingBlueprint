import type { CanvasEdge, CanvasGraph, CanvasNode } from '../graph/types.ts';
import { calculateBounds, computeLayerRanks } from '../graph/layoutEngine.ts';
import type {
  ArchitectureLensResult,
  ConfigWiringModel,
  DataSchemaModel,
  ErrorPathModel,
  ModuleHierarchyModel,
  StateTransitionModel,
} from './types.ts';

const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;
const RANK_SPACING = 280;
const NODE_SPACING = 110;

/**
 * Converts State Transition Analysis into an interactive CanvasGraph.
 */
export function buildCanvasFromStateTransitions(
  result: ArchitectureLensResult<StateTransitionModel>
): CanvasGraph {
  if (!result.hasSufficientEvidence || !result.model || result.model.machines.length === 0) {
    return {
      id: 'state-transitions-empty',
      title: 'State Transition View',
      viewMode: 'state_transitions',
      nodes: [],
      edges: [],
      bounds: { minX: 0, minY: 0, maxX: 600, maxY: 400, width: 600, height: 400 },
      explanation: result.reasonIfUnsupported || 'No state machines or transitions detected in inspected code.',
    };
  }

  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  for (const machine of result.model.machines) {
    const stateIds = machine.states.map((s) => s.id);
    const transEdges = machine.transitions.map((t) => {
      const fromState = machine.states.find((s) => s.id === t.from || s.label === t.from || s.value === t.from);
      const toState = machine.states.find((s) => s.id === t.to || s.label === t.to || s.value === t.to);
      return {
        source: fromState ? fromState.id : `${machine.name}.${t.from}`,
        target: toState ? toState.id : `${machine.name}.${t.to}`,
      };
    });
    const ranks = computeLayerRanks(stateIds, transEdges);

    const rankBuckets = new Map<number, string[]>();
    for (const [id, r] of ranks.entries()) {
      if (!rankBuckets.has(r)) rankBuckets.set(r, []);
      rankBuckets.get(r)!.push(id);
    }

    // Place states
    for (const [r, ids] of rankBuckets.entries()) {
      ids.forEach((id, idx) => {
        const stateObj = machine.states.find((s) => s.id === id);
        if (!stateObj) return;

        nodes.push({
          id: stateObj.id,
          label: stateObj.label,
          subLabel: stateObj.value ? `Value: "${stateObj.value}"` : machine.name,
          kind: 'state',
          x: r * RANK_SPACING + 40,
          y: idx * NODE_SPACING + 60,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          filePath: stateObj.sourceFile,
          lineRange: { startLine: stateObj.line, endLine: stateObj.line },
          classification: 'observed',
          groupName: machine.name,
          codeSnippet: {
            code: `${machine.name}.${stateObj.label} = "${stateObj.value || stateObj.label}"`,
            line: stateObj.line,
            explanation: `Observed state in ${machine.name}`,
          },
        });
      });
    }

    // Place transitions
    for (const t of machine.transitions) {
      const fromState = machine.states.find((s) => s.id === t.from || s.label === t.from || s.value === t.from);
      const toState = machine.states.find((s) => s.id === t.to || s.label === t.to || s.value === t.to);
      const sourceId = fromState ? fromState.id : `${machine.name}.${t.from}`;
      const targetId = toState ? toState.id : `${machine.name}.${t.to}`;

      edges.push({
        id: t.id,
        source: sourceId,
        target: targetId,
        label: t.trigger || 'transition',
        branchLabel: t.trigger,
        classification: 'observed',
        style: 'solid',
        evidence: t.evidence,
      });
    }
  }

  const bounds = calculateBounds(nodes);

  return {
    id: 'canvas-state-transitions',
    title: 'State Transition & Lifecycle View',
    viewMode: 'state_transitions',
    nodes,
    edges,
    bounds,
    explanation: `Detected ${result.model.machines.length} state machine(s) with ${result.model.totalStates} states and ${result.model.totalTransitions} code-supported transitions.`,
  };
}

/**
 * Converts Data & Schema Model Analysis into an interactive CanvasGraph.
 */
export function buildCanvasFromDataSchemas(
  result: ArchitectureLensResult<DataSchemaModel>
): CanvasGraph {
  if (!result.hasSufficientEvidence || !result.model || result.model.models.length === 0) {
    return {
      id: 'data-schemas-empty',
      title: 'Data & Schema View',
      viewMode: 'data_schema',
      nodes: [],
      edges: [],
      bounds: { minX: 0, minY: 0, maxX: 600, maxY: 400, width: 600, height: 400 },
      explanation: result.reasonIfUnsupported || 'No schemas or models detected in inspected code.',
    };
  }

  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  const modelIds = result.model.models.map((m) => m.name);
  const relEdges = result.model.relationships.map((r) => ({
    source: r.sourceModel,
    target: r.targetModel,
  }));
  const ranks = computeLayerRanks(modelIds, relEdges);

  const rankBuckets = new Map<number, string[]>();
  for (const [id, r] of ranks.entries()) {
    if (!rankBuckets.has(r)) rankBuckets.set(r, []);
    rankBuckets.get(r)!.push(id);
  }

  for (const [r, names] of rankBuckets.entries()) {
    names.forEach((name, idx) => {
      const m = result.model!.models.find((item) => item.name === name);
      if (!m) return;

      const fieldList = m.fields.map((f) => `${f.name}: ${f.type}${f.isPrimary ? ' [PK]' : ''}${f.isForeign ? ' [FK]' : ''}`).join('\n');

      nodes.push({
        id: m.name,
        label: m.name,
        subLabel: `${m.kind.replace('_', ' ').toUpperCase()} (${m.fields.length} fields)`,
        kind: 'storage',
        x: r * (RANK_SPACING + 40) + 40,
        y: idx * (NODE_SPACING + 50) + 60,
        width: NODE_WIDTH + 40,
        height: NODE_HEIGHT + 20,
        filePath: m.filePath,
        lineRange: m.lineRange,
        classification: 'observed',
        inputs: m.fields.slice(0, 5).map((f) => f.name).join(', '),
        codeSnippet: {
          code: m.rawDefinition || fieldList,
          line: m.lineRange.startLine,
          explanation: `Detected ${m.kind}: ${m.name}`,
        },
      });
    });
  }

  for (const rel of result.model.relationships) {
    edges.push({
      id: rel.id,
      source: rel.sourceModel,
      target: rel.targetModel,
      label: rel.kind === 'foreign_key' ? `FK: ${rel.sourceField}` : rel.kind,
      classification: 'observed',
      style: 'solid',
      evidence: rel.evidence,
    });
  }

  const bounds = calculateBounds(nodes);

  return {
    id: 'canvas-data-schema',
    title: 'Data & Schema Model View',
    viewMode: 'data_schema',
    nodes,
    edges,
    bounds,
    explanation: `Detected ${result.model.models.length} model(s) and ${result.model.relationships.length} field relationships.`,
  };
}

/**
 * Converts Configuration & Environment Wiring into an interactive CanvasGraph.
 * Strictly redacts secret values.
 */
export function buildCanvasFromConfigWiring(
  result: ArchitectureLensResult<ConfigWiringModel>
): CanvasGraph {
  if (!result.hasSufficientEvidence || !result.model || result.model.configs.length === 0) {
    return {
      id: 'config-wiring-empty',
      title: 'Configuration Wiring View',
      viewMode: 'config_wiring',
      nodes: [],
      edges: [],
      bounds: { minX: 0, minY: 0, maxX: 600, maxY: 400, width: 600, height: 400 },
      explanation: result.reasonIfUnsupported || 'No environment variables or config keys detected.',
    };
  }

  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  // Group 0: Config variables on left
  result.model.configs.forEach((cfg, idx) => {
    const configNodeId = `cfg-${cfg.key}`;
    nodes.push({
      id: configNodeId,
      label: cfg.key,
      subLabel: cfg.isSecret ? '🔒 SECRET (REDACTED)' : cfg.defaultValue ? `Default: ${cfg.defaultValue}` : 'Environment Variable',
      kind: 'config',
      x: 40,
      y: idx * (NODE_SPACING - 10) + 60,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      classification: 'observed',
      codeSnippet: {
        code: cfg.isSecret ? `${cfg.key}=[REDACTED]` : `${cfg.key}=${cfg.defaultValue || '<unset>'}`,
        explanation: `Config variable read by ${cfg.consumers.length} consumer(s)`,
      },
    });

    // Group 1: Consumers on right
    cfg.consumers.forEach((c, cIdx) => {
      const consumerNodeId = `consumer-${c.filePath}#${c.line}`;
      const existing = nodes.find((n) => n.id === consumerNodeId);
      if (!existing) {
        nodes.push({
          id: consumerNodeId,
          label: c.filePath.split('/').pop() || c.filePath,
          subLabel: c.functionName ? `${c.functionName}()` : `Line ${c.line}`,
          kind: 'module',
          x: RANK_SPACING + 100,
          y: (idx + cIdx) * (NODE_SPACING - 15) + 60,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          filePath: c.filePath,
          lineRange: { startLine: c.line, endLine: c.line },
          classification: 'observed',
          codeSnippet: {
            code: c.expression,
            line: c.line,
            explanation: `Consumes config key: ${cfg.key}`,
          },
        });
      }

      edges.push({
        id: `edge-${configNodeId}-${consumerNodeId}`,
        source: configNodeId,
        target: consumerNodeId,
        label: 'reads',
        classification: 'observed',
        style: 'solid',
        evidence: `Observed read in ${c.filePath}:${c.line}`,
      });
    });
  });

  const bounds = calculateBounds(nodes);

  return {
    id: 'canvas-config-wiring',
    title: 'Configuration & Environment Wiring View',
    viewMode: 'config_wiring',
    nodes,
    edges,
    bounds,
    explanation: `Mapped ${result.model.configs.length} configuration keys (${result.model.secretKeysCount} secret) to consumer modules. Secret values are never exposed.`,
  };
}

/**
 * Converts Module Hierarchy into an interactive CanvasGraph with collapsible clusters
 * and circular-dependency highlighting.
 */
export function buildCanvasFromModuleHierarchy(
  result: ArchitectureLensResult<ModuleHierarchyModel>
): CanvasGraph {
  if (!result.hasSufficientEvidence || !result.model) {
    return {
      id: 'module-hierarchy-empty',
      title: 'Module Hierarchy View',
      viewMode: 'module_hierarchy',
      nodes: [],
      edges: [],
      bounds: { minX: 0, minY: 0, maxX: 600, maxY: 400, width: 600, height: 400 },
      explanation: result.reasonIfUnsupported || 'Insufficient module data.',
    };
  }

  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  const moduleIds = result.model.modules.map((m) => m.path);
  const depEdges: Array<{ source: string; target: string }> = [];
  for (const m of result.model.modules) {
    for (const imp of m.imports) {
      depEdges.push({ source: m.path, target: imp });
    }
  }

  const ranks = computeLayerRanks(moduleIds, depEdges);
  const rankBuckets = new Map<number, string[]>();
  for (const [id, r] of ranks.entries()) {
    if (!rankBuckets.has(r)) rankBuckets.set(r, []);
    rankBuckets.get(r)!.push(id);
  }

  for (const [r, paths] of rankBuckets.entries()) {
    paths.forEach((path, idx) => {
      const mod = result.model!.modules.find((item) => item.path === path);
      if (!mod) return;

      nodes.push({
        id: mod.path,
        label: mod.name,
        subLabel: mod.isPartOfCycle ? '⚠️ Circular Dependency' : mod.clusterId.replace('cluster-', ''),
        kind: 'module',
        x: r * RANK_SPACING + 40,
        y: idx * NODE_SPACING + 60,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        filePath: mod.path,
        classification: 'observed',
        groupId: mod.clusterId,
        groupName: mod.clusterId.replace('cluster-', ''),
        hasIssues: mod.isPartOfCycle,
        issuesSummary: mod.isPartOfCycle ? 'Module participates in a circular import loop.' : undefined,
      });

      for (const imp of mod.imports) {
        const isCycleEdge = mod.isPartOfCycle && mod.cycleParticipants?.includes(imp);
        edges.push({
          id: `mod-edge-${mod.path}-${imp}`,
          source: mod.path,
          target: imp,
          label: isCycleEdge ? '⚠️ CIRCULAR' : 'imports',
          classification: 'observed',
          style: isCycleEdge ? 'dashed' : 'solid',
          isBackEdge: isCycleEdge,
          evidence: isCycleEdge ? `Circular import loop between ${mod.name} and ${imp}` : `Import relationship`,
        });
      }
    });
  }

  const bounds = calculateBounds(nodes);

  return {
    id: 'canvas-module-hierarchy',
    title: 'Module Hierarchy & Import Clusters View',
    viewMode: 'module_hierarchy',
    nodes,
    edges,
    bounds,
    explanation: `Hierarchical directory clusters for ${result.model.totalModules} modules. ${result.model.circularModulesCount > 0 ? `⚠️ Found ${result.model.circularModulesCount} module(s) in circular dependency cycles.` : 'No circular dependencies detected.'}`,
  };
}

/**
 * Converts Error-Path Analysis into an interactive CanvasGraph.
 */
export function buildCanvasFromErrorPaths(
  result: ArchitectureLensResult<ErrorPathModel>
): CanvasGraph {
  if (!result.hasSufficientEvidence || !result.model || result.model.throwSites.length === 0) {
    return {
      id: 'error-paths-empty',
      title: 'Error-Path View',
      viewMode: 'error_paths',
      nodes: [],
      edges: [],
      bounds: { minX: 0, minY: 0, maxX: 600, maxY: 400, width: 600, height: 400 },
      explanation: result.reasonIfUnsupported || 'No explicit throw statements or error handlers detected.',
    };
  }

  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  // 1. Throw Site nodes
  result.model.throwSites.forEach((t, idx) => {
    nodes.push({
      id: t.id,
      label: `throw ${t.errorType}`,
      subLabel: t.enclosingFunction ? `${t.enclosingFunction}()` : `Line ${t.line}`,
      kind: 'throw',
      x: 40,
      y: idx * NODE_SPACING + 60,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      filePath: t.filePath,
      lineRange: { startLine: t.line, endLine: t.line },
      classification: 'observed',
      hasIssues: true,
      codeSnippet: {
        code: t.codeExcerpt,
        line: t.line,
        explanation: `Explicit throw of ${t.errorType}`,
      },
    });
  });

  // 2. Error Class / Handler nodes
  result.model.errorPaths.forEach((path, idx) => {
    const handlerNodeId = path.handlerId || `handler-default-${path.statusCode || 500}`;
    const existing = nodes.find((n) => n.id === handlerNodeId);

    if (!existing) {
      nodes.push({
        id: handlerNodeId,
        label: path.statusCode ? `HTTP ${path.statusCode}` : 'Error Handler',
        subLabel: path.targetFile ? (path.targetFile.split('/').pop() || path.targetFile) : 'Failure Exit',
        kind: 'exit',
        x: RANK_SPACING + 100,
        y: idx * NODE_SPACING + 60,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        filePath: path.targetFile,
        classification: 'observed',
      });
    }

    edges.push({
      id: `err-edge-${path.id}`,
      source: path.throwSiteId,
      target: handlerNodeId,
      label: path.statusCode ? `status ${path.statusCode}` : path.errorType,
      classification: 'observed',
      style: 'solid',
      evidence: path.evidence,
    });
  });

  const bounds = calculateBounds(nodes);

  return {
    id: 'canvas-error-paths',
    title: 'Error-Path & Failure Branch View',
    viewMode: 'error_paths',
    nodes,
    edges,
    bounds,
    explanation: `Detected ${result.model.throwSites.length} throw site(s) and mapped error flow branches.`,
  };
}
