/**
 * investigateRequest.ts — Adapter from WorkspaceSnapshot to InvestigateApiRequest.
 *
 * Conforms strictly to src/domain/investigation/types.ts, validating room existence
 * and preserving strict status/evidence boundaries.
 */

import type { InvestigateApiRequest } from '../../../src/domain/investigation/types.ts';
import type { WorkspaceSnapshot } from './snapshot.ts';
import { getSnapshotExcerpt } from './snapshot.ts';

export interface ToInvestigateRequestOptions {
  bypassCache?: boolean;
}

function normalizeDependencies(deps?: unknown[]): string[] {
  if (!deps) return [];
  return deps.map((d) => {
    if (typeof d === 'string') return d;
    if (d && typeof d === 'object') {
      const conn = d as any;
      if (conn.sourceRoomId && conn.targetRoomId) {
        return `${conn.sourceRoomId}->${conn.targetRoomId}`;
      }
      return conn.id || String(d);
    }
    return String(d);
  });
}

/**
 * Adapts a WorkspaceSnapshot and target roomId into an InvestigateApiRequest.
 * Throws an Error if the roomId does not exist in the snapshot.
 */
export function toInvestigateRequest(
  snapshot: WorkspaceSnapshot,
  roomId: string,
  options: ToInvestigateRequestOptions = {}
): InvestigateApiRequest {
  const room = snapshot.rooms.find((r) => r.id === roomId);
  if (!room) {
    throw new Error(`Room with ID "${roomId}" not found in workspace snapshot "${snapshot.workspaceName}"`);
  }

  const inspectedFiles = snapshot.inspectedFiles.map((f) => ({
    path: f.path,
    category: f.category,
    sizeBytes: f.sizeBytes,
    contentExcerpt: getSnapshotExcerpt(snapshot, f.path) ?? '',
  }));

  const repoContext = {
    owner: 'local',
    repo: snapshot.workspaceName,
    branch: 'main',
    commitSha: snapshot.fingerprint,
    inspectedFiles,
    discoveredFilePaths: snapshot.discoveredFilePaths,
    detectedTechnologies: snapshot.detectedTechnologies,
    dependencies: room.dependencies || [],
    ciEvaluation: {
      status: 'inconclusive',
      isVerified: false,
      reason: 'Local workspace scan: automated CI check runs unavailable',
      checkRunsCount: 0,
      failedChecks: [],
    },
  };

  return {
    roomId: room.id,
    roomName: room.name,
    roomLayer: room.layer ?? 'core',
    roomStatus: room.status,
    roomEvidence: room.evidence ?? '',
    roomFilePaths: room.filePaths ?? [],
    bypassCache: options.bypassCache,
    repoContext,
  };
}
