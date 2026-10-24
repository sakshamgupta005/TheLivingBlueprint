/**
 * chatRequest.ts — Adapter from WorkspaceSnapshot to ChatApiRequest['repoContext'].
 *
 * Conforms strictly to the root server contract in src/server/types.ts,
 * populating local identity, fingerprint commitSha, real redacted excerpts,
 * and truthful room summaries without fabricating findings.
 */

import type { ChatApiRequest } from '../../../src/server/types.ts';
import type { WorkspaceSnapshot } from './snapshot.ts';
import { getSnapshotExcerpt } from './snapshot.ts';

export type ChatRepoContext = NonNullable<ChatApiRequest['repoContext']>;

/** Repository identity and redacted excerpts shared by chat and investigation requests. */
export function localRepoContextBase(snapshot: WorkspaceSnapshot) {
  return {
    owner: 'local',
    repo: snapshot.workspaceName,
    branch: 'main',
    commitSha: snapshot.fingerprint,
    inspectedFiles: snapshot.inspectedFiles.map((f) => ({
      path: f.path,
      category: f.category,
      sizeBytes: f.sizeBytes,
      contentExcerpt: getSnapshotExcerpt(snapshot, f.path) ?? '',
    })),
    discoveredFilePaths: snapshot.discoveredFilePaths,
    detectedTechnologies: snapshot.detectedTechnologies,
    // Local workspaces have no CI check runs; verification comes only from local test evidence.
    ciEvaluation: {
      status: 'inconclusive',
      isVerified: false,
      reason: 'Local workspace scan: automated CI check runs unavailable',
      checkRunsCount: 0,
      failedChecks: [],
    },
  };
}

/**
 * Adapts a WorkspaceSnapshot into the server ChatApiRequest['repoContext'] structure.
 */
export function toChatRepoContext(
  snapshot: WorkspaceSnapshot,
  selectedRoomId?: string
): ChatRepoContext {
  let roomSummaries = snapshot.rooms.map((r) => ({
    id: r.id,
    name: r.name,
    layer: r.layer,
    status: r.status,
    evidence: r.evidence ?? '',
    filePaths: r.filePaths ?? [],
  }));

  if (selectedRoomId) {
    const selectedIdx = roomSummaries.findIndex((r) => r.id === selectedRoomId);
    if (selectedIdx > 0) {
      const [selected] = roomSummaries.splice(selectedIdx, 1);
      roomSummaries = [selected, ...roomSummaries];
    }
  }

  const selectedRoom = selectedRoomId
    ? snapshot.rooms.find((r) => r.id === selectedRoomId)
    : undefined;

  return {
    ...localRepoContextBase(snapshot),
    totalFiles: snapshot.discoveredFilesCount,
    roomSummaries,
    dependencies: selectedRoom?.dependencies || [],
    investigationFindings: {},
  };
}
