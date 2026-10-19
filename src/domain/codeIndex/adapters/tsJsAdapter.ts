import ts from 'typescript';
import type {
  LanguageAdapter,
  ParsedFileResult,
  SymbolDefinition,
  ImportStatement,
  ExportStatement,
  RouteRegistration,
  ParseDiagnostic,
  SourceLineRange,
} from '../types.ts';

function getLineAndCharacter(sourceFile: ts.SourceFile, pos: number): { line: number; character: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
  return { line: line + 1, character }; // 1-indexed line
}

function getNodeLineRange(sourceFile: ts.SourceFile, node: ts.Node): SourceLineRange {
  const start = getLineAndCharacter(sourceFile, node.getStart(sourceFile));
  const end = getLineAndCharacter(sourceFile, node.getEnd());
  return {
    startLine: start.line,
    endLine: Math.max(start.line, end.line),
  };
}

function getScriptKind(filePath: string): ts.ScriptKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

export class TypeScriptJavaScriptAdapter implements LanguageAdapter {
  id = 'typescript';
  name = 'TypeScript / JavaScript AST Parser';
  supportedExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  analysisQuality = 'full_ast' as const;

  parseFile(path: string, content: string): ParsedFileResult {
    const scriptKind = getScriptKind(path);
    const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind);

    const diagnostics: ParseDiagnostic[] = [];
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

    // 1. Collect Syntax Diagnostics
    const parseDiags = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
    if (Array.isArray(parseDiags)) {
      for (const diag of parseDiags) {
        const line = diag.start !== undefined ? getLineAndCharacter(sourceFile, diag.start).line : 1;
        const msg = typeof diag.messageText === 'string' ? diag.messageText : diag.messageText.messageText;
        diagnostics.push({
          path,
          message: msg,
          line,
          severity: diag.category === ts.DiagnosticCategory.Error ? 'error' : 'warning',
        });
      }
    }

    let currentCallerSymbol: string | undefined;

