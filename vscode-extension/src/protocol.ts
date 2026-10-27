/**
 * protocol.ts — Typed, validated message protocol for Living Blueprint webview.
 *
 * Implements strict runtime validation and allowlist filtering for inbound
 * webview messages to prevent execution of unknown commands or malformed payloads.
 */

export const ALLOWED_COMMANDS = [
  'openFile',
  'refresh',
  'askCompanion',
  'selectRoom',
  'toggleAiConsent',
  'configureApiKey',
  'openEditorPanel',
  'selectFolder',
  'requestPayloadPreview',
  'clearConversation',
  'setExplanationLevel',
  'investigateRoom',
  'handoffRepairPrompt',
  'selectArchitectureLens',
  'requestEvidenceChain',
  'runProjectTests',
  'reinspectFinding',
  'requestBuildTasks',
  'createBuildTask',
  'buildTaskAction',
] as const;

/** Mirrors LENS_IDS in core/lenses.ts (existing GraphViewMode identifiers). */
export const ARCHITECTURE_LENS_IDS = [
  'modules',
  'state_transitions',
  'data_schema',
  'config_wiring',
  'error_paths',
  'module_hierarchy',
] as const;
export type ArchitectureLensIdValue = (typeof ARCHITECTURE_LENS_IDS)[number];

export const EXPLANATION_LEVELS = ['beginner', 'intermediate', 'technical'] as const;
export type ExplanationLevelValue = (typeof EXPLANATION_LEVELS)[number];

export type InboundCommand = (typeof ALLOWED_COMMANDS)[number];

export interface OpenFileMessage {
  command: 'openFile';
  path: string;
  line?: number;
}

export interface RefreshMessage {
  command: 'refresh';
}

export interface AskCompanionMessage {
  command: 'askCompanion';
  question: string;
  roomId?: string;
  explanationLevel?: ExplanationLevelValue;
}

export interface ClearConversationMessage {
  command: 'clearConversation';
}

export interface SetExplanationLevelMessage {
  command: 'setExplanationLevel';
  level: ExplanationLevelValue;
}

export interface SelectArchitectureLensMessage {
  command: 'selectArchitectureLens';
  lensId: ArchitectureLensIdValue;
}

export interface ReinspectFindingMessage {
  command: 'reinspectFinding';
  roomId: string;
}

export interface RunProjectTestsMessage {
  command: 'runProjectTests';
}

export interface RequestEvidenceChainMessage {
  command: 'requestEvidenceChain';
  roomId: string;
}

export interface HandoffRepairPromptMessage {
  command: 'handoffRepairPrompt';
  roomId: string;
  action: 'copy' | 'save';
}

export interface InvestigateRoomMessage {
  command: 'investigateRoom';
  roomId: string;
  /** Re-run even if the shared engine has a cached finding for this snapshot. */
  bypassCache?: boolean;
}

export interface SelectRoomMessage {
  command: 'selectRoom';
  roomId: string | null;
}

export interface ToggleAiConsentMessage {
  command: 'toggleAiConsent';
  enabled: boolean;
}

export interface ConfigureApiKeyMessage {
  command: 'configureApiKey';
}

export interface OpenEditorPanelMessage {
  command: 'openEditorPanel';
}

export interface SelectFolderMessage {
  command: 'selectFolder';
  folderPath: string;
}

export interface RequestPayloadPreviewMessage {
  command: 'requestPayloadPreview';
}

export const BUILD_TASK_STATUSES = [
  'planned',
  'ready',
  'handed_off',
  'implemented',
  'blocked',
] as const;
export type BuildTaskStatus = (typeof BUILD_TASK_STATUSES)[number];

export const BUILD_TASK_ACTIONS = [
  'approve',
  'previewPrompt',
  'copyPrompt',
  'markImplemented',
  'markBlocked',
  'reopen',
  'delete',
] as const;
export type BuildTaskAction = (typeof BUILD_TASK_ACTIONS)[number];

export interface RequestBuildTasksMessage {
  command: 'requestBuildTasks';
}

