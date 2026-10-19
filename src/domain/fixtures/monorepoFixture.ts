import type { BenchmarkFixture } from './types.ts';

export const monorepoFixture: BenchmarkFixture = {
  id: 'fixture-monorepo',
  name: 'TypeScript Monorepo',
  owner: 'benchmark-org',
  repo: 'saas-platform-monorepo',
  defaultBranch: 'main',
  commitSha: 'd4e5f60718293a4b5c6d7e8f9012345678901234',
  checkRuns: [
    {
      id: 9004,
      name: 'ci-matrix',
      status: 'completed',
      conclusion: 'success',
      commitSha: 'd4e5f60718293a4b5c6d7e8f9012345678901234',
      completedAt: '2026-10-19T00:00:00Z',
      htmlUrl: 'https://github.com/benchmark-org/saas-platform-monorepo/actions/runs/4/job/9004',
      isRelevantTestCheck: true,
    },
  ],
  files: {
    'package.json': JSON.stringify(
      {
        name: 'saas-platform-root',
        private: true,
        workspaces: ['packages/*'],
        scripts: {
          test: 'turbo run test',
          build: 'turbo run build',
        },
      },
      null,
      2
    ),
    'README.md': `# SaaS Platform Monorepo\n\nTurborepo monorepo with API server, Web React client, and shared TypeScript domain types.`,
    'packages/api/package.json': JSON.stringify(
      {
        name: '@saas/api',
        version: '1.0.0',
        main: 'src/server.ts',
        dependencies: {
          express: '^4.18.2',
        },
      },
      null,
      2
    ),
    'packages/api/src/server.ts': `import express from 'express';
import { userRouter } from './routes/users';

export const app = express();
app.use(express.json());
app.use('/api/v1/users', userRouter);
`,
    'packages/api/src/routes/users.ts': `import { Router } from 'express';
import type { UserProfile } from '../../../shared/src/types';

export const userRouter = Router();
userRouter.get('/', (req, res) => {
  const users: UserProfile[] = [{ id: 'u1', name: 'Alice', role: 'admin' }];
  res.json({ users });
});
`,
    'packages/api/test/users.test.ts': `import { describe, it } from 'node:test';
import assert from 'node:assert';
import { app } from '../src/server';

describe('Users API route', () => {
  it('initializes express app', () => {
    assert.strictEqual(typeof app, 'function');
  });
});
`,
    'packages/web/package.json': JSON.stringify(
      {
        name: '@saas/web',
        version: '1.0.0',
        dependencies: {
          react: '^18.3.1',
        },
      },
      null,
      2
    ),
    'packages/web/src/App.tsx': `import React from 'react';
import { UserList } from './components/UserList';

export const App: React.FC = () => {
  return (
    <div>
      <h1>SaaS Platform Admin</h1>
      <UserList />
    </div>
  );
};
`,
    'packages/web/src/components/UserList.tsx': `import React from 'react';
import type { UserProfile } from '../../../shared/src/types';

export const UserList: React.FC = () => {
  const users: UserProfile[] = [{ id: 'u1', name: 'Alice', role: 'admin' }];
  return (
    <ul>
      {users.map((u) => (
        <li key={u.id}>{u.name} ({u.role})</li>
      ))}
    </ul>
  );
};
`,
    'packages/web/test/App.test.tsx': `import { describe, it } from 'node:test';
import assert from 'node:assert';
import { App } from '../src/App';

describe('Web App Component', () => {
  it('exports component', () => {
    assert.strictEqual(typeof App, 'function');
  });
});
`,
    'packages/shared/package.json': JSON.stringify(
      {
        name: '@saas/shared',
        version: '1.0.0',
        main: 'src/types.ts',
      },
      null,
      2
    ),
    'packages/shared/src/types.ts': `export interface UserProfile {
  id: string;
  name: string;
  role: 'admin' | 'member' | 'guest';
}
`,
    '.github/workflows/ci.yml': `name: Monorepo CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install
      - run: npm test
`,
  },
  knownFacts: {
    name: 'TypeScript Monorepo',
    description: 'Workspaces monorepo containing @saas/api, @saas/web, and @saas/shared packages.',
    entryPoints: ['packages/api/src/server.ts', 'packages/web/src/App.tsx'],
    routes: ['GET /api/v1/users'],
    imports: [
      { from: 'packages/api/src/server.ts', to: 'packages/api/src/routes/users.ts' },
      { from: 'packages/api/src/routes/users.ts', to: 'packages/shared/src/types.ts' },
      { from: 'packages/web/src/App.tsx', to: 'packages/web/src/components/UserList.tsx' },
      { from: 'packages/web/src/components/UserList.tsx', to: 'packages/shared/src/types.ts' },
      { from: 'packages/api/test/users.test.ts', to: 'packages/api/src/server.ts' },
      { from: 'packages/web/test/App.test.tsx', to: 'packages/web/src/App.tsx' },
    ],
    tests: ['packages/api/test/users.test.ts', 'packages/web/test/App.test.tsx'],
    workflows: ['.github/workflows/ci.yml'],
    expectedRelationships: [
      { source: 'room-tests', target: 'room-server', type: 'imports' },
      { source: 'room-tests', target: 'room-ui', type: 'imports' },
    ],
    expectedRooms: ['room-server', 'room-ui', 'room-tests'],
    unsupportedOrUncertainFacts: [
      'Turborepo build artifact cache hit rates across remote developers',
      'Circular workspace symlink resolution without running npm/yarn/pnpm install',
      'Runtime inter-process communication between API and Web frontend',
    ],
  },
};
