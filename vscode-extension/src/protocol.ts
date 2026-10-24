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

const MAX_PATH_LENGTH = 1024;
const MAX_QUESTION_LENGTH = 4096;
const MAX_ROOM_ID_LENGTH = 256;
const MIN_LINE_NUMBER = 1;
const MAX_LINE_NUMBER = 1_000_000;

/**
 * Validates an arbitrary inbound webview payload against the typed message protocol.
 */
export function validateInboundMessage(
  raw: unknown,
  options: ProtocolValidationOptions = {}
): ValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    rejectedMessageCounter++;
    return { valid: false, reason: 'Payload must be a non-null object' };
  }

  const obj = raw as Record<string, unknown>;
  const command = obj.command;

  if (typeof command !== 'string') {
    rejectedMessageCounter++;
    return { valid: false, reason: 'Message missing string command field' };
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
        rejectedMessageCounter++;
        return { valid: false, reason: 'openFile requires a non-empty string path' };
      }
      if (obj.path.length > MAX_PATH_LENGTH) {
        rejectedMessageCounter++;
        return { valid: false, reason: `path exceeds maximum length of ${MAX_PATH_LENGTH}` };
      }

      let parsedLine: number | undefined;
      if (obj.line !== undefined && obj.line !== null) {
        let num: number;
        if (typeof obj.line === 'number') {
          num = obj.line;
        } else if (typeof obj.line === 'string' && /^-?\d+(\.\d+)?$/.test(obj.line.trim())) {
          num = Number(obj.line.trim());
        } else {
          rejectedMessageCounter++;
          return { valid: false, reason: 'line must be an integer' };
        }

        if (Number.isNaN(num) || !Number.isFinite(num) || !Number.isInteger(num)) {
          rejectedMessageCounter++;
          return { valid: false, reason: 'line must be a valid integer' };
        }

        if (num < MIN_LINE_NUMBER) {
          rejectedMessageCounter++;
          return { valid: false, reason: `line must be greater than or equal to ${MIN_LINE_NUMBER}` };
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
        rejectedMessageCounter++;
        return { valid: false, reason: 'level must be beginner, intermediate or technical' };
      }
      return { valid: true, message: { command: 'setExplanationLevel', level: obj.level as ExplanationLevelValue } };
    }

    case 'investigateRoom': {
      if (typeof obj.roomId !== 'string' || obj.roomId.trim().length === 0) {
        rejectedMessageCounter++;
        return { valid: false, reason: 'investigateRoom requires a non-empty string roomId' };
      }
      const roomId = obj.roomId.trim();
      if (roomId.length > MAX_ROOM_ID_LENGTH) {
        rejectedMessageCounter++;
        return { valid: false, reason: `roomId exceeds max length of ${MAX_ROOM_ID_LENGTH}` };
      }
      // Without a snapshot there is no valid room to investigate.
      const idSet = options.validRoomIds instanceof Set ? options.validRoomIds : new Set(options.validRoomIds ?? []);
      if (!idSet.has(roomId)) {
        rejectedMessageCounter++;
        return { valid: false, reason: `Room ID '${roomId}' does not exist in active snapshot` };
      }
      if (obj.bypassCache !== undefined && typeof obj.bypassCache !== 'boolean') {
        rejectedMessageCounter++;
        return { valid: false, reason: 'bypassCache must be a boolean' };
      }
      return { valid: true, message: { command: 'investigateRoom', roomId, bypassCache: obj.bypassCache === true } };
    }

    case 'handoffRepairPrompt': {
      if (typeof obj.roomId !== 'string' || obj.roomId.trim().length === 0 || obj.roomId.length > MAX_ROOM_ID_LENGTH) {
        rejectedMessageCounter++;
        return { valid: false, reason: 'handoffRepairPrompt requires a valid roomId' };
      }
      const roomId = obj.roomId.trim();
      const idSet = options.validRoomIds instanceof Set ? options.validRoomIds : new Set(options.validRoomIds ?? []);
      if (!idSet.has(roomId)) {
        rejectedMessageCounter++;
        return { valid: false, reason: `Room ID '${roomId}' does not exist in active snapshot` };
      }
      if (obj.action !== 'copy' && obj.action !== 'save') {
        rejectedMessageCounter++;
        return { valid: false, reason: "action must be 'copy' or 'save'" };
      }
      return { valid: true, message: { command: 'handoffRepairPrompt', roomId, action: obj.action } };
    }

    case 'reinspectFinding': {
      if (typeof obj.roomId !== 'string' || obj.roomId.trim().length === 0 || obj.roomId.length > MAX_ROOM_ID_LENGTH) {
        rejectedMessageCounter++;
        return { valid: false, reason: 'reinspectFinding requires a valid roomId' };
      }
      const roomId = obj.roomId.trim();
      const idSet = options.validRoomIds instanceof Set ? options.validRoomIds : new Set(options.validRoomIds ?? []);
      if (!idSet.has(roomId)) {
        rejectedMessageCounter++;
        return { valid: false, reason: `Room ID '${roomId}' does not exist in active snapshot` };
      }
      return { valid: true, message: { command: 'reinspectFinding', roomId } };
    }

    case 'runProjectTests': {
      // No fields: the host chooses the observed command; the webview can never supply one.
      return { valid: true, message: { command: 'runProjectTests' } };
    }

    case 'selectArchitectureLens': {
      if (!ARCHITECTURE_LENS_IDS.includes(obj.lensId as ArchitectureLensIdValue)) {
        rejectedMessageCounter++;
        return { valid: false, reason: 'Unknown architecture lens id' };
      }
      return { valid: true, message: { command: 'selectArchitectureLens', lensId: obj.lensId as ArchitectureLensIdValue } };
    }

    case 'requestEvidenceChain': {
      if (typeof obj.roomId !== 'string' || obj.roomId.trim().length === 0 || obj.roomId.length > MAX_ROOM_ID_LENGTH) {
        rejectedMessageCounter++;
        return { valid: false, reason: 'requestEvidenceChain requires a valid roomId' };
      }
      const roomId = obj.roomId.trim();
      const idSet = options.validRoomIds instanceof Set ? options.validRoomIds : new Set(options.validRoomIds ?? []);
      if (!idSet.has(roomId)) {
        rejectedMessageCounter++;
        return { valid: false, reason: `Room ID '${roomId}' does not exist in active snapshot` };
      }
      return { valid: true, message: { command: 'requestEvidenceChain', roomId } };
    }

    case 'toggleAiConsent': {
      if (typeof obj.enabled !== 'boolean') {
        rejectedMessageCounter++;
        return { valid: false, reason: 'toggleAiConsent requires a boolean enabled field' };
      }
      return {
        valid: true,
        message: { command: 'toggleAiConsent', enabled: obj.enabled },
      };
    }

    case 'selectRoom': {
      if (obj.roomId === null || obj.roomId === undefined) {
        return { valid: true, message: { command: 'selectRoom', roomId: null } };
      }

      if (typeof obj.roomId !== 'string') {
        rejectedMessageCounter++;
        return { valid: false, reason: 'selectRoom roomId must be string or null' };
      }

      const roomId = obj.roomId.trim();
      if (roomId.length > MAX_ROOM_ID_LENGTH) {
        rejectedMessageCounter++;
        return { valid: false, reason: `roomId exceeds max length of ${MAX_ROOM_ID_LENGTH}` };
      }

      if (options.validRoomIds) {
        const idSet =
          options.validRoomIds instanceof Set
            ? options.validRoomIds
            : new Set(options.validRoomIds);
        if (roomId.length > 0 && !idSet.has(roomId)) {
          rejectedMessageCounter++;
          return { valid: false, reason: `Room ID '${roomId}' does not exist in active snapshot` };
        }
      }

      return {
        valid: true,
        message: { command: 'selectRoom', roomId: roomId || null },
      };
    }

    case 'askCompanion': {
      if (typeof obj.question !== 'string' || obj.question.trim().length === 0) {
        rejectedMessageCounter++;
        return { valid: false, reason: 'askCompanion requires a non-empty string question' };
      }
      if (obj.question.length > MAX_QUESTION_LENGTH) {
        rejectedMessageCounter++;
        return {
          valid: false,
          reason: `question exceeds maximum length of ${MAX_QUESTION_LENGTH}`,
        };
      }

      let parsedRoomId: string | undefined;
      if (obj.roomId !== undefined && obj.roomId !== null) {
        if (typeof obj.roomId !== 'string') {
          rejectedMessageCounter++;
          return { valid: false, reason: 'askCompanion roomId must be a string' };
        }
        parsedRoomId = obj.roomId.trim();
        if (parsedRoomId.length > MAX_ROOM_ID_LENGTH) {
          rejectedMessageCounter++;
          return { valid: false, reason: `roomId exceeds max length of ${MAX_ROOM_ID_LENGTH}` };
        }
        if (options.validRoomIds && parsedRoomId.length > 0) {
          const idSet =
            options.validRoomIds instanceof Set
              ? options.validRoomIds
              : new Set(options.validRoomIds);
          if (!idSet.has(parsedRoomId)) {
            rejectedMessageCounter++;
            return {
              valid: false,
              reason: `Room ID '${parsedRoomId}' does not exist in active snapshot`,
            };
          }
        }
      }

      let explanationLevel: ExplanationLevelValue | undefined;
      if (obj.explanationLevel !== undefined && obj.explanationLevel !== null) {
        if (!EXPLANATION_LEVELS.includes(obj.explanationLevel as ExplanationLevelValue)) {
          rejectedMessageCounter++;
          return { valid: false, reason: 'explanationLevel must be beginner, intermediate or technical' };
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
        rejectedMessageCounter++;
        return { valid: false, reason: 'selectFolder requires a non-empty string folderPath' };
      }
      if (obj.folderPath.length > MAX_PATH_LENGTH) {
        rejectedMessageCounter++;
        return {
          valid: false,
          reason: `folderPath exceeds maximum length of ${MAX_PATH_LENGTH}`,
        };
      }
      return {
        valid: true,
        message: {
          command: 'selectFolder',
          folderPath: obj.folderPath,
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
