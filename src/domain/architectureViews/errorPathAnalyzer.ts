import type {
  ArchitectureLensResult,
  DetectedErrorClass,
  DetectedErrorHandler,
  DetectedErrorPath,
  DetectedThrowSite,
  ErrorPathModel,
} from './types.ts';

export interface ErrorPathAnalyzerInput {
  files: Record<string, string>; // path -> content
}

/**
 * Shows explicitly detected exceptions, error handlers, and route-level failure branches
 * when they can be resolved from inspected source code.
 */
export function analyzeErrorPaths(
  input: ErrorPathAnalyzerInput
): ArchitectureLensResult<ErrorPathModel> {
  const errorClasses: DetectedErrorClass[] = [];
  const throwSites: DetectedThrowSite[] = [];
  const handlers: DetectedErrorHandler[] = [];
  const errorPaths: DetectedErrorPath[] = [];

  for (const [filePath, content] of Object.entries(input.files)) {
    const lines = content.split('\n');

    // 1. Detect custom Error classes: class MyError extends Error { ... }
    const classErrorRegex = /class\s+([A-Za-z0-9_$]+Error)\s+extends\s+([A-Za-z0-9_$]+)/g;
    let mClass: RegExpExecArray | null;
    while ((mClass = classErrorRegex.exec(content)) !== null) {
      const name = mClass[1];
      const baseClass = mClass[2];
      const line = content.slice(0, mClass.index).split('\n').length;
      errorClasses.push({
        name,
        baseClass,
        filePath,
        line,
      });
    }

    // 2. Detect Throw Sites: throw new FooError('...') or throw new Error('...')
    const throwRegex = /throw\s+new\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/g;
    let mThrow: RegExpExecArray | null;
    while ((mThrow = throwRegex.exec(content)) !== null) {
      const errType = mThrow[1];
      const msgArg = mThrow[2].trim();
      const line = content.slice(0, mThrow.index).split('\n').length;

      // Find enclosing function if detectable
      const prevLines = lines.slice(Math.max(0, line - 20), line).join('\n');
      const funcMatch = prevLines.match(/(?:function|const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/) ||
        prevLines.match(/function\s+([A-Za-z0-9_$]+)\s*\(/);
      const enclosingFunction = funcMatch ? funcMatch[1] : undefined;

      throwSites.push({
        id: `throw-${filePath.replace(/[^a-zA-Z0-9_-]/g, '_')}-${line}`,
        errorType: errType,
        message: msgArg.replace(/['"]/g, '').slice(0, 80),
        filePath,
        line,
        enclosingFunction,
        codeExcerpt: lines[line - 1]?.trim() || `throw new ${errType}`,
      });
    }

    // 3. Detect Try/Catch Handlers: try { ... } catch (err) { ... }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      const catchMatch = line.match(/catch\s*\(\s*([A-Za-z0-9_$]+)\s*\)/);
      if (catchMatch) {
        const catchBody = lines.slice(i, Math.min(lines.length, i + 25)).join('\n');

        // Look for status code in catch block (e.g. res.status(400) or res.status(500))
        const statusMatch = catchBody.match(/res\.status\s*\(\s*(\d{3})\s*\)/);
        const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : undefined;

        // Check if handler checks `if (err instanceof FooError)`
        const instanceOfMatch = catchBody.match(/instanceof\s+([A-Za-z0-9_$]+)/);
        const handledErrorType = instanceOfMatch ? instanceOfMatch[1] : undefined;

        const handlerId = `catch-${filePath.replace(/[^a-zA-Z0-9_-]/g, '_')}-${lineNum}`;
        handlers.push({
          id: handlerId,
          filePath,
          lineRange: { startLine: lineNum, endLine: Math.min(lines.length, lineNum + 15) },
          handlerKind: 'try_catch',
          handledErrorType,
          statusCode: statusCode || 500,
        });
      }

      // 4. Detect Route-Level Failure Responses: res.status(400).json(...)
      const routeFailMatch = line.match(/(?:res|response)\.status\s*\(\s*(4\d\d|5\d\d)\s*\)/);
      if (routeFailMatch && !line.includes('//')) {
        const statusCode = parseInt(routeFailMatch[1], 10);
        const handlerId = `route-status-${filePath.replace(/[^a-zA-Z0-9_-]/g, '_')}-${lineNum}`;

        handlers.push({
          id: handlerId,
          filePath,
          lineRange: { startLine: lineNum, endLine: lineNum },
          handlerKind: 'route_status_response',
          statusCode,
        });
      }
    }
  }

  // 5. Connect Throw Sites to Matching Handlers or Error Classes
  for (const throwSite of throwSites) {
    // Find matching handler in the same file or downstream
    const matchingHandler = handlers.find(
      (h) =>
        (h.handledErrorType && h.handledErrorType === throwSite.errorType) ||
        (h.filePath === throwSite.filePath && h.lineRange.startLine > throwSite.line)
    ) || handlers.find((h) => h.handlerKind === 'try_catch');

    errorPaths.push({
      id: `errpath-${throwSite.id}`,
      throwSiteId: throwSite.id,
      handlerId: matchingHandler?.id,
      errorType: throwSite.errorType,
      sourceFile: throwSite.filePath,
      targetFile: matchingHandler?.filePath,
      statusCode: matchingHandler?.statusCode || (throwSite.errorType.includes('Validation') ? 400 : 500),
      evidence: `Explicit throw "${throwSite.errorType}" at ${throwSite.filePath}:${throwSite.line}${
        matchingHandler ? ` handled by ${matchingHandler.handlerKind} (HTTP ${matchingHandler.statusCode})` : ''
      }`,
    });
  }

  const totalErrorsDetected = errorClasses.length + throwSites.length + handlers.length;
  const hasSufficientEvidence = totalErrorsDetected > 0;

  return {
    viewMode: 'error_paths',
    title: 'Error-Path & Exception Flow View',
    hasSufficientEvidence,
    reasonIfUnsupported: hasSufficientEvidence
      ? undefined
      : 'No custom Error classes, explicit throw statements, catch handlers, or route failure status codes detected in inspected code.',
    model: hasSufficientEvidence
      ? {
          errorClasses,
          throwSites,
          handlers,
          errorPaths,
          totalErrorsDetected,
        }
      : null,
    stats: {
      errorClassesCount: errorClasses.length,
      throwSitesCount: throwSites.length,
      handlersCount: handlers.length,
      errorPathsCount: errorPaths.length,
    },
  };
}