export interface CreateBuildTaskMessage {
  command: 'createBuildTask';
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

export interface BuildTaskActionMessage {
  command: 'buildTaskAction';
  taskId: string;
  action: BuildTaskAction;
  blockerNote?: string;
}

export type ValidInboundMessage =
  | RequestPayloadPreviewMessage
  | ClearConversationMessage
  | SetExplanationLevelMessage
  | InvestigateRoomMessage
  | HandoffRepairPromptMessage
  | SelectArchitectureLensMessage
  | RequestEvidenceChainMessage
  | RunProjectTestsMessage
  | ReinspectFindingMessage
  | RequestBuildTasksMessage
  | CreateBuildTaskMessage
  | BuildTaskActionMessage
  | OpenFileMessage
  | RefreshMessage
  | AskCompanionMessage
  | SelectRoomMessage
  | ToggleAiConsentMessage
  | ConfigureApiKeyMessage
  | OpenEditorPanelMessage
  | SelectFolderMessage;

export interface ValidationSuccess {
  valid: true;
  message: ValidInboundMessage;
}

export interface ValidationFailure {
  valid: false;
  reason: string;
  rejectedCommand?: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export interface ProtocolValidationOptions {
  validRoomIds?: Set<string> | string[];
}

let rejectedMessageCounter = 0;

export function getRejectedMessagesCount(): number {
  return rejectedMessageCounter;
}

export function resetRejectedMessagesCount(): void {
  rejectedMessageCounter = 0;
}

/** Counts and returns a validation failure. */
function reject(reason: string): ValidationFailure {
  rejectedMessageCounter++;
  return { valid: false, reason };
}

const MAX_PATH_LENGTH = 1024;
const MAX_QUESTION_LENGTH = 4096;
const MAX_ROOM_ID_LENGTH = 256;
const MIN_LINE_NUMBER = 1;
const MAX_LINE_NUMBER = 1_000_000;
export const MAX_TASK_TITLE_LENGTH = 160;
export const MAX_TASK_DESC_LENGTH = 2000;
export const MAX_TASK_CRITERIA_COUNT = 15;
export const MAX_TASK_CRITERIA_LENGTH = 400;
export const MAX_TASK_ID_LENGTH = 128;
export const MAX_BLOCKER_NOTE_LENGTH = 1000;

/** Validates a roomId that must exist in the current snapshot (no snapshot means no valid room). */
function requireRoomId(
  command: string,
  value: unknown,
  options: ProtocolValidationOptions
): { roomId: string } | ValidationFailure {
  const roomId = typeof value === 'string' ? value.trim() : '';
  const reason = !roomId
    ? `${command} requires a non-empty string roomId`
    : roomId.length > MAX_ROOM_ID_LENGTH
    ? `roomId exceeds max length of ${MAX_ROOM_ID_LENGTH}`
    : !new Set(options.validRoomIds ?? []).has(roomId)
    ? `Room ID '${roomId}' does not exist in active snapshot`
    : undefined;
  return reason ? reject(reason) : { roomId };
}

/** Validates a roomId that may be omitted; when present it must exist in the snapshot (if one is known). */
function optionalRoomId(
  command: string,
  value: unknown,
  options: ProtocolValidationOptions
): { roomId?: string } | ValidationFailure {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string') return reject(`${command} roomId must be a string or null`);
  const roomId = value.trim();
  if (roomId.length > MAX_ROOM_ID_LENGTH) return reject(`roomId exceeds max length of ${MAX_ROOM_ID_LENGTH}`);
  if (roomId && options.validRoomIds && !new Set(options.validRoomIds).has(roomId)) {
    return reject(`Room ID '${roomId}' does not exist in active snapshot`);
  }
  return { roomId: roomId || undefined };
}

/**
 * Validates an arbitrary inbound webview payload against the typed message protocol.
 */
export function validateInboundMessage(
  raw: unknown,
  options: ProtocolValidationOptions = {}
): ValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return reject('Payload must be a non-null object');
  }

  const obj = raw as Record<string, unknown>;
  const command = obj.command;

  if (typeof command !== 'string') {
    return reject('Message missing string command field');
  }

  if (!ALLOWED_COMMANDS.includes(command as InboundCommand)) {
    rejectedMessageCounter++;
    return {
      valid: false,
      reason: `Unknown or disallowed command: ${command.slice(0, 32)}`,
      rejectedCommand: command.slice(0, 32),
    };
  }

