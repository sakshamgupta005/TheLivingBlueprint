import type { ControlFlowGraph, CfgNode, CfgEdge } from '../cfg/types.ts';
import { buildControlFlowGraph } from '../cfg/cfgBuilder.ts';
import type {
  AlternativeBranch,
  SimulationConditionResult,
  SimulationResult,
  SimulationScenario,
  SimulationStep,
} from './types.ts';

export interface RunSimulationOptions {
  cfg?: ControlFlowGraph;
  sourcePath?: string;
  sourceCode?: string;
  functionName?: string;
  scenario?: SimulationScenario;
  relevantTests?: string[];
  maxSteps?: number;
  maxLoopIterations?: number;
}

/**
 * Generate default input scenarios derived from function parameters and known conventions.
 */
export function deriveScenarios(
  input: string | ControlFlowGraph = 'handler',
  paramNames: string[] = [],
  codeSnippet: string = ''
): SimulationScenario[] {
  const fnName = typeof input === 'string' ? input : input.functionName;
  void fnName;
  let code = codeSnippet.toLowerCase();
  const params = paramNames.map((p) => p.toLowerCase());

  if (typeof input !== 'string') {
    code = input.nodes.map((n) => n.codeExcerpt).join('\n').toLowerCase();
    for (const n of input.nodes) {
      if (n.metadata?.variableName) {
        params.push(n.metadata.variableName.toLowerCase());
      }
    }
  }
  const isReq = params.includes('req') || params.includes('request') || code.includes('req.body') || code.includes('req.params');
  const hasTitle = params.includes('title') || code.includes('title');
  const hasCount = params.includes('count') || params.includes('amount') || params.includes('id');
  void hasCount;

  const scenarios: SimulationScenario[] = [];

  if (isReq) {
    scenarios.push({
      id: 'scenario-valid',
      name: 'Valid Request Body',
      description: 'Standard payload meeting all field presence and formatting requirements.',
      category: 'valid',
      parameters: {
        req: {
          body: hasTitle ? { title: 'Complete Blueprint Task', amount: 10 } : { name: 'Item Alpha', value: 100 },
          params: { id: '101' },
          headers: { authorization: 'Bearer token_verified' },
        },
      },
      expectedOutcome: 'success',
    });

    scenarios.push({
      id: 'scenario-whitespace',
      name: 'Whitespace-Only Input (Known Bug Case)',
      description: 'Field contains only space characters; triggers validation bug if .trim() is not applied or ordered late.',
      category: 'whitespace',
      parameters: {
        req: {
          body: hasTitle ? { title: '     ', amount: 5 } : { name: '   ', value: 5 },
          params: { id: '101' },
        },
      },
      expectedOutcome: 'error',
    });

    scenarios.push({
      id: 'scenario-missing',
      name: 'Missing Required Fields',
      description: 'Empty payload missing required parameters; tests early validation guard checks.',
      category: 'missing_fields',
      parameters: {
        req: {
          body: {},
          params: {},
        },
      },
      expectedOutcome: 'error',
    });

    scenarios.push({
      id: 'scenario-boundary',
      name: 'Boundary Values (Zero / Empty)',
      description: 'Boundary test with zero amount and single-character title.',
      category: 'boundary',
      parameters: {
        req: {
          body: hasTitle ? { title: 'X', amount: 0 } : { name: 'A', value: 0 },
          params: { id: '0' },
        },
      },
      expectedOutcome: 'success',
    });
  } else {
    // Direct function parameters
    scenarios.push({
      id: 'scenario-valid',
      name: 'Valid Nominal Input',
      description: 'Standard valid arguments provided to function.',
      category: 'valid',
      parameters: hasTitle ? { title: 'Buy Groceries', count: 5 } : { x: 10, y: 20 },
      expectedOutcome: 'success',
    });

    scenarios.push({
      id: 'scenario-whitespace',
      name: 'Whitespace String Parameter',
      description: 'Tests string trimming and length assertions on whitespace.',
      category: 'whitespace',
      parameters: hasTitle ? { title: '   ', count: 0 } : { input: '   ' },
      expectedOutcome: 'error',
    });

    scenarios.push({
      id: 'scenario-boundary',
      name: 'Boundary Value Parameter',
      description: 'Boundary numbers and empty string limits.',
      category: 'boundary',
      parameters: hasTitle ? { title: '', count: 0 } : { x: 0, y: 0 },
      expectedOutcome: 'early_return',
    });

    scenarios.push({
      id: 'scenario-invalid',
      name: 'Invalid / Null Input',
      description: 'Null or missing values to verify exception paths and early returns.',
      category: 'invalid',
      parameters: hasTitle ? { title: null, count: -1 } : { x: null },
      expectedOutcome: 'error',
    });
  }

  return scenarios;
}

