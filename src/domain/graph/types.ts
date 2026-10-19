/**
 * Types for the Interactive Architecture Graph Canvas (T25).
 * Represents interactive nodes, edges, groups, layout metrics, and view modes.
 */

export type GraphViewMode =
  | 'modules'
  | 'functions'
  | 'workflow'
  | 'control_flow'
  | 'data_flow'
  | 'sequence'
  | 'simulation'
  | 'state_transitions'
  | 'data_schema'
  | 'config_wiring'
  | 'module_hierarchy'
  | 'error_paths';

export type CanvasNodeKind =
  | 'module'
  | 'function'
  | 'route'
  | 'decision'
  | 'storage'
  | 'external'
  | 'group'
  | 'component'
  | 'entry'
  | 'exit'
  | 'condition'
  | 'loop'
  | 'return'
  | 'throw'
  | 'source'
  | 'validation'
  | 'sink'
  | 'state'
  | 'transition'
  | 'schema'
  | 'config'
  | 'error_handler';

export interface CanvasNode {
  id: string;
  label: string;
  subLabel?: string;
  kind: CanvasNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  roomId?: string;
  filePath?: string;
  lineRange?: { startLine: number; endLine: number };
  classification: 'observed' | 'inferred';
  groupId?: string;
  groupName?: string;
  isGroupCollapsed?: boolean;
  groupMemberCount?: number;
  codeSnippet?: {
    code: string;
    line?: number;
    explanation?: string;
  };
  inputs?: string;
  outputs?: string;
  description?: string;
  importance?: string;
  unsupportedReason?: string;
  hasIssues?: boolean;
  issuesSummary?: string;
  relatedTests?: string[];
  functionName?: string;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  branchLabel?: string;
  classification: 'observed' | 'inferred';
  confidence?: 'directly_observed' | 'inferred' | 'unresolved';
  style: 'solid' | 'dashed';
  edgeKind?: string;
  isBackEdge?: boolean;
  evidence?: string;
  isTainted?: boolean;
}

export interface GraphBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface CanvasGraph {
  id: string;
  title: string;
  viewMode: GraphViewMode;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  bounds: GraphBounds;
  uncertainties?: string;
  explanation?: string;
}

export interface ViewportTransform {
  x: number;
  y: number;
  zoom: number;
}
