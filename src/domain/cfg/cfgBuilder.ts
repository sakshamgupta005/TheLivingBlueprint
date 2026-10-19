/**
 * Deterministic Control-Flow Graph (CFG) Generator from Source Code (T26).
 * Analyzes JavaScript/TypeScript AST to construct real, evidence-backed control-flow graphs
 * for entry/exit, sequential statements, if/else, switch, loops, break, continue, return,
 * throw, and try/catch/finally.
 */

import ts from 'typescript';
import type {
  CfgNode,
  CfgEdge,
  CfgStats,
  ControlFlowGraph,
  FunctionSummary,
  CfgNodeKind,
  CfgEdgeKind,
} from './types.ts';
import type { WorkflowDiagram, WorkflowNode, WorkflowEdge } from '../../server/types.ts';
import type { SourceLineRange } from '../codeIndex/types.ts';

function getLineAndCharacter(sourceFile: ts.SourceFile, pos: number): { line: number; character: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
  return { line: line + 1, character };
}

function getNodeLineRange(sourceFile: ts.SourceFile, node: ts.Node): SourceLineRange {
  const start = getLineAndCharacter(sourceFile, node.getStart(sourceFile));
  const end = getLineAndCharacter(sourceFile, node.getEnd());
  return {
    startLine: start.line,
    endLine: Math.max(start.line, end.line),
  };
}

