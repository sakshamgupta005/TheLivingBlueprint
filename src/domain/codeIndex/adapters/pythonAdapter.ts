import type {
  LanguageAdapter,
  ParsedFileResult,
  SymbolDefinition,
  ImportStatement,
  ExportStatement,
  RouteRegistration,
  ParseDiagnostic,
} from '../types.ts';

export class PythonLanguageAdapter implements LanguageAdapter {
  id = 'python';
  name = 'Python Syntax Pattern Adapter';
  supportedExtensions = ['.py', '.pyi'];
  analysisQuality = 'pattern_ast' as const;

  parseFile(path: string, content: string): ParsedFileResult {
    const lines = content.split(/\r?\n/);
    const symbols: SymbolDefinition[] = [];
    const imports: ImportStatement[] = [];
    const exports: ExportStatement[] = [];
    const routes: RouteRegistration[] = [];
    const calls: Array<{
      callerSymbol?: string;
      calleeName: string;
      line: number;
      evidence: string;
    }> = [];
    const diagnostics: ParseDiagnostic[] = [];

    let currentFunction: { name: string; startLine: number; indent: number } | null = null;
    let currentClass: { name: string; startLine: number; indent: number } | null = null;
    let pendingDecorator: { method: string; routePath: string; line: number; framework: 'fastapi' | 'flask' } | null = null;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const rawLine = lines[i];
      const trimmed = rawLine.trim();

      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const indent = rawLine.search(/\S/);

      // Check if we exited current function/class indentation scope
      if (currentFunction && indent <= currentFunction.indent && !trimmed.startsWith('def ') && !trimmed.startsWith('async def ')) {
        symbols.push({
          id: `${path}#${currentFunction.name}`,
          name: currentFunction.name,
          path,
          kind: 'function',
          lineRange: { startLine: currentFunction.startLine, endLine: lineNum - 1 },
          isExported: !currentFunction.name.startsWith('_'),
        });
        currentFunction = null;
      }

      if (currentClass && indent <= currentClass.indent && !trimmed.startsWith('class ')) {
        symbols.push({
          id: `${path}#${currentClass.name}`,
          name: currentClass.name,
          path,
          kind: 'class',
          lineRange: { startLine: currentClass.startLine, endLine: lineNum - 1 },
          isExported: !currentClass.name.startsWith('_'),
        });
        currentClass = null;
      }

      // 1. Detect Decorators (e.g. FastAPI/Flask routes)
      // @app.get("/tasks") or @router.post('/tasks') or @app.route('/tasks', methods=['GET'])
      const routeMatch = trimmed.match(
        /@(?:app|router|blueprint|api)\.(get|post|put|delete|patch|route)\s*\(\s*["']([^"']+)["']/i
      );
      if (routeMatch) {
        let method = routeMatch[1].toUpperCase();
        const routePath = routeMatch[2];
        if (method === 'ROUTE') {
          const methodsMatch = trimmed.match(/methods\s*=\s*\[\s*["']([A-Z]+)["']/i);
          method = methodsMatch ? methodsMatch[1].toUpperCase() : 'GET';
        }
        pendingDecorator = {
          method,
          routePath,
          line: lineNum,
          framework: trimmed.includes('.route') ? 'flask' : 'fastapi',
        };
        continue;
      }

      // 2. Imports
      // from .module import func1, func2 or from app.services import X
      const fromImportMatch = trimmed.match(/^from\s+([.\w]+)\s+import\s+(.+)$/);
      if (fromImportMatch) {
        const rawSpecifier = fromImportMatch[1];
        const rawSymbols = fromImportMatch[2].split(',');
        const isRelative = rawSpecifier.startsWith('.');
        const importedSymbols = rawSymbols.map((s) => {
          const parts = s.trim().split(/\s+as\s+/);
          return {
            name: parts[0].trim(),
            alias: parts[1] ? parts[1].trim() : undefined,
          };
        }).filter((s) => s.name.length > 0);

        imports.push({
          sourcePath: path,
          rawSpecifier,
          importedSymbols,
          line: lineNum,
          isRelative,
          isAlias: false,
          isExternal: !isRelative,
          isResolved: false,
        });
        continue;
      }

      // import module, other_module or import module as alias
      const directImportMatch = trimmed.match(/^import\s+([.\w\s,]+)$/);
      if (directImportMatch && !trimmed.startsWith('import (')) {
        const items = directImportMatch[1].split(',');
        for (const item of items) {
          const parts = item.trim().split(/\s+as\s+/);
          const rawSpecifier = parts[0].trim();
          if (rawSpecifier) {
            const isRelative = rawSpecifier.startsWith('.');
            imports.push({
              sourcePath: path,
              rawSpecifier,
              importedSymbols: [
                {
                  name: rawSpecifier,
                  alias: parts[1] ? parts[1].trim() : undefined,
                },
              ],
              line: lineNum,
              isRelative,
              isAlias: false,
              isExternal: !isRelative,
              isResolved: false,
            });
          }
        }
        continue;
      }

      // 3. Class Definitions: class TaskModel(BaseModel):
      const classMatch = trimmed.match(/^class\s+([a-zA-Z0-9_]+)(?:\s*\(([^)]*)\))?:/);
      if (classMatch) {
        const className = classMatch[1];
        const bases = classMatch[2] ? classMatch[2].split(',').map((b) => b.trim()).filter(Boolean) : [];
        currentClass = { name: className, startLine: lineNum, indent };
        symbols.push({
          id: `${path}#${className}`,
          name: className,
          path,
          kind: 'class',
          lineRange: { startLine: lineNum, endLine: lineNum },
          isExported: !className.startsWith('_'),
          heritage: bases.length > 0 ? { extends: bases } : undefined,
        });
        continue;
      }

      // 4. Function Definitions: def foo(x, y): or async def bar():
      const funcMatch = trimmed.match(/^(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(/);
      if (funcMatch) {
        const funcName = funcMatch[1];
        const isExported = !funcName.startsWith('_');
        currentFunction = { name: funcName, startLine: lineNum, indent };

        const symbolId = `${path}#${funcName}`;
        symbols.push({
          id: symbolId,
          name: funcName,
          path,
          kind: currentClass ? 'method' : 'function',
          lineRange: { startLine: lineNum, endLine: lineNum },
          isExported,
        });

        if (isExported && !currentClass) {
          exports.push({
            sourcePath: path,
            exportedName: funcName,
            localName: funcName,
            isDefault: false,
            isReExport: false,
            line: lineNum,
          });
        }

        // Connect pending route decorator to this function handler
        if (pendingDecorator) {
          routes.push({
            id: `${path}:${pendingDecorator.line}#${pendingDecorator.method}:${pendingDecorator.routePath}`,
            method: pendingDecorator.method,
            routePath: pendingDecorator.routePath,
            sourcePath: path,
            lineRange: { startLine: pendingDecorator.line, endLine: lineNum },
            handlerSymbol: symbolId,
            framework: pendingDecorator.framework,
            evidence: `@app.${pendingDecorator.method.toLowerCase()}("${pendingDecorator.routePath}") -> def ${funcName}`,
          });
          pendingDecorator = null;
        }
        continue;
      }

      // 5. Function Calls: callee(arg1, arg2)
      const callMatches = trimmed.matchAll(/(?:([a-zA-Z0-9_]+)\.)?([a-zA-Z0-9_]+)\s*\(/g);
      for (const cm of callMatches) {
        const callee = cm[2];
        const KEYWORDS = new Set(['def', 'class', 'if', 'elif', 'while', 'for', 'with', 'return', 'print', 'len', 'range', 'isinstance', 'str', 'int', 'dict', 'list', 'set']);
        if (!KEYWORDS.has(callee)) {
          calls.push({
            callerSymbol: currentFunction ? `${path}#${currentFunction.name}` : undefined,
            calleeName: callee,
            line: lineNum,
            evidence: cm[0].slice(0, 40),
          });
        }
      }
    }

    // Close remaining open scopes
    if (currentFunction) {
      const existing = symbols.find((s) => s.id === `${path}#${currentFunction!.name}`);
      if (existing) {
        existing.lineRange.endLine = lines.length;
      }
    }
    if (currentClass) {
      const existing = symbols.find((s) => s.id === `${path}#${currentClass!.name}`);
      if (existing) {
        existing.lineRange.endLine = lines.length;
      }
    }

    return {
      path,
      language: 'Python',
      analysisQuality: this.analysisQuality,
      symbols,
      imports,
      exports,
      routes,
      calls,
      diagnostics,
    };
  }
}