/**
 * Pure, bounded expression evaluator.
 * Evaluates literals, variable references, comparisons, boolean logic, and safe primitive methods.
 * Marks unsupported or external expressions as 'UNKNOWN' without executing target code.
 */
export function evaluateExpression(
  exprStr: string,
  scope: Record<string, any>
): { value: any; isUnknown: boolean; explanation: string } {
  const trimmed = exprStr.trim();
  if (!trimmed) {
    return { value: undefined, isUnknown: false, explanation: 'Empty expression' };
  }

  // 1. Literals
  if (trimmed === 'true') return { value: true, isUnknown: false, explanation: 'Literal boolean true' };
  if (trimmed === 'false') return { value: false, isUnknown: false, explanation: 'Literal boolean false' };
  if (trimmed === 'null') return { value: null, isUnknown: false, explanation: 'Literal null' };
  if (trimmed === 'undefined') return { value: undefined, isUnknown: false, explanation: 'Literal undefined' };
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { value: Number(trimmed), isUnknown: false, explanation: `Literal number ${trimmed}` };
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return { value: trimmed.slice(1, -1), isUnknown: false, explanation: `Literal string "${trimmed.slice(1, -1)}"` };
  }

  // Helper to resolve property paths: e.g. "req.body.title" or simple variable "title"
  const resolvePath = (path: string): { found: boolean; val: any } => {
    const parts = path.split('.');
    let curr = scope;
    for (const part of parts) {
      if (curr === undefined || curr === null) return { found: false, val: undefined };
      if (typeof curr === 'object' && part in curr) {
        curr = curr[part];
      } else {
        return { found: false, val: undefined };
      }
    }
    return { found: true, val: curr };
  };

  // 2. Logical OR (||)
  if (trimmed.includes(' || ')) {
    const parts = trimmed.split(' || ');
    for (const p of parts) {
      const e = evaluateExpression(p, scope);
      if (e.isUnknown) continue;
      if (e.value) {
        return { value: true, isUnknown: false, explanation: `Clause "${p}" is truthy` };
      }
    }
    return { value: false, isUnknown: false, explanation: `All || clauses are falsy` };
  }

  // 3. Logical AND (&&)
  if (trimmed.includes(' && ')) {
    const parts = trimmed.split(' && ');
    for (const p of parts) {
      const e = evaluateExpression(p, scope);
      if (e.isUnknown) return { value: 'UNKNOWN', isUnknown: true, explanation: `&& condition has unknown clause` };
      if (!e.value) {
        return { value: false, isUnknown: false, explanation: `Clause "${p}" is false` };
      }
    }
    return { value: true, isUnknown: false, explanation: `All && clauses are true` };
  }

  // 4. Binary Comparisons: ===, !==, ==, !=, >=, <=, >, <
  const operators = ['===', '!==', '==', '!=', '>=', '<=', '>', '<'];
  for (const op of operators) {
    if (trimmed.includes(` ${op} `)) {
      const [leftStr, rightStr] = trimmed.split(` ${op} `);
      const left = evaluateExpression(leftStr, scope);
      const right = evaluateExpression(rightStr, scope);

      if (left.isUnknown || right.isUnknown) {
        return {
          value: 'UNKNOWN',
          isUnknown: true,
          explanation: `Comparison "${trimmed}" contains unknown operands`,
        };
      }

      let res = false;
      if (op === '===') res = left.value === right.value;
      else if (op === '!==') res = left.value !== right.value;
      else if (op === '==') res = left.value == right.value;
      else if (op === '!=') res = left.value != right.value;
      else if (op === '>=') res = left.value >= right.value;
      else if (op === '<=') res = left.value <= right.value;
      else if (op === '>') res = left.value > right.value;
      else if (op === '<') res = left.value < right.value;

      return {
        value: res,
        isUnknown: false,
        explanation: `(${JSON.stringify(left.value)} ${op} ${JSON.stringify(right.value)}) = ${res}`,
      };
    }
  }

  // 5. Logical NOT (!expr)
  if (trimmed.startsWith('!') && !trimmed.startsWith('!=')) {
    const inner = trimmed.slice(1).trim();
    const innerEval = evaluateExpression(inner, scope);
    if (innerEval.isUnknown) {
      return { value: 'UNKNOWN', isUnknown: true, explanation: `Cannot negate unknown expression: ${inner}` };
    }
    const val = !innerEval.value;
    return {
      value: val,
      isUnknown: false,
      explanation: `!(${inner} [${JSON.stringify(innerEval.value)}]) = ${val}`,
    };
  }

  // 6. String Methods: e.g. str.trim(), str.toLowerCase(), str.length, str.trim().length
  if (trimmed.includes('.trim()') || trimmed.includes('.toLowerCase()') || trimmed.includes('.length')) {
    let target = trimmed;
    let isLength = false;
    let isTrim = false;

    if (target.endsWith('.length')) {
      isLength = true;
      target = target.slice(0, -7).trim();
    }
    if (target.endsWith('.trim()')) {
      isTrim = true;
      target = target.slice(0, -7).trim();
    }

    let baseVal: any = undefined;
    if (target.startsWith('"') && target.endsWith('"')) {
      baseVal = target.slice(1, -1);
    } else if (target.startsWith("'") && target.endsWith("'")) {
      baseVal = target.slice(1, -1);
    } else {
      const base = resolvePath(target);
      if (base.found) baseVal = base.val;
    }

    if (typeof baseVal === 'string') {
      let resultStr = baseVal;
      if (isTrim) resultStr = resultStr.trim();
      const finalVal = isLength ? resultStr.length : resultStr;
      return {
        value: finalVal,
        isUnknown: false,
        explanation: `${trimmed} evaluated on "${baseVal}" -> ${JSON.stringify(finalVal)}`,
      };
    }
  }

  // 7. Simple Variable or Property Access
  if (/^[a-zA-Z_$][a-zA-Z0-9_$.]*$/.test(trimmed)) {
    const resolved = resolvePath(trimmed);
    if (resolved.found) {
      return {
        value: resolved.val,
        isUnknown: false,
        explanation: `${trimmed} = ${JSON.stringify(resolved.val)}`,
      };
    }
    return {
      value: 'UNKNOWN',
      isUnknown: true,
      explanation: `Variable or property "${trimmed}" is not declared in current modeled scope`,
    };
  }

  // Default: Unsupported or dynamic expression
  return {
    value: 'UNKNOWN',
    isUnknown: true,
    explanation: `Expression "${trimmed}" is outside static bounded interpreter rules; treated as UNKNOWN`,
  };
}

