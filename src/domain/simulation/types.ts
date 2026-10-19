/**
 * Types for the Real Static Simulation Workbench (T29).
 * Defines deterministic bounded interpreter types, simulation steps,
 * variable environments, branch decisions, and input scenarios.
 */

export interface SimulationVariable {
  name: string;
  value: any;
  type: 'string' | 'number' | 'boolean' | 'null' | 'undefined' | 'object' | 'array' | 'unknown';
  isUnknown: boolean;
  sourceExpression?: string;
}

export type SimulationScope = Record<string, SimulationVariable>;

export interface SimulationConditionResult {
  expression: string;
  result: boolean | 'UNKNOWN';
  explanation: string;
  evaluatedVariables: Record<string, any>;
}

export interface AlternativeBranch {
  edgeId: string;
  label: string;
  targetNodeId: string;
  targetNodeLabel: string;
  reasonNotTaken: string;
  codeExcerpt?: string;
  line?: number;
}

export interface SimulationStep {
  stepIndex: number; // 0-based
  nodeId: string;
  nodeLabel: string;
  nodeKind: string;
  filePath?: string;
  lineRange: { startLine: number; endLine: number };
  codeExcerpt: string;
  variables: Record<string, any>;
  variableUpdates?: Record<string, any>;
  conditionResult?: SimulationConditionResult;
  alternativeBranches: AlternativeBranch[];
  chosenBranchLabel?: string;
  returnValue?: any;
  isError?: boolean;
  explanation: string;
  hasUnknownExpressions?: boolean;
}

export type ScenarioCategory = 'valid' | 'invalid' | 'boundary' | 'whitespace' | 'missing_fields' | 'custom';

export interface SimulationScenario {
  id: string;
  name: string;
  description: string;
  category: ScenarioCategory;
  parameters: Record<string, any>;
  expectedOutcome?: 'success' | 'error' | 'early_return';
}

export interface SimulationResult {
  id: string;
  functionName: string;
  sourcePath: string;
  scenario: SimulationScenario;
  steps: SimulationStep[];
  finalVariables: Record<string, any>;
  returnValue?: any;
  isComplete: boolean;
  terminatedEarly: boolean;
  terminationReason?: string;
  /**
   * Requirement 7: Explicitly labeled static code simulation, not live execution.
   */
  traceKind: 'static_code_simulation';
  relevantTests?: string[];
  stats: {
    totalSteps: number;
    branchesEvaluated: number;
    variablesTracked: number;
    unknownExpressionsCount: number;
  };
}
