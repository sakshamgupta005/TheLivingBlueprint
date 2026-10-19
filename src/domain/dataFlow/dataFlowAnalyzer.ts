/**
 * Static Data-Flow and Value-Lineage Analyzer (T27).
 * Deterministically constructs value-lineage graphs from source code AST and symbol index.
 * Tracks parameter/input origin -> validation -> normalization -> storage/response sinks,
 * highlighting unvalidated paths, late normalizations, and evidence-backed edges.
 */

import ts from 'typescript';
import type {
  DataFlowGraph,
  DataFlowNode,
  DataFlowEdge,
  DataFlowIssue,
  DataFlowStats,
  DataFlowNodeKind,
  DataFlowConfidence,
  DataFlowCapabilityLevel,
} from './types.ts';
import type { CodeIndex } from '../codeIndex/types.ts';
import type { ArchitecturalRoom } from '../../types.ts';

function getLine(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function getNodeExcerpt(sourceFile: ts.SourceFile, node: ts.Node, maxLen = 70): string {
  const text = node.getText(sourceFile).trim().replace(/\s+/g, ' ');
  return text.length > maxLen ? `${text.slice(0, maxLen - 3)}...` : text;
}

function getScriptKind(filePath: string): ts.ScriptKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

export interface AnalyzeDataFlowOptions {
  sourcePath: string;
  content: string;
  functionName?: string;
  targetLine?: number;
  codeIndex?: CodeIndex;
  repositorySha?: string;
  rooms?: ArchitecturalRoom[];
  knownTests?: string[];
}

/**
 * Extracts identifiers referenced inside an AST expression.
 */
function extractIdentifiers(node: ts.Node): string[] {
  const ids = new Set<string>();
  function visit(n: ts.Node) {
    if (ts.isIdentifier(n)) {
      ids.add(n.text);
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return Array.from(ids);
}

/**
 * Deterministically analyzes static data-flow and value lineage for source code.
 */
export function analyzeDataFlow(options: AnalyzeDataFlowOptions): DataFlowGraph {
  const {
    sourcePath,
    content,
    functionName,
    targetLine,
    codeIndex,
    repositorySha,
    rooms = [],
    knownTests = [],
  } = options;

  const lowerPath = sourcePath.toLowerCase();
  const isJsTs = /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(lowerPath);
  const isPython = lowerPath.endsWith('.py');

  // Determine capability level honestly (Req 4, Req 7)
  let capabilityLevel: DataFlowCapabilityLevel = 'unsupported';
  if (isJsTs) {
    capabilityLevel = 'full_ast';
  } else if (isPython) {
    capabilityLevel = 'pattern_ast';
  } else if (/\.(json|yaml|yml|md|txt)$/.test(lowerPath)) {
    capabilityLevel = 'shallow';
  }

  // Find associated room if available
  const associatedRoom = rooms.find((r) =>
    (r.filePaths || []).some((fp) => fp.toLowerCase() === lowerPath)
  );
  const roomId = associatedRoom?.id;

  // Find associated tests touching this file
  const baseName = sourcePath.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
  const relatedTests = knownTests.filter((t) =>
    t.toLowerCase().includes(baseName.toLowerCase()) ||
    t.toLowerCase().includes('test') ||
    t.toLowerCase().includes('spec')
  ).slice(0, 5);

  // If unsupported or shallow, return honest fallback representation
  if (capabilityLevel === 'unsupported' || capabilityLevel === 'shallow' || !content.trim()) {
    return {
      id: `dfg-${baseName || 'unsupported'}`,
      title: `Data Flow: ${baseName || 'Unsupported'}`,
      capabilityLevel,
      sourcePath,
      repositorySha,
      nodes: [],
      edges: [],
      issues: [],
      stats: {
        totalSources: 0,
        totalTransforms: 0,
        totalValidations: 0,
        totalSinks: 0,
        unvalidatedPathsCount: 0,
        observedCount: 0,
        inferredCount: 0,
        unresolvedCount: 0,
      },
      explanation: `Static data-flow lineage requires AST parsing. Capability level for '${sourcePath}' is '${capabilityLevel}'.`,
    };
  }

  // --- Python Pattern-AST Mode ---
  if (capabilityLevel === 'pattern_ast') {
    return analyzePythonDataFlow(options, capabilityLevel, roomId, relatedTests);
  }

  // --- JavaScript / TypeScript Full-AST Mode ---
  const scriptKind = getScriptKind(sourcePath);
  const sourceFile = ts.createSourceFile(sourcePath, content, ts.ScriptTarget.Latest, true, scriptKind);

  // Locate target function or process top-level statements
  let targetFuncNode: ts.Node | null = null;
  let resolvedFuncName = functionName;

  function findTarget(node: ts.Node): void {
    if (targetFuncNode) return;
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      const name = node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
      const startLine = getLine(sourceFile, node.getStart(sourceFile));
      const endLine = getLine(sourceFile, node.getEnd());

      if (functionName && name === functionName) {
        targetFuncNode = node;
        resolvedFuncName = name;
        return;
      }
      if (targetLine && targetLine >= startLine && targetLine <= endLine) {
        targetFuncNode = node;
        resolvedFuncName = name || resolvedFuncName;
        return;
      }
      if (!functionName && !targetLine && !targetFuncNode) {
        targetFuncNode = node;
        resolvedFuncName = name || 'main';
      }
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        const name = node.name.text;
        const startLine = getLine(sourceFile, node.getStart(sourceFile));
        const endLine = getLine(sourceFile, node.getEnd());

        if (functionName && name === functionName) {
          targetFuncNode = node.initializer;
          resolvedFuncName = name;
          return;
        }
        if (targetLine && targetLine >= startLine && targetLine <= endLine) {
          targetFuncNode = node.initializer;
          resolvedFuncName = name || resolvedFuncName;
          return;
        }
        if (!functionName && !targetLine && !targetFuncNode) {
          targetFuncNode = node.initializer;
          resolvedFuncName = name;
        }
      }
    }
    ts.forEachChild(node, findTarget);
  }

  findTarget(sourceFile);

  const nodes: DataFlowNode[] = [];
  const edges: DataFlowEdge[] = [];
  const issues: DataFlowIssue[] = [];

  let nodeIdCounter = 1;
  let edgeIdCounter = 1;
  let stepCounter = 1;

  // Active lineage map: variable name -> node id representing its current value
  const variableLineage = new Map<string, string>();
  // Variables that have passed a validation check
  const validatedVariables = new Set<string>();
  // Line of last validation check for a variable
  const validationLines = new Map<string, number>();

  function createNode(
    variableName: string,
    label: string,
    kind: DataFlowNodeKind,
    confidence: DataFlowConfidence,
    astNode: ts.Node,
    extra?: Partial<DataFlowNode>
  ): DataFlowNode {
    const id = `df-node-${nodeIdCounter++}`;
    const startLine = getLine(sourceFile, astNode.getStart(sourceFile));
    const endLine = getLine(sourceFile, astNode.getEnd());
    const excerpt = getNodeExcerpt(sourceFile, astNode);

    const node: DataFlowNode = {
      id,
      label,
      variableName,
      kind,
      confidence,
      sourcePath,
      lineRange: { startLine, endLine: Math.max(startLine, endLine) },
      codeExcerpt: excerpt,
      stepOrder: stepCounter++,
      functionName: resolvedFuncName,
      roomId,
      relatedTests: relatedTests.length > 0 ? relatedTests : undefined,
      ...extra,
    };

    nodes.push(node);
    variableLineage.set(variableName, id);
    return node;
  }

  function createEdge(
    sourceId: string,
    targetId: string,
    label: string,
    confidence: DataFlowConfidence,
    evidence: string,
    isTainted = false
  ): void {
    edges.push({
      id: `df-edge-${edgeIdCounter++}`,
      source: sourceId,
      target: targetId,
      label,
      confidence,
      evidence,
      isTainted,
    });
  }

  // 1. Extract Function Parameters as Sources
  const anyTarget = targetFuncNode as any;
  if (anyTarget && Array.isArray(anyTarget.parameters)) {
    for (const param of anyTarget.parameters) {
      if (ts.isIdentifier(param.name)) {
        const paramName = param.name.text;
        createNode(
          paramName,
          `Input Param: ${paramName}`,
          'source',
          'directly_observed',
          param,
          {
            metadata: { operationType: 'assign' },
          }
        );
      } else if (ts.isObjectBindingPattern(param.name)) {
        // Destructured parameters: function({ title, priority })
        for (const elem of param.name.elements) {
          if (ts.isIdentifier(elem.name)) {
            const paramName = elem.name.text;
            createNode(
              paramName,
              `Input Prop: ${paramName}`,
              'source',
              'directly_observed',
              elem,
              {
                metadata: { operationType: 'assign' },
              }
            );
          }
        }
      }
    }
  }

  // Statements to analyze (function body or file statements)
  let statements: ArrayLike<ts.Statement> = [];
  if (anyTarget && anyTarget.body) {
    if (ts.isBlock(anyTarget.body)) {
      statements = anyTarget.body.statements;
    } else {
      // Expression body arrow function
      statements = [ts.factory.createReturnStatement(anyTarget.body as ts.Expression)];
    }
  } else {
    statements = sourceFile.statements;
  }

  // 2. Sequential AST Statement Analysis
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];

    // Case A: Variable Declarations
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const newVarName = decl.name.text;
        const line = getLine(sourceFile, decl.getStart(sourceFile));

        if (!decl.initializer) {
          // Uninitialized variable
          continue;
        }

        const rhsText = getNodeExcerpt(sourceFile, decl.initializer, 40);
        const referencedVars = extractIdentifiers(decl.initializer).filter((v) =>
          variableLineage.has(v)
        );

        // Detect normalization (e.g. .trim(), .toLowerCase(), .replace())
        const isNormalization =
          ts.isCallExpression(decl.initializer) &&
          ts.isPropertyAccessExpression(decl.initializer.expression) &&
          /trim|lowercase|uppercase|replace|normalize|sanitize|slice|substring/i.test(
            decl.initializer.expression.name.text
          );

        // Detect validation call (e.g. isValid(), validateUser())
        const isValidationCall =
          ts.isCallExpression(decl.initializer) &&
          /validate|check|verify|isValid|is_valid|schema/i.test(
            decl.initializer.expression.getText(sourceFile)
          );

        if (isValidationCall) {
          const valNode = createNode(
            newVarName,
            `Validate: ${rhsText}`,
            'validation',
            'directly_observed',
            decl,
            { metadata: { operationType: 'check' } }
          );

          for (const rv of referencedVars) {
            const prevId = variableLineage.get(rv);
            if (prevId) {
              createEdge(
                prevId,
                valNode.id,
                `checks ${rv}`,
                'directly_observed',
                `Line ${line}: Passed into validation expression '${rhsText}'`
              );
            }
            validatedVariables.add(rv);
            validationLines.set(rv, line);
          }
          validatedVariables.add(newVarName);
          validationLines.set(newVarName, line);
        } else if (isNormalization) {
          const normNode = createNode(
            newVarName,
            `Normalize: ${rhsText}`,
            'transform',
            'directly_observed',
            decl,
            { metadata: { operationType: 'sanitize' } }
          );

          for (const rv of referencedVars) {
            const prevId = variableLineage.get(rv);
            if (prevId) {
              createEdge(
                prevId,
                normNode.id,
                `normalizes ${rv}`,
                'directly_observed',
                `Line ${line}: Derived from '${rv}' via normalization '${rhsText}'`
              );
            }

            // Check Requirement 5: Highlight normalization occurring AFTER a check
            const checkLine = validationLines.get(rv);
            if (checkLine !== undefined && line > checkLine) {
              issues.push({
                type: 'late_normalization',
                severity: 'warning',
                message: `Late Normalization: '${rv}' was normalized on line ${line} after being checked on line ${checkLine}.`,
                variableName: rv,
                sourceLine: checkLine,
                sinkLine: line,
                evidence: `Source proves condition check on line ${checkLine} precedes normalization on line ${line}`,
              });
            }
          }
        } else {
          // Standard transformation / assignment
          const transNode = createNode(
            newVarName,
            `const ${newVarName} = ${rhsText}`,
            'transform',
            'directly_observed',
            decl,
            { metadata: { operationType: 'assign' } }
          );

          for (const rv of referencedVars) {
            const prevId = variableLineage.get(rv);
            if (prevId) {
              createEdge(
                prevId,
                transNode.id,
                `assigned to ${newVarName}`,
                'directly_observed',
                `Line ${line}: Assigned into '${newVarName}' via '${rhsText}'`
              );
            }
          }
        }
      }
    }

    // Case B: Conditional Validation Check `if (condition)`
    else if (ts.isIfStatement(stmt)) {
      const line = getLine(sourceFile, stmt.expression.getStart(sourceFile));
      const condText = getNodeExcerpt(sourceFile, stmt.expression, 50);
      const conditionVars = extractIdentifiers(stmt.expression).filter((v) =>
        variableLineage.has(v)
      );

      if (conditionVars.length > 0) {
        const valNode = createNode(
          conditionVars[0],
          `Check: if (${condText})`,
          'validation',
          'directly_observed',
          stmt.expression,
          { metadata: { operationType: 'check' } }
        );

        for (const cv of conditionVars) {
          const prevId = variableLineage.get(cv);
          if (prevId) {
            createEdge(
              prevId,
              valNode.id,
              `validated by if`,
              'directly_observed',
              `Line ${line}: Evaluated by guard condition 'if (${condText})'`
            );
          }
          validatedVariables.add(cv);
          validationLines.set(cv, line);
        }
      }
    }

    // Case C: Expression Statements / Function Calls (Storage writes, dispatches)
    else if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
      const call = stmt.expression;
      const line = getLine(sourceFile, call.getStart(sourceFile));
      const calleeText = call.expression.getText(sourceFile);
      const argsText = call.arguments.map((a) => getNodeExcerpt(sourceFile, a, 25)).join(', ');
      const referencedVars = extractIdentifiers(call).filter((v) => variableLineage.has(v));

      const isStorageWrite = /save|insert|update|store|write|persist|db\./i.test(calleeText);
      const isResponseDispatch = /send|json|render|respond|emit|dispatch/i.test(calleeText);
      const isValidationCall = /validate|check|assert|verify|sanitize/i.test(calleeText);

      if (isStorageWrite || isResponseDispatch) {
        const sinkNode = createNode(
          calleeText,
          `${isStorageWrite ? 'Storage Write' : 'Response Send'}: ${calleeText}(${argsText})`,
          'sink',
          'directly_observed',
          call,
          { metadata: { operationType: 'write', calleeName: calleeText } }
        );

        for (const rv of referencedVars) {
          const prevId = variableLineage.get(rv);
          const isTainted = !validatedVariables.has(rv);

          if (prevId) {
            createEdge(
              prevId,
              sinkNode.id,
              `passed to ${calleeText}()`,
              'directly_observed',
              `Line ${line}: Value passed as payload argument into sink '${calleeText}'`,
              isTainted
            );
          }

          // Check Requirement 5: Highlight unvalidated input paths reaching sinks
          if (isTainted) {
            issues.push({
              type: 'unvalidated_input',
              severity: 'warning',
              message: `Unvalidated Input Path: Parameter or value '${rv}' reaches sink '${calleeText}' without verified guard or validation check.`,
              variableName: rv,
              sourceLine: line,
              evidence: `Line ${line}: Value '${rv}' directly supplied to sink '${calleeText}' without preceding validation`,
            });
          }
        }
      } else if (isValidationCall) {
        const valNode = createNode(
          calleeText,
          `Validate Call: ${calleeText}(${argsText})`,
          'validation',
          'directly_observed',
          call,
          { metadata: { operationType: 'check', calleeName: calleeText } }
        );

        for (const rv of referencedVars) {
          const prevId = variableLineage.get(rv);
          if (prevId) {
            createEdge(
              prevId,
              valNode.id,
              `validated by ${calleeText}()`,
              'directly_observed',
              `Line ${line}: Value passed into validator '${calleeText}()'`
            );
          }
          validatedVariables.add(rv);
          validationLines.set(rv, line);
        }
      } else {
        // Inter-procedural data passing (Req 2, Req 4)
        // Check if callee is known in codeIndex
        const isResolvedInIndex = codeIndex?.symbols.some((s) => s.name === calleeText);
        const confidence: DataFlowConfidence = isResolvedInIndex ? 'inferred' : 'unresolved';

        const callNode = createNode(
          calleeText,
          `Call: ${calleeText}(${argsText})`,
          'call_arg',
          confidence,
          call,
          { metadata: { calleeName: calleeText } }
        );

        for (const rv of referencedVars) {
          const prevId = variableLineage.get(rv);
          if (prevId) {
            createEdge(
              prevId,
              callNode.id,
              `passed to ${calleeText}()`,
              confidence,
              isResolvedInIndex
                ? `Line ${line}: Syntactic argument passing resolved to indexed function '${calleeText}'`
                : `Line ${line}: Passed to unresolved or external function '${calleeText}'`
            );
          }
        }
      }
    }

    // Case D: Return Statement `return expr;`
    else if (ts.isReturnStatement(stmt)) {
      const line = getLine(sourceFile, stmt.getStart(sourceFile));
      const exprText = stmt.expression ? getNodeExcerpt(sourceFile, stmt.expression, 40) : 'void';
      const referencedVars = stmt.expression
        ? extractIdentifiers(stmt.expression).filter((v) => variableLineage.has(v))
        : [];

      const sinkNode = createNode(
        'return',
        `Return: ${exprText}`,
        'sink',
        'directly_observed',
        stmt,
        { metadata: { operationType: 'return' } }
      );

      for (const rv of referencedVars) {
        const prevId = variableLineage.get(rv);
        const isTainted = !validatedVariables.has(rv);

        if (prevId) {
          createEdge(
            prevId,
            sinkNode.id,
            `returned as output`,
            'directly_observed',
            `Line ${line}: Value '${rv}' returned as function output`,
            isTainted
          );
        }
      }
    }
  }

  // Calculate Data-Flow Stats
  let totalSources = 0;
  let totalTransforms = 0;
  let totalValidations = 0;
  let totalSinks = 0;
  let observedCount = 0;
  let inferredCount = 0;
  let unresolvedCount = 0;

  for (const node of nodes) {
    if (node.kind === 'source') totalSources++;
    else if (node.kind === 'transform') totalTransforms++;
    else if (node.kind === 'validation') totalValidations++;
    else if (node.kind === 'sink') totalSinks++;

    if (node.confidence === 'directly_observed') observedCount++;
    else if (node.confidence === 'inferred') inferredCount++;
    else if (node.confidence === 'unresolved') unresolvedCount++;
  }

  const stats: DataFlowStats = {
    totalSources,
    totalTransforms,
    totalValidations,
    totalSinks,
    unvalidatedPathsCount: issues.filter((i) => i.type === 'unvalidated_input').length,
    observedCount,
    inferredCount,
    unresolvedCount,
  };

  return {
    id: `dfg-${resolvedFuncName || baseName}`,
    title: `Data Flow: ${resolvedFuncName ? `${resolvedFuncName}()` : baseName}`,
    capabilityLevel,
    sourcePath,
    functionName: resolvedFuncName,
    repositorySha,
    nodes,
    edges,
    issues,
    stats,
    explanation: `Static value-lineage analysis for ${resolvedFuncName ? `${resolvedFuncName}()` : baseName} (${totalSources} sources, ${totalValidations} validations, ${totalSinks} sinks, ${stats.unvalidatedPathsCount} unvalidated paths).`,
  };
}

