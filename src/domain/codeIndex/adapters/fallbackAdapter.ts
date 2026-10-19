import type {
  LanguageAdapter,
  ParsedFileResult,
  SymbolDefinition,
  ImportStatement,
  ExportStatement,
  RouteRegistration,
  ParseDiagnostic,
} from '../types.ts';

export class FallbackLanguageAdapter implements LanguageAdapter {
  id = 'fallback';
  name = 'Generic / Shallow Language Adapter';
  supportedExtensions = ['.go', '.rs', '.java', '.c', '.cpp', '.rb', '.php', '.cs'];
  analysisQuality = 'shallow' as const;

  parseFile(path: string, content: string): ParsedFileResult {
    const lines = content.split(/\r?\n/);
    const symbols: SymbolDefinition[] = [];
    const imports: ImportStatement[] = [];
    const exports: ExportStatement[] = [];
    const routes: RouteRegistration[] = [];
    const calls: Array<{ callerSymbol?: string; calleeName: string; line: number; evidence: string }> = [];
    const diagnostics: ParseDiagnostic[] = [];

    // Extract basic package/import patterns without fabricating full AST claims
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i].trim();

      // Go: import "foo/bar"
      const goImport = line.match(/^import\s+["']([^"']+)["']/);
      if (goImport) {
        imports.push({
          sourcePath: path,
          rawSpecifier: goImport[1],
          importedSymbols: [{ name: goImport[1].split('/').pop() || goImport[1] }],
          line: lineNum,
          isRelative: goImport[1].startsWith('./') || goImport[1].startsWith('../'),
          isAlias: false,
          isExternal: true,
          isResolved: false,
        });
      }

      // Rust: use foo::bar;
      const rustUse = line.match(/^use\s+([a-zA-Z0-9_:]+);/);
      if (rustUse) {
        imports.push({
          sourcePath: path,
          rawSpecifier: rustUse[1],
          importedSymbols: [{ name: rustUse[1].split('::').pop() || rustUse[1] }],
          line: lineNum,
          isRelative: rustUse[1].startsWith('super::') || rustUse[1].startsWith('crate::'),
          isAlias: false,
          isExternal: !rustUse[1].startsWith('super::') && !rustUse[1].startsWith('crate::'),
          isResolved: false,
        });
      }

      // Go: func FunctionName(...)
      const goFunc = line.match(/^func\s+(?:\([^)]*\)\s+)?([a-zA-Z0-9_]+)\s*\(/);
      if (goFunc) {
        const name = goFunc[1];
        symbols.push({
          id: `${path}#${name}`,
          name,
          path,
          kind: 'function',
          lineRange: { startLine: lineNum, endLine: lineNum },
          isExported: /^[A-Z]/.test(name),
        });
      }

      // Rust: fn function_name(...) or pub fn function_name(...)
      const rustFn = line.match(/^(?:pub\s+)?fn\s+([a-zA-Z0-9_]+)\s*\(/);
      if (rustFn) {
        const name = rustFn[1];
        symbols.push({
          id: `${path}#${name}`,
          name,
          path,
          kind: 'function',
          lineRange: { startLine: lineNum, endLine: lineNum },
          isExported: line.startsWith('pub '),
        });
      }
    }

    return {
      path,
      language: path.endsWith('.go') ? 'Go' : path.endsWith('.rs') ? 'Rust' : 'Other',
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