    // Helper to check for 'export' keyword modifier
    const hasExportModifier = (node: ts.Node): boolean => {
      if (!ts.canHaveModifiers(node)) return false;
      const modifiers = ts.getModifiers(node);
      return Boolean(modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
    };

    // Helper to check for 'default' keyword modifier
    const hasDefaultModifier = (node: ts.Node): boolean => {
      if (!ts.canHaveModifiers(node)) return false;
      const modifiers = ts.getModifiers(node);
      return Boolean(modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
    };

    // 2. Traverse AST
    const visit = (node: ts.Node): void => {
      // Imports (ESM: import ... from '...')
      if (ts.isImportDeclaration(node)) {
        if (ts.isStringLiteral(node.moduleSpecifier)) {
          const specifier = node.moduleSpecifier.text;
          const line = getLineAndCharacter(sourceFile, node.getStart(sourceFile)).line;
          const importedSymbols: ImportStatement['importedSymbols'] = [];

          if (node.importClause) {
            // Default import: import foo from '...'
            if (node.importClause.name) {
              importedSymbols.push({
                name: node.importClause.name.text,
                isDefault: true,
              });
            }

            // Named imports or namespace import
            if (node.importClause.namedBindings) {
              if (ts.isNamedImports(node.importClause.namedBindings)) {
                for (const element of node.importClause.namedBindings.elements) {
                  const importedName = element.propertyName ? element.propertyName.text : element.name.text;
                  const localAlias = element.propertyName ? element.name.text : undefined;
                  importedSymbols.push({
                    name: importedName,
                    alias: localAlias,
                  });
                }
              } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
                importedSymbols.push({
                  name: node.importClause.namedBindings.name.text,
                  isNamespace: true,
                });
              }
            }
          }

          const isRelative = specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..';
          const isAlias = specifier.startsWith('@/') || specifier.startsWith('~/') || specifier.startsWith('@');

          imports.push({
            sourcePath: path,
            rawSpecifier: specifier,
            importedSymbols,
            line,
            isRelative,
            isAlias,
            isExternal: !isRelative && !isAlias,
            isResolved: false,
          });
        }
      }

      // Exports (ESM: export { a as b } from './x' or export { a, b })
      if (ts.isExportDeclaration(node)) {
        const line = getLineAndCharacter(sourceFile, node.getStart(sourceFile)).line;
        const isReExport = Boolean(node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier));
        const reExportSpecifier = isReExport && ts.isStringLiteral(node.moduleSpecifier!) ? node.moduleSpecifier.text : undefined;

        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) {
            const exportedName = el.name.text;
            const localName = el.propertyName ? el.propertyName.text : el.name.text;
            exports.push({
              sourcePath: path,
              exportedName,
              localName,
              isDefault: exportedName === 'default',
              isReExport,
              reExportSpecifier,
              line,
            });
          }
        } else if (isReExport && !node.exportClause) {
          // export * from './x'
          exports.push({
            sourcePath: path,
            exportedName: '*',
            localName: '*',
            isDefault: false,
            isReExport: true,
            reExportSpecifier,
            line,
          });
        }
      }

      // Export Default Assignment: export default foo;
      if (ts.isExportAssignment(node)) {
        const line = getLineAndCharacter(sourceFile, node.getStart(sourceFile)).line;
        const localName = ts.isIdentifier(node.expression) ? node.expression.text : 'default';
        exports.push({
          sourcePath: path,
          exportedName: 'default',
          localName,
          isDefault: true,
          isReExport: false,
          line,
        });
      }

      // Function Declarations
      if (ts.isFunctionDeclaration(node) && node.name) {
        const name = node.name.text;
        const lineRange = getNodeLineRange(sourceFile, node);
        const isExported = hasExportModifier(node);
        const symbolId = `${path}#${name}`;

        symbols.push({
          id: symbolId,
          name,
          path,
          kind: 'function',
          lineRange,
          isExported,
        });

        if (isExported) {
          exports.push({
            sourcePath: path,
            exportedName: hasDefaultModifier(node) ? 'default' : name,
            localName: name,
            isDefault: hasDefaultModifier(node),
            isReExport: false,
            line: lineRange.startLine,
          });
        }

        // Check for Next.js App Router route handlers: GET, POST, etc. in route.ts/js
        if (isExported && /route\.(?:ts|js)$/i.test(path) && ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(name.toUpperCase())) {
          routes.push({
            id: `${path}#${name.toUpperCase()}`,
            method: name.toUpperCase(),
            routePath: '/' + path.replace(/^(?:app|src\/app)\/?/i, '').replace(/\/route\.[a-z]+$/i, ''),
            sourcePath: path,
            lineRange,
            handlerSymbol: symbolId,
            framework: 'nextjs',
            evidence: `Exported ${name.toUpperCase()} handler in Next.js route file`,
          });
        }

        const prevCaller = currentCallerSymbol;
        currentCallerSymbol = symbolId;
        if (node.body) {
          ts.forEachChild(node.body, visit);
        }
        currentCallerSymbol = prevCaller;
        return; // already visited children
      }

      // Class Declarations
      if (ts.isClassDeclaration(node) && node.name) {
        const name = node.name.text;
        const lineRange = getNodeLineRange(sourceFile, node);
        const isExported = hasExportModifier(node);
        const symbolId = `${path}#${name}`;

        const heritage: { extends?: string[]; implements?: string[] } = {};
        if (node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            const types = clause.types.map((t) => (ts.isIdentifier(t.expression) ? t.expression.text : t.expression.getText(sourceFile)));
            if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
              heritage.extends = types;
            } else if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
              heritage.implements = types;
            }
          }
        }

        symbols.push({
          id: symbolId,
          name,
          path,
          kind: 'class',
          lineRange,
          isExported,
          heritage,
        });

        if (isExported) {
          exports.push({
            sourcePath: path,
            exportedName: hasDefaultModifier(node) ? 'default' : name,
            localName: name,
            isDefault: hasDefaultModifier(node),
            isReExport: false,
            line: lineRange.startLine,
          });
        }

        const prevCaller = currentCallerSymbol;
        currentCallerSymbol = symbolId;
        ts.forEachChild(node, visit);
        currentCallerSymbol = prevCaller;
        return;
      }

      // Method Declarations in Classes or Objects
      if (ts.isMethodDeclaration(node) && node.name) {
        const methodName = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(sourceFile);
        const lineRange = getNodeLineRange(sourceFile, node);
        const parentName = currentCallerSymbol ? currentCallerSymbol.split('#')[1] : '';
        const symbolId = `${path}#${parentName ? `${parentName}.${methodName}` : methodName}`;

        symbols.push({
          id: symbolId,
          name: methodName,
          path,
          kind: 'method',
          lineRange,
          isExported: false,
        });

        const prevCaller = currentCallerSymbol;
        currentCallerSymbol = symbolId;
        if (node.body) {
          ts.forEachChild(node.body, visit);
        }
        currentCallerSymbol = prevCaller;
        return;
      }

      // Interfaces
      if (ts.isInterfaceDeclaration(node)) {
        const name = node.name.text;
        const lineRange = getNodeLineRange(sourceFile, node);
        const isExported = hasExportModifier(node);
        symbols.push({
          id: `${path}#${name}`,
          name,
          path,
          kind: 'interface',
          lineRange,
          isExported,
        });
        if (isExported) {
          exports.push({
            sourcePath: path,
            exportedName: name,
            localName: name,
            isDefault: false,
            isReExport: false,
            line: lineRange.startLine,
          });
        }
      }

      // Type Aliases
      if (ts.isTypeAliasDeclaration(node)) {
        const name = node.name.text;
        const lineRange = getNodeLineRange(sourceFile, node);
        const isExported = hasExportModifier(node);
        symbols.push({
          id: `${path}#${name}`,
          name,
          path,
          kind: 'type',
          lineRange,
          isExported,
        });
        if (isExported) {
          exports.push({
            sourcePath: path,
            exportedName: name,
            localName: name,
            isDefault: false,
            isReExport: false,
            line: lineRange.startLine,
          });
        }
      }

      // Variable Statements: const foo = () => { ... } or const x = require('...')
      if (ts.isVariableStatement(node)) {
        const isExported = hasExportModifier(node);
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const varName = decl.name.text;
            const lineRange = getNodeLineRange(sourceFile, decl);

            // Function expression / Arrow function assigned to variable
            if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
              const symbolId = `${path}#${varName}`;
              symbols.push({
                id: symbolId,
                name: varName,
                path,
                kind: 'function',
                lineRange,
                isExported,
              });

              if (isExported) {
                exports.push({
                  sourcePath: path,
                  exportedName: varName,
                  localName: varName,
                  isDefault: false,
                  isReExport: false,
                  line: lineRange.startLine,
                });
              }

              const prevCaller = currentCallerSymbol;
              currentCallerSymbol = symbolId;
              ts.forEachChild(decl.initializer.body, visit);
              currentCallerSymbol = prevCaller;
              continue;
            }

            // CommonJS require statement: const x = require('...')
            if (
              decl.initializer &&
              ts.isCallExpression(decl.initializer) &&
              ts.isIdentifier(decl.initializer.expression) &&
              decl.initializer.expression.text === 'require' &&
              decl.initializer.arguments.length > 0 &&
              ts.isStringLiteral(decl.initializer.arguments[0])
            ) {
              const specifier = decl.initializer.arguments[0].text;
              const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
              const isAlias = specifier.startsWith('@/') || specifier.startsWith('~/');
              imports.push({
                sourcePath: path,
                rawSpecifier: specifier,
                importedSymbols: [{ name: varName, isDefault: true }],
                line: lineRange.startLine,
                isRelative,
                isAlias,
                isExternal: !isRelative && !isAlias,
                isResolved: false,
              });
            } else {
              // Regular variable
              symbols.push({
                id: `${path}#${varName}`,
                name: varName,
                path,
                kind: 'variable',
                lineRange,
                isExported,
              });
              if (isExported) {
                exports.push({
                  sourcePath: path,
                  exportedName: varName,
                  localName: varName,
                  isDefault: false,
                  isReExport: false,
                  line: lineRange.startLine,
                });
              }
            }
          }
        }
      }

      // Route Registration Calls: app.get('/route', handler), router.post('/route', handler)
      if (ts.isCallExpression(node)) {
        const line = getLineAndCharacter(sourceFile, node.getStart(sourceFile)).line;
        const lineRange = getNodeLineRange(sourceFile, node);

        if (ts.isPropertyAccessExpression(node.expression)) {
          const methodName = node.expression.name.text.toLowerCase();
          const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'all', 'use'];

          if (HTTP_METHODS.includes(methodName) && node.arguments.length >= 1) {
            const firstArg = node.arguments[0];
            let routePath: string | undefined;

            if (ts.isStringLiteral(firstArg)) {
              routePath = firstArg.text;
            } else if (ts.isTemplateExpression(firstArg)) {
              routePath = firstArg.head.text + '...';
            }

            if (routePath && (routePath.startsWith('/') || routePath === '*')) {
              let handlerSymbol: string | undefined;
              if (node.arguments.length >= 2) {
                const handlerArg = node.arguments[node.arguments.length - 1];
                if (ts.isIdentifier(handlerArg)) {
                  handlerSymbol = handlerArg.text;
                }
              }

              routes.push({
                id: `${path}:${line}#${methodName.toUpperCase()}:${routePath}`,
                method: methodName.toUpperCase(),
                routePath,
                sourcePath: path,
                lineRange,
                handlerSymbol,
                framework: 'express',
                evidence: `${node.expression.getText(sourceFile)}('${routePath}', ...)`,
              });
            }
          }
        }

        // Record syntactic call
        let calleeName: string | undefined;
        if (ts.isIdentifier(node.expression)) {
          calleeName = node.expression.text;
        } else if (ts.isPropertyAccessExpression(node.expression)) {
          calleeName = node.expression.name.text;
        }

        if (calleeName && calleeName !== 'require' && calleeName !== 'import') {
          calls.push({
            callerSymbol: currentCallerSymbol,
            calleeName,
            line,
            evidence: node.expression.getText(sourceFile),
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);

    return {
      path,
      language: scriptKind === ts.ScriptKind.TS || scriptKind === ts.ScriptKind.TSX ? 'TypeScript' : 'JavaScript',
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
