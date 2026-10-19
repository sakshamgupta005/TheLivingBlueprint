import ts from 'typescript';
import type { CodeIndex } from '../codeIndex/types.ts';
import type {
  JourneyEntryPoint,
  JourneyParticipant,
  JourneyParticipantKind,
  JourneyStep,
  RequestJourney,
} from './types.ts';
import type { ArchitecturalRoom } from '../../types.ts';

/**
 * Detect all recognizable entry points in the inspected code.
 * Supports Express, Fastify, Next.js API handlers, FastAPI, and Flask routes.
 */
export function detectEntryPoints(codeIndex?: CodeIndex): JourneyEntryPoint[] {
  const entryPoints: JourneyEntryPoint[] = [];
  const seenIds = new Set<string>();

  if (!codeIndex) return entryPoints;

  // 1. Routes registered in codeIndex
  if (Array.isArray(codeIndex.routes) && codeIndex.routes.length > 0) {
    for (const r of codeIndex.routes) {
      if (!seenIds.has(r.id)) {
        seenIds.add(r.id);
        entryPoints.push({
          id: r.id,
          method: r.method,
          routePath: r.routePath,
          framework: r.framework,
          sourcePath: r.sourcePath,
          lineRange: r.lineRange,
          handlerSymbol: r.handlerSymbol,
          evidence: r.evidence,
        });
      }
    }
  }

  // 2. Look for exported Next.js API handlers in route.ts/js or pages/api
  if (Array.isArray(codeIndex.symbols)) {
    for (const sym of codeIndex.symbols) {
      if (sym.isExported && sym.kind === 'function') {
        const isNextApi =
          sym.path.includes('pages/api/') ||
          sym.path.includes('app/api/') ||
          /route\.(?:ts|js)$/i.test(sym.path);

        if (isNextApi) {
          const nameUpper = sym.name.toUpperCase();
          const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
          const method = HTTP_METHODS.includes(nameUpper) ? nameUpper : 'ALL';
          const routePath = '/' + sym.path
            .replace(/^(?:app|src\/app|pages|src\/pages)\/?/i, '')
            .replace(/\/route\.[a-z]+$/i, '')
            .replace(/\.[a-z]+$/i, '');

          const id = `next:${sym.path}#${sym.name}`;
          if (!seenIds.has(id)) {
            seenIds.add(id);
            entryPoints.push({
              id,
              method,
              routePath: routePath.startsWith('/') ? routePath : `/${routePath}`,
              framework: 'nextjs',
              sourcePath: sym.path,
              lineRange: sym.lineRange,
              handlerSymbol: sym.id,
              evidence: `Exported ${sym.name} in ${sym.path}`,
            });
          }
        }
      }
    }
  }

  return entryPoints;
}

/**
 * Helper to match a file path to an architectural room
 */
function findRoomForPath(path?: string, rooms?: ArchitecturalRoom[]): string | undefined {
  if (!path || !rooms) return undefined;
  for (const r of rooms) {
    if (r.filePaths && r.filePaths.some((f) => path.includes(f) || f.includes(path))) {
      return r.id;
    }
  }
  return undefined;
}

/**
 * Determine participant kind from symbol name, path, and usage
 */
function inferParticipantKind(name: string, path?: string): JourneyParticipantKind {
  const lowerName = name.toLowerCase();
  const lowerPath = (path || '').toLowerCase();

  if (
    lowerName.includes('db') ||
    lowerName.includes('database') ||
    lowerName.includes('repo') ||
    lowerName.includes('store') ||
    lowerName.includes('model') ||
    lowerName.includes('prisma') ||
    lowerName.includes('sqlite') ||
    lowerPath.includes('/db') ||
    lowerPath.includes('/repositories') ||
    lowerPath.includes('/models')
  ) {
    return 'storage';
  }

  if (
    lowerName.includes('validate') ||
    lowerName.includes('check') ||
    lowerName.includes('sanitize') ||
    lowerName.includes('verify') ||
    lowerName.includes('schema') ||
    lowerPath.includes('/validation') ||
    lowerPath.includes('/schema')
  ) {
    return 'validator';
  }

  if (
    lowerName.includes('service') ||
    lowerName.includes('manager') ||
    lowerName.includes('usecase') ||
    lowerPath.includes('/services')
  ) {
    return 'service';
  }

  if (
    lowerName.includes('route') ||
    lowerName.includes('router') ||
    lowerPath.includes('/routes')
  ) {
    return 'entry_route';
  }

  return 'handler';
}

