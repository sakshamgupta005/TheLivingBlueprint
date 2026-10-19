import type { BenchmarkFixture } from './types.ts';

export const jsApiFixture: BenchmarkFixture = {
  id: 'fixture-js-api',
  name: 'Small JavaScript API',
  owner: 'benchmark-org',
  repo: 'express-task-service',
  defaultBranch: 'main',
  commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  checkRuns: [
    {
      id: 9001,
      name: 'test-suite',
      status: 'completed',
      conclusion: 'success',
      commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      completedAt: '2026-10-19T00:00:00Z',
      htmlUrl: 'https://github.com/benchmark-org/express-task-service/actions/runs/1/job/9001',
      isRelevantTestCheck: true,
    },
  ],
  files: {
    'package.json': JSON.stringify(
      {
        name: 'express-task-service',
        version: '1.0.0',
        main: 'src/server.js',
        scripts: {
          start: 'node src/server.js',
          test: 'node --test test/*.test.js',
        },
        dependencies: {
          express: '^4.18.2',
          sqlite3: '^5.1.6',
        },
        devDependencies: {
          supertest: '^6.3.3',
        },
      },
      null,
      2
    ),
    'README.md': `# Express Task Service\n\nA small native JavaScript REST API providing task CRUD operations and SQLite storage.`,
    'src/server.js': `const express = require('express');
const { taskRouter } = require('./routes/tasks');
const { authMiddleware } = require('./middleware/auth');

const app = express();
app.use(express.json());
app.use(authMiddleware);
app.use('/api/tasks', taskRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

module.exports = { app };
`,
    'src/routes/tasks.js': `const express = require('express');
const { getDatabase } = require('../db/database');
const router = express.Router();

router.get('/', (req, res) => {
  const db = getDatabase();
  res.json({ tasks: [] });
});

router.post('/', (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  res.status(201).json({ id: 1, title });
});

module.exports = { taskRouter: router };
`,
    'src/db/database.js': `const sqlite3 = require('sqlite3');

let dbInstance = null;
function getDatabase() {
  if (!dbInstance) {
    dbInstance = new sqlite3.Database(':memory:');
  }
  return dbInstance;
}

module.exports = { getDatabase };
`,
    'src/middleware/auth.js': `function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

module.exports = { authMiddleware };
`,
    'test/tasks.test.js': `const assert = require('node:assert');
const { describe, it } = require('node:test');
const { app } = require('../src/server');

describe('Tasks API Integration', () => {
  it('rejects unauthenticated requests with 401', () => {
    assert.strictEqual(typeof app, 'function');
  });
});
`,
    '.github/workflows/test.yml': `name: Node CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm test
`,
  },
  knownFacts: {
    name: 'Small JavaScript API',
    description: 'A small native JavaScript REST API with routing, auth, sqlite db, and test suite.',
    entryPoints: ['src/server.js'],
    routes: ['GET /health', 'GET /api/tasks', 'POST /api/tasks'],
    imports: [
      { from: 'src/server.js', to: 'src/routes/tasks.js' },
      { from: 'src/server.js', to: 'src/middleware/auth.js' },
      { from: 'src/routes/tasks.js', to: 'src/db/database.js' },
      { from: 'test/tasks.test.js', to: 'src/server.js' },
    ],
    tests: ['test/tasks.test.js'],
    workflows: ['.github/workflows/test.yml'],
    expectedRelationships: [
      { source: 'room-server', target: 'room-auth', type: 'calls' },
      { source: 'room-server', target: 'room-database', type: 'calls' },
      { source: 'room-tests', target: 'room-server', type: 'imports' },
    ],
    expectedRooms: ['room-server', 'room-auth', 'room-database', 'room-tests'],
    unsupportedOrUncertainFacts: [
      'Live database runtime connectivity cannot be proven without running the database',
      'Runtime latency distribution cannot be measured by static scan',
      'Environment variables and secrets are unknown without runtime config',
    ],
  },
};
