import { validateTaskTitle } from './validation.js';
import { addTask } from './store.js';

export class TaskValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaskValidationError';
  }
}

/**
 * Creates and persists a new task after validating title input.
 * @throws {TaskValidationError} if the title fails validation rules.
 */
export function createTask(rawTitle) {
  const validation = validateTaskTitle(rawTitle);
  if (!validation.valid) {
    throw new TaskValidationError(validation.error);
  }

  return addTask({
    title: validation.sanitizedTitle,
  });
}
