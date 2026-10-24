/**
 * lenses.ts — Architecture lenses for the extension (P2-12).
 *
 * Reuses the shared domain analyzers and graph builders from
 * src/domain/architectureViews (the same pair buildArchitectureLensGraph uses)
 * so each lens also reports the analyzer's hasSufficientEvidence and reason.
 * Input is the snapshot's host-only, redacted excerpts. When evidence is
 * insufficient the graph is null and an explicit message is returned.
 *
 * Config lens: names only. Every default value and consumer expression is
 * stripped before the graph is built, so no configuration value can leak.
 *
 * Pure TypeScript: no vscode import, no React, no TypeScript compiler.
 */

import type { CanvasGraph } from '../../../src/domain/graph/types.ts';
import {
  analyzeStateTransitions,
  analyzeDataSchemas,
  analyzeConfigWiring,
  analyzeErrorPaths,
  buildCanvasFromStateTransitions,
  buildCanvasFromDataSchemas,
  buildCanvasFromConfigWiring,
  buildCanvasFromErrorPaths,
  type ArchitectureLensResult,
  type ConfigWiringModel,
} from '../../../src/domain/architectureViews/index.ts';
import { getSnapshotHostExcerpts, type WorkspaceSnapshot } from './snapshot.ts';

/** Existing GraphViewMode identifiers offered in the extension. */
export const LENS_IDS = [
  'modules',
  'state_transitions',
  'data_schema',
  'config_wiring',
  'error_paths',
  'module_hierarchy',
] as const;
export type LensId = (typeof LENS_IDS)[number];

export function isLensId(value: unknown): value is LensId {
  return LENS_IDS.includes(value as LensId);
}

export interface LensView {
  lensId: LensId;
  title: string;
  /** null whenever sufficientEvidence is false: never an empty graph posing as a result. */
  graph: CanvasGraph | null;
  sufficientEvidence: boolean;
  message?: string;
  stats?: Record<string, number>;
}

/** Strips values so the config lens can only show configuration names. */
function namesOnly(result: ArchitectureLensResult<ConfigWiringModel>): ArchitectureLensResult<ConfigWiringModel> {
  if (!result.model) return result;
  return {
    ...result,
    model: {
      ...result.model,
      configs: result.model.configs.map((c) => ({
        ...c,
        defaultValue: undefined,
        consumers: c.consumers.map((k) => ({ ...k, expression: `reads ${c.key}` })),
      })),
    },
  };
}

function fromAnalyzer<T>(
  lensId: LensId,
  result: ArchitectureLensResult<T>,
  build: (r: ArchitectureLensResult<T>) => CanvasGraph,
  inspectedCount: number
): LensView {
  if (!result.hasSufficientEvidence) {
    return {
      lensId,
      title: result.title,
      graph: null,
      sufficientEvidence: false,
      message:
        (result.reasonIfUnsupported || 'Not enough evidence in the inspected files for this lens.') +
        ` (Based on ${inspectedCount} inspected file(s); each excerpt is bounded.)`,
      stats: result.stats,
    };
  }
  return { lensId, title: result.title, graph: build(result), sufficientEvidence: true, stats: result.stats };
}

export function buildLensView(lensId: LensId, snapshot: WorkspaceSnapshot): LensView {
  const files = Object.fromEntries(getSnapshotHostExcerpts(snapshot));
  const inspected = snapshot.inspectedFiles.length;

  switch (lensId) {
    case 'modules':
      return snapshot.rooms.length > 0
        ? { lensId, title: 'Module graph', graph: snapshot.graph, sufficientEvidence: true }
        : { lensId, title: 'Module graph', graph: null, sufficientEvidence: false, message: 'No architecture rooms were mapped in this workspace.' };
    case 'state_transitions':
      return fromAnalyzer(lensId, analyzeStateTransitions({ files }), buildCanvasFromStateTransitions, inspected);
    case 'data_schema':
      return fromAnalyzer(lensId, analyzeDataSchemas({ files }), buildCanvasFromDataSchemas, inspected);
    case 'config_wiring':
      return fromAnalyzer(lensId, namesOnly(analyzeConfigWiring({ files })), buildCanvasFromConfigWiring, inspected);
    case 'error_paths':
      return fromAnalyzer(lensId, analyzeErrorPaths({ files }), buildCanvasFromErrorPaths, inspected);
    case 'module_hierarchy':
      return {
        lensId,
        title: 'Module hierarchy',
        graph: null,
        sufficientEvidence: false,
        message:
          'This lens needs the TypeScript code index, which is not bundled in the extension (deferred to a later milestone).',
      };
  }
}
