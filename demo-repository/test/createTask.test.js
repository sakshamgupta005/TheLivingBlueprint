import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createTask, TaskValidationError } from '../src/tasks/createTask.js';
import { clearTasks, getAllTasks } from '../src/tasks/store.js';

describe('Task Creation & Validation', () => {
  beforeEach(() => {
    clearTasks();
  });

  it('creates a task with a valid title and trims surrounding whitespace', () => {
    const task = createTask('  Deploy production build  ');
    assert.strictEqual(task.title, 'Deploy production build');
    assert.strictEqual(task.completed, false);
    assert.ok(task.id.startsWith('task-'));
    assert.ok(task.createdAt);

    const stored = getAllTasks();
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].title, 'Deploy production build');
  });

  it('rejects non-string titles with TaskValidationError', () => {
    assert.throws(() => {
      createTask(12345);
    }, TaskValidationError);

    assert.throws(() => {
      createTask(null);
    }, TaskValidationError);

    assert.throws(() => {
      createTask(undefined);
    }, TaskValidationError);
  });

  it('rejects empty string titles with TaskValidationError', () => {
    assert.throws(() => {
      createTask('');
    }, TaskValidationError);
  });

  it('rejects whitespace-only task titles', () => {
    // Requirements rule: "The title must contain at least one non-whitespace character."
    // INTENTIONAL BASELINE REGRESSION: This test is expected to fail on the baseline
    // repository because validation currently checks title.length > 0 instead of title.trim().length > 0.
    assert.throws(
      () => {
        createTask('   ');
      },
      TaskValidationError,
      'Expected whitespace-only title to be rejected with TaskValidationError'
    );
  });

  it('assigns unique incrementing IDs to successive tasks', () => {
    const task1 = createTask('First task');
    const task2 = createTask('Second task');
    assert.notStrictEqual(task1.id, task2.id);
  });
});
