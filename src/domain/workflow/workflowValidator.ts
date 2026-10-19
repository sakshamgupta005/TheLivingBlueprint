/**
 * Validator and sanitizer for educational workflow diagrams and walkthroughs.
 * Enforces strict grounding against scanned repository context and inspected files.
 */

import type { WorkflowDiagram, WorkflowNode, WorkflowEdge, ChatApiRequest } from '../../server/types.ts';

const DEFAULT_MAX_NODES = 7;
const ABSOLUTE_MAX_NODES = 12;
const MIN_NODES = 2;
const DEFAULT_MAX_EDGES = 10;
const ABSOLUTE_MAX_EDGES = 20;
const MIN_EDGES = 1;

const VALID_NODE_TYPES = new Set(['component', 'decision', 'storage', 'external', 'step']);

export interface WorkflowValidationOptions {
  maxNodes?: number;
  maxEdges?: number;
}

export function validateWorkflowDiagram(
  rawDiagram: unknown,
  repoContext?: ChatApiRequest['repoContext'],
  options?: WorkflowValidationOptions
): WorkflowDiagram | null {
  if (!rawDiagram || typeof rawDiagram !== 'object') {
    return null;
  }

  const maxNodesLimit = Math.min(
    ABSOLUTE_MAX_NODES,
    Math.max(MIN_NODES, options?.maxNodes ?? DEFAULT_MAX_NODES)
  );
  const maxEdgesLimit = Math.min(
    ABSOLUTE_MAX_EDGES,
    Math.max(MIN_EDGES, options?.maxEdges ?? DEFAULT_MAX_EDGES)
  );

  const candidate = rawDiagram as Record<string, unknown>;

  // Optional stable diagram ID
  const id =
    typeof candidate.id === 'string' && candidate.id.trim().length > 0
      ? candidate.id.trim().slice(0, 64)
      : undefined;

  // Title validation
  if (typeof candidate.title !== 'string' || candidate.title.trim().length === 0) {
    return null;
  }
  const title = candidate.title.trim().slice(0, 100);

  // Explanation validation
  if (typeof candidate.explanation !== 'string' || candidate.explanation.trim().length === 0) {
    return null;
  }
  const explanation = candidate.explanation.trim().slice(0, 400);

  // Strict simulation labeling: code-derived walkthrough, never actual runtime traces
  const simulationType: WorkflowDiagram['simulationType'] = 'code-derived workflow walkthrough';

  // Build repository lookup indices for verification
  const inspectedPathSet = new Set<string>();
  const discoveredPathSet = new Set<string>();
  const roomIdsSet = new Set<string>();

  if (repoContext) {
    if (Array.isArray(repoContext.inspectedFiles)) {
      for (const f of repoContext.inspectedFiles) {
        if (f && f.path && typeof f.path === 'string') {
          const norm = f.path.trim().toLowerCase();
          inspectedPathSet.add(norm);
          discoveredPathSet.add(norm);
        }
      }
    }

    if (Array.isArray(repoContext.discoveredFilePaths)) {
      for (const p of repoContext.discoveredFilePaths) {
        if (typeof p === 'string' && p.trim()) {
          discoveredPathSet.add(p.trim().toLowerCase());
        }
      }
    }

    if (Array.isArray(repoContext.roomSummaries)) {
      for (const r of repoContext.roomSummaries) {
        if (r && r.id && typeof r.id === 'string') {
          roomIdsSet.add(r.id.trim());
        }
      }
    }
  }

  // Validate nodes
  if (!Array.isArray(candidate.nodes) || candidate.nodes.length < MIN_NODES) {
    return null;
  }

  const validNodes: WorkflowNode[] = [];
  const seenNodeIds = new Set<string>();

  for (const rawNode of candidate.nodes.slice(0, maxNodesLimit)) {
    if (!rawNode || typeof rawNode !== 'object') continue;
    const n = rawNode as Record<string, unknown>;

    if (typeof n.id !== 'string' || !n.id.trim()) continue;
    const id = n.id.trim().toLowerCase();
    if (seenNodeIds.has(id)) continue;
    seenNodeIds.add(id);

    if (typeof n.label !== 'string' || !n.label.trim()) continue;
    const label = n.label.trim().slice(0, 60);

    const role = typeof n.role === 'string' && n.role.trim() ? n.role.trim().slice(0, 60) : undefined;
    const description =
      typeof n.description === 'string' && n.description.trim()
        ? n.description.trim().slice(0, 300)
        : `Processes step in ${label}`;

    const inputs = typeof n.inputs === 'string' && n.inputs.trim() ? n.inputs.trim().slice(0, 150) : undefined;
    const outputs = typeof n.outputs === 'string' && n.outputs.trim() ? n.outputs.trim().slice(0, 150) : undefined;

    // Validate roomId mapping
    let roomId: string | undefined;
    if (typeof n.roomId === 'string' && roomIdsSet.has(n.roomId.trim())) {
      roomId = n.roomId.trim();
    }

    // Validate filePath grounding against repository records
    let filePath: string | undefined;
    let isFileInspected = false;
    let _isFileDiscovered = false;

    if (typeof n.filePath === 'string' && n.filePath.trim()) {
      const candidatePath = n.filePath.trim();
      const lower = candidatePath.toLowerCase();

      if (inspectedPathSet.has(lower)) {
        filePath = candidatePath;
        isFileInspected = true;
        _isFileDiscovered = true;
      } else if (discoveredPathSet.has(lower)) {
        filePath = candidatePath;
        _isFileDiscovered = true;
      }
      // If candidatePath is neither inspected nor discovered in the scanned repository,
      // it is a fabricated path: do not attach it as a valid filePath.
    }
    void _isFileDiscovered;

    // Classification: only observed if verified against an inspected file in scan
    let classification: 'observed' | 'inferred' = 'inferred';
    if (n.classification === 'observed' && isFileInspected) {
      classification = 'observed';
    } else {
      classification = 'inferred';
    }

    let nodeType: WorkflowNode['nodeType'] = undefined;
    if (typeof n.nodeType === 'string' && VALID_NODE_TYPES.has(n.nodeType.trim().toLowerCase())) {
      nodeType = n.nodeType.trim().toLowerCase() as WorkflowNode['nodeType'];
    } else {
      const combined = `${label} ${role || ''}`.toLowerCase();
      if (/decision|condition|check|validat|branch|guard/i.test(combined)) {
        nodeType = 'decision';
      } else if (/storage|db|database|table|sql|cache|store|repo/i.test(combined)) {
        nodeType = 'storage';
      } else if (/client|gateway|external|http|request|api|user/i.test(combined)) {
        nodeType = 'external';
      } else {
        nodeType = 'component';
      }
    }

    validNodes.push({
      id,
      label,
      role,
      nodeType,
      roomId,
      filePath,
      classification,
      description,
      inputs,
      outputs,
    });
  }

  if (validNodes.length < MIN_NODES) {
    return null;
  }

  // Validate edges
  if (!Array.isArray(candidate.edges) || candidate.edges.length < MIN_EDGES) {
    return null;
  }

  const validEdges: WorkflowEdge[] = [];
  const seenEdges = new Set<string>();

  for (const rawEdge of candidate.edges.slice(0, maxEdgesLimit)) {
    if (!rawEdge || typeof rawEdge !== 'object') continue;
    const e = rawEdge as Record<string, unknown>;

    if (typeof e.from !== 'string' || typeof e.to !== 'string') continue;
    const from = e.from.trim().toLowerCase();
    const to = e.to.trim().toLowerCase();

    if (from === to) continue; // No self loops
    if (!seenNodeIds.has(from) || !seenNodeIds.has(to)) continue;

    const edgeKey = `${from}->${to}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);

    const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim().slice(0, 60) : undefined;
    const branchLabel =
      typeof e.branchLabel === 'string' && e.branchLabel.trim() ? e.branchLabel.trim().slice(0, 60) : undefined;

    // Edge classification: only observed if both nodes are observed, else inferred
    const fromNode = validNodes.find((n) => n.id === from);
    const toNode = validNodes.find((n) => n.id === to);
    let classification: 'observed' | 'inferred' = 'inferred';

    if (
      e.classification === 'observed' &&
      fromNode?.classification === 'observed' &&
      toNode?.classification === 'observed'
    ) {
      classification = 'observed';
    }

    let evidenceReference: string | undefined;
    if (typeof e.evidenceReference === 'string' && e.evidenceReference.trim()) {
      const ref = e.evidenceReference.trim();
      if (inspectedPathSet.has(ref.toLowerCase())) {
        evidenceReference = ref;
      }
    }

    validEdges.push({
      from,
      to,
      label,
      branchLabel,
      classification,
      evidenceReference,
    });
  }

  if (validEdges.length < MIN_EDGES) {
    return null;
  }

  const uncertainties =
    typeof candidate.uncertainties === 'string' && candidate.uncertainties.trim()
      ? candidate.uncertainties.trim().slice(0, 300)
      : undefined;

  return {
    id,
    title,
    explanation,
    simulationType,
    nodes: validNodes,
    edges: validEdges,
    uncertainties,
  };
}