/**
 * Execute a deterministic, bounded static simulation of a Control-Flow Graph.
 */
export function runStaticSimulation(options: RunSimulationOptions): SimulationResult {
  const maxSteps = options.maxSteps || 50;
  const maxLoopIterations = options.maxLoopIterations || 5;

  // 1. Resolve or Build Control Flow Graph
  let cfg = options.cfg;
  if (!cfg && options.sourcePath && options.sourceCode) {
    const built = buildControlFlowGraph({
      sourcePath: options.sourcePath,
      content: options.sourceCode,
      functionName: options.functionName,
    });
    if (built) cfg = built;
  }

  // Empty fallback if CFG cannot be constructed
  if (!cfg || cfg.nodes.length === 0) {
    const defaultScenario = options.scenario || {
      id: 'default',
      name: 'Default Scenario',
      description: 'No executable CFG available',
      category: 'valid',
      parameters: {},
    };

    return {
      id: 'sim-empty',
      functionName: options.functionName || 'unknown',
      sourcePath: options.sourcePath || 'unknown',
      scenario: defaultScenario,
      steps: [],
      finalVariables: {},
      isComplete: false,
      terminatedEarly: true,
      terminationReason: 'No control-flow graph nodes available for simulation',
      traceKind: 'static_code_simulation',
      stats: {
        totalSteps: 0,
        branchesEvaluated: 0,
        variablesTracked: 0,
        unknownExpressionsCount: 0,
      },
    };
  }

  // 2. Select Scenario
  const scenarios = deriveScenarios(cfg.functionName, [], options.sourceCode);
  const scenario = options.scenario || (scenarios.length > 0 ? scenarios[0] : {
    id: 'default',
    name: 'Default Parameters',
    description: 'Initial nominal inputs',
    category: 'valid',
    parameters: {},
  });

  // 3. Initialize Variable Scope Environment
  const currentScope: Record<string, any> = { ...scenario.parameters };

  // Node Map and Edge Map
  const nodeMap = new Map<string, CfgNode>();
  for (const n of cfg.nodes) nodeMap.set(n.id, n);

  const outgoingEdges = new Map<string, CfgEdge[]>();
  for (const e of cfg.edges) {
    const list = outgoingEdges.get(e.source) || [];
    list.push(e);
    outgoingEdges.set(e.source, list);
  }

  // 4. Trace Execution Steps
  const steps: SimulationStep[] = [];
  const nodeVisitCounts = new Map<string, number>();
  let currentNodeId: string | null = cfg.entryNodeId;
  let terminatedEarly = false;
  let terminationReason: string | undefined;
  let returnValue: any = undefined;
  let unknownCount = 0;
  let branchesEvaluated = 0;

  while (currentNodeId && steps.length < maxSteps) {
    const node = nodeMap.get(currentNodeId);
    if (!node) break;

    // Track node visit frequency for loop bounding
    const visits = (nodeVisitCounts.get(currentNodeId) || 0) + 1;
    nodeVisitCounts.set(currentNodeId, visits);

    if (visits > maxLoopIterations && (node.kind === 'loop_header' || node.kind === 'condition')) {
      terminatedEarly = true;
      terminationReason = `Loop bounded at ${maxLoopIterations} iterations to ensure finite static simulation.`;
      break;
    }

    const stepIndex = steps.length;
    const variableSnapshot = JSON.parse(JSON.stringify(currentScope));
    const variableUpdates: Record<string, any> = {};
    let conditionResult: SimulationConditionResult | undefined;
    const alternativeBranches: AlternativeBranch[] = [];
    let chosenBranchLabel: string | undefined;
    let nextNodeId: string | null = null;
    let explanation = (node as any).explanation || node.codeExcerpt;
    let stepHasUnknown = false;

    // A. Variable Declarations / Assignments in statements
    if (node.kind === 'statement' || node.kind === 'entry') {
      const code = node.codeExcerpt.trim();
      // Match const/let/var x = ... or destructuring const { x } = ...
      const constMatch = code.match(/^(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*([^;]+)/);
      if (constMatch) {
        const varName = constMatch[1];
        const expr = constMatch[2];
        const evalRes = evaluateExpression(expr, currentScope);
        currentScope[varName] = evalRes.value;
        variableUpdates[varName] = evalRes.value;
        if (evalRes.isUnknown) {
          stepHasUnknown = true;
          unknownCount++;
        }
        explanation = `Assigned ${varName} = ${JSON.stringify(evalRes.value)} (${evalRes.explanation})`;
      }

      // Destructuring: const { a, b } = req.body
      const destrMatch = code.match(/^(?:const|let|var)\s+\{\s*([^}]+)\s*\}\s*=\s*([^;]+)/);
      if (destrMatch) {
        const fieldNames = destrMatch[1].split(',').map((f: string) => f.trim().split(':')[0].trim());
        const sourceObjExpr = destrMatch[2].trim();
        const evalSource = evaluateExpression(sourceObjExpr, currentScope);

        if (evalSource.isUnknown === false && typeof evalSource.value === 'object' && evalSource.value !== null) {
          for (const f of fieldNames) {
            const val = evalSource.value[f];
            currentScope[f] = val;
            variableUpdates[f] = val;
          }
          explanation = `Destructured fields [${fieldNames.join(', ')}] from ${sourceObjExpr}`;
        } else {
          for (const f of fieldNames) {
            currentScope[f] = 'UNKNOWN';
            variableUpdates[f] = 'UNKNOWN';
          }
          stepHasUnknown = true;
          unknownCount++;
        }
      }
    }

    // B. Conditional Decisions (if, loops, ternary)
    const outEdges: CfgEdge[] = outgoingEdges.get(currentNodeId) || [];

    if (node.kind === 'condition' || node.kind === 'loop_header') {
      branchesEvaluated++;
      const condExpr = (node as any).conditionExpression || node.metadata?.expression || node.codeExcerpt.replace(/^(?:if|while)\s*\(/, '').replace(/\)\s*\{?$/, '').trim();
      const evalRes = evaluateExpression(condExpr, currentScope);

      if (evalRes.isUnknown) {
        stepHasUnknown = true;
        unknownCount++;
      }

      const isConditionTrue = evalRes.value === true;
      conditionResult = {
        expression: condExpr,
        result: evalRes.isUnknown ? 'UNKNOWN' : Boolean(evalRes.value),
        explanation: evalRes.explanation,
        evaluatedVariables: { ...variableSnapshot },
      };

      // Select matching edge (condition_true vs condition_false / fall-through)
      const trueEdge: CfgEdge | undefined = outEdges.find((e: CfgEdge) => e.kind === 'condition_true' || e.kind === 'loop_enter' || e.label === 'true');
      const falseEdge: CfgEdge | undefined = outEdges.find((e: CfgEdge) => e.kind === 'condition_false' || e.kind === 'loop_exit' || e.label === 'false' || (e.kind === 'normal' && e !== trueEdge));

      if (isConditionTrue && trueEdge) {
        nextNodeId = trueEdge.target;
        chosenBranchLabel = trueEdge.label || 'True Branch';
        explanation = `Branch chosen: TRUE because (${condExpr}) evaluated to true.`;

        if (falseEdge) {
          const falseTarget = nodeMap.get(falseEdge.target);
          alternativeBranches.push({
            edgeId: falseEdge.id,
            label: falseEdge.label || 'False Branch',
            targetNodeId: falseEdge.target,
            targetNodeLabel: falseTarget?.label || falseEdge.target,
            reasonNotTaken: `Condition evaluated to true; false branch skipped.`,
            codeExcerpt: falseTarget?.codeExcerpt,
            line: falseTarget?.lineRange.startLine,
          });
        }
      } else if (falseEdge) {
        nextNodeId = falseEdge.target;
        chosenBranchLabel = falseEdge.label || 'False Branch';
        explanation = `Branch chosen: FALSE because (${condExpr}) evaluated to false.`;

        if (trueEdge) {
          const trueTarget = nodeMap.get(trueEdge.target);
          alternativeBranches.push({
            edgeId: trueEdge.id,
            label: trueEdge.label || 'True Branch',
            targetNodeId: trueEdge.target,
            targetNodeLabel: trueTarget?.label || trueEdge.target,
            reasonNotTaken: `Condition evaluated to false; true branch skipped.`,
            codeExcerpt: trueTarget?.codeExcerpt,
            line: trueTarget?.lineRange.startLine,
          });
        }
      } else if (outEdges.length > 0) {
        // Fallback to first edge
        nextNodeId = outEdges[0].target;
        chosenBranchLabel = outEdges[0].label;
      }
    } else if (outEdges.length > 0) {
      // Normal sequential transition
      nextNodeId = outEdges[0].target;
      chosenBranchLabel = outEdges[0].label;
    }

    // C. Return / Exit Handling
    if (node.kind === 'return' || node.kind === 'exit') {
      const returnMatch = node.codeExcerpt.match(/return\s+(.+);?$/);
      if (returnMatch) {
        const retEval = evaluateExpression(returnMatch[1], currentScope);
        returnValue = retEval.value;
        explanation = `Function returns: ${JSON.stringify(returnValue)} (${retEval.explanation})`;
      } else {
        returnValue = 'void / default';
        explanation = 'Function execution completed cleanly.';
      }
      nextNodeId = null; // stop simulation
    }

    // D. Error / Throw Handling
    if (node.kind === 'throw') {
      explanation = `Exception thrown: ${node.codeExcerpt}`;
      nextNodeId = null; // stop simulation
    }

    // Record Step
    steps.push({
      stepIndex,
      nodeId: node.id,
      nodeLabel: node.label,
      nodeKind: node.kind,
      filePath: cfg.sourcePath,
      lineRange: node.lineRange,
      codeExcerpt: node.codeExcerpt,
      variables: variableSnapshot,
      variableUpdates: Object.keys(variableUpdates).length > 0 ? variableUpdates : undefined,
      conditionResult,
      alternativeBranches,
      chosenBranchLabel,
      returnValue,
      isError: node.kind === 'throw' || node.codeExcerpt.includes('status(400)') || node.codeExcerpt.includes('status(500)'),
      explanation,
      hasUnknownExpressions: stepHasUnknown,
    });

    currentNodeId = nextNodeId;
  }

  if (steps.length >= maxSteps && currentNodeId) {
    terminatedEarly = true;
    terminationReason = `Max step bound (${maxSteps}) reached. Static simulation halted.`;
  }

  const cfgId = (cfg as any).id || `${cfg.sourcePath}:${cfg.functionName}`;
  return {
    id: `sim-${cfgId}-${scenario.id}`,
    functionName: cfg.functionName,
    sourcePath: cfg.sourcePath,
    scenario,
    steps,
    finalVariables: JSON.parse(JSON.stringify(currentScope)),
    returnValue,
    isComplete: !terminatedEarly,
    terminatedEarly,
    terminationReason,
    traceKind: 'static_code_simulation',
    relevantTests: options.relevantTests || [],
    stats: {
      totalSteps: steps.length,
      branchesEvaluated,
      variablesTracked: Object.keys(currentScope).length,
      unknownExpressionsCount: unknownCount,
    },
  };
}
