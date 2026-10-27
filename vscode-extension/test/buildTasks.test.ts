import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  createBuildTaskManager,
  generateTaskPrompt,
  containsSecretPattern,
  MAX_TASKS_PER_FOLDER,
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_CRITERIA_COUNT,
  MAX_CRITERIA_LENGTH,
  type BuildTaskStore,
  type BuildTask,
} from '../src/core/buildTasks.ts';
import {
  validateInboundMessage,
  BUILD_TASK_ACTIONS,
  BUILD_TASK_STATUSES,
} from '../src/protocol.ts';
import { scanWorkspace } from '../src/workspaceScanner.ts';
import { asSnapshot, type WorkspaceSnapshot } from '../src/core/snapshot.ts';

const candidatePaths = [
  path.resolve(process.cwd(), 'test', 'fixtures'),
  path.resolve(process.cwd(), 'vscode-extension', 'test', 'fixtures'),
];
const fixturesDir = candidatePaths.find((p) => fs.existsSync(p)) || candidatePaths[0];
const smallExpressFixture = path.join(fixturesDir, 'small-express');

function createMemoryStore(): BuildTaskStore {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string): T | undefined => map.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    },
  };
}

const FOLDER_A = 'file:///workspace/alpha';
const FOLDER_B = 'file:///workspace/beta';

