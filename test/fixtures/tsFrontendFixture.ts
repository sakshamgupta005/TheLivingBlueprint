import type { BenchmarkFixture } from './types.ts';

export const tsFrontendFixture: BenchmarkFixture = {
  id: 'fixture-ts-frontend',
  name: 'TypeScript Frontend',
  owner: 'benchmark-org',
  repo: 'vite-react-dashboard',
  defaultBranch: 'main',
  commitSha: 'b2c3d4e5f60718293a4b5c6d7e8f901234567890',
  checkRuns: [
    {
      id: 9002,
      name: 'vitest',
      status: 'completed',
      conclusion: 'success',
      commitSha: 'b2c3d4e5f60718293a4b5c6d7e8f901234567890',
      completedAt: '2026-10-19T00:00:00Z',
      htmlUrl: 'https://github.com/benchmark-org/vite-react-dashboard/actions/runs/2/job/9002',
      isRelevantTestCheck: true,
    },
  ],
  files: {
    'package.json': JSON.stringify(
      {
        name: 'vite-react-dashboard',
        version: '0.1.0',
        private: true,
        scripts: {
          dev: 'vite',
          build: 'tsc && vite build',
          test: 'vitest run',
        },
        dependencies: {
          react: '^18.3.1',
          'react-dom': '^18.3.1',
        },
        devDependencies: {
          typescript: '^5.6.3',
          vite: '^5.4.11',
          vitest: '^2.1.0',
        },
      },
      null,
      2
    ),
    'vite.config.ts': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`,
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          jsx: 'react-jsx',
          strict: true,
        },
      },
      null,
      2
    ),
    'README.md': `# React Dashboard\n\nA modern frontend single page dashboard built with React 18, Vite, and TypeScript.`,
    'index.html': `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Dashboard</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    'src/main.tsx': `import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`,
    'src/App.tsx': `import React from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { DashboardView } from './views/DashboardView';

export const App: React.FC = () => {
  return (
    <div className="layout">
      <Header title="Mission Control" />
      <Sidebar />
      <main>
        <DashboardView />
      </main>
    </div>
  );
};
`,
    'src/components/Header.tsx': `import React from 'react';

export const Header: React.FC<{ title: string }> = ({ title }) => (
  <header><h1>{title}</h1></header>
);
`,
    'src/components/Sidebar.tsx': `import React from 'react';

export const Sidebar: React.FC = () => (
  <aside><nav><a href="#overview">Overview</a></nav></aside>
);
`,
    'src/views/DashboardView.tsx': `import React from 'react';

export const DashboardView: React.FC = () => {
  return (
    <section>
      <h2>Active Metrics</h2>
      <p>System status operational.</p>
    </section>
  );
};
`,
    'test/App.test.tsx': `import { describe, it, expect } from 'vitest';
import { App } from '../src/App';

describe('App Component', () => {
  it('renders without crashing', () => {
    expect(App).toBeDefined();
  });
});
`,
    '.github/workflows/ci.yml': `name: Frontend CI
on: [push]
jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install
      - run: npm test
`,
  },
  knownFacts: {
    name: 'TypeScript Frontend',
    description: 'React SPA with Vite, TypeScript components, views, and vitest unit tests.',
    entryPoints: ['src/main.tsx', 'index.html'],
    routes: ['Client-side /overview view rendering'],
    imports: [
      { from: 'src/main.tsx', to: 'src/App.tsx' },
      { from: 'src/App.tsx', to: 'src/components/Header.tsx' },
      { from: 'src/App.tsx', to: 'src/components/Sidebar.tsx' },
      { from: 'src/App.tsx', to: 'src/views/DashboardView.tsx' },
      { from: 'test/App.test.tsx', to: 'src/App.tsx' },
    ],
    tests: ['test/App.test.tsx'],
    workflows: ['.github/workflows/ci.yml'],
    expectedRelationships: [
      { source: 'room-tests', target: 'room-ui', type: 'imports' },
    ],
    expectedRooms: ['room-ui', 'room-tests'],
    unsupportedOrUncertainFacts: [
      'Client-side runtime rendering speed and paint latency',
      'Real-world bundle size and code-splitting chunks after vite build',
      'Browser DOM compatibility quirks',
    ],
  },
};
