/**
 * Types for the Real Code Structure and Deterministic Dependency Index (T24).
 * Provides a UI-independent source of truth for symbols, relationships, routes,
 * and provenance-backed dependency analysis.
 */

export type AnalysisQuality = 'full_ast' | 'pattern_ast' | 'shallow' | 'unsupported';

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'variable'
  | 'interface'
  | 'type'
  | 'route_handler'
  | 'enum';

export type RelationshipType =
  | 'imports'
  | 're_exports'
  | 'calls'
  | 'extends'
  | 'implements'
  | 'routes_to'
  | 'references';

export type RelationshipProvenance = 'syntax' | 'heuristic' | 'unresolved';

export type RelationshipConfidence = 'confirmed' | 'probable' | 'unresolved';

export type UnresolvedReason =
  | 'unresolved_relative_path'
  | 'unresolvable_alias'
  | 'external_package'
  | 'missing_target_file'
  | 'syntax_error'
  | 'unresolved_symbol';

export interface SourceLineRange {
  startLine: number;
  endLine: number;
}

export interface SymbolDefinition {
  id: string; // e.g. "src/server.ts#startServer"
  name: string;
  path: string;
  kind: SymbolKind;
  lineRange: SourceLineRange;
  isExported: boolean;
  signature?: string;
  heritage?: {
    extends?: string[];
    implements?: string[];
  };
}

export interface ImportedSymbolRef {
  name: string;
  alias?: string;
  isDefault?: boolean;
  isNamespace?: boolean;
}

export interface ImportStatement {
  sourcePath: string;
  rawSpecifier: string;
  importedSymbols: ImportedSymbolRef[];
  line: number;
  isRelative: boolean;
  isAlias: boolean;
  isExternal: boolean;
  resolvedPath?: string;
  isResolved: boolean;
  unresolvedReason?: UnresolvedReason;
}

export interface ExportStatement {
  sourcePath: string;
  exportedName: string;
  localName: string;
  isDefault: boolean;
  isReExport: boolean;
  reExportSpecifier?: string;
  resolvedReExportPath?: string;
  line: number;
}

export interface CodeRelationship {
  id: string;
  source: {
    path: string;
    symbol?: string;
  };
  target: {
    path: string;
    symbol?: string;
  };
  type: RelationshipType;
  provenance: RelationshipProvenance;
  confidence: RelationshipConfidence;
  line: number;
  evidence: string;
}

export interface RouteRegistration {
  id: string;
  method: string;
  routePath: string;
  sourcePath: string;
  lineRange: SourceLineRange;
  handlerSymbol?: string;
  framework: 'express' | 'fastapi' | 'flask' | 'nextjs' | 'koa' | 'generic';
  evidence: string;
}

export interface ParseDiagnostic {
  path: string;
  message: string;
  line: number;
  severity: 'error' | 'warning';
}

export interface UnresolvedImport {
  sourcePath: string;
  specifier: string;
  line: number;
  reason: UnresolvedReason;
  detail: string;
}

export interface IndexedFileSummary {
  path: string;
  language: string;
  analysisQuality: AnalysisQuality;
  symbolsCount: number;
  importsCount: number;
  exportsCount: number;
  routesCount: number;
}

export interface CodeIndex {
  repositorySha: string;
  indexedAt: string;
  files: Record<string, IndexedFileSummary>;
  symbols: SymbolDefinition[];
  imports: ImportStatement[];
  exports: ExportStatement[];
  relationships: CodeRelationship[];
  routes: RouteRegistration[];
  unresolvedImports: UnresolvedImport[];
  circularDependencies: string[][];
  diagnostics: ParseDiagnostic[];
  stats: {
    filesIndexed: number;
    symbolsIndexed: number;
    relationshipsCount: number;
    routesCount: number;
    syntaxErrorsCount: number;
    circularDependencyCount: number;
  };
}

export interface ParsedFileResult {
  path: string;
  language: string;
  analysisQuality: AnalysisQuality;
  symbols: SymbolDefinition[];
  imports: ImportStatement[];
  exports: ExportStatement[];
  routes: RouteRegistration[];
  calls: Array<{
    callerSymbol?: string;
    calleeName: string;
    line: number;
    evidence: string;
  }>;
  diagnostics: ParseDiagnostic[];
}

export interface LanguageAdapter {
  id: string;
  name: string;
  supportedExtensions: string[];
  analysisQuality: AnalysisQuality;
  parseFile(path: string, content: string): ParsedFileResult;
}

export interface TsConfigPathsConfig {
  baseUrl?: string;
  paths?: Record<string, string[]>;
}