describe('VS Code Extension — Build Queue & Task Orchestration (Part 3.1)', () => {
  let store: BuildTaskStore;

  beforeEach(() => {
    store = createMemoryStore();
  });

  describe('1. Task Creation & Data Model', () => {
    it('verifies exported domain status definitions and constants', () => {
      assert.strictEqual(MAX_TASKS_PER_FOLDER, 50);
      assert.deepStrictEqual(BUILD_TASK_STATUSES, ['planned', 'ready', 'handed_off', 'implemented', 'blocked']);
    });

    it('creates a task with planned status, unique id, and timestamps', async () => {
      const manager = createBuildTaskManager(store);
      const res = await manager.createTask(FOLDER_A, {
        title: 'Implement health check endpoint',
        description: 'Add a /health route returning status: ok',
        acceptanceCriteria: ['Returns HTTP 200', 'JSON contains status ok'],
      });

      assert.strictEqual(res.ok, true);
      if (!res.ok) return;

      const task = res.task;
      assert.ok(task.id.startsWith('task-'), `Task id should start with task-, got ${task.id}`);
      assert.strictEqual(task.title, 'Implement health check endpoint');
      assert.strictEqual(task.description, 'Add a /health route returning status: ok');
      assert.deepStrictEqual(task.acceptanceCriteria, ['Returns HTTP 200', 'JSON contains status ok']);
      assert.strictEqual(task.status, 'planned');
      assert.ok(Date.parse(task.createdAt) > 0);
      assert.strictEqual(task.createdAt, task.updatedAt);

      const tasks = manager.getTasks(FOLDER_A);
      assert.strictEqual(tasks.length, 1);
      assert.deepStrictEqual(tasks[0], task);
    });

    it('trims whitespace and ignores empty acceptance criteria items', async () => {
      const manager = createBuildTaskManager(store);
      const res = await manager.createTask(FOLDER_A, {
        title: '   Fix auth token expiry   ',
        description: '   Ensure tokens expire after 3600 seconds   ',
        acceptanceCriteria: ['  Criterion 1  ', '   ', 'Criterion 2'],
      });

      assert.strictEqual(res.ok, true);
      if (!res.ok) return;

      assert.strictEqual(res.task.title, 'Fix auth token expiry');
      assert.strictEqual(res.task.description, 'Ensure tokens expire after 3600 seconds');
      assert.deepStrictEqual(res.task.acceptanceCriteria, ['Criterion 1', 'Criterion 2']);
    });
  });

  describe('2. Persistence Isolation & Limits', () => {
    it('isolates tasks per workspace folder', async () => {
      const manager = createBuildTaskManager(store);

      await manager.createTask(FOLDER_A, { title: 'Alpha task 1' });
      await manager.createTask(FOLDER_A, { title: 'Alpha task 2' });
      await manager.createTask(FOLDER_B, { title: 'Beta task 1' });

      const tasksA = manager.getTasks(FOLDER_A);
      const tasksB = manager.getTasks(FOLDER_B);

      assert.strictEqual(tasksA.length, 2);
      assert.strictEqual(tasksB.length, 1);
      assert.strictEqual(tasksA[0].title, 'Alpha task 1');
      assert.strictEqual(tasksB[0].title, 'Beta task 1');
    });

    it('persists across simulated extension restarts', async () => {
      const manager1 = createBuildTaskManager(store);
      const created = await manager1.createTask(FOLDER_A, {
        title: 'Persistent task',
        description: 'Testing persistence',
        acceptanceCriteria: ['Should reload'],
      });
      assert.strictEqual(created.ok, true);

      // Re-instantiate manager with identical underlying store
      const manager2 = createBuildTaskManager(store);
      const tasks = manager2.getTasks(FOLDER_A);

      assert.strictEqual(tasks.length, 1);
      assert.strictEqual(tasks[0].id, (created as { ok: true; task: BuildTask }).task.id);
      assert.strictEqual(tasks[0].title, 'Persistent task');
    });

    it('enforces maximum task count per workspace folder', async () => {
      const manager = createBuildTaskManager(store, 3);

      assert.strictEqual((await manager.createTask(FOLDER_A, { title: 'Task 1' })).ok, true);
      assert.strictEqual((await manager.createTask(FOLDER_A, { title: 'Task 2' })).ok, true);
      assert.strictEqual((await manager.createTask(FOLDER_A, { title: 'Task 3' })).ok, true);

      const overflow = await manager.createTask(FOLDER_A, { title: 'Task 4' });
      assert.strictEqual(overflow.ok, false);
      if (!overflow.ok) {
        assert.match(overflow.message, /task limit reached/i);
      }
      assert.strictEqual(manager.getTasks(FOLDER_A).length, 3);
    });
  });

  describe('3. Input Validation & Security Rejection', () => {
    it('rejects empty or whitespace-only title', async () => {
      const manager = createBuildTaskManager(store);
      const res = await manager.createTask(FOLDER_A, { title: '   ' });
      assert.strictEqual(res.ok, false);
      if (!res.ok) {
        assert.match(res.message, /title cannot be empty/i);
      }
    });

    it('rejects title and description exceeding length limits', async () => {
      const manager = createBuildTaskManager(store);

      const longTitle = 'a'.repeat(MAX_TITLE_LENGTH + 1);
      const res1 = await manager.createTask(FOLDER_A, { title: longTitle });
      assert.strictEqual(res1.ok, false);
      if (!res1.ok) assert.match(res1.message, /title exceeds maximum length/i);

      const longDesc = 'd'.repeat(MAX_DESCRIPTION_LENGTH + 1);
      const res2 = await manager.createTask(FOLDER_A, { title: 'Valid Title', description: longDesc });
      assert.strictEqual(res2.ok, false);
      if (!res2.ok) assert.match(res2.message, /description exceeds maximum length/i);
    });

    it('rejects criteria exceeding count or item length limits', async () => {
      const manager = createBuildTaskManager(store);

      const tooManyCriteria = Array.from({ length: MAX_CRITERIA_COUNT + 1 }, (_, i) => `Criterion ${i}`);
      const res1 = await manager.createTask(FOLDER_A, { title: 'Task', acceptanceCriteria: tooManyCriteria });
      assert.strictEqual(res1.ok, false);
      if (!res1.ok) assert.match(res1.message, /criteria count exceeds/i);

      const longCriterion = 'c'.repeat(MAX_CRITERIA_LENGTH + 1);
      const res2 = await manager.createTask(FOLDER_A, { title: 'Task', acceptanceCriteria: [longCriterion] });
      assert.strictEqual(res2.ok, false);
      if (!res2.ok) assert.match(res2.message, /criterion exceeds maximum length/i);
    });

    it('detects secret patterns and prevents credential leakage', async () => {
      assert.strictEqual(containsSecretPattern('-----BEGIN RSA PRIVATE KEY-----'), true);
      assert.strictEqual(containsSecretPattern('ghp_123456789012345678901234567890123456'), true);
      assert.strictEqual(containsSecretPattern('sk-123456789012345678901234567890'), true);
      assert.strictEqual(containsSecretPattern('Normal task description about auth tokens'), false);

      const manager = createBuildTaskManager(store);
      const secretTask = await manager.createTask(FOLDER_A, {
        title: 'Leak key',
        description: 'ghp_123456789012345678901234567890123456',
      });
      assert.strictEqual(secretTask.ok, false);
      if (!secretTask.ok) assert.match(secretTask.message, /sensitive credentials or secret/i);
    });
  });

  describe('4. Status Transitions & Actions', () => {
    it('approves a task from planned to ready', async () => {
      const manager = createBuildTaskManager(store);
      const createRes = await manager.createTask(FOLDER_A, { title: 'Task to approve' });
      assert.strictEqual(createRes.ok, true);
      if (!createRes.ok) return;

      const taskId = createRes.task.id;
      const actionRes = await manager.executeAction(FOLDER_A, taskId, 'approve');
      assert.strictEqual(actionRes.ok, true);
      assert.strictEqual(actionRes.task?.status, 'ready');

      const updated = manager.getTasks(FOLDER_A).find((t) => t.id === taskId);
      assert.strictEqual(updated?.status, 'ready');
    });

    it('previews prompt without mutating task status', async () => {
      const manager = createBuildTaskManager(store);
      const createRes = await manager.createTask(FOLDER_A, { title: 'Preview test' });
      assert.strictEqual(createRes.ok, true);
      if (!createRes.ok) return;

      const taskId = createRes.task.id;
      const previewRes = await manager.executeAction(FOLDER_A, taskId, 'previewPrompt');
      assert.strictEqual(previewRes.ok, true);
      assert.ok(previewRes.prompt?.body.includes('Task: Preview test'));
      assert.strictEqual(previewRes.task?.status, 'planned');

      const after = manager.getTasks(FOLDER_A).find((t) => t.id === taskId);
      assert.strictEqual(after?.status, 'planned');
    });

    it('copies prompt and transitions to handed_off only when clipboard succeeds', async () => {
      const manager = createBuildTaskManager(store);
      const createRes = await manager.createTask(FOLDER_A, { title: 'Copy test' });
      assert.strictEqual(createRes.ok, true);
      if (!createRes.ok) return;

      const taskId = createRes.task.id;
      await manager.executeAction(FOLDER_A, taskId, 'approve');

      // 1. Failing clipboard write leaves task status unchanged
      const failCopyRes = await manager.executeAction(FOLDER_A, taskId, 'copyPrompt', {
        copyToClipboard: async () => false,
      });
      assert.strictEqual(failCopyRes.ok, false);
      assert.match(failCopyRes.message, /failed to copy prompt/i);
      assert.strictEqual(manager.getTasks(FOLDER_A).find((t) => t.id === taskId)?.status, 'ready');

      // 2. Successful clipboard write marks task as handed_off
      let copiedText = '';
      const successCopyRes = await manager.executeAction(FOLDER_A, taskId, 'copyPrompt', {
        copyToClipboard: async (text) => {
          copiedText = text;
          return true;
        },
      });
      assert.strictEqual(successCopyRes.ok, true);
      assert.ok(copiedText.includes('Task: Copy test'));
      assert.strictEqual(manager.getTasks(FOLDER_A).find((t) => t.id === taskId)?.status, 'handed_off');
    });

    it('marks task as implemented (unverified)', async () => {
      const manager = createBuildTaskManager(store);
      const createRes = await manager.createTask(FOLDER_A, { title: 'Implement test' });
      if (!createRes.ok) return;

      const taskId = createRes.task.id;
      const res = await manager.executeAction(FOLDER_A, taskId, 'markImplemented');
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.task?.status, 'implemented');
      assert.match(res.message, /unverified/i);
    });

    it('marks task as blocked with optional blocker note', async () => {
      const manager = createBuildTaskManager(store);
      const createRes = await manager.createTask(FOLDER_A, { title: 'Blocked test' });
      if (!createRes.ok) return;

      const taskId = createRes.task.id;
      const res = await manager.executeAction(FOLDER_A, taskId, 'markBlocked', {
        blockerNote: 'Waiting for upstream schema change in API',
      });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.task?.status, 'blocked');
      assert.strictEqual(res.task?.blockerNote, 'Waiting for upstream schema change in API');
    });

    it('reopens a blocked or implemented task back to planned', async () => {
      const manager = createBuildTaskManager(store);
      const createRes = await manager.createTask(FOLDER_A, { title: 'Reopen test' });
      if (!createRes.ok) return;

      const taskId = createRes.task.id;
      await manager.executeAction(FOLDER_A, taskId, 'markBlocked');
      assert.strictEqual(manager.getTasks(FOLDER_A).find((t) => t.id === taskId)?.status, 'blocked');

      const reopenRes = await manager.executeAction(FOLDER_A, taskId, 'reopen');
      assert.strictEqual(reopenRes.ok, true);
      assert.strictEqual(reopenRes.task?.status, 'planned');
    });

    it('deletes a task from the store', async () => {
      const manager = createBuildTaskManager(store);
      const createRes = await manager.createTask(FOLDER_A, { title: 'To delete' });
      if (!createRes.ok) return;

      const taskId = createRes.task.id;
      const deleteRes = await manager.executeAction(FOLDER_A, taskId, 'delete');
      assert.strictEqual(deleteRes.ok, true);
      assert.strictEqual(manager.getTasks(FOLDER_A).length, 0);

      // Second deletion returns not found
      const secondRes = await manager.executeAction(FOLDER_A, taskId, 'delete');
      assert.strictEqual(secondRes.ok, false);
    });
  });

  describe('5. Grounded Prompt Generation', () => {
    it('generates prompt grounded in real workspace evidence when snapshot is available', async () => {
      const scanData = await scanWorkspace(smallExpressFixture);
      const snapshot: WorkspaceSnapshot = asSnapshot(scanData);

      const task: BuildTask = {
        id: 'task-test-01',
        title: 'Add authentication test coverage',
        description: 'Verify invalid token rejects request with 401',
        acceptanceCriteria: [
          'Request with malformed token returns 401 Unauthorized',
          'Automated tests execute and pass',
        ],
        status: 'ready',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const prompt = generateTaskPrompt(task, {
        workspaceName: 'small-express',
        snapshot,
      });

      assert.strictEqual(prompt.title, task.title);
      assert.ok(prompt.body.includes('Task: Add authentication test coverage'));
      assert.ok(prompt.body.includes('Workspace: small-express'));
      assert.ok(prompt.body.includes(snapshot.fingerprint));
      assert.ok(prompt.body.includes('Request with malformed token returns 401 Unauthorized'));
      assert.ok(prompt.body.includes('Inspect before editing'));
      assert.ok(prompt.body.includes('Honest reporting'));

      // Check observed test command detection
      if (prompt.observedTest) {
        assert.ok(prompt.body.includes(prompt.observedTest.command));
      }
    });

    it('generates clear advisory prompt when workspace evidence is unavailable', () => {
      const task: BuildTask = {
        id: 'task-no-evidence',
        title: 'Implement database connection retry',
        description: 'Retry up to 3 times with exponential backoff',
        acceptanceCriteria: ['Exponential backoff delay verified'],
        status: 'planned',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const prompt = generateTaskPrompt(task, {
        workspaceName: 'offline-repo',
      });

      assert.ok(prompt.body.includes('Task: Implement database connection retry'));
      assert.ok(prompt.body.includes('No workspace snapshot evidence is currently available'));
      assert.ok(prompt.body.includes('No test command was detected'));
      assert.strictEqual(prompt.observedTest, undefined);
    });
  });

  describe('6. Protocol & Host-Side Contract Validation', () => {
    it('validates requestBuildTasks message', () => {
      const res = validateInboundMessage({ command: 'requestBuildTasks' });
      assert.strictEqual(res.valid, true);
      if (res.valid) {
        assert.strictEqual(res.message.command, 'requestBuildTasks');
      }
    });

    it('validates createBuildTask message', () => {
      const valid = validateInboundMessage({
        command: 'createBuildTask',
        title: 'Build task',
        description: 'Task description',
        acceptanceCriteria: ['Criterion 1'],
      });
      assert.strictEqual(valid.valid, true);
      if (valid.valid && valid.message.command === 'createBuildTask') {
        assert.strictEqual(valid.message.title, 'Build task');
        assert.strictEqual(valid.message.description, 'Task description');
        assert.deepStrictEqual(valid.message.acceptanceCriteria, ['Criterion 1']);
      }

      // Rejects empty title
      const emptyTitle = validateInboundMessage({
        command: 'createBuildTask',
        title: '',
      });
      assert.strictEqual(emptyTitle.valid, false);

      // Rejects non-array acceptanceCriteria
      const invalidCriteria = validateInboundMessage({
        command: 'createBuildTask',
        title: 'Valid',
        acceptanceCriteria: 'not an array',
      });
      assert.strictEqual(invalidCriteria.valid, false);
    });

    it('validates buildTaskAction message for all allowed actions', () => {
      for (const action of BUILD_TASK_ACTIONS) {
        const res = validateInboundMessage({
          command: 'buildTaskAction',
          taskId: 'task-123',
          action,
        });
        assert.strictEqual(res.valid, true, `Action ${action} should be valid`);
      }

      // Accepts blockerNote
      const withNote = validateInboundMessage({
        command: 'buildTaskAction',
        taskId: 'task-123',
        action: 'markBlocked',
        blockerNote: 'Blocked by dependency',
      });
      assert.strictEqual(withNote.valid, true);

      // Rejects unknown action
      const badAction = validateInboundMessage({
        command: 'buildTaskAction',
        taskId: 'task-123',
        action: 'unsupportedAction',
      });
      assert.strictEqual(badAction.valid, false);
      if (!badAction.valid) {
        assert.match(badAction.reason, /action must be one of/i);
      }
    });
  });

  describe('7. End-to-End Task Lifecycle & Error Handling Integration', () => {
    it('executes the full lifecycle seamlessly: create -> approve -> preview -> copy -> block -> reopen -> implement -> delete', async () => {
      const manager = createBuildTaskManager(store);

      // 1. Create
      const created = await manager.createTask(FOLDER_A, {
        title: 'Full lifecycle task',
        description: 'Verify each state transition in order',
        acceptanceCriteria: ['Passes all checks'],
      });
      assert.strictEqual(created.ok, true);
      if (!created.ok) return;
      const taskId = created.task.id;
      assert.strictEqual(created.task.status, 'planned');

      // 2. Approve
      const approved = await manager.executeAction(FOLDER_A, taskId, 'approve');
      assert.strictEqual(approved.ok, true);
      assert.strictEqual(approved.task?.status, 'ready');

      // 3. Preview prompt (status unchanged)
      const previewed = await manager.executeAction(FOLDER_A, taskId, 'previewPrompt', {
        workspaceName: 'test-ws',
      });
      assert.strictEqual(previewed.ok, true);
      assert.strictEqual(previewed.task?.status, 'ready');
      assert.ok(previewed.prompt?.body.includes('Task: Full lifecycle task'));

      // 4. Copy prompt (transitions to handed_off)
      const copied = await manager.executeAction(FOLDER_A, taskId, 'copyPrompt', {
        copyToClipboard: async () => true,
      });
      assert.strictEqual(copied.ok, true);
      assert.strictEqual(copied.task?.status, 'handed_off');

      // 5. Mark blocked with note
      const blocked = await manager.executeAction(FOLDER_A, taskId, 'markBlocked', {
        blockerNote: 'Blocked by downstream service dependency',
      });
      assert.strictEqual(blocked.ok, true);
      assert.strictEqual(blocked.task?.status, 'blocked');
      assert.strictEqual(blocked.task?.blockerNote, 'Blocked by downstream service dependency');

      // 6. Reopen back to planned
      const reopened = await manager.executeAction(FOLDER_A, taskId, 'reopen');
      assert.strictEqual(reopened.ok, true);
      assert.strictEqual(reopened.task?.status, 'planned');

      // 7. Re-approve and mark implemented (user-confirmed, unverified)
      await manager.executeAction(FOLDER_A, taskId, 'approve');
      const implemented = await manager.executeAction(FOLDER_A, taskId, 'markImplemented');
      assert.strictEqual(implemented.ok, true);
      assert.strictEqual(implemented.task?.status, 'implemented');
      assert.ok(implemented.message.includes('user-confirmed, unverified'));

      // 8. Delete
      const deleted = await manager.executeAction(FOLDER_A, taskId, 'delete');
      assert.strictEqual(deleted.ok, true);
      assert.strictEqual(manager.getTasks(FOLDER_A).length, 0);
    });

    it('rejects prompt preview and copy if task data contains raw credentials', async () => {
      const manager = createBuildTaskManager(store);
      // Construct a corrupted/injected task directly into store
      const badTask: BuildTask = {
        id: 'task-corrupt-sec',
        title: 'Task with leaked credential',
        description: 'sk-123456789012345678901234567890',
        acceptanceCriteria: ['Do not leak'],
        status: 'ready',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await store.update('livingBlueprint.buildTasks.v1:' + FOLDER_A, [badTask]);

      const previewRes = await manager.executeAction(FOLDER_A, badTask.id, 'previewPrompt');
      assert.strictEqual(previewRes.ok, false);
      assert.match(previewRes.message, /sensitive credential patterns/i);

      const copyRes = await manager.executeAction(FOLDER_A, badTask.id, 'copyPrompt', {
        copyToClipboard: async () => true,
      });
      assert.strictEqual(copyRes.ok, false);
      assert.match(copyRes.message, /sensitive credential patterns/i);
    });

    it('rejects blocker note containing sensitive secret patterns', async () => {
      const manager = createBuildTaskManager(store);
      const created = await manager.createTask(FOLDER_A, { title: 'Test secret note' });
      if (!created.ok) return;

      const blockedRes = await manager.executeAction(FOLDER_A, created.task.id, 'markBlocked', {
        blockerNote: 'ghp_123456789012345678901234567890123456',
      });
      assert.strictEqual(blockedRes.ok, false);
      assert.match(blockedRes.message, /sensitive credentials or secret/i);
      assert.strictEqual(manager.getTasks(FOLDER_A)[0].status, 'planned');
    });

    it('returns useful error when action is executed on non-existent task', async () => {
      const manager = createBuildTaskManager(store);
      const res = await manager.executeAction(FOLDER_A, 'non-existent-id', 'approve');
      assert.strictEqual(res.ok, false);
      assert.match(res.message, /task not found with id 'non-existent-id'/i);
    });
  });
});
