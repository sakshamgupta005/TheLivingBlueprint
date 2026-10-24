/**
 * chatSession.ts — Bounded per-workspace-folder conversation memory (P2-08).
 *
 * Stored in workspaceState keyed by folder.uri.toString(), so each folder has
 * its own conversation. Only AI turns feed the model history; offline answers
 * are kept for display but never presented to the model as its own words.
 *
 * Pure TypeScript: no vscode import. Pass `context.workspaceState` as the store.
 */

import type { ChatApiRequest, ExplanationLevel } from '../../src/server/types.ts';

export interface ChatStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface ChatTurnRecord {
  question: string;
  /** evidenceRefs are the host-validated refs, kept so restored history stays navigable (never sent to the model). */
  replies: Array<{ speaker: 'dog' | 'cat'; text: string; evidenceRefs?: Array<{ file: string; line?: number; label?: string; status?: string }> }>;
  selectedRoomId?: string;
  mode: 'ai' | 'offline';
  at: string;
}

export type ChatHistory = NonNullable<ChatApiRequest['history']>;

export const MAX_STORED_TURNS = 20;
const KEY_PREFIX = 'livingBlueprint.chat.v1:';
const LEVEL_PREFIX = 'livingBlueprint.explanationLevel.v1:';

export const EXPLANATION_LEVELS: readonly ExplanationLevel[] = ['beginner', 'intermediate', 'technical'];
export const DEFAULT_EXPLANATION_LEVEL: ExplanationLevel = 'beginner';

export function isExplanationLevel(value: unknown): value is ExplanationLevel {
  return EXPLANATION_LEVELS.includes(value as ExplanationLevel);
}

export interface ChatSessionStore {
  getTurns(folderUri: string): ChatTurnRecord[];
  /** Model history from AI turns only, oldest first. executeAiChat keeps the last 4 entries. */
  getHistory(folderUri: string): ChatHistory;
  appendTurn(folderUri: string, turn: ChatTurnRecord): Promise<void>;
  clear(folderUri: string): Promise<void>;
  /** Persisted per folder; unknown stored values fall back to the default. */
  getExplanationLevel(folderUri: string): ExplanationLevel;
  /** Returns false and stores nothing for values other than beginner/intermediate/technical. */
  setExplanationLevel(folderUri: string, level: unknown): Promise<boolean>;
}

export function createChatSessionStore(store: ChatStore, maxTurns = MAX_STORED_TURNS): ChatSessionStore {
  const keyFor = (folderUri: string) => KEY_PREFIX + folderUri;
  const read = (folderUri: string): ChatTurnRecord[] => {
    const value = store.get<unknown>(keyFor(folderUri));
    return Array.isArray(value) ? (value as ChatTurnRecord[]) : [];
  };

  return {
    getTurns: read,

    getHistory(folderUri) {
      const history: ChatHistory = [];
      for (const turn of read(folderUri)) {
        if (turn.mode !== 'ai') continue;
        history.push({ role: 'user', text: turn.question });
        for (const reply of turn.replies) {
          history.push({ role: 'assistant', text: reply.text, speaker: reply.speaker });
        }
      }
      return history;
    },

    async appendTurn(folderUri, turn) {
      await store.update(keyFor(folderUri), [...read(folderUri), turn].slice(-maxTurns));
    },

    async clear(folderUri) {
      await store.update(keyFor(folderUri), undefined);
    },

    getExplanationLevel(folderUri) {
      const value = store.get<unknown>(LEVEL_PREFIX + folderUri);
      return isExplanationLevel(value) ? value : DEFAULT_EXPLANATION_LEVEL;
    },

    async setExplanationLevel(folderUri, level) {
      if (!isExplanationLevel(level)) return false;
      await store.update(LEVEL_PREFIX + folderUri, level);
      return true;
    },
  };
}
