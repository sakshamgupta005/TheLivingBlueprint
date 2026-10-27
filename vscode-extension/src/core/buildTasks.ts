/**
 * buildTasks.ts — Task orchestration domain model and persistent store (Part 3.1).
 *
 * Provides a bounded, per-workspace-folder task ledger and grounded prompt generation.
 * Pure TypeScript: No vscode imports; memento store and clipboard adapters are injected.
 */

import { detectTestCommand, type ObservedTestCommand } from './handoff.ts';
import type { WorkspaceSnapshot } from './snapshot.ts';

export type BuildTaskStatus =
  | 'planned'
  | 'ready'
  | 'handed_off'
  | 'implemented'
  | 'blocked';

export type BuildTaskAction =
  | 'approve'
  | 'previewPrompt'
  | 'copyPrompt'
  | 'markImplemented'
  | 'markBlocked'
  | 'reopen'
  | 'delete';

export interface BuildTask {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: BuildTaskStatus;
  createdAt: string;
  updatedAt: string;
  blockerNote?: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
}

export interface BuildTaskStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface TaskPromptContext {
  workspaceName?: string;
  snapshot?: WorkspaceSnapshot;
}

export interface GeneratedTaskPrompt {
  title: string;
  body: string;
  observedTest?: ObservedTestCommand;
  inspectedFilePaths: string[];
}

export const MAX_TASKS_PER_FOLDER = 50;
export const MAX_TITLE_LENGTH = 160;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_CRITERIA_COUNT = 15;
export const MAX_CRITERIA_LENGTH = 400;
export const MAX_BLOCKER_NOTE_LENGTH = 1000;

const KEY_PREFIX = 'livingBlueprint.buildTasks.v1:';