/**
 * Statically trace a request journey through handlers, services, data stores, and responses.
 */
export function traceRequestJourney(options: {
  entryPointId?: string;
  startSymbolId?: string;
  startRoutePath?: string;
  codeIndex: CodeIndex;
  fileContents?: Record<string, string>;
  rooms?: ArchitecturalRoom[];
  maxDepth?: number;
}): RequestJourney {
  const { codeIndex, fileContents = {}, rooms = [], maxDepth = 3 } = options;
  const entryPoints = detectEntryPoints(codeIndex);

  // 1. Identify Target Entry Point or Starting Function
  let targetEntry: JourneyEntryPoint | null = null;
  if (options.entryPointId) {
    targetEntry = entryPoints.find((e) => e.id === options.entryPointId) || null;
  } else if (options.startRoutePath) {
    targetEntry = entryPoints.find((e) => e.routePath === options.startRoutePath) || null;
  } else if (entryPoints.length > 0) {
    targetEntry = entryPoints[0];
  }

  // Fallback if no detectable route exists in inspected code
  if (!targetEntry && !options.startSymbolId) {
    return {
      id: 'journey-empty',
      title: 'No Detectable Entry Points',
      entryPoint: null,
      traceKind: 'statically_reconstructed',
      isComplete: false,
      unresolvedLinksCount: 0,
      participants: [
        {
          id: 'client',
          label: 'Client / Caller',
          kind: 'client',
          confidence: 'directly_observed',
        },
      ],
      steps: [],
      explanation:
        'No recognizable HTTP route handlers (e.g. Express, Next.js, FastAPI) were detected in inspected code. You can start exploring from any indexed function or symbol.',
      stats: {
        totalParticipants: 1,
        totalSteps: 0,
        callsCount: 0,
        returnsCount: 0,
        errorBranchesCount: 0,
        unresolvedCount: 0,
      },
      supportedExploration: {
        canStepForward: false,
        canStepBackward: false,
      },
    };
  }

  const participants: JourneyParticipant[] = [];
  const steps: JourneyStep[] = [];
  const participantMap = new Map<string, JourneyParticipant>();
  let unresolvedCount = 0;
  let isComplete = true;

  const addParticipant = (p: JourneyParticipant): JourneyParticipant => {
    if (!participantMap.has(p.id)) {
      participantMap.set(p.id, p);
      participants.push(p);
    }
    return participantMap.get(p.id)!;
  };

  // Base Client Participant
  const clientPart = addParticipant({
    id: 'client',
    label: 'Client / Actor',
    kind: 'client',
    confidence: 'directly_observed',
  });

  // Entry Route Participant
  let entryRoutePart: JourneyParticipant | null = null;
  if (targetEntry) {
    entryRoutePart = addParticipant({
      id: `entry:${targetEntry.id}`,
      label: `${targetEntry.method} ${targetEntry.routePath}`,
      kind: 'entry_route',
      filePath: targetEntry.sourcePath,
      lineRange: targetEntry.lineRange,
      roomId: findRoomForPath(targetEntry.sourcePath, rooms),
      confidence: 'directly_observed',
    });

    // Step 1: Client initiates request
    steps.push({
      id: `step-${steps.length + 1}`,
      order: steps.length + 1,
      fromParticipantId: clientPart.id,
      toParticipantId: entryRoutePart.id,
      type: 'call',
      label: `${targetEntry.method} ${targetEntry.routePath}`,
      detail: `HTTP request received by ${targetEntry.framework} router`,
      filePath: targetEntry.sourcePath,
      lineRange: targetEntry.lineRange,
      confidence: 'directly_observed',
      evidence: targetEntry.evidence,
    });
  }

  // 2. Identify Handler / Entry Logic
  let initialHandlerPath = targetEntry?.sourcePath;
  let initialHandlerSymbol = targetEntry?.handlerSymbol;

  if (options.startSymbolId) {
    const sym = codeIndex.symbols.find((s) => s.id === options.startSymbolId);
    if (sym) {
      initialHandlerPath = sym.path;
      initialHandlerSymbol = sym.name;
    }
  }

  // Handler Participant
  const handlerId = `handler:${initialHandlerPath || 'main'}#${initialHandlerSymbol || 'handler'}`;
  const handlerPart = addParticipant({
    id: handlerId,
    label: initialHandlerSymbol ? `${initialHandlerSymbol}()` : 'Route Handler',
    kind: 'handler',
    filePath: initialHandlerPath,
    lineRange: targetEntry?.lineRange,
    roomId: findRoomForPath(initialHandlerPath, rooms),
    confidence: 'directly_observed',
  });

  if (entryRoutePart) {
    steps.push({
      id: `step-${steps.length + 1}`,
      order: steps.length + 1,
      fromParticipantId: entryRoutePart.id,
      toParticipantId: handlerPart.id,
      type: 'call',
      label: `invoke ${handlerPart.label}`,
      detail: 'Dispatch request to handler function',
      filePath: targetEntry?.sourcePath,
      lineRange: targetEntry?.lineRange,
      confidence: 'directly_observed',
      evidence: targetEntry ? targetEntry.evidence : 'Route dispatch',
    });
  }

  // 3. Trace Handler AST or CodeIndex Relationships
  let responseSent = false;

  // Recursive call tracer for nested function calls (e.g. Handler -> Service -> Store)
  const traceFunctionCalls = (
    currentCallerPart: JourneyParticipant,
    filePath: string,
    functionName: string | undefined,
    currentDepth: number
  ) => {
    if (currentDepth > maxDepth) return;

    const sourceCode = fileContents[filePath];
    if (!sourceCode) {
      // Fallback: check codeIndex relationships
      const rels = codeIndex.relationships.filter(
        (r) => r.source.path === filePath && r.type === 'calls'
      );
      for (const rel of rels) {
        const calleeName = rel.target.symbol || rel.target.path.split('/').pop() || 'callee';
        const targetSym = codeIndex.symbols.find(
          (s) => s.path === rel.target.path && s.name === rel.target.symbol
        );

        let pKind: JourneyParticipantKind = 'service';
        if (targetSym) {
          pKind = inferParticipantKind(targetSym.name, targetSym.path);
        }

        const calleePart = addParticipant({
          id: `symbol:${rel.target.path}#${calleeName}`,
          label: `${calleeName}()`,
          kind: pKind,
          filePath: rel.target.path,
          lineRange: targetSym?.lineRange,
          roomId: findRoomForPath(rel.target.path, rooms),
          confidence: rel.confidence === 'confirmed' ? 'directly_observed' : 'inferred',
        });

        steps.push({
          id: `step-${steps.length + 1}`,
          order: steps.length + 1,
          fromParticipantId: currentCallerPart.id,
          toParticipantId: calleePart.id,
          type: 'call',
          label: `${calleeName}()`,
          detail: rel.evidence,
          filePath: rel.source.path,
          lineRange: { startLine: rel.line, endLine: rel.line },
          confidence: 'statically_reconstructed',
          evidence: rel.evidence,
        });

        // Nested return
        steps.push({
          id: `step-${steps.length + 1}`,
          order: steps.length + 1,
          fromParticipantId: calleePart.id,
          toParticipantId: currentCallerPart.id,
          type: 'return',
          label: `return`,
          confidence: 'statically_reconstructed',
          evidence: `Return path from ${calleeName}()`,
        });
      }
      return;
    }

    // AST Parse of file content
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceCode,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith('.ts') || filePath.endsWith('.tsx') ? ts.ScriptKind.TS : ts.ScriptKind.JS
    );

    // Locate function node or route handler callback
    let targetNode: ts.Node | null = null;
    const findNode = (node: ts.Node) => {
      if (functionName) {
        if (
          (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
          node.name &&
          ts.isIdentifier(node.name) &&
          node.name.text === functionName
        ) {
          targetNode = node;
          return;
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === functionName) {
          targetNode = node.initializer || node;
          return;
        }
      } else if (targetEntry && targetEntry.sourcePath === filePath) {
        // If this is the entry route call expression, target its handler callback argument
        if (ts.isCallExpression(node)) {
          const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          if (Math.abs(startLine - targetEntry.lineRange.startLine) <= 2) {
            const lastArg = node.arguments[node.arguments.length - 1];
            if (lastArg && (ts.isArrowFunction(lastArg) || ts.isFunctionExpression(lastArg))) {
              targetNode = lastArg.body;
              return;
            }
          }
        }
      }
      ts.forEachChild(node, findNode);
    };

    findNode(sourceFile);
    if (!targetNode) {
      targetNode = sourceFile; // inspect entire file block if specific function node is not isolated
    }

    // Traverse body statements sequentially to maintain call order
    const visitStatement = (node: ts.Node) => {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

      // 1. Validation conditional check (e.g. if (!title) return res.status(400)...)
      if (ts.isIfStatement(node)) {
        const condText = node.expression.getText(sourceFile);
        const thenText = node.thenStatement.getText(sourceFile);

        // Check if condition tests validation or inputs
        const isValidation =
          condText.includes('!') ||
          condText.includes('valid') ||
          condText.includes('error') ||
          condText.includes('auth') ||
          thenText.includes('400') ||
          thenText.includes('401') ||
          thenText.includes('403') ||
          thenText.includes('status(') ||
          thenText.includes('throw');

        if (isValidation) {
          const valPart = addParticipant({
            id: `validator:${filePath}:${line}`,
            label: 'Input Validator',
            kind: 'validator',
            filePath,
            lineRange: { startLine: line, endLine },
            roomId: findRoomForPath(filePath, rooms),
            confidence: 'directly_observed',
          });

          steps.push({
            id: `step-${steps.length + 1}`,
            order: steps.length + 1,
            fromParticipantId: currentCallerPart.id,
            toParticipantId: valPart.id,
            type: 'validation_check',
            label: `check (${condText})`,
            detail: `Validation guard condition on line ${line}`,
            filePath,
            lineRange: { startLine: line, endLine },
            codeExcerpt: node.getText(sourceFile),
            confidence: 'directly_observed',
            evidence: `if (${condText}) in ${filePath}:${line}`,
          });

          // Error branch step directly back to client if error response is returned
          if (thenText.includes('status(') || thenText.includes('throw') || thenText.includes('return res')) {
            const statusMatch = thenText.match(/status\((\d+)\)/);
            const statusCode = statusMatch ? statusMatch[1] : '400/401';
            steps.push({
              id: `step-${steps.length + 1}`,
              order: steps.length + 1,
              fromParticipantId: valPart.id,
              toParticipantId: clientPart.id,
              type: 'error_branch',
              isError: true,
              label: `[Error Branch] ${statusCode} Error Response`,
              detail: `Conditional early return or rejection on error: ${thenText.slice(0, 60)}...`,
              filePath,
              lineRange: { startLine: line, endLine },
              codeExcerpt: node.thenStatement.getText(sourceFile),
              confidence: 'directly_observed',
              evidence: `Error return on line ${line}`,
            });
          }

          // Return back to caller for happy path
          steps.push({
            id: `step-${steps.length + 1}`,
            order: steps.length + 1,
            fromParticipantId: valPart.id,
            toParticipantId: currentCallerPart.id,
            type: 'return',
            label: 'valid (continue)',
            confidence: 'directly_observed',
            evidence: `Validation passes; proceed with request execution`,
          });
        }
      }

      // 2. Try-Catch Statement (Error Handling)
      if (ts.isTryStatement(node)) {
        // Trace try block
        ts.forEachChild(node.tryBlock, visitStatement);

        // Catch clause (error branch)
        if (node.catchClause) {
          const catchLine = sourceFile.getLineAndCharacterOfPosition(node.catchClause.getStart(sourceFile)).line + 1;
          const catchText = node.catchClause.getText(sourceFile);
          steps.push({
            id: `step-${steps.length + 1}`,
            order: steps.length + 1,
            fromParticipantId: currentCallerPart.id,
            toParticipantId: clientPart.id,
            type: 'error_branch',
            isError: true,
            label: 'catch (err) -> Error Dispatch',
            detail: `Exception handler caught error: ${catchText.slice(0, 50)}...`,
            filePath,
            lineRange: { startLine: catchLine, endLine: catchLine },
            codeExcerpt: catchText,
            confidence: 'directly_observed',
            evidence: `Catch clause in ${filePath}:${catchLine}`,
          });
        }
        return;
      }

      // 3. Call Expressions (Services, Storage, Database, External APIs, Response Sends)
      if (ts.isCallExpression(node)) {
        const exprText = node.expression.getText(sourceFile);

        // Check if response construction (e.g. res.json, res.send, Response.json)
        if (
          exprText.endsWith('.json') ||
          exprText.endsWith('.send') ||
          exprText.endsWith('.end') ||
          exprText === 'Response.json' ||
          exprText === 'jsonify'
        ) {
          responseSent = true;
          steps.push({
            id: `step-${steps.length + 1}`,
            order: steps.length + 1,
            fromParticipantId: currentCallerPart.id,
            toParticipantId: clientPart.id,
            type: 'response_send',
            label: `${exprText}(...) -> HTTP Response`,
            detail: `Construct and dispatch final response to client`,
            filePath,
            lineRange: { startLine: line, endLine },
            codeExcerpt: node.getText(sourceFile),
            confidence: 'directly_observed',
            evidence: `${exprText} in ${filePath}:${line}`,
          });
          return;
        }

        // Callee extraction
        let calleeName: string | undefined;
        if (ts.isIdentifier(node.expression)) {
          calleeName = node.expression.text;
        } else if (ts.isPropertyAccessExpression(node.expression)) {
          calleeName = node.expression.name.text;
        }

        // Ignore standard built-ins, loggers, or server bootstrap calls
        if (
          calleeName &&
          !['require', 'import', 'log', 'info', 'warn', 'error', 'toString', 'slice', 'push', 'express', 'Router'].includes(calleeName) &&
          !['get', 'post', 'put', 'delete', 'patch', 'use'].includes(calleeName)
        ) {
          // Resolve target symbol in CodeIndex
          const matchingSymbol = codeIndex.symbols.find((s) => s.name === calleeName);
          const isStorage =
            exprText.includes('db.') ||
            exprText.includes('database') ||
            exprText.includes('repo') ||
            exprText.includes('prisma.') ||
            exprText.includes('sqlite') ||
            calleeName.includes('Database') ||
            calleeName.includes('query') ||
            calleeName.includes('find') ||
            calleeName.includes('insert') ||
            calleeName.includes('save');

          if (matchingSymbol) {
            // Internal symbol resolved!
            const kind = isStorage ? 'storage' : inferParticipantKind(matchingSymbol.name, matchingSymbol.path);
            const calleePart = addParticipant({
              id: `symbol:${matchingSymbol.path}#${matchingSymbol.name}`,
              label: `${matchingSymbol.name}()`,
              kind,
              filePath: matchingSymbol.path,
              lineRange: matchingSymbol.lineRange,
              roomId: findRoomForPath(matchingSymbol.path, rooms),
              confidence: 'directly_observed',
            });

            // Call step
            steps.push({
              id: `step-${steps.length + 1}`,
              order: steps.length + 1,
              fromParticipantId: currentCallerPart.id,
              toParticipantId: calleePart.id,
              type: isStorage ? 'storage_op' : 'call',
              label: `${exprText}(...)`,
              detail: `Call to resolved function ${matchingSymbol.name}()`,
              filePath,
              lineRange: { startLine: line, endLine },
              codeExcerpt: node.getText(sourceFile),
              confidence: 'directly_observed',
              evidence: `${exprText} in ${filePath}:${line}`,
            });

            // Nested call tracing (Handler -> Service -> Store)
            if (currentDepth < maxDepth) {
              traceFunctionCalls(calleePart, matchingSymbol.path, matchingSymbol.name, currentDepth + 1);
            }

            // Return step
            steps.push({
              id: `step-${steps.length + 1}`,
              order: steps.length + 1,
              fromParticipantId: calleePart.id,
              toParticipantId: currentCallerPart.id,
              type: 'return',
              label: `return [result]`,
              confidence: 'directly_observed',
              evidence: `Return from ${matchingSymbol.name}()`,
            });
          } else if (isStorage) {
            // Local / library storage invocation
            const storePart = addParticipant({
              id: `storage:${calleeName}`,
              label: calleeName,
              kind: 'storage',
              filePath,
              lineRange: { startLine: line, endLine },
              roomId: findRoomForPath(filePath, rooms),
              confidence: 'directly_observed',
            });

            steps.push({
              id: `step-${steps.length + 1}`,
              order: steps.length + 1,
              fromParticipantId: currentCallerPart.id,
              toParticipantId: storePart.id,
              type: 'storage_op',
              label: `${exprText}(...)`,
              detail: 'Execute storage operation / database query',
              filePath,
              lineRange: { startLine: line, endLine },
              codeExcerpt: node.getText(sourceFile),
              confidence: 'directly_observed',
              evidence: `${exprText} in ${filePath}:${line}`,
            });

            steps.push({
              id: `step-${steps.length + 1}`,
              order: steps.length + 1,
              fromParticipantId: storePart.id,
              toParticipantId: currentCallerPart.id,
              type: 'return',
              label: 'return [records / acknowledgment]',
              confidence: 'directly_observed',
              evidence: `Storage operation completes`,
            });
          } else {
            // Unresolved external or dynamic call (Requirement 6)
            unresolvedCount++;
            isComplete = false;

            const isExternalPkg = exprText.includes('.') && !exprText.startsWith('this.');
            const unresolvedReason = isExternalPkg ? 'external_package' : 'unresolved_symbol';

            const unresPart = addParticipant({
              id: `unresolved:${calleeName}`,
              label: `${calleeName} [Unresolved]`,
              kind: 'unresolved',
              isExternal: true,
              unresolvedReason,
              confidence: 'unresolved',
            });

            steps.push({
              id: `step-${steps.length + 1}`,
              order: steps.length + 1,
              fromParticipantId: currentCallerPart.id,
              toParticipantId: unresPart.id,
              type: 'unresolved_call',
              label: `${exprText}(...) ⚠`,
              detail: `Unresolved dispatch: target implementation was not inspected or is external package`,
              filePath,
              lineRange: { startLine: line, endLine },
              codeExcerpt: node.getText(sourceFile),
              confidence: 'unresolved',
              evidence: `${exprText} (unresolved)`,
              unresolvedReason,
            });
          }
        }
      }

      ts.forEachChild(node, visitStatement);
    };

    ts.forEachChild(targetNode, visitStatement);
  };

  // Start tracing from the initial handler
  if (initialHandlerPath) {
    traceFunctionCalls(handlerPart, initialHandlerPath, initialHandlerSymbol, 1);
  }

  // If no explicit response_send was detected, append return to client
  if (!responseSent) {
    steps.push({
      id: `step-${steps.length + 1}`,
      order: steps.length + 1,
      fromParticipantId: handlerPart.id,
      toParticipantId: clientPart.id,
      type: 'return',
      label: 'return Response / 200 OK',
      detail: 'Handler returns result or sends default acknowledgment',
      confidence: 'statically_reconstructed',
      evidence: 'End of handler execution path',
    });
  }

  // Calculate statistics
  const callsCount = steps.filter((s) => s.type === 'call').length;
  const returnsCount = steps.filter((s) => s.type === 'return').length;
  const errorBranchesCount = steps.filter((s) => s.type === 'error_branch').length;
  const unresolvedStepCount = steps.filter((s) => s.type === 'unresolved_call').length;

  const title = targetEntry
    ? `${targetEntry.method} ${targetEntry.routePath} Journey`
    : `${initialHandlerSymbol || 'Function'} Call Sequence`;

  const explanation = targetEntry
    ? `Statically reconstructed request sequence for ${targetEntry.method} ${targetEntry.routePath} from inspected AST and symbol definitions (${steps.length} sequential events, ${participants.length} participants).`
    : `Statically reconstructed call sequence for ${initialHandlerSymbol}() across ${participants.length} participants.`;

  return {
    id: `journey-${targetEntry ? targetEntry.id.replace(/[^a-zA-Z0-9_-]/g, '_') : 'custom'}`,
    title,
    entryPoint: targetEntry,
    traceKind: 'statically_reconstructed',
    isComplete: isComplete && unresolvedCount === 0,
    unresolvedLinksCount: unresolvedCount || unresolvedStepCount,
    participants,
    steps,
    explanation,
    stats: {
      totalParticipants: participants.length,
      totalSteps: steps.length,
      callsCount,
      returnsCount,
      errorBranchesCount,
      unresolvedCount: unresolvedCount || unresolvedStepCount,
    },
    supportedExploration: {
      canStepForward: true,
      canStepBackward: true,
    },
  };
}

