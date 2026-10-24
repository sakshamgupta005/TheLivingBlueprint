/**
 * investigationService.ts — Room investigation inside the IDE (P2-10).
 *
 * Uses the shared executeRoomInvestigation engine (which already runs
 * validateInvestigationFinding and generateRepairPrompt) behind the P2-07 AI
 * gate. Findings are stored per folder and room, keyed to the snapshot
 * fingerprint: a changed fingerprint marks them stale, never deletes them,
 * and a failed investigation keeps the previous finding.
 *
 * Findings are advisory only: nothing here touches room status or evidence.
 * Pure TypeScript: no vscode import.
 */

import { executeRoomInvestigation } from '../../src/server/investigationProvider.ts';
import type { InvestigateApiResponse, RoomInvestigationFinding } from '../../src/domain/investigation/types.ts';
import type { AiErrorInfo, ExecutionTimingMetadata } from '../../src/server/types.ts';
import { evaluateAiGate, guardFetch, type AiGateContext, type AiState } from './security/aiGate.ts';
import { toInvestigateRequest } from './core/investigateRequest.ts';
import { asSnapshot, type WorkspaceSnapshot } from './core/snapshot.ts';
import {
  validateEvidenceRefs,
  type EvidenceRefCandidate,
  type ValidatedEvidenceRef as NavigableRef,
} from './core/evidenceRefs.ts';
import type { WorkspaceBlueprintData } from './workspaceScanner.ts';
import { toValidatedCompanionMessages, type CompanionMessage } from './companionEngine.ts';
import { baselineHashesFor, type ReinspectionResult } from './core/localReinspection.ts';

export interface StoredFinding {
  roomId: string;
  fingerprint: string;
  investigatedAt: string;
  /** The domain finding exactly as the shared engine validated it (githubUrl removed for local files). */
  finding: RoomInvestigationFinding;
  /** Clickable references re-checked against the snapshot by the P2-09 validator. */
  navigation: { references: NavigableRef[]; droppedCount: number };
  companionMessages: CompanionMessage[];
  /** SHA-256 of each cited inspected file when the finding was produced (P2-14 baseline). */
  sourceHashes?: Record<string, string>;
  /** Local re-inspections attached to this finding, newest last (bounded). */
  reinspections?: ReinspectionResult[];
}

const MAX_REINSPECTIONS = 5;

export interface FindingView extends StoredFinding {
  /** True when the workspace changed since this finding was produced. */
  stale: boolean;
}

export interface FindingsMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface FindingsStore {
  get(folderUri: string, roomId: string, currentFingerprint: string): FindingView | undefined;
  all(folderUri: string, currentFingerprint: string): Record<string, FindingView>;
  save(folderUri: string, record: StoredFinding): Promise<void>;
  /** Non-stale findings in the shape ChatApiRequest.investigationFindings expects. */
  currentFindings(folderUri: string, currentFingerprint: string): Record<string, RoomInvestigationFinding>;
  /** Appends a re-inspection to the stored finding; the original finding is never modified. */
  attachReinspection(folderUri: string, roomId: string, result: ReinspectionResult): Promise<void>;
}

const KEY_PREFIX = 'livingBlueprint.findings.v1:';

export function createFindingsStore(memento: FindingsMemento): FindingsStore {
  const read = (folderUri: string): Record<string, StoredFinding> => {
    const value = memento.get<unknown>(KEY_PREFIX + folderUri);
    return value && typeof value === 'object' ? (value as Record<string, StoredFinding>) : {};
  };
  const view = (r: StoredFinding, fp: string): FindingView => ({ ...r, stale: r.fingerprint !== fp });

  return {
    get(folderUri, roomId, fp) {
      const record = read(folderUri)[roomId];
      return record ? view(record, fp) : undefined;
    },
    all(folderUri, fp) {
      return Object.fromEntries(Object.entries(read(folderUri)).map(([id, r]) => [id, view(r, fp)]));
    },
    async save(folderUri, record) {
      await memento.update(KEY_PREFIX + folderUri, { ...read(folderUri), [record.roomId]: record });
    },
    currentFindings(folderUri, fp) {
      return Object.fromEntries(
        Object.entries(read(folderUri))
          .filter(([, r]) => r.fingerprint === fp)
          .map(([id, r]) => [id, r.finding])
      );
    },
    async attachReinspection(folderUri, roomId, result) {
      const all = read(folderUri);
      const record = all[roomId];
      if (!record) return;
      const reinspections = [...(record.reinspections ?? []), result].slice(-MAX_REINSPECTIONS);
      await memento.update(KEY_PREFIX + folderUri, { ...all, [roomId]: { ...record, reinspections } });
    },
  };
}

