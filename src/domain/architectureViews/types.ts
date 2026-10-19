import type { GraphViewMode } from '../graph/types.ts';

export interface ArchitectureLensResult<T> {
  viewMode: GraphViewMode;
  title: string;
  hasSufficientEvidence: boolean;
  reasonIfUnsupported?: string;
  model: T | null;
  stats: Record<string, number>;
}

// 1. State-Transition Model
export interface DetectedState {
  id: string;
  label: string;
  value?: string;
  sourceFile: string;
  line: number;
  isInitial?: boolean;
  isFinal?: boolean;
}

export interface DetectedStateTransition {
  id: string;
  from: string;
  to: string;
  trigger?: string;
  sourceFile: string;
  line: number;
  evidence: string;
  confidence: 'observed' | 'inferred';
}

export interface StateMachineModel {
  name: string;
  sourceFile: string;
  states: DetectedState[];
  transitions: DetectedStateTransition[];
}

export interface StateTransitionModel {
  machines: StateMachineModel[];
  totalStates: number;
  totalTransitions: number;
}

// 2. Data / Schema Model
export type SchemaKind = 'sql_table' | 'orm_model' | 'validation_schema' | 'typed_interface';

export interface SchemaField {
  name: string;
  type: string;
  isPrimary?: boolean;
  isForeign?: boolean;
  referencesModel?: string;
  referencesField?: string;
  isNullable?: boolean;
  line?: number;
}

export interface DetectedSchemaModel {
  id: string;
  name: string;
  kind: SchemaKind;
  filePath: string;
  lineRange: { startLine: number; endLine: number };
  fields: SchemaField[];
  rawDefinition?: string;
}

export interface SchemaRelationship {
  id: string;
  sourceModel: string;
  targetModel: string;
  sourceField: string;
  targetField?: string;
  kind: 'foreign_key' | 'relation' | 'type_reference';
  evidence: string;
}

export interface DataSchemaModel {
  models: DetectedSchemaModel[];
  relationships: SchemaRelationship[];
  malformedSchemasCount: number;
  diagnostics: string[];
}

// 3. Configuration Wiring Model
export interface ConfigConsumer {
  filePath: string;
  functionName?: string;
  line: number;
  expression: string;
}

export interface DetectedConfigKey {
  key: string;
  isSecret: boolean;
  defaultValue?: string;
  sources: string[]; // e.g. ['.env', 'src/server.ts:12']
  consumers: ConfigConsumer[];
}

export interface ConfigWiringModel {
  configs: DetectedConfigKey[];
  totalKeys: number;
  secretKeysCount: number;
  totalReads: number;
}

// 4. Module Hierarchy Model
export interface ModuleCluster {
  id: string;
  name: string;
  directoryPath: string;
  modulePaths: string[];
  isCollapsed?: boolean;
}

export interface ModuleHierarchyItem {
  id: string;
  path: string;
  name: string;
  clusterId: string;
  imports: string[];
  importedBy: string[];
  isPartOfCycle: boolean;
  cycleParticipants?: string[];
}

export interface ModuleHierarchyModel {
  clusters: ModuleCluster[];
  modules: ModuleHierarchyItem[];
  circularDependencies: string[][];
  totalModules: number;
  totalClusters: number;
  circularModulesCount: number;
}

// 5. Error-Path Model
export interface DetectedErrorClass {
  name: string;
  baseClass: string;
  filePath: string;
  line: number;
}

export interface DetectedThrowSite {
  id: string;
  errorType: string;
  message?: string;
  filePath: string;
  line: number;
  enclosingFunction?: string;
  codeExcerpt: string;
}

export interface DetectedErrorHandler {
  id: string;
  filePath: string;
  lineRange: { startLine: number; endLine: number };
  handlerKind: 'try_catch' | 'middleware' | 'route_status_response';
  handledErrorType?: string;
  statusCode?: number;
  enclosingFunction?: string;
}

export interface DetectedErrorPath {
  id: string;
  throwSiteId: string;
  handlerId?: string;
  errorType: string;
  sourceFile: string;
  targetFile?: string;
  statusCode?: number;
  evidence: string;
}

export interface ErrorPathModel {
  errorClasses: DetectedErrorClass[];
  throwSites: DetectedThrowSite[];
  handlers: DetectedErrorHandler[];
  errorPaths: DetectedErrorPath[];
  totalErrorsDetected: number;
}