  switch (command as InboundCommand) {
    case 'openFile': {
      if (typeof obj.path !== 'string' || obj.path.trim().length === 0) {
        return reject('openFile requires a non-empty string path');
      }
      if (obj.path.length > MAX_PATH_LENGTH) {
        return reject(`path exceeds maximum length of ${MAX_PATH_LENGTH}`);
      }

      let parsedLine: number | undefined;
      if (obj.line !== undefined && obj.line !== null) {
        let num: number;
        if (typeof obj.line === 'number') {
          num = obj.line;
        } else if (typeof obj.line === 'string' && /^-?\d+(\.\d+)?$/.test(obj.line.trim())) {
          num = Number(obj.line.trim());
        } else {
          return reject('line must be an integer');
        }

        if (Number.isNaN(num) || !Number.isFinite(num) || !Number.isInteger(num)) {
          return reject('line must be a valid integer');
        }

        if (num < MIN_LINE_NUMBER) {
          return reject(`line must be greater than or equal to ${MIN_LINE_NUMBER}`);
        }

        // Clamp to maximum allowed line
        parsedLine = Math.min(MAX_LINE_NUMBER, Math.max(MIN_LINE_NUMBER, num));
      }

      return {
        valid: true,
        message: {
          command: 'openFile',
          path: obj.path,
          line: parsedLine,
        },
      };
    }

    case 'refresh': {
      return { valid: true, message: { command: 'refresh' } };
    }

    case 'openEditorPanel': {
      return { valid: true, message: { command: 'openEditorPanel' } };
    }

    case 'configureApiKey': {
      return { valid: true, message: { command: 'configureApiKey' } };
    }

    case 'requestPayloadPreview': {
      return { valid: true, message: { command: 'requestPayloadPreview' } };
    }

    case 'clearConversation': {
      return { valid: true, message: { command: 'clearConversation' } };
    }

    case 'setExplanationLevel': {
      if (!EXPLANATION_LEVELS.includes(obj.level as ExplanationLevelValue)) {
        return reject('level must be beginner, intermediate or technical');
      }
      return { valid: true, message: { command: 'setExplanationLevel', level: obj.level as ExplanationLevelValue } };
    }

    case 'investigateRoom': {
      const room = requireRoomId(command, obj.roomId, options);
      if ('valid' in room) return room;
      const { roomId } = room;
      if (obj.bypassCache !== undefined && typeof obj.bypassCache !== 'boolean') {
        return reject('bypassCache must be a boolean');
      }
      return { valid: true, message: { command: 'investigateRoom', roomId, bypassCache: obj.bypassCache === true } };
    }

    case 'handoffRepairPrompt': {
      const room = requireRoomId(command, obj.roomId, options);
      if ('valid' in room) return room;
      const { roomId } = room;
      if (obj.action !== 'copy' && obj.action !== 'save') {
        return reject("action must be 'copy' or 'save'");
      }
      return { valid: true, message: { command: 'handoffRepairPrompt', roomId, action: obj.action } };
    }

    case 'reinspectFinding': {
      const room = requireRoomId(command, obj.roomId, options);
      if ('valid' in room) return room;
      const { roomId } = room;
      return { valid: true, message: { command: 'reinspectFinding', roomId } };
    }

    case 'runProjectTests': {
      // No fields: the host chooses the observed command; the webview can never supply one.
      return { valid: true, message: { command: 'runProjectTests' } };
    }

    case 'selectArchitectureLens': {
      if (!ARCHITECTURE_LENS_IDS.includes(obj.lensId as ArchitectureLensIdValue)) {
        return reject('Unknown architecture lens id');
      }
      return { valid: true, message: { command: 'selectArchitectureLens', lensId: obj.lensId as ArchitectureLensIdValue } };
    }

    case 'requestEvidenceChain': {
      const room = requireRoomId(command, obj.roomId, options);
      if ('valid' in room) return room;
      const { roomId } = room;
      return { valid: true, message: { command: 'requestEvidenceChain', roomId } };
    }

    case 'toggleAiConsent': {
      if (typeof obj.enabled !== 'boolean') {
        return reject('toggleAiConsent requires a boolean enabled field');
      }
      return {
        valid: true,
        message: { command: 'toggleAiConsent', enabled: obj.enabled },
      };
    }

    case 'selectRoom': {
      const room = optionalRoomId(command, obj.roomId, options);
      if ('valid' in room) return room;
      return { valid: true, message: { command: 'selectRoom', roomId: room.roomId ?? null } };
    }

    case 'askCompanion': {
      if (typeof obj.question !== 'string' || obj.question.trim().length === 0) {
        return reject('askCompanion requires a non-empty string question');
      }
      if (obj.question.length > MAX_QUESTION_LENGTH) {
        return reject(`question exceeds maximum length of ${MAX_QUESTION_LENGTH}`);
      }

      const room = optionalRoomId(command, obj.roomId, options);
      if ('valid' in room) return room;
      const parsedRoomId = room.roomId;

      let explanationLevel: ExplanationLevelValue | undefined;
      if (obj.explanationLevel !== undefined && obj.explanationLevel !== null) {
        if (!EXPLANATION_LEVELS.includes(obj.explanationLevel as ExplanationLevelValue)) {
          return reject('explanationLevel must be beginner, intermediate or technical');
        }
        explanationLevel = obj.explanationLevel as ExplanationLevelValue;
      }

      return {
        valid: true,
        message: {
          command: 'askCompanion',
          question: obj.question.trim(),
          roomId: parsedRoomId || undefined,
          explanationLevel,
        },
      };
    }

    case 'selectFolder': {
      if (typeof obj.folderPath !== 'string' || obj.folderPath.trim().length === 0) {
        return reject('selectFolder requires a non-empty string folderPath');
      }
      if (obj.folderPath.length > MAX_PATH_LENGTH) {
        return reject(`folderPath exceeds maximum length of ${MAX_PATH_LENGTH}`);
      }
      return {
        valid: true,
        message: {
          command: 'selectFolder',
          folderPath: obj.folderPath,
        },
      };
    }

    case 'requestBuildTasks': {
      return { valid: true, message: { command: 'requestBuildTasks' } };
    }

    case 'createBuildTask': {
      if (typeof obj.title !== 'string' || obj.title.trim().length === 0) {
        return reject('createBuildTask requires a non-empty string title');
      }
      if (obj.title.length > MAX_TASK_TITLE_LENGTH) {
        return reject(`title exceeds maximum length of ${MAX_TASK_TITLE_LENGTH}`);
      }

      if (obj.description !== undefined && obj.description !== null) {
        if (typeof obj.description !== 'string') {
          return reject('description must be a string');
        }
        if (obj.description.length > MAX_TASK_DESC_LENGTH) {
          return reject(`description exceeds maximum length of ${MAX_TASK_DESC_LENGTH}`);
        }
      }

      if (obj.acceptanceCriteria !== undefined && obj.acceptanceCriteria !== null) {
        if (!Array.isArray(obj.acceptanceCriteria)) {
          return reject('acceptanceCriteria must be an array of strings');
        }
        if (obj.acceptanceCriteria.length > MAX_TASK_CRITERIA_COUNT) {
          return reject(`acceptanceCriteria exceeds maximum count of ${MAX_TASK_CRITERIA_COUNT}`);
        }
        for (const item of obj.acceptanceCriteria) {
          if (typeof item !== 'string') {
            return reject('acceptanceCriteria items must be strings');
          }
          if (item.length > MAX_TASK_CRITERIA_LENGTH) {
            return reject(`acceptanceCriteria item exceeds maximum length of ${MAX_TASK_CRITERIA_LENGTH}`);
          }
        }
      }

      const cleanedCriteria = Array.isArray(obj.acceptanceCriteria)
        ? obj.acceptanceCriteria.map((c) => String(c).trim()).filter((c) => c.length > 0)
        : [];

      return {
        valid: true,
        message: {
          command: 'createBuildTask',
          title: obj.title.trim(),
          description: typeof obj.description === 'string' ? obj.description.trim() : '',
          acceptanceCriteria: cleanedCriteria,
        },
      };
    }

    case 'buildTaskAction': {
      if (typeof obj.taskId !== 'string' || obj.taskId.trim().length === 0) {
        return reject('buildTaskAction requires a non-empty string taskId');
      }
      if (obj.taskId.length > MAX_TASK_ID_LENGTH) {
        return reject(`taskId exceeds maximum length of ${MAX_TASK_ID_LENGTH}`);
      }
      if (typeof obj.action !== 'string' || !BUILD_TASK_ACTIONS.includes(obj.action as BuildTaskAction)) {
        return reject(`action must be one of: ${BUILD_TASK_ACTIONS.join(', ')}`);
      }

      const rawNote = obj.blockerNote ?? obj.note;
      let blockerNote: string | undefined;
      if (rawNote !== undefined && rawNote !== null) {
        if (typeof rawNote !== 'string') {
          return reject('blockerNote must be a string');
        }
        if (rawNote.length > MAX_BLOCKER_NOTE_LENGTH) {
          return reject(`blockerNote exceeds maximum length of ${MAX_BLOCKER_NOTE_LENGTH}`);
        }
        blockerNote = rawNote.trim();
      }

      return {
        valid: true,
        message: {
          command: 'buildTaskAction',
          taskId: obj.taskId.trim(),
          action: obj.action as BuildTaskAction,
          blockerNote,
        },
      };
    }
  }
}

export interface FolderSelectionResult {
  accepted: boolean;
  activeFolderPath: string | undefined;
}

/**
 * Validates whether a requested folderPath is among the available workspace folders.
 */
export function handleFolderSelection(
  requestedFolder: string,
  availableFolders: Array<{ uri: { fsPath: string } }>,
  currentActiveFolder?: string
): FolderSelectionResult {
  const exists = availableFolders.some((f) => f.uri.fsPath === requestedFolder);
  if (!exists) {
    return { accepted: false, activeFolderPath: currentActiveFolder };
  }
  return { accepted: true, activeFolderPath: requestedFolder };
}
