import { getHostExcerpts, type WorkspaceBlueprintData } from './workspaceScanner.ts';
import { executeAiChat } from '../../src/server/aiProvider.ts';
import type {
  AiErrorInfo,
  ChatApiRequest,
  ChatApiResponse,
  CompanionReplyMessage,
  ExecutionTimingMetadata,
  ExplanationLevel,
} from '../../src/server/types.ts';
import { evaluateAiGate, guardFetch, type AiGateContext } from './security/aiGate.ts';
import { toChatRepoContext } from './core/chatRequest.ts';
import { createWorkspaceSnapshot, type WorkspaceSnapshot } from './core/snapshot.ts';
import type { ChatHistory } from './chatSession.ts';
import {
  validateEvidenceRefs,
  extractRefCandidates,
  type EvidenceRefCandidate,
  type EvidenceRefStatus,
} from './core/evidenceRefs.ts';

export interface EvidenceRef {
  file: string;
  line?: number;
  label?: string;
  /** Set by validateEvidenceRefs before a message leaves the host. */
  status?: EvidenceRefStatus;
  note?: string;
}

export interface CompanionMessage {
  id: string;
  speaker: 'dog' | 'cat';
  speakerName: string;
  tagline: string;
  text: string;
  /** Validated against the snapshot (P2-09); raw model paths are never forwarded. */
  evidenceRefs: EvidenceRef[];
  timestamp: string;
  isAiGenerated?: boolean;
  suggestedFollowUps?: string[];
  /** Cited references dropped because their path is not in the snapshot. */
  droppedReferenceCount?: number;
  /** Kept references that could not be fully verified (uninspected file or line beyond excerpt). */
  unverifiedReferenceCount?: number;
}

/**
 * Validates every reference on a message against the snapshot. Raw model
 * references are passed as extra candidates and never forwarded unvalidated.
 */
export function finalizeMessageRefs(
  message: CompanionMessage,
  data: WorkspaceBlueprintData,
  modelEvidenceReference?: string
): CompanionMessage {
  const candidates: EvidenceRefCandidate[] = [
    ...(modelEvidenceReference || message.isAiGenerated
      ? extractRefCandidates(message.text, modelEvidenceReference)
      : []),
    ...message.evidenceRefs.map((r) => ({ file: r.file, line: r.line })),
  ];
  const { refs, droppedCount, unverifiedCount } = validateEvidenceRefs(
    candidates,
    { discoveredFilePaths: data.discoveredFilePaths ?? [], inspectedFiles: data.inspectedFiles ?? [] },
    getHostExcerpts(data)
  );
  const note =
    droppedCount > 0
      ? `\n\n(${droppedCount} cited reference${droppedCount === 1 ? '' : 's'} could not be verified in this workspace and ${droppedCount === 1 ? 'was' : 'were'} removed.)`
      : '';
  return {
    ...message,
    text: message.text + note,
    evidenceRefs: refs,
    droppedReferenceCount: droppedCount,
    unverifiedReferenceCount: unverifiedCount,
  };
}

function asSnapshot(data: WorkspaceBlueprintData): WorkspaceSnapshot {
  return 'fingerprint' in data ? (data as WorkspaceSnapshot) : createWorkspaceSnapshot(data);
}

export interface CompanionAnalysisResult {
  timestamp: string;
  messages: CompanionMessage[];
  suggestedQuestions: string[];
}

const OFFLINE_LABEL = 'Offline (no AI call made)';

/**
 * Extracts file:line or file paths mentioned in text and returns structured references.
 */