interface OutcomeMeta {
  providerUsed?: InvestigateApiResponse['providerUsed'];
  fallbackUsed?: boolean;
  cached?: boolean;
  timing?: ExecutionTimingMetadata;
}

export type InvestigationOutcome =
  | { status: 'success'; roomId: string; record: FindingView; meta: OutcomeMeta }
  | { status: 'invalid_room'; roomId: string; reason: string }
  /** AI is blocked or not configured: no request made, no finding invented. */
  | { status: 'unavailable'; roomId: string; state: Exclude<AiState, 'ready'>; reason: string; previous?: FindingView }
  /** The request was made and failed; the previous finding (if any) is preserved untouched. */
  | {
      status: 'error';
      roomId: string;
      errorInfo?: AiErrorInfo;
      error?: string;
      code?: InvestigateApiResponse['code'];
      previous?: FindingView;
      meta: OutcomeMeta;
    };

export interface InvestigateRoomParams {
  roomId: string;
  data: WorkspaceBlueprintData;
  folderUri: string;
  gateContext: AiGateContext;
  store: FindingsStore;
  bypassCache?: boolean;
  fetchFn?: typeof fetch;
}

/** Local workspaces have no GitHub URL; the domain validator builds one from owner "local". */
function withoutGithubUrls(finding: RoomInvestigationFinding): RoomInvestigationFinding {
  return {
    ...finding,
    evidenceReferences: finding.evidenceReferences.map(({ githubUrl: _ignored, ...ref }) => ref),
  };
}

function navigableRefs(finding: RoomInvestigationFinding, snapshot: WorkspaceSnapshot) {
  const candidates: EvidenceRefCandidate[] = finding.evidenceReferences.map((r) => ({
    file: r.path,
    line: r.derivedLineNumber,
    identifier: r.verifiedIdentifier,
  }));
  if (finding.codeEvidence?.filePath) {
    candidates.push({
      file: finding.codeEvidence.filePath,
      line: finding.codeEvidence.derivedLineNumber,
      identifier: finding.codeEvidence.targetIdentifier,
    });
  }
  const { refs, droppedCount } = validateEvidenceRefs(candidates, snapshot);
  return { references: refs, droppedCount };
}

export async function investigateRoom(params: InvestigateRoomParams): Promise<InvestigationOutcome> {
  const { roomId, data, folderUri, gateContext, store } = params;
  const snapshot = asSnapshot(data);

  if (!snapshot.rooms.some((r) => r.id === roomId)) {
    return { status: 'invalid_room', roomId, reason: 'Room is not in the current workspace snapshot' };
  }

  const previous = store.get(folderUri, roomId, snapshot.fingerprint);
  const gate = await evaluateAiGate(gateContext);
  if (!gate.allowed) {
    return { status: 'unavailable', roomId, state: gate.state, reason: gate.reason, previous };
  }

  const request = toInvestigateRequest(snapshot, roomId, { bypassCache: params.bypassCache });
  const fetchFn = guardFetch(params.fetchFn ?? fetch, gateContext, gate.folderUri);

  let response: InvestigateApiResponse;
  try {
    // Explicit env object: executeRoomInvestigation would otherwise default to process.env.
    response = await executeRoomInvestigation(request, { ...gate.env }, fetchFn, { strategy: 'hedged' });
  } catch {
    return {
      status: 'error',
      roomId,
      previous,
      meta: {},
      error: 'The investigation request failed unexpectedly.',
      errorInfo: { kind: 'unknown', title: 'Investigation failed', message: 'Unexpected error while contacting the AI provider.', retryable: true },
    };
  }

  const meta: OutcomeMeta = {
    providerUsed: response.providerUsed ?? response.provider,
    fallbackUsed: response.fallbackUsed,
    cached: response.cached,
    timing: response.timing,
  };

  if (!response.success || !response.finding) {
    return { status: 'error', roomId, previous, meta, error: response.error, code: response.code, errorInfo: response.errorInfo };
  }

  const finding = withoutGithubUrls(response.finding);
  const navigation = navigableRefs(finding, snapshot);
  const record: StoredFinding = {
    roomId,
    fingerprint: snapshot.fingerprint,
    investigatedAt: new Date().toISOString(),
    finding,
    navigation,
    companionMessages: toValidatedCompanionMessages(finding.companionMessages ?? [], data),
    sourceHashes: baselineHashesFor(navigation.references.map((r) => r.file), snapshot),
  };
  await store.save(folderUri, record);
  return { status: 'success', roomId, record: { ...record, stale: false }, meta };
}