const SECRET_PATTERNS = [
  /BEGIN (?:[A-Z0-9_-]+ )*PRIVATE KEY/i,
  /(?:api[_-]?key|auth[_-]?token|secret|password)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{16,}['"]/i,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
];

export function containsSecretPattern(text: string): boolean {
  return SECRET_PATTERNS.some((pat) => pat.test(text));
}

export function generateTaskPrompt(task: BuildTask, context?: TaskPromptContext): GeneratedTaskPrompt {
  const snapshot = context?.snapshot;
  const workspaceName = context?.workspaceName || 'Workspace';
  const test = snapshot ? detectTestCommand(snapshot) : undefined;

  // Extract relevant inspected files without leaking full contents
  const inspectedFiles = snapshot?.inspectedFiles ?? [];
  let relevantFiles: string[] = [];
  if (inspectedFiles.length > 0) {
    const textToMatch = `${task.title} ${task.description}`.toLowerCase();
    const keywords = textToMatch
      .split(/[^a-z0-9_-]+/)
      .filter((w) => w.length >= 3 && !['the', 'and', 'for', 'with', 'task'].includes(w));

    if (keywords.length > 0) {
      relevantFiles = inspectedFiles
        .filter((f) => keywords.some((kw) => f.path.toLowerCase().includes(kw)))
        .slice(0, 6)
        .map((f) => f.path);
    }
    if (relevantFiles.length === 0) {
      relevantFiles = inspectedFiles.slice(0, 5).map((f) => f.path);
    }
  }

  const criteriaLines = task.acceptanceCriteria.length > 0
    ? task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')
    : '- Confirm requirements in code before making changes.\n- Implement only the scoped changes.\n- Verify changes with automated tests.';

  const fileRefLines = relevantFiles.length > 0
    ? relevantFiles.map((p) => `- \`${p}\``).join('\n')
    : '- No specific files identified in current snapshot.';

  const testSection = test
    ? `- Observed test command: \`${test.command}\` (from ${test.source}).`
    : '- No test command was detected in inspected workspace manifests. Do not guess commands without inspecting the repository.';

  const evidenceSection = snapshot
    ? `### Inspected workspace evidence
- Fingerprint: \`${snapshot.fingerprint}\`
- Detected technologies: ${snapshot.detectedTechnologies?.length ? snapshot.detectedTechnologies.join(', ') : 'None'}
- Relevant inspected files:
${fileRefLines}
${testSection}`
    : `### Workspace evidence
No workspace snapshot evidence is currently available. Inspect the repository directory structure, manifests, and source files directly before editing.
${testSection}`;

  const body = `<!-- Living Blueprint task handoff -->
# Task: ${task.title}

- Task ID: \`${task.id}\`
- Status: \`${task.status}\`
- Workspace: ${workspaceName}

## Description
${task.description || 'No description provided.'}

## Acceptance criteria
${criteriaLines}

## Grounded context
${evidenceSection}

## Instructions for coding agent
1. **Inspect before editing**: Ground all changes in the current codebase before modifying files.
2. **Strict scope**: Implement only what is required to satisfy the acceptance criteria. Preserve unrelated code and architecture.
3. **Run tests**: Execute observed tests or verified project test suites to validate your changes.
4. **Honest reporting**: Report actual files changed, exact test execution results, and any blockers encountered. Never claim a task or test is verified without real proof.

---
_Orchestration note: Generated by Living Blueprint for manual handoff to your coding agent. Direct execution was not performed._
`;

  return {
    title: task.title,
    body,
    observedTest: test,
    inspectedFilePaths: relevantFiles,
  };
}

export interface BuildTaskManager {
  getTasks(folderUri: string): BuildTask[];
  createTask(folderUri: string, input: CreateTaskInput): Promise<{ ok: true; task: BuildTask } | { ok: false; message: string }>;
  executeAction(
    folderUri: string,
    taskId: string,
    action: BuildTaskAction,
    options?: {
      blockerNote?: string;
      workspaceName?: string;
      snapshot?: WorkspaceSnapshot;
      copyToClipboard?: (text: string) => Promise<boolean> | boolean | Thenable<void> | Promise<void>;
    }
  ): Promise<{ ok: boolean; message: string; task?: BuildTask; prompt?: GeneratedTaskPrompt }>;
  deleteTask(folderUri: string, taskId: string): Promise<boolean>;
  clear(folderUri: string): Promise<void>;
}

export function createBuildTaskManager(store: BuildTaskStore, maxTasks = MAX_TASKS_PER_FOLDER): BuildTaskManager {
  const keyFor = (folderUri: string) => KEY_PREFIX + folderUri;

  const read = (folderUri: string): BuildTask[] => {
    const value = store.get<unknown>(keyFor(folderUri));
    return Array.isArray(value) ? (value as BuildTask[]) : [];
  };

  const save = async (folderUri: string, tasks: BuildTask[]) => {
    await store.update(keyFor(folderUri), tasks);
  };

  return {
    getTasks: read,

    async createTask(folderUri, input) {
      if (!folderUri || typeof folderUri !== 'string') {
        return { ok: false, message: 'Invalid or missing folder URI.' };
      }

      const title = typeof input?.title === 'string' ? input.title.trim() : '';
      if (!title) {
        return { ok: false, message: 'Task title cannot be empty.' };
      }
      if (title.length > MAX_TITLE_LENGTH) {
        return { ok: false, message: `Task title exceeds maximum length of ${MAX_TITLE_LENGTH} characters.` };
      }

      const description = typeof input?.description === 'string' ? input.description.trim() : '';
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        return { ok: false, message: `Task description exceeds maximum length of ${MAX_DESCRIPTION_LENGTH} characters.` };
      }

      if (containsSecretPattern(title) || containsSecretPattern(description)) {
        return { ok: false, message: 'Task content contains potentially sensitive credentials or secret patterns.' };
      }

      const rawCriteria = Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : [];
      if (rawCriteria.length > MAX_CRITERIA_COUNT) {
        return { ok: false, message: `Acceptance criteria count exceeds maximum of ${MAX_CRITERIA_COUNT} items.` };
      }

      const cleanedCriteria: string[] = [];
      for (const item of rawCriteria) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (!trimmed) continue;
        if (trimmed.length > MAX_CRITERIA_LENGTH) {
          return { ok: false, message: `Acceptance criterion exceeds maximum length of ${MAX_CRITERIA_LENGTH} characters.` };
        }
        if (containsSecretPattern(trimmed)) {
          return { ok: false, message: 'Acceptance criterion contains potentially sensitive credentials or secret patterns.' };
        }
        cleanedCriteria.push(trimmed);
      }

      const tasks = read(folderUri);
      if (tasks.length >= maxTasks) {
        return { ok: false, message: `Task limit reached (${maxTasks} tasks maximum per workspace folder).` };
      }

      const now = new Date().toISOString();
      const task: BuildTask = {
        id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title,
        description,
        acceptanceCriteria: cleanedCriteria,
        status: 'planned',
        createdAt: now,
        updatedAt: now,
      };

      await save(folderUri, [...tasks, task]);
      return { ok: true, task };
    },

    async executeAction(folderUri, taskId, action, options) {
      if (!folderUri || typeof folderUri !== 'string') {
        return { ok: false, message: 'Invalid or missing folder URI.' };
      }

      const tasks = read(folderUri);
      const taskIndex = tasks.findIndex((t) => t.id === taskId);
      if (taskIndex === -1) {
        return { ok: false, message: `Task not found with ID '${taskId}'.` };
      }

      const task = { ...tasks[taskIndex] };
      const now = new Date().toISOString();

      switch (action) {
        case 'approve': {
          task.status = 'ready';
          task.updatedAt = now;
          tasks[taskIndex] = task;
          await save(folderUri, tasks);
          return { ok: true, message: 'Task approved and marked ready.', task };
        }

        case 'previewPrompt': {
          if (containsSecretPattern(task.title) || containsSecretPattern(task.description) || task.acceptanceCriteria.some(containsSecretPattern)) {
            return { ok: false, message: 'Cannot generate prompt: task contains sensitive credential patterns.' };
          }
          const prompt = generateTaskPrompt(task, {
            workspaceName: options?.workspaceName,
            snapshot: options?.snapshot,
          });
          return { ok: true, message: 'Task prompt preview generated.', task, prompt };
        }

        case 'copyPrompt': {
          if (containsSecretPattern(task.title) || containsSecretPattern(task.description) || task.acceptanceCriteria.some(containsSecretPattern)) {
            return { ok: false, message: 'Cannot generate prompt: task contains sensitive credential patterns.' };
          }
          const prompt = generateTaskPrompt(task, {
            workspaceName: options?.workspaceName,
            snapshot: options?.snapshot,
          });

          let copyOk = false;
          if (options?.copyToClipboard) {
            try {
              const res = await options.copyToClipboard(prompt.body);
              copyOk = res !== false;
            } catch {
              copyOk = false;
            }
          }

          if (!copyOk) {
            return {
              ok: false,
              message: 'Failed to copy prompt to clipboard. Task status remains unchanged.',
              task,
            };
          }

          task.status = 'handed_off';
          task.updatedAt = now;
          tasks[taskIndex] = task;
          await save(folderUri, tasks);
          return {
            ok: true,
            message: 'Task prompt copied to clipboard and marked handed off.',
            task,
            prompt,
          };
        }

        case 'markImplemented': {
          task.status = 'implemented';
          task.updatedAt = now;
          tasks[taskIndex] = task;
          await save(folderUri, tasks);
          return { ok: true, message: 'Task marked as implemented (user-confirmed, unverified).', task };
        }

        case 'markBlocked': {
          task.status = 'blocked';
          if (options?.blockerNote && typeof options.blockerNote === 'string') {
            const note = options.blockerNote.trim();
            if (note.length > MAX_BLOCKER_NOTE_LENGTH) {
              return { ok: false, message: `Blocker note exceeds maximum length of ${MAX_BLOCKER_NOTE_LENGTH} characters.` };
            }
            if (containsSecretPattern(note)) {
              return { ok: false, message: 'Blocker note contains potentially sensitive credentials or secret patterns.' };
            }
            task.blockerNote = note;
          }
          task.updatedAt = now;
          tasks[taskIndex] = task;
          await save(folderUri, tasks);
          return { ok: true, message: 'Task marked as blocked.', task };
        }

        case 'reopen': {
          task.status = 'planned';
          task.updatedAt = now;
          tasks[taskIndex] = task;
          await save(folderUri, tasks);
          return { ok: true, message: 'Task reopened and set to planned.', task };
        }

        case 'delete': {
          const updated = tasks.filter((t) => t.id !== taskId);
          await save(folderUri, updated);
          return { ok: true, message: 'Task deleted successfully.' };
        }

        default:
          return { ok: false, message: `Unsupported task action '${action}'.` };
      }
    },

    async deleteTask(folderUri, taskId) {
      const tasks = read(folderUri);
      const filtered = tasks.filter((t) => t.id !== taskId);
      if (filtered.length === tasks.length) return false;
      await save(folderUri, filtered);
      return true;
    },

    async clear(folderUri) {
      await store.update(keyFor(folderUri), undefined);
    },
  };
}
