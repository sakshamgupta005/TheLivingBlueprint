/**
 * Validates task creation input according to specifications.
 */

export function validateTaskTitle(title) {
  if (typeof title !== 'string') {
    return {
      valid: false,
      error: 'Task title must be a string.',
    };
  }

  // NOTE: Baseline implementation defect seeded for The Living Blueprint demonstration.
  // Checks raw length instead of trimmed length, erroneously accepting whitespace-only strings.
  if (title.length === 0) {
    return {
      valid: false,
      error: 'Task title cannot be empty.',
    };
  }

  return {
    valid: true,
    sanitizedTitle: title.trim(),
  };
}