/**
 * Explore a participant forward (downstream calls) or backward (upstream callers).
 */
export function exploreJourneyStep(
  journey: RequestJourney,
  options: {
    direction: 'forward' | 'backward';
    participantId: string;
    codeIndex: CodeIndex;
    fileContents?: Record<string, string>;
  }
): {
  success: boolean;
  discoveredSymbols: Array<{ name: string; path: string; direction: string }>;
  explanation: string;
} {
  const { direction, participantId, codeIndex } = options;
  const targetPart = journey.participants.find((p) => p.id === participantId);

  if (!targetPart) {
    return {
      success: false,
      discoveredSymbols: [],
      explanation: `Participant ${participantId} not found in active request journey.`,
    };
  }

  const discovered: Array<{ name: string; path: string; direction: string }> = [];

  if (direction === 'forward') {
    // Find all outgoing calls from this participant
    if (targetPart.filePath) {
      const outgoing = codeIndex.relationships.filter(
        (r) => r.source.path === targetPart.filePath && r.type === 'calls'
      );
      for (const rel of outgoing) {
        discovered.push({
          name: rel.target.symbol || rel.target.path,
          path: rel.target.path,
          direction: 'calls',
        });
      }
    }
    return {
      success: discovered.length > 0,
      discoveredSymbols: discovered,
      explanation:
        discovered.length > 0
          ? `Discovered ${discovered.length} forward call targets invoked by ${targetPart.label}.`
          : `No additional forward calls found in inspected symbols for ${targetPart.label}.`,
    };
  } else {
    // Backward: Find callers that invoke this participant
    const targetName = targetPart.label.replace(/\(\)$/, '');
    const incoming = codeIndex.relationships.filter(
      (r) =>
        (r.target.symbol === targetName || (targetPart.filePath && r.target.path === targetPart.filePath)) &&
        r.type === 'calls'
    );
    for (const rel of incoming) {
      discovered.push({
        name: rel.source.symbol || rel.source.path,
        path: rel.source.path,
        direction: 'called_by',
      });
    }
    return {
      success: discovered.length > 0,
      discoveredSymbols: discovered,
      explanation:
        discovered.length > 0
          ? `Discovered ${discovered.length} upstream caller(s) invoking ${targetPart.label}.`
          : `No upstream callers found in inspected relationships for ${targetPart.label}.`,
    };
  }
}