/**
 * Fallback pattern-based data-flow extractor for Python files (Req 7).
 */
function analyzePythonDataFlow(
  options: AnalyzeDataFlowOptions,
  capabilityLevel: DataFlowCapabilityLevel,
  roomId?: string,
  relatedTests?: string[]
): DataFlowGraph {
  const { sourcePath, content, functionName, repositorySha } = options;
  const lines = content.split('\n');
  const nodes: DataFlowNode[] = [];
  const edges: DataFlowEdge[] = [];
  const issues: DataFlowIssue[] = [];

  let nodeId = 1;
  let step = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Detect def func(a, b):
    const funcMatch = line.match(/^\s*def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\):/);
    if (funcMatch) {
      const fName = funcMatch[1];
      if (functionName && fName !== functionName) continue;

      const params = funcMatch[2].split(',').map((p) => p.trim().split(':')[0].trim()).filter(Boolean);
      for (const param of params) {
        if (param === 'self' || param === 'cls') continue;
        nodes.push({
          id: `df-py-${nodeId++}`,
          label: `Input Param: ${param}`,
          variableName: param,
          kind: 'source',
          confidence: 'directly_observed',
          sourcePath,
          lineRange: { startLine: lineNum, endLine: lineNum },
          codeExcerpt: line.trim(),
          stepOrder: step++,
          functionName: fName,
          roomId,
          relatedTests,
        });
      }
    }

    // Detect if checks
    const ifMatch = line.match(/^\s*if\s+(.+):/);
    if (ifMatch && nodes.length > 0) {
      const cond = ifMatch[1].trim();
      const checkNode: DataFlowNode = {
        id: `df-py-${nodeId++}`,
        label: `Check: if ${cond}`,
        variableName: 'condition',
        kind: 'validation',
        confidence: 'directly_observed',
        sourcePath,
        lineRange: { startLine: lineNum, endLine: lineNum },
        codeExcerpt: line.trim(),
        stepOrder: step++,
        roomId,
      };
      nodes.push(checkNode);
      edges.push({
        id: `df-py-edge-${nodeId++}`,
        source: nodes[0].id,
        target: checkNode.id,
        label: 'validated by if',
        confidence: 'directly_observed',
        evidence: `Line ${lineNum}: Evaluated by Python condition 'if ${cond}'`,
      });
    }

    // Detect return
    const retMatch = line.match(/^\s*return\s+(.+)/);
    if (retMatch && nodes.length > 0) {
      const retExpr = retMatch[1].trim();
      const retNode: DataFlowNode = {
        id: `df-py-${nodeId++}`,
        label: `Return: ${retExpr}`,
        variableName: 'return',
        kind: 'sink',
        confidence: 'directly_observed',
        sourcePath,
        lineRange: { startLine: lineNum, endLine: lineNum },
        codeExcerpt: line.trim(),
        stepOrder: step++,
        roomId,
      };
      nodes.push(retNode);
      edges.push({
        id: `df-py-edge-${nodeId++}`,
        source: nodes[nodes.length - 2].id,
        target: retNode.id,
        label: 'returned',
        confidence: 'directly_observed',
        evidence: `Line ${lineNum}: Value returned in Python statement '${line.trim()}'`,
      });
    }
  }

  const stats: DataFlowStats = {
    totalSources: nodes.filter((n) => n.kind === 'source').length,
    totalTransforms: nodes.filter((n) => n.kind === 'transform').length,
    totalValidations: nodes.filter((n) => n.kind === 'validation').length,
    totalSinks: nodes.filter((n) => n.kind === 'sink').length,
    unvalidatedPathsCount: 0,
    observedCount: nodes.length,
    inferredCount: 0,
    unresolvedCount: 0,
  };

  return {
    id: `dfg-py-${functionName || 'script'}`,
    title: `Data Flow: ${functionName || 'Python Script'}`,
    capabilityLevel,
    sourcePath,
    functionName,
    repositorySha,
    nodes,
    edges,
    issues,
    stats,
    explanation: `Pattern-based Python value-lineage analysis for ${functionName || 'module'} (${nodes.length} nodes).`,
  };
}
