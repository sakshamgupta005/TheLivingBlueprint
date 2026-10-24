/**
 * investigateRequest.ts — Adapter from WorkspaceSnapshot to InvestigateApiRequest.
 *
 * Conforms strictly to src/domain/investigation/types.ts, validating room existence
 * and preserving strict status/evidence boundaries.
 */

import type { InvestigateApiRequest } from '../../../src/domain/investigation/types.ts';
import type { WorkspaceSnapshot } from './snapshot.ts';
import { localRepoContextBase } from './chatRequest.ts';

export interface ToInvestigateRequestOptions {
  bypassCache?: boolean;
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

  const repoContext = { ...localRepoContextBase(snapshot), dependencies: room.dependencies || [] };

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