export function extractEvidenceRefs(text: string, knownFiles: string[] = []): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  const seen = new Set<string>();

  // Match file.ext:line patterns
  const fileLineRegex = /([a-zA-Z0-9_.\-\/\\]+\.[a-zA-Z0-9]+):(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = fileLineRegex.exec(text)) !== null) {
    const rawPath = match[1].replace(/\\/g, '/');
    const line = parseInt(match[2], 10);
    const key = `${rawPath}:${line}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ file: rawPath, line, label: `${pathBasename(rawPath)}:${line}` });
    }
  }

  // Match known file paths without line numbers
  for (const kf of knownFiles) {
    const normalized = kf.replace(/\\/g, '/');
    if (text.includes(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      refs.push({ file: normalized, line: 1, label: pathBasename(normalized) });
    }
  }

  return refs;
}

function pathBasename(p: string): string {
  return p.split('/').pop() || p;
}

/**
 * Generates automatic workspace analysis grounded strictly in discovered architecture and evidence.
 * Barkley explains the architecture in friendly plain English;
 * Cleo challenges assumptions and calls out genuine evidence gaps (silent if none).
 */
export function generateAutomaticCompanionAnalysis(
  data: WorkspaceBlueprintData
): CompanionAnalysisResult {
  const timestamp = new Date().toISOString();
  const messages: CompanionMessage[] = [];

  const rooms = data.rooms || [];
  const roomNames = rooms.map((r) => r.name).join(', ');
  const totalDiscovered = data.discoveredFilesCount;
  const totalInspected = data.inspectedFilesCount;

  // 1. Identify primary entry point / manifest from inspected files
  const manifestFile = data.inspectedFiles.find((f) => f.category === 'manifest');
  const entryFile = data.inspectedFiles.find(
    (f) =>
      f.path.includes('App.') ||
      f.path.includes('main.') ||
      f.path.includes('index.') ||
      f.path.includes('server.')
  );
  const testFiles = data.inspectedFiles.filter((f) => f.category === 'test');

  const barkleyRefs: EvidenceRef[] = [];
  if (manifestFile) barkleyRefs.push({ file: manifestFile.path, line: 1, label: manifestFile.path });
  if (entryFile) barkleyRefs.push({ file: entryFile.path, line: 1, label: entryFile.path });

  // 2. Barkley: Plain-English Architectural Explanation (only observed facts)
  const entryDesc = entryFile ? ` A likely entry point by file name is ${entryFile.path}:1.` : '';

  const barkleyText =
    `Hello! I've mapped out ${data.workspaceName} across ${rooms.length} architecture rooms (${roomNames || 'none yet'}). ` +
    `We discovered ${totalDiscovered} total files in the workspace, with bounded in-depth inspection on ${totalInspected} high-importance files.` +
    `${entryDesc} Room statuses come from the deterministic status engine, not from me.`;

  messages.push({
    id: `msg-barkley-auto-${Date.now()}`,
    speaker: 'dog',
    speakerName: 'Barkley',
    tagline: 'Friendly · Architectural Teacher',
    text: barkleyText,
    evidenceRefs: barkleyRefs,
    timestamp,
    isAiGenerated: false,
  });

  // 3. Cleo: Skeptical Reviewer - ONLY speaks if genuine evidence gaps exist
  const cleoRefs: EvidenceRef[] = [];
  const gaps: string[] = [];

  // Gap 1: Test suites discovered in source, but zero live execution evidence
  const testRoom = rooms.find((r) => r.id === 'room-tests' || r.layer === 'gateway');
  if (testRoom && testRoom.status === 'implemented') {
    const sampleTest = testFiles[0]?.path;
    gaps.push(
      sampleTest
        ? `Test suite files exist (e.g. ${sampleTest}:1), but 0 live test execution records were verified. Code in ${testRoom.name} remains IMPLEMENTED rather than VERIFIED.`
        : `${testRoom.name} is IMPLEMENTED, but no test file was among the inspected files and 0 live test execution records exist.`
    );
    if (sampleTest) cleoRefs.push({ file: sampleTest, line: 1, label: sampleTest });
  }

  // Gap 2: Missing or unconfigured infrastructure pillars
  const missingPillars = (data.pillars || []).filter((p) => p.status === 'missing');
  if (missingPillars.length > 0) {
    const pNames = missingPillars.map((p) => p.name).join(', ');
    gaps.push(`Infrastructure pillars are unconfigured or missing: ${pNames}.`);
  }

  // Gap 3: Bounded inspection coverage gap
  if (totalDiscovered > totalInspected) {
    gaps.push(
      `Inspection budget capped at ${totalInspected} files out of ${totalDiscovered} discovered files. ${totalDiscovered - totalInspected} files remain uninspected.`
    );
  }

  // Cleo only outputs if there are concrete objections/gaps
  if (gaps.length > 0) {
    const cleoText =
      `Don't celebrate prematurely, Barkley. Look at the evidence gaps: ` +
      gaps.join(' ') +
      ` The Living Blueprint deterministic status engine strictly rejects claims of completion without verified test runs.`;

    messages.push({
      id: `msg-cleo-auto-${Date.now()}`,
      speaker: 'cat',
      speakerName: 'Cleo',
      tagline: 'Sassy · Skeptical Reviewer',
      text: cleoText,
      evidenceRefs: cleoRefs,
      timestamp,
      isAiGenerated: false,
    });
  }

  return {
    timestamp,
    messages: messages.map((m) => finalizeMessageRefs(m, data)),
    suggestedQuestions: [
      'Explain how the rooms connect',
      'What tests are missing verification?',
      'How does the status engine evaluate evidence?',
    ],
  };
}

