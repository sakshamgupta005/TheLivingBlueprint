/**
 * Volatile in-memory store for tasks.
 * Resets whenever the Node.js process restarts.
 */

let tasks = [];
let nextId = 1;

export function getAllTasks() {
  return [...tasks];
}

export function addTask(taskData) {
  const task = {
    id: `task-${nextId++}`,
    title: taskData.title,
    completed: false,
    createdAt: new Date().toISOString(),
  };
  tasks.push(task);
  return { ...task };
}

export function clearTasks() {
  tasks = [];
  nextId = 1;
}
