/**
 * Domain types for Static Data-Flow and Value-Lineage Analysis (T27).
 * Tracks how data travels through inspected code: request input -> validation ->
 * normalization -> storage operation -> response, or parameter -> check -> return.
 */

import type { SourceLineRange } from '../codeIndex/types.ts';

export type DataFlowCapabilityLevel = 'full_ast' | 'pattern_ast' | 'shallow' | 'unsupported';

export type DataFlowNodeKind =
  | 'source'       // Parameter, request body, query, env, initial read
  | 'transform'    // Assignment, normalization (.trim()), calculation
  | 'validation'   // Condition check, guard, validation call
  | 'call_arg'     // Data passed into a resolved callee function
  | 'sink'         // Return statement, storage write, response send
  | 'unresolved';  // Dynamic boundary or uninspected destination

export type DataFlowConfidence =
  | 'directly_observed' // Syntactic variable/expression lineage in local AST
  | 'inferred'          // Inter-procedural flow matched via code index
  | 'unresolved';       // External library, global, or dynamic lookup

export type DataFlowIssueType =
  | 'unvalidated_input'
  | 'late_normalization'
  | 'unresolved_sink'
  | 'tainted_path';

export interface DataFlowIssue {
  type: DataFlowIssueType;
  severity: 'warning' | 'info';
  message: string;
  variableName: string;
  sourceLine: number;
  sinkLine?: number;
  evidence: string;
}

export interface DataFlowNode {
  id: string;
  label: string;
  variableName: string;
  kind: DataFlowNodeKind;
  confidence: DataFlowConfidence;
  sourcePath: string;
  lineRange: SourceLineRange;
  codeExcerpt: string;
  stepOrder: number;
  functionName?: string;
  roomId?: string;
  relatedTests?: string[];
  issues?: DataFlowIssue[];
  metadata?: {
    calleeName?: string;
    argIndex?: number;
    operationType?: 'sanitize' | 'check' | 'assign' | 'write' | 'return';
  };
}

export interface DataFlowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  confidence: DataFlowConfidence;
  evidence: string; // Explains what evidence supports this relationship (Req 3)
  isTainted?: boolean; // Flags unvalidated data reaching sink
}

export interface DataFlowStats {
  totalSources: number;
  totalTransforms: number;
  totalValidations: number;
  totalSinks: number;
  unvalidatedPathsCount: number;
  observedCount: number;
  inferredCount: number;
  unresolvedCount: number;
}

export interface DataFlowGraph {
  id: string;
  title: string;
  capabilityLevel: DataFlowCapabilityLevel;
  sourcePath: string;
  functionName?: string;
  repositorySha?: string;
  nodes: DataFlowNode[];
  edges: DataFlowEdge[];
  issues: DataFlowIssue[];
  stats: DataFlowStats;
  explanation: string;
}
