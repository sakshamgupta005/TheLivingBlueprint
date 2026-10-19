/**
 * Domain types for deterministic Control-Flow Graph (CFG) generation from source code (T26).
 * Represents verified AST constructs: entry/exit, sequential statements, if/else, switch,
 * loops, break, continue, return, throw, and try/catch/finally.
 */

import type { SourceLineRange } from '../codeIndex/types.ts';

export type CfgNodeKind =
  | 'entry'
  | 'exit'
  | 'statement'
  | 'condition'
  | 'loop_header'
  | 'loop_exit'
  | 'switch_header'
  | 'switch_case'
  | 'case_default'
  | 'return'
  | 'throw'
  | 'try_block'
  | 'catch_block'
  | 'finally_block'
  | 'break'
  | 'continue'
  | 'unsupported';

export type CfgEdgeKind =
  | 'normal'
  | 'condition_true'
  | 'condition_false'
  | 'case_match'
  | 'case_default'
  | 'loop_enter'
  | 'loop_exit'
  | 'loop_back'
  | 'early_return'
  | 'exception'
  | 'finally_flow';

export interface CfgNode {
  id: string;
  kind: CfgNodeKind;
  label: string;
  codeExcerpt: string;
  lineRange: SourceLineRange;
  sourcePath: string;
  repositorySha?: string;
  isObserved: boolean;
  unsupportedReason?: string;
  metadata?: {
    variableName?: string;
    expression?: string;
    callees?: string[];
    loopType?: 'for' | 'while' | 'do_while' | 'for_of' | 'for_in';
  };
}

export interface CfgEdge {
  id: string;
  source: string;
  target: string;
  kind: CfgEdgeKind;
  label?: string;
  condition?: string;
  isBackEdge?: boolean;
}

export interface CfgStats {
  totalNodes: number;
  totalEdges: number;
  cyclomaticComplexity: number;
  branchCount: number;
  loopCount: number;
  returnCount: number;
  throwCount: number;
}

export interface ControlFlowGraph {
  functionName: string;
  sourcePath: string;
  repositorySha?: string;
  language: string;
  entryNodeId: string;
  exitNodeId: string;
  nodes: CfgNode[];
  edges: CfgEdge[];
  stats: CfgStats;
  hasParseErrors?: boolean;
  parseDiagnostics?: string[];
  unsupportedConstructs?: string[];
}

export interface FunctionSummary {
  name: string;
  sourcePath: string;
  lineRange: SourceLineRange;
  signature?: string;
}