/**
 * Legacy signature kept for existing callers: always offline, never a network call.
 * AI requests go through askCompanion (central P2-07 gate + shared executeAiChat).
 */
export async function answerCompanionQuery(
  question: string,
  data: WorkspaceBlueprintData,
  _apiKeys: unknown,
  _aiConsent: unknown
): Promise<CompanionMessage[]> {
  return generateLocalGroundedAnswer(question, data, new Date().toISOString()).map((m) =>
    finalizeMessageRefs(m, data)
  );
}

export interface AskCompanionOptions {
  selectedRoomId?: string;
  explanationLevel?: ExplanationLevel;
  history?: ChatHistory;
  investigationFindings?: Record<string, unknown>;
  /** Aborted when a newer question or a room switch supersedes this one. */
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}

export interface CompanionChatResult {
  /** 'ai' when an AI request was made (even if it failed), 'offline' when none was made. */
  mode: 'ai' | 'offline';
  messages: CompanionMessage[];
  /** Why no AI call was made (offline mode only). */
  offlineReason?: string;
  /** True when a newer question or room switch made this result stale; show nothing. */
  superseded?: boolean;
  providerUsed?: ChatApiResponse['providerUsed'];
  fallbackUsed?: boolean;
  cached?: boolean;
  timing?: ExecutionTimingMetadata;
  /** Set when the AI request failed (rate limit, quota, config, network...). No reply is invented. */
  errorInfo?: AiErrorInfo;
  error?: string;
  code?: ChatApiResponse['code'];
  warning?: string;
}

function abortError(): Error {
  const err = new Error('Companion request superseded');
  err.name = 'AbortError';
  return err;
}

/** Rejects provider calls once the signal is aborted (Node 18 has no AbortSignal.any). */
function abortableFetch(fetchFn: typeof fetch, signal?: AbortSignal): typeof fetch {
  if (!signal) return fetchFn;
  const wrapped = (...args: Parameters<typeof fetch>) =>
    signal.aborted ? Promise.reject(abortError()) : fetchFn(...args);
  return wrapped as typeof fetch;
}

function toCompanionMessage(
  reply: CompanionReplyMessage,
  idx: number,
  timestamp: string,
  snapshot: WorkspaceSnapshot
): CompanionMessage {
  const isDog = reply.speaker === 'dog';
  const message: CompanionMessage = {
    id: `msg-ai-${Date.now()}-${idx}`,
    speaker: reply.speaker,
    speakerName: isDog ? 'Barkley' : 'Cleo',
    tagline: isDog ? 'Friendly · Architectural Teacher' : 'Sassy · Skeptical Reviewer',
    text: reply.text,
    evidenceRefs: [],
    timestamp,
    isAiGenerated: true,
    suggestedFollowUps: reply.suggestedFollowUps,
  };
  // The raw model evidenceReference is consumed here and never forwarded.
  return finalizeMessageRefs(message, snapshot, reply.evidenceReference);
}

/** Maps model replies (chat or investigation) to validated companion messages. */
export function toValidatedCompanionMessages(
  replies: CompanionReplyMessage[],
  data: WorkspaceBlueprintData
): CompanionMessage[] {
  const timestamp = new Date().toISOString();
  return replies.map((r, idx) => toCompanionMessage(r, idx, timestamp, asSnapshot(data)));
}

/**
 * Answers a companion question through the shared web chat engine (executeAiChat)
 * when the central AI gate allows it; otherwise answers offline from the snapshot.
 * AI output only produces messages: it never touches room status or evidence.
 */
