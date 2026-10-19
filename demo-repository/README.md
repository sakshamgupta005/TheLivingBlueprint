# Patchboard Tasks API

A lightweight, zero-dependency task management HTTP service built with native Node.js APIs (Node.js 20+).

This repository serves as a realistic demonstration codebase for **The Living Blueprint** evidence-backed investigation and repair workflow.

## Features

- **Standard HTTP endpoints**: RESTful JSON API using pure Node.js `node:http`.
- **Zero third-party dependencies**: Uses native platform APIs only.
- **In-memory storage**: Fast, volatile task store suitable for demos and testing.
- **Built-in test runner**: Comprehensive unit and integration test suite using `node:test`.

## Getting Started

### Prerequisites

- Node.js 20.0.0 or higher.
- npm 9.0.0 or higher.

### Running Locally

```bash
# Start the HTTP server on port 3001 (or PORT environment variable)
npm start
```

### Running Tests

```bash
# Run the automated test suite
npm test
```

> **Note on Baseline Tests**: One baseline regression test in the test suite is deliberately failing as part of the Living Blueprint repair-workflow demonstration. All other tests pass. A later coding-agent repair prompt will identify the root cause, apply the fix, and verify it against CI.

## API Endpoints

| Method | Path | Description | Success Status |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Service health status and timestamp | `200 OK` |
| `GET` | `/api/tasks` | Returns all active tasks in memory | `200 OK` |
| `POST` | `/api/tasks` | Creates a new task (`{ "title": "..." }`) | `201 Created` |

### Example Request

```bash
curl -X POST http://localhost:3001/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "Review architectural blueprint"}'
```

Response (`201 Created`):
```json
{
  "task": {
    "id": "task-1",
    "title": "Review architectural blueprint",
    "completed": false,
    "createdAt": "2026-10-18T19:00:00.000Z"
  }
}
```

## Architecture & Limitations

- **Volatile Storage**: Tasks are held in memory in `src/tasks/store.js`. Data resets whenever the process restarts.
- **No Database or Auth**: The service intentionally contains no database, user authentication, or persistent storage.
- **Strict Budget**: Kept to 12 or fewer substantive files to facilitate automated repository scanning.

## License

MIT
