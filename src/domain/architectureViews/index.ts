import type { CodeIndex } from '../codeIndex/types.ts';
import type { CanvasGraph, GraphViewMode } from '../graph/types.ts';
import { analyzeStateTransitions } from './stateTransitionAnalyzer.ts';
import { analyzeDataSchemas } from './dataSchemaAnalyzer.ts';
import { analyzeConfigWiring } from './configWiringAnalyzer.ts';
import { analyzeModuleHierarchy } from './moduleHierarchyAnalyzer.ts';
import { analyzeErrorPaths } from './errorPathAnalyzer.ts';
import {
  buildCanvasFromStateTransitions,
  buildCanvasFromDataSchemas,
  buildCanvasFromConfigWiring,
  buildCanvasFromModuleHierarchy,
  buildCanvasFromErrorPaths,
} from './viewGraphBuilder.ts';

export * from './types.ts';
export * from './stateTransitionAnalyzer.ts';
export * from './dataSchemaAnalyzer.ts';
export * from './configWiringAnalyzer.ts';
export * from './moduleHierarchyAnalyzer.ts';
export * from './errorPathAnalyzer.ts';
export * from './viewGraphBuilder.ts';

export interface ArchitectureLensOptions {
  files?: Record<string, string>;
  codeIndex?: CodeIndex;
}

/**
 * Builds an interactive CanvasGraph for the given architecture lens mode.
 * Returns empty/unsupported graph with truthful explanation when evidence is insufficient.
 */
export function buildArchitectureLensGraph(
  viewMode: GraphViewMode,
  options: ArchitectureLensOptions
): CanvasGraph | null {
  const files = options.files || {};
  const codeIndex = options.codeIndex;

  switch (viewMode) {
    case 'state_transitions': {
      const result = analyzeStateTransitions({ files });
      return buildCanvasFromStateTransitions(result);
    }

    case 'data_schema': {
      const result = analyzeDataSchemas({ files });
      return buildCanvasFromDataSchemas(result);
    }

    case 'config_wiring': {
      const result = analyzeConfigWiring({ files });
      return buildCanvasFromConfigWiring(result);
    }

    case 'module_hierarchy': {
      if (!codeIndex) return null;
      const result = analyzeModuleHierarchy({ codeIndex });
      return buildCanvasFromModuleHierarchy(result);
    }

    case 'error_paths': {
      const result = analyzeErrorPaths({ files });
      return buildCanvasFromErrorPaths(result);
    }

    default:
      return null;
  }
}