export async function askCompanion(
  question: string,
  data: WorkspaceBlueprintData,
  gateContext: AiGateContext,
  options: AskCompanionOptions = {}
): Promise<CompanionChatResult> {
  const timestamp = new Date().toISOString();
  const gate = await evaluateAiGate(gateContext);

  if (!gate.allowed) {
    return {
      mode: 'offline',
      offlineReason: gate.reason,
      messages: generateLocalGroundedAnswer(question, data, timestamp).map((m) => finalizeMessageRefs(m, data)),
    };
  }

  const snapshot = asSnapshot(data);

  const repoContext = toChatRepoContext(snapshot, options.selectedRoomId);
  if (options.investigationFindings) {
    repoContext.investigationFindings = options.investigationFindings;
  }

  const request: ChatApiRequest = {
    message: question,
    explanationLevel: options.explanationLevel,
    history: options.history ?? [],
    selectedRoomId: options.selectedRoomId,
    repoContext,
  };

  const fetchFn = abortableFetch(
    guardFetch(options.fetchFn ?? fetch, gateContext, gate.folderUri),
    options.signal
  );

  let response: ChatApiResponse;
  try {
    // Explicit env object: executeAiChat would otherwise default to process.env.
    // Hedged: the fastest configured provider answers; slow ones are cancelled.
    response = await executeAiChat(request, { ...gate.env }, fetchFn, { strategy: 'hedged' });
  } catch (err) {
    if (options.signal?.aborted) return { mode: 'ai', messages: [], superseded: true };
    return {
      mode: 'ai',
      messages: [],
      error: 'The AI request failed unexpectedly.',
      errorInfo: {
        kind: 'unknown',
        title: 'AI request failed',
        message: err instanceof Error && err.name === 'AbortError' ? 'Request was cancelled.' : 'Unexpected error while contacting the AI provider.',
        retryable: true,
      },
    };
  }

  if (options.signal?.aborted) {
    return { mode: 'ai', messages: [], superseded: true };
  }

  const meta = {
    providerUsed: response.providerUsed ?? response.provider,
    fallbackUsed: response.fallbackUsed,
    cached: response.cached,
    timing: response.timing,
    warning: response.warning,
  };

  if (!response.success) {
    return { mode: 'ai', messages: [], ...meta, error: response.error, code: response.code, errorInfo: response.errorInfo };
  }

  const replies = response.replies?.length ? response.replies : response.reply ? [response.reply] : [];
  return {
    mode: 'ai',
    ...meta,
    messages: replies.map((r, idx) => toCompanionMessage(r, idx, timestamp, snapshot)),
  };
}

/**
 * Offline answers use only observed snapshot fields and say that no AI call was made.
 */
function generateLocalGroundedAnswer(
  question: string,
  data: WorkspaceBlueprintData,
  timestamp: string
): CompanionMessage[] {
  const lowerQ = question.toLowerCase();
  const knownPaths = (data.inspectedFiles || []).map((f) => f.path);
  const rooms = data.rooms || [];
  const firstInspected = data.inspectedFiles[0]?.path;

  const barkley = (text: string, evidenceRefs: EvidenceRef[]): CompanionMessage => ({
    id: `msg-barkley-ans-${Date.now()}`,
    speaker: 'dog',
    speakerName: 'Barkley',
    tagline: 'Friendly · Architectural Teacher',
    text: `${OFFLINE_LABEL}: ${text}`,
    evidenceRefs,
    timestamp,
    isAiGenerated: false,
  });

  if (lowerQ.includes('test') || lowerQ.includes('verif') || lowerQ.includes('pass')) {
    const testFiles = data.inspectedFiles.filter((f) => f.category === 'test');
    const firstTest = testFiles[0]?.path;
    if (!firstTest) {
      return [
        barkley(
          `No test files were among the ${data.inspectedFilesCount} inspected files, so I can't point to any. Rooms stay unverified until real test execution evidence exists.`,
          []
        ),
      ];
    }
    return [
      barkley(
        `I found ${testFiles.length} inspected test file(s), e.g. ${firstTest}:1. Static scanning cannot run tests, so these prove implementation, not verification. Verified status needs real test execution or CI evidence.`,
        [{ file: firstTest, line: 1, label: firstTest }]
      ),
    ];
  }

  if (lowerQ.includes('room') || lowerQ.includes('connect') || lowerQ.includes('architecture')) {
    const roomList = rooms.map((r) => `${r.name} (${r.status.toUpperCase()})`).join(', ');
    const depCount = (data.dependencies || []).length;
    return [
      barkley(
        `${data.workspaceName} maps to ${rooms.length} room(s)${roomList ? `: ${roomList}` : ''}. The scanner recorded ${depCount} dependency link(s) between rooms.`,
        firstInspected ? [{ file: firstInspected, line: 1, label: firstInspected }] : []
      ),
    ];
  }

  const refs = extractEvidenceRefs(question, knownPaths);
  if (refs.length === 0 && firstInspected) {
    refs.push({ file: firstInspected, line: 1, label: firstInspected });
  }
  return [
    barkley(
      `I can only describe the scan without AI. ${data.workspaceName} has ${data.discoveredFilesCount} discovered and ${data.inspectedFilesCount} inspected files across ${rooms.length} room(s).` +
        (firstInspected ? ` The highest-priority inspected file is ${firstInspected}:1.` : ''),
      refs
    ),
  ];
}