function getNodeExcerpt(sourceFile: ts.SourceFile, node: ts.Node, maxLen = 80): string {
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

/**
 * Extracts all declared functions and methods from a JavaScript/TypeScript source file.
 */
export function extractFunctionsFromSource(sourcePath: string, content: string): FunctionSummary[] {
  const scriptKind = getScriptKind(sourcePath);
  const sourceFile = ts.createSourceFile(sourcePath, content, ts.ScriptTarget.Latest, true, scriptKind);
  const functions: FunctionSummary[] = [];

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      functions.push({
        name: node.name.text,
        sourcePath,
        lineRange: getNodeLineRange(sourceFile, node),
        signature: getNodeExcerpt(sourceFile, node, 60),
      });
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      functions.push({
        name: node.name.text,
        sourcePath,
        lineRange: getNodeLineRange(sourceFile, node),
        signature: getNodeExcerpt(sourceFile, node, 60),
      });
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        functions.push({
          name: node.name.text,
          sourcePath,
          lineRange: getNodeLineRange(sourceFile, node),
          signature: `${node.name.text} = ${getNodeExcerpt(sourceFile, node.initializer, 50)}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return functions;
}

export interface BuildCfgOptions {
  sourcePath: string;
  content: string;
  functionName?: string;
  targetLine?: number;
  repositorySha?: string;
}

interface TraversalContext {
  breakTarget?: string;
  continueTarget?: string;
  catchTarget?: string;
  finallyTarget?: string;
  exitNodeId: string;
}

/**
 * Builds a deterministic Control-Flow Graph for a specific function or top-level logic.
 */
export function buildControlFlowGraph(options: BuildCfgOptions): ControlFlowGraph | null {
  const { sourcePath, content, functionName, targetLine, repositorySha } = options;
  const scriptKind = getScriptKind(sourcePath);
  const sourceFile = ts.createSourceFile(sourcePath, content, ts.ScriptTarget.Latest, true, scriptKind);

  // Collect parse diagnostics
  const parseDiags = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  const parseErrors: string[] = [];
  if (Array.isArray(parseDiags) && parseDiags.length > 0) {
    for (const d of parseDiags) {
      const msg = typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText;
      parseErrors.push(`Line ${d.start !== undefined ? sourceFile.getLineAndCharacterOfPosition(d.start).line + 1 : '?'}: ${msg}`);
    }
  }

  // Find target function AST node
  type TargetFunctionNode =
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction;

  let targetNode: TargetFunctionNode | null = null;
  let resolvedFunctionName = functionName || 'anonymous';

  function findFunction(node: ts.Node): void {
    if (targetNode) return;

    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      const name = node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
      const range = getNodeLineRange(sourceFile, node);

      if (functionName && name === functionName) {
        targetNode = node;
        resolvedFunctionName = name;
        return;
      }
      if (targetLine && targetLine >= range.startLine && targetLine <= range.endLine) {
        targetNode = node;
        resolvedFunctionName = name || resolvedFunctionName;
        return;
      }
      if (!functionName && !targetLine && !targetNode) {
        targetNode = node;
        resolvedFunctionName = name || 'main';
      }
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        const name = node.name.text;
        const range = getNodeLineRange(sourceFile, node);

        if (functionName && name === functionName) {
          targetNode = node.initializer;
          resolvedFunctionName = name;
          return;
        }
        if (targetLine && targetLine >= range.startLine && targetLine <= range.endLine) {
          targetNode = node.initializer;
          resolvedFunctionName = name;
          return;
        }
        if (!functionName && !targetLine && !targetNode) {
          targetNode = node.initializer;
          resolvedFunctionName = name;
        }
      }
    }
    ts.forEachChild(node, findFunction);
  }

  findFunction(sourceFile);

  // If no function declaration found, check if top-level script statements exist
  let statementsToProcess: ts.NodeArray<ts.Statement> | ts.Statement[] = [];
  let funcHeaderRange: SourceLineRange = { startLine: 1, endLine: 1 };
  const foundNode: any = targetNode;
  if (foundNode) {
    funcHeaderRange = getNodeLineRange(sourceFile, foundNode);
    if (foundNode.body) {
      if (ts.isBlock(foundNode.body)) {
        statementsToProcess = foundNode.body.statements;
      } else {
        // Arrow function with concise body expression: `x => x + 1`
        statementsToProcess = [ts.factory.createReturnStatement(foundNode.body as ts.Expression)];
      }
    }
  } else if (sourceFile.statements.length > 0) {
    resolvedFunctionName = resolvedFunctionName !== 'anonymous' ? resolvedFunctionName : 'topLevelScript';
    statementsToProcess = sourceFile.statements;
    funcHeaderRange = {
      startLine: 1,
      endLine: Math.max(1, sourceFile.getLineAndCharacterOfPosition(sourceFile.getEnd()).line + 1),
    };
  } else {
    // Completely empty source file
    const entryId = 'cfg-entry';
    const exitId = 'cfg-exit';
    return {
      functionName: resolvedFunctionName,
      sourcePath,
      repositorySha,
      language: scriptKind === ts.ScriptKind.TS || scriptKind === ts.ScriptKind.TSX ? 'TypeScript' : 'JavaScript',
      entryNodeId: entryId,
      exitNodeId: exitId,
      nodes: [
        {
          id: entryId,
          kind: 'entry',
          label: `Entry: ${resolvedFunctionName}`,
          codeExcerpt: `function ${resolvedFunctionName}()`,
          lineRange: { startLine: 1, endLine: 1 },
          sourcePath,
          repositorySha,
          isObserved: true,
        },
        {
          id: exitId,
          kind: 'exit',
          label: `Exit: ${resolvedFunctionName}`,
          codeExcerpt: '}',
          lineRange: { startLine: 1, endLine: 1 },
          sourcePath,
          repositorySha,
          isObserved: true,
        },
      ],
      edges: [
        {
          id: 'edge-entry-exit',
          source: entryId,
          target: exitId,
          kind: 'normal',
          label: 'empty body',
        },
      ],
      stats: {
        totalNodes: 2,
        totalEdges: 1,
        cyclomaticComplexity: 1,
        branchCount: 0,
        loopCount: 0,
        returnCount: 0,
        throwCount: 0,
      },
      hasParseErrors: parseErrors.length > 0,
      parseDiagnostics: parseErrors.length > 0 ? parseErrors : undefined,
    };
  }

  // --- CFG Construction State ---
  let nodeIdCounter = 1;
  const nodes: CfgNode[] = [];
  const edges: CfgEdge[] = [];
  const unsupportedConstructs: string[] = [];

  let branchCount = 0;
  let loopCount = 0;
  let returnCount = 0;
  let throwCount = 0;

  const entryNodeId = 'cfg-entry';
  const exitNodeId = 'cfg-exit';

  nodes.push({
    id: entryNodeId,
    kind: 'entry',
    label: `Entry: ${resolvedFunctionName}`,
    codeExcerpt: getNodeExcerpt(sourceFile, targetNode || sourceFile, 70),
    lineRange: funcHeaderRange,
    sourcePath,
    repositorySha,
    isObserved: true,
  });

  nodes.push({
    id: exitNodeId,
    kind: 'exit',
    label: `Exit: ${resolvedFunctionName}`,
    codeExcerpt: '}',
    lineRange: { startLine: funcHeaderRange.endLine, endLine: funcHeaderRange.endLine },
    sourcePath,
    repositorySha,
    isObserved: true,
  });

  const baseContext: TraversalContext = {
    exitNodeId,
  };

  function addNode(
    kind: CfgNodeKind,
    label: string,
    astNode: ts.Node,
    extra?: { unsupportedReason?: string; metadata?: Record<string, unknown> }
  ): CfgNode {
    const id = `cfg-node-${nodeIdCounter++}`;
    const range = getNodeLineRange(sourceFile, astNode);
    const excerpt = getNodeExcerpt(sourceFile, astNode);
    const node: CfgNode = {
      id,
      kind,
      label,
      codeExcerpt: excerpt,
      lineRange: range,
      sourcePath,
      repositorySha,
      isObserved: true,
      unsupportedReason: extra?.unsupportedReason,
      metadata: extra?.metadata,
    };
    nodes.push(node);
    return node;
  }

  function addEdge(
    source: string,
    target: string,
    kind: CfgEdgeKind,
    label?: string,
    isBackEdge = false
  ): void {
    // Avoid duplicate edges between identical source and target with same kind
    const exists = edges.some(
      (e) => e.source === source && e.target === target && e.kind === kind && e.label === label
    );
    if (!exists) {
      edges.push({
        id: `cfg-edge-${edges.length + 1}`,
        source,
        target,
        kind,
        label,
        isBackEdge,
      });
    }
  }

  /**
   * Traverses a list of statements sequentially.
   * incomingNodes: node IDs that flow into the first statement.
   * Returns: node IDs that exit the last statement and can flow onward.
   */
  function processStatements(
    stmts: ArrayLike<ts.Statement>,
    incomingNodes: string[],
    ctx: TraversalContext
  ): string[] {
    let currentIncomings = [...incomingNodes];

    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i];
      if (currentIncomings.length === 0) {
        // Dead code or unreachable statements after return/throw/break
        break;
      }
      currentIncomings = processStatement(stmt, currentIncomings, ctx);
    }

    return currentIncomings;
  }

  /**
   * Processes a single statement and returns outgoing node IDs.
   */
  function processStatement(
    stmt: ts.Statement,
    incomingNodes: string[],
    ctx: TraversalContext
  ): string[] {
    // 1. Block Statement `{ ... }`
    if (ts.isBlock(stmt)) {
      return processStatements(stmt.statements, incomingNodes, ctx);
    }

    // 2. Return Statement `return expr;`
    if (ts.isReturnStatement(stmt)) {
      returnCount++;
      const excerpt = getNodeExcerpt(sourceFile, stmt, 50);
      const retNode = addNode('return', excerpt || 'return', stmt);
      for (const inId of incomingNodes) {
        addEdge(inId, retNode.id, 'normal');
      }
      // Edge directly to function exit
      addEdge(retNode.id, ctx.exitNodeId, 'early_return', 'return');
      return []; // Terminates current flow path
    }

    // 3. Throw Statement `throw expr;`
    if (ts.isThrowStatement(stmt)) {
      throwCount++;
      const excerpt = getNodeExcerpt(sourceFile, stmt, 50);
      const throwNode = addNode('throw', excerpt || 'throw', stmt);
      for (const inId of incomingNodes) {
        addEdge(inId, throwNode.id, 'normal');
      }
      // Route to catch if inside try, else finally, else exit
      if (ctx.catchTarget) {
        addEdge(throwNode.id, ctx.catchTarget, 'exception', 'catch error');
      } else if (ctx.finallyTarget) {
        addEdge(throwNode.id, ctx.finallyTarget, 'exception', 'finally error');
      } else {
        addEdge(throwNode.id, ctx.exitNodeId, 'exception', 'unhandled throw');
      }
      return []; // Terminates current flow path
    }

    // 4. Break Statement `break;`
    if (ts.isBreakStatement(stmt)) {
      const breakNode = addNode('break', 'break', stmt);
      for (const inId of incomingNodes) {
        addEdge(inId, breakNode.id, 'normal');
      }
      if (ctx.breakTarget) {
        addEdge(breakNode.id, ctx.breakTarget, 'normal', 'break');
      } else {
        addEdge(breakNode.id, ctx.exitNodeId, 'normal', 'break');
      }
      return [];
    }

    // 5. Continue Statement `continue;`
    if (ts.isContinueStatement(stmt)) {
      const contNode = addNode('continue', 'continue', stmt);
      for (const inId of incomingNodes) {
        addEdge(inId, contNode.id, 'normal');
      }
      if (ctx.continueTarget) {
        addEdge(contNode.id, ctx.continueTarget, 'loop_back', 'continue', true);
      }
      return [];
    }

    // 6. If Statement `if (cond) { then } else { else }`
    if (ts.isIfStatement(stmt)) {
      branchCount++;
      const condText = getNodeExcerpt(sourceFile, stmt.expression, 40);
      const condNode = addNode('condition', `if (${condText})`, stmt.expression);

      for (const inId of incomingNodes) {
        addEdge(inId, condNode.id, 'normal');
      }

      // Then branch
      const thenOuts = processBranchStatement(stmt.thenStatement, [condNode.id], ctx, 'condition_true', 'true');

      // Else branch
      if (stmt.elseStatement) {
        const elseOuts = processBranchStatement(stmt.elseStatement, [condNode.id], ctx, 'condition_false', 'false');
        return [...thenOuts, ...elseOuts];
      } else {
        // No else block: condition false flows directly to next statement
        return [...thenOuts, condNode.id];
      }
    }

    // 7. While Loop `while (cond) { body }`
    if (ts.isWhileStatement(stmt)) {
      loopCount++;
      const condText = getNodeExcerpt(sourceFile, stmt.expression, 40);
      const loopHeader = addNode('loop_header', `while (${condText})`, stmt.expression, {
        metadata: { loopType: 'while' },
      });

      for (const inId of incomingNodes) {
        addEdge(inId, loopHeader.id, 'normal');
      }

      // Create a dedicated merge/exit point for the loop to resolve breaks
      const loopExitNode = addNode('loop_exit', `Exit loop: while (${condText})`, stmt);

      // Loop body
      const loopCtx: TraversalContext = {
        ...ctx,
        breakTarget: loopExitNode.id,
        continueTarget: loopHeader.id,
      };

      const bodyOuts = processBranchStatement(stmt.statement, [loopHeader.id], loopCtx, 'loop_enter', 'true');

      // Back edge from loop body bottom to loop header
      for (const bOut of bodyOuts) {
        addEdge(bOut, loopHeader.id, 'loop_back', 'loop back', true);
      }

      // Condition false edge flows to loop exit
      addEdge(loopHeader.id, loopExitNode.id, 'loop_exit', 'false');

      return [loopExitNode.id];
    }

    // 8. Do-While Loop `do { body } while (cond);`
    if (ts.isDoStatement(stmt)) {
      loopCount++;
      const condText = getNodeExcerpt(sourceFile, stmt.expression, 40);
      const loopCond = addNode('loop_header', `while (${condText})`, stmt.expression, {
        metadata: { loopType: 'do_while' },
      });
      const loopExitNode = addNode('loop_exit', `Exit loop: do..while`, stmt);

      const loopCtx: TraversalContext = {
        ...ctx,
        breakTarget: loopExitNode.id,
        continueTarget: loopCond.id,
      };

      // In do-while, body executes before condition
      const bodyOuts = processBranchStatement(stmt.statement, incomingNodes, loopCtx, 'normal');

      // Flow from body to condition
      for (const bOut of bodyOuts) {
        addEdge(bOut, loopCond.id, 'normal');
      }

      // If condition true, loop back to body entry
      // Find the first body node or flow to body statement
      if (bodyOuts.length > 0) {
        // Back edge to first statement of loop body
        addEdge(loopCond.id, bodyOuts[0], 'loop_back', 'true (loop back)', true);
      }
      addEdge(loopCond.id, loopExitNode.id, 'loop_exit', 'false');

      return [loopExitNode.id];
    }

    // 9. For Loop `for (init; cond; incr) { body }`
    if (ts.isForStatement(stmt)) {
      loopCount++;
      let currentIn = incomingNodes;

      // Initializer statement if present
      if (stmt.initializer) {
        const initText = getNodeExcerpt(sourceFile, stmt.initializer, 40);
        const initNode = addNode('statement', initText, stmt.initializer);
        for (const inId of currentIn) {
          addEdge(inId, initNode.id, 'normal');
        }
        currentIn = [initNode.id];
      }

      // Condition check
      const condText = stmt.condition ? getNodeExcerpt(sourceFile, stmt.condition, 40) : 'true';
      const loopHeader = addNode('loop_header', `for (; ${condText};)`, stmt.condition || stmt, {
        metadata: { loopType: 'for' },
      });

      for (const inId of currentIn) {
        addEdge(inId, loopHeader.id, 'normal');
      }

      const loopExitNode = addNode('loop_exit', `Exit loop: for`, stmt);

      // Increment node if present
      let continueNodeId = loopHeader.id;
      let incrNode: CfgNode | null = null;
      if (stmt.incrementor) {
        const incrText = getNodeExcerpt(sourceFile, stmt.incrementor, 40);
        incrNode = addNode('statement', incrText, stmt.incrementor);
        continueNodeId = incrNode.id;
        addEdge(incrNode.id, loopHeader.id, 'loop_back', 'next iteration', true);
      }

      const loopCtx: TraversalContext = {
        ...ctx,
        breakTarget: loopExitNode.id,
        continueTarget: continueNodeId,
      };

      const bodyOuts = processBranchStatement(stmt.statement, [loopHeader.id], loopCtx, 'loop_enter', 'true');

      // Loop body flows into increment node (or directly back to header)
      for (const bOut of bodyOuts) {
        if (incrNode) {
          addEdge(bOut, incrNode.id, 'normal');
        } else {
          addEdge(bOut, loopHeader.id, 'loop_back', 'loop back', true);
        }
      }

      // False exit from loop header
      addEdge(loopHeader.id, loopExitNode.id, 'loop_exit', 'false');

      return [loopExitNode.id];
    }

    // 10. For-Of / For-In Loop
    if (ts.isForOfStatement(stmt) || ts.isForInStatement(stmt)) {
      loopCount++;
      const isForOf = ts.isForOfStatement(stmt);
      const exprText = getNodeExcerpt(sourceFile, stmt.expression, 40);
      const loopHeader = addNode('loop_header', `for (${isForOf ? 'of' : 'in'} ${exprText})`, stmt, {
        metadata: { loopType: isForOf ? 'for_of' : 'for_in' },
      });

      for (const inId of incomingNodes) {
        addEdge(inId, loopHeader.id, 'normal');
      }

      const loopExitNode = addNode('loop_exit', `Exit loop: for-${isForOf ? 'of' : 'in'}`, stmt);

      const loopCtx: TraversalContext = {
        ...ctx,
        breakTarget: loopExitNode.id,
        continueTarget: loopHeader.id,
      };

      const bodyOuts = processBranchStatement(stmt.statement, [loopHeader.id], loopCtx, 'loop_enter', 'next item');

      for (const bOut of bodyOuts) {
        addEdge(bOut, loopHeader.id, 'loop_back', 'loop back', true);
      }

      addEdge(loopHeader.id, loopExitNode.id, 'loop_exit', 'done');
      return [loopExitNode.id];
    }

    // 11. Switch Statement `switch (expr) { case ... }`
    if (ts.isSwitchStatement(stmt)) {
      branchCount++;
      const exprText = getNodeExcerpt(sourceFile, stmt.expression, 40);
      const switchHeader = addNode('switch_header', `switch (${exprText})`, stmt.expression);

      for (const inId of incomingNodes) {
        addEdge(inId, switchHeader.id, 'normal');
      }

      const switchExitNode = addNode('statement', `Exit switch (${exprText})`, stmt);

      const switchCtx: TraversalContext = {
        ...ctx,
        breakTarget: switchExitNode.id,
      };

      let previousCaseFallthrough: string[] = [];
      let hasDefault = false;

      for (const clause of stmt.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) {
          branchCount++;
          const caseText = getNodeExcerpt(sourceFile, clause.expression, 30);
          const caseNode = addNode('switch_case', `case ${caseText}:`, clause.expression);

          // Edge from switch header to case test
          addEdge(switchHeader.id, caseNode.id, 'case_match', `case ${caseText}`);

          // Connect fallthrough from previous case if any
          for (const ftId of previousCaseFallthrough) {
            addEdge(ftId, caseNode.id, 'normal', 'fallthrough');
          }

          // Process statements in this case clause
          const caseOuts = processStatements(clause.statements, [caseNode.id], switchCtx);
          previousCaseFallthrough = caseOuts;
        } else if (ts.isDefaultClause(clause)) {
          hasDefault = true;
          const defaultNode = addNode('case_default', 'default:', clause);

          addEdge(switchHeader.id, defaultNode.id, 'case_default', 'default');

          for (const ftId of previousCaseFallthrough) {
            addEdge(ftId, defaultNode.id, 'normal', 'fallthrough');
          }

          const defaultOuts = processStatements(clause.statements, [defaultNode.id], switchCtx);
          previousCaseFallthrough = defaultOuts;
        }
      }

      // If no default clause, switchHeader flows to exit on no-match
      if (!hasDefault) {
        addEdge(switchHeader.id, switchExitNode.id, 'normal', 'no match');
      }

      // Connect any trailing fallthrough to switch exit
      for (const ftId of previousCaseFallthrough) {
        addEdge(ftId, switchExitNode.id, 'normal');
      }

      return [switchExitNode.id];
    }

    // 12. Try-Catch-Finally Statement `try { } catch (e) { } finally { }`
    if (ts.isTryStatement(stmt)) {
      const tryNode = addNode('try_block', 'try', stmt);
      for (const inId of incomingNodes) {
        addEdge(inId, tryNode.id, 'normal');
      }

      let catchNode: CfgNode | null = null;
      let finallyNode: CfgNode | null = null;

      if (stmt.finallyBlock) {
        finallyNode = addNode('finally_block', 'finally', stmt.finallyBlock);
      }

      if (stmt.catchClause) {
        const varName = stmt.catchClause.variableDeclaration
          ? getNodeExcerpt(sourceFile, stmt.catchClause.variableDeclaration, 20)
          : 'err';
        catchNode = addNode('catch_block', `catch (${varName})`, stmt.catchClause);
      }

      // Try block execution context
      const tryCtx: TraversalContext = {
        ...ctx,
        catchTarget: catchNode?.id,
        finallyTarget: finallyNode?.id,
      };

      const tryOuts = processStatements(stmt.tryBlock.statements, [tryNode.id], tryCtx);

      // Catch block execution
      let catchOuts: string[] = [];
      if (stmt.catchClause && catchNode) {
        const catchCtx: TraversalContext = {
          ...ctx,
          finallyTarget: finallyNode?.id,
        };
        catchOuts = processStatements(stmt.catchClause.block.statements, [catchNode.id], catchCtx);
      }

      // Combine flow to finally block or merge
      const flowToNext = [...tryOuts, ...catchOuts];

      if (finallyNode && stmt.finallyBlock) {
        for (const outId of flowToNext) {
          addEdge(outId, finallyNode.id, 'finally_flow');
        }
        const finallyOuts = processStatements(stmt.finallyBlock.statements, [finallyNode.id], ctx);
        return finallyOuts;
      }

      return flowToNext;
    }

    // 13. Unsupported Syntax Constructs (e.g. WithStatement, DebuggerStatement)
    if (stmt.kind === ts.SyntaxKind.WithStatement) {
      unsupportedConstructs.push('WithStatement (deprecated dynamic scope)');
      const unsuppNode = addNode('unsupported', 'with (...) [dynamic scope unsupported]', stmt, {
        unsupportedReason: 'Dynamic scope cannot be statically resolved into deterministic control flow',
      });
      for (const inId of incomingNodes) {
        addEdge(inId, unsuppNode.id, 'normal');
      }
      return [unsuppNode.id];
    }

    // 14. Standard Sequential Statements (VariableStatement, ExpressionStatement, etc.)
    const stmtExcerpt = getNodeExcerpt(sourceFile, stmt, 60);
    const label = stmtExcerpt || ts.SyntaxKind[stmt.kind];
    const stmtNode = addNode('statement', label, stmt);

    for (const inId of incomingNodes) {
      addEdge(inId, stmtNode.id, 'normal');
    }

    return [stmtNode.id];
  }

  /**
   * Helper to process a branch body (can be a block or single statement)
   */
  function processBranchStatement(
    body: ts.Statement,
    incomings: string[],
    ctx: TraversalContext,
    edgeKind: CfgEdgeKind = 'normal',
    edgeLabel?: string
  ): string[] {
    if (ts.isBlock(body)) {
      if (body.statements.length === 0) {
        // Empty block
        return incomings;
      }
      // Process first statement with branch edge label
      const firstStmt = body.statements[0];
      const remaining = body.statements.slice(1);

      // Create intermediate container or hook first statement
      const firstOuts = processStatementWithLabel(firstStmt, incomings, ctx, edgeKind, edgeLabel);
      return processStatements(remaining, firstOuts, ctx);
    } else {
      return processStatementWithLabel(body, incomings, ctx, edgeKind, edgeLabel);
    }
  }

  function processStatementWithLabel(
    stmt: ts.Statement,
    incomings: string[],
    ctx: TraversalContext,
    edgeKind: CfgEdgeKind,
    edgeLabel?: string
  ): string[] {
    // If incoming edge has label, we add it explicitly on the first node created
    const initialEdgesCount = edges.length;
    const outs = processStatement(stmt, incomings, ctx);

    // Patch the first newly created edge from incomings with kind/label
    for (let i = initialEdgesCount; i < edges.length; i++) {
      const edge = edges[i];
      if (incomings.includes(edge.source)) {
        edge.kind = edgeKind;
        if (edgeLabel) {
          edge.label = edgeLabel;
        }
      }
    }

    return outs;
  }

  // --- Process Function Body Statements ---
  const terminalOutgoings = processStatements(statementsToProcess, [entryNodeId], baseContext);

  // Connect any normal fall-through paths to function exit
  for (const termId of terminalOutgoings) {
    addEdge(termId, exitNodeId, 'normal', 'exit');
  }

  // Calculate Cyclomatic Complexity: M = E - N + 2P
  const totalNodes = nodes.length;
  const totalEdges = edges.length;
  // Cyclomatic complexity using standard formula E - N + 2
  const cyclomaticComplexity = Math.max(1, totalEdges - totalNodes + 2);

  const stats: CfgStats = {
    totalNodes,
    totalEdges,
    cyclomaticComplexity,
    branchCount,
    loopCount,
    returnCount,
    throwCount,
  };

  return {
    functionName: resolvedFunctionName,
    sourcePath,
    repositorySha,
    language: scriptKind === ts.ScriptKind.TS || scriptKind === ts.ScriptKind.TSX ? 'TypeScript' : 'JavaScript',
    entryNodeId,
    exitNodeId,
    nodes,
    edges,
    stats,
    hasParseErrors: parseErrors.length > 0,
    parseDiagnostics: parseErrors.length > 0 ? parseErrors : undefined,
    unsupportedConstructs: unsupportedConstructs.length > 0 ? unsupportedConstructs : undefined,
  };
}

/**
 * Converts a deterministic ControlFlowGraph into a WorkflowDiagram so it can power
 * the existing simulation engine, flowchart view, and room inspector.
 */
export function cfgToWorkflowDiagram(cfg: ControlFlowGraph): WorkflowDiagram {
  const workflowNodes: WorkflowNode[] = cfg.nodes.map((n) => {
    let nodeType: WorkflowNode['nodeType'] = 'component';
    if (n.kind === 'condition' || n.kind === 'loop_header' || n.kind === 'switch_header') {
      nodeType = 'decision';
    } else if (n.kind === 'entry' || n.kind === 'exit') {
      nodeType = 'external';
    }

    return {
      id: n.id,
      label: n.label,
      role: n.kind.toUpperCase(),
      nodeType,
      classification: 'observed' as const,
      description: n.unsupportedReason
        ? `[Unsupported] ${n.unsupportedReason}`
        : `${n.kind.toUpperCase()}: ${n.codeExcerpt}`,
      sourceFile: cfg.sourcePath,
      lineRange: n.lineRange,
      codeSnippet: {
        code: n.codeExcerpt,
        line: n.lineRange.startLine,
        explanation: n.unsupportedReason,
      },
    };
  });

  const workflowEdges: WorkflowEdge[] = cfg.edges.map((e) => ({
    from: e.source,
    to: e.target,
    label: e.label || (e.isBackEdge ? 'loop back' : undefined),
    branchLabel: e.label,
    classification: 'observed' as const,
  }));

  return {
    title: `Control Flow: ${cfg.functionName}()`,
    explanation: `Deterministic AST control-flow graph extracted from ${cfg.sourcePath} (${cfg.stats.totalNodes} nodes, ${cfg.stats.totalEdges} edges, complexity ${cfg.stats.cyclomaticComplexity}).`,
    nodes: workflowNodes,
    edges: workflowEdges,
    simulationType: 'code-derived workflow walkthrough',
    uncertainties:
      'Static control flow does not simulate live runtime execution or dynamic argument values. External imported callbacks and dynamic evaluation paths are not followed across runtime boundaries.',
  };
}
