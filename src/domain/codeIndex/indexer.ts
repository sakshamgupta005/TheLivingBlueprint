import type {
  CodeIndex,
  CodeRelationship,
  ExportStatement,
  ImportStatement,
  IndexedFileSummary,
  LanguageAdapter,
  ParseDiagnostic,
  ParsedFileResult,
  RouteRegistration,
  SymbolDefinition,
  UnresolvedImport,
} from './types.ts';
import { TypeScriptJavaScriptAdapter } from './adapters/tsJsAdapter.ts';
import { PythonLanguageAdapter } from './adapters/pythonAdapter.ts';
import { FallbackLanguageAdapter } from './adapters/fallbackAdapter.ts';
import {
  classifyUnresolvedReason,
  detectCircularDependencies,
  normalizeRepoPath,
  parseTsConfigPaths,
  resolveAliasImport,
  resolveRelativeImport,
} from './resolver.ts';

export interface BuildCodeIndexOptions {
  repositorySha?: string;
  files: Record<string, string>; // path -> content
  configFiles?: Record<string, string>; // tsconfig.json, jsconfig.json, etc.
  adapters?: LanguageAdapter[];
}

export function buildCodeIndex(options: BuildCodeIndexOptions): CodeIndex {
  const repositorySha = options.repositorySha || 'local-working-tree';
  const rawFiles = options.files || {};
  const adapters: LanguageAdapter[] = options.adapters || [
    new TypeScriptJavaScriptAdapter(),
    new PythonLanguageAdapter(),
    new FallbackLanguageAdapter(),
  ];

  // 1. Normalize available file paths
  const fileEntries: Array<{ normalizedPath: string; content: string }> = [];
  const availablePaths = new Set<string>();

  for (const [rawPath, content] of Object.entries(rawFiles)) {
    const normalized = normalizeRepoPath(rawPath);
    fileEntries.push({ normalizedPath: normalized, content });
    availablePaths.add(normalized);
  }

  // 2. Locate tsconfig.json / jsconfig.json for alias mappings
  let tsconfigConfig: ReturnType<typeof parseTsConfigPaths>;
  const tsconfigContent =
    options.configFiles?.['tsconfig.json'] ||
    options.configFiles?.['jsconfig.json'] ||
    rawFiles['tsconfig.json'] ||
    rawFiles['jsconfig.json'];

  if (tsconfigContent) {
    tsconfigConfig = parseTsConfigPaths(tsconfigContent);
  }

  // Helper to select language adapter
  function getAdapterForPath(path: string): LanguageAdapter {
    const lower = path.toLowerCase();
    for (const adapter of adapters) {
      if (adapter.supportedExtensions.some((ext) => lower.endsWith(ext))) {
        return adapter;
      }
    }
    return adapters[adapters.length - 1]; // fallback adapter
  }

  // 3. Parse each file
  const parsedResults: ParsedFileResult[] = [];
  const filesSummary: Record<string, IndexedFileSummary> = {};
  const allSymbols: SymbolDefinition[] = [];
  const allImports: ImportStatement[] = [];
  const allExports: ExportStatement[] = [];
  const allRoutes: RouteRegistration[] = [];
  const allDiagnostics: ParseDiagnostic[] = [];

  for (const { normalizedPath, content } of fileEntries) {
    const adapter = getAdapterForPath(normalizedPath);
    const parsed = adapter.parseFile(normalizedPath, content);

    parsedResults.push(parsed);
    allSymbols.push(...parsed.symbols);
    allImports.push(...parsed.imports);
    allExports.push(...parsed.exports);
    allRoutes.push(...parsed.routes);
    allDiagnostics.push(...parsed.diagnostics);

    filesSummary[normalizedPath] = {
      path: normalizedPath,
      language: parsed.language,
      analysisQuality: parsed.analysisQuality,
      symbolsCount: parsed.symbols.length,
      importsCount: parsed.imports.length,
      exportsCount: parsed.exports.length,
      routesCount: parsed.routes.length,
    };
  }

  // Index symbols by id and by (path + symbolName) for fast O(1) lookup
  const symbolsByPathAndName = new Map<string, SymbolDefinition>();
  for (const sym of allSymbols) {
    symbolsByPathAndName.set(`${sym.path}#${sym.name}`, sym);
  }

  // 4. Resolve Imports and Build Dependency Graph
  const relationships: CodeRelationship[] = [];
  const unresolvedImports: UnresolvedImport[] = [];
  const importGraph = new Map<string, Set<string>>();

  // Initialize graph
  for (const p of availablePaths) {
    importGraph.set(p, new Set());
  }

  let relationshipIdCounter = 1;

  for (const imp of allImports) {
    let resolvedPath: string | undefined;
    let isConfiguredAlias = false;

    if (imp.isRelative) {
      resolvedPath = resolveRelativeImport(imp.sourcePath, imp.rawSpecifier, availablePaths);
    } else if (imp.isAlias) {
      const aliasResult = resolveAliasImport(imp.rawSpecifier, tsconfigConfig, availablePaths);
      resolvedPath = aliasResult.resolvedPath;
      isConfiguredAlias = aliasResult.isConfiguredAlias;
    } else {
      // Check if non-relative specifier can be resolved via tsconfig alias
      const aliasResult = resolveAliasImport(imp.rawSpecifier, tsconfigConfig, availablePaths);
      if (aliasResult.resolvedPath) {
        resolvedPath = aliasResult.resolvedPath;
        isConfiguredAlias = true;
      }
    }

    if (resolvedPath) {
      imp.isResolved = true;
      imp.resolvedPath = resolvedPath;

      // Add to import graph for circular dependency detection
      const edges = importGraph.get(imp.sourcePath) || new Set();
      edges.add(resolvedPath);
      importGraph.set(imp.sourcePath, edges);

      // Record direct syntactic import relationship
      relationships.push({
        id: `rel-${relationshipIdCounter++}`,
        source: { path: imp.sourcePath },
        target: { path: resolvedPath },
        type: 'imports',
        provenance: 'syntax',
        confidence: 'confirmed',
        line: imp.line,
        evidence: `import ... from '${imp.rawSpecifier}'`,
      });
    } else {
      imp.isResolved = false;
      const reason = classifyUnresolvedReason(imp.rawSpecifier, imp.isRelative, isConfiguredAlias);
      imp.unresolvedReason = reason;

      if (reason !== 'external_package') {
        unresolvedImports.push({
          sourcePath: imp.sourcePath,
          specifier: imp.rawSpecifier,
          line: imp.line,
          reason,
          detail:
            reason === 'unresolvable_alias'
              ? `Configured alias "${imp.rawSpecifier}" did not match any file in inspected repository`
              : `Relative import target "${imp.rawSpecifier}" does not exist in repository files`,
        });

        // Record unresolved relationship explicitly without fabricating connection
        relationships.push({
          id: `rel-${relationshipIdCounter++}`,
          source: { path: imp.sourcePath },
          target: { path: imp.rawSpecifier },
          type: 'imports',
          provenance: 'unresolved',
          confidence: 'unresolved',
          line: imp.line,
          evidence: `Unresolved ${reason}: '${imp.rawSpecifier}'`,
        });
      }
    }
  }

  // 5. Resolve Re-Exports: export { a } from './b'
  for (const exp of allExports) {
    if (exp.isReExport && exp.reExportSpecifier) {
      let resolvedReExport: string | undefined;
      const isRelative = exp.reExportSpecifier.startsWith('./') || exp.reExportSpecifier.startsWith('../');

      if (isRelative) {
        resolvedReExport = resolveRelativeImport(exp.sourcePath, exp.reExportSpecifier, availablePaths);
      } else {
        const aliasResult = resolveAliasImport(exp.reExportSpecifier, tsconfigConfig, availablePaths);
        resolvedReExport = aliasResult.resolvedPath;
      }

      if (resolvedReExport) {
        exp.resolvedReExportPath = resolvedReExport;
        relationships.push({
          id: `rel-${relationshipIdCounter++}`,
          source: { path: exp.sourcePath, symbol: exp.exportedName },
          target: { path: resolvedReExport, symbol: exp.localName },
          type: 're_exports',
          provenance: 'syntax',
          confidence: 'confirmed',
          line: exp.line,
          evidence: `export { ${exp.exportedName} } from '${exp.reExportSpecifier}'`,
        });
      }
    }
  }

  // 6. Resolve Direct Syntactic Calls
  // For each call in parsedResults, check if it links to an imported symbol or local symbol
  for (const parsed of parsedResults) {
    const filePath = parsed.path;

    // Build a map of imported symbol name -> { targetPath, targetSymbolName }
    const importedSymbolsMap = new Map<string, { targetPath: string; targetSymbol: string }>();

    for (const imp of parsed.imports) {
      if (imp.isResolved && imp.resolvedPath) {
        for (const sym of imp.importedSymbols) {
          const localLookupName = sym.alias || sym.name;
          importedSymbolsMap.set(localLookupName, {
            targetPath: imp.resolvedPath,
            targetSymbol: sym.name,
          });
        }
      }
    }

    for (const call of parsed.calls) {
      // 1. Check if callee matches an imported symbol
      const imported = importedSymbolsMap.get(call.calleeName);
      if (imported) {
        const targetSymbolDef = symbolsByPathAndName.get(`${imported.targetPath}#${imported.targetSymbol}`);

        relationships.push({
          id: `rel-${relationshipIdCounter++}`,
          source: {
            path: filePath,
            symbol: call.callerSymbol,
          },
          target: {
            path: imported.targetPath,
            symbol: targetSymbolDef ? targetSymbolDef.id : `${imported.targetPath}#${imported.targetSymbol}`,
          },
          type: 'calls',
          provenance: 'syntax',
          confidence: 'confirmed',
          line: call.line,
          evidence: `Direct call to imported symbol "${call.calleeName}"`,
        });
        continue;
      }

      // 2. Check if callee is a locally declared function in the same file
      const localSymbol = symbolsByPathAndName.get(`${filePath}#${call.calleeName}`);
      if (localSymbol && call.callerSymbol !== localSymbol.id) {
        relationships.push({
          id: `rel-${relationshipIdCounter++}`,
          source: {
            path: filePath,
            symbol: call.callerSymbol,
          },
          target: {
            path: filePath,
            symbol: localSymbol.id,
          },
          type: 'calls',
          provenance: 'syntax',
          confidence: 'confirmed',
          line: call.line,
          evidence: `Direct local call to function "${call.calleeName}"`,
        });
      }

      // 3. Otherwise: DO NOT infer a cross-file relationship based on name similarity!
      // This strictly enforces:
      // "Distinguish direct syntactic relationships from heuristics and AI interpretations.
      //  Do not infer a confirmed call edge merely because two files have similar names."
    }
  }

  // 7. Resolve Class Heritage (extends / implements)
  for (const sym of allSymbols) {
    if (sym.heritage?.extends) {
      for (const baseName of sym.heritage.extends) {
        // Find if base class was imported or local
        let targetPath = sym.path;
        let targetSymbolId = `${sym.path}#${baseName}`;

        const fileImports = allImports.filter((i) => i.sourcePath === sym.path && i.isResolved);
        for (const imp of fileImports) {
          const match = imp.importedSymbols.find((s) => (s.alias || s.name) === baseName);
          if (match && imp.resolvedPath) {
            targetPath = imp.resolvedPath;
            targetSymbolId = `${imp.resolvedPath}#${match.name}`;
            break;
          }
        }

        relationships.push({
          id: `rel-${relationshipIdCounter++}`,
          source: { path: sym.path, symbol: sym.id },
          target: { path: targetPath, symbol: targetSymbolId },
          type: 'extends',
          provenance: 'syntax',
          confidence: 'confirmed',
          line: sym.lineRange.startLine,
          evidence: `class ${sym.name} extends ${baseName}`,
        });
      }
    }
  }

  // 8. Detect Circular Dependencies
  const circularDependencies = detectCircularDependencies(importGraph);

  // 9. Aggregate Statistics
  const syntaxErrorsCount = allDiagnostics.filter((d) => d.severity === 'error').length;

  return {
    repositorySha,
    indexedAt: new Date().toISOString(),
    files: filesSummary,
    symbols: allSymbols,
    imports: allImports,
    exports: allExports,
    relationships,
    routes: allRoutes,
    unresolvedImports,
    circularDependencies,
    diagnostics: allDiagnostics,
    stats: {
      filesIndexed: Object.keys(filesSummary).length,
      symbolsIndexed: allSymbols.length,
      relationshipsCount: relationships.length,
      routesCount: allRoutes.length,
      syntaxErrorsCount,
      circularDependencyCount: circularDependencies.length,
    },
  };
}
