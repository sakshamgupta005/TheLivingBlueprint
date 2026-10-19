# Patchboard Tasks API — Specification & Requirements

This document specifies the formal behavior and constraints for the Patchboard Tasks API service.

## 1. Domain Requirements

### Task Title Rules
1. **Type Constraint**: The task `title` field must be a primitive string. Missing titles, numbers, booleans, objects, arrays, and null values must be rejected.
2. **Non-Empty & Non-Whitespace**: The `title` must contain at least one non-whitespace character. An empty string (`""`) or a string consisting solely of spaces, tabs, or newlines (e.g. `"   "`) is invalid and must be rejected.
3. **Trimming**: Leading and trailing whitespace characters on valid titles must be trimmed before storage. For example, `"  Ship feature  "` is stored as `"Ship feature"`.
4. **Task Structure**:
   - `id`: Unique task identifier string (e.g. `task-1`).
   - `title`: Sanitized, trimmed title string.
   - `completed`: Boolean initialized to `false`.
   - `createdAt`: ISO 8601 UTC timestamp string.

## 2. API Endpoints Specification

### `GET /health`
- **Purpose**: Liveness and service status check.
- **Response**: `200 OK` with JSON `{ "status": "ok", "timestamp": "<ISO-8601>" }`.

### `GET /api/tasks`
- **Purpose**: Retrieve all stored tasks.
- **Response**: `200 OK` with JSON `{ "tasks": [ ... ] }`.

### `POST /api/tasks`
- **Purpose**: Create a new task.
- **Request Body**: JSON object `{ "title": "<string>" }`.
- **Validation**:
  - If `Content-Type` is not JSON or JSON is malformed, return `400 Bad Request` with `{ "error": "Malformed JSON payload" }`.
  - If `title` violates any Task Title Rule, return `400 Bad Request` with `{ "error": "<descriptive reason>" }`.
- **Success**: Return `201 Created` with JSON `{ "task": <created task object> }`.

## 3. Storage & Persistence Boundary
- **In-Memory Volatility**: Storage is strictly in-memory (`store.js`). All records reset when the server process terminates.
- **No External Dependencies**: The application does not integrate with SQL databases, key-value stores, or remote cloud services.
