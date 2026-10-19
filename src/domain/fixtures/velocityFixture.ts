import type { BenchmarkFixture } from './types.ts';

export const velocityFixture: BenchmarkFixture = {
  id: 'fixture-living-blueprint',
  name: 'The Living Blueprint (Self)',
  owner: 'sakshamgupta005',
  repo: 'velocity',
  defaultBranch: 'main',
  commitSha: '67421ed463c545ba97faad2d039647abcdef12',
  checkRuns: [
    {
      id: 9999,
      name: 'Vite Production Build & Test Suite',
      status: 'completed',
      conclusion: 'success',
      commitSha: '67421ed463c545ba97faad2d039647abcdef12',
      completedAt: '2026-10-19T00:00:00Z',
      htmlUrl: 'https://github.com/sakshamgupta005/velocity/actions/runs/1/job/9999',
      isRelevantTestCheck: true,
    },
  ],
  files: {
    'package.json': JSON.stringify(
      {
        name: 'living-blueprint',
        version: '0.1.0',
        private: true,
        scripts: {
          dev: 'vite',
          build: 'tsc && vite build',
          test: 'node --test',
        },
        dependencies: {
          react: '^18.3.1',
          'react-dom': '^18.3.1',
        },
        devDependencies: {
          typescript: '^5.6.3',
          vite: '^5.4.11',
        },
      },
      null,
      2
    ),
    'README.md': `# The Living Blueprint\n\nInteractive software architecture house backed by verified git trees, tests, and CI evidence.`,
    'src/App.tsx': `import React, { useState } from 'react';
import { RepoConnectBar } from './components/RepoConnectBar';
import { RoomInspector } from './components/RoomInspector';

export const App: React.FC = () => {
  const [activeWorkspace, setActiveWorkspace] = useState(null);
  return (
    <div className="blueprint-container">
      <RepoConnectBar />
      <RoomInspector />
    </div>
  );
};
`,
    'src/domain/status/statusEngine.ts': `export type RoomStatus = 'verified' | 'implemented' | 'planned' | 'blocked' | 'unknown';

export function deriveRoomStatus(evidence: any): RoomStatus {
  if (evidence.failingTests?.length > 0) return 'blocked';
  if (evidence.passingTests?.length > 0) return 'verified';
  if (evidence.sourceFiles?.length > 0) return 'implemented';
  return 'planned';
}
`,
    'src/domain/github/scanner.ts': `import { deriveRoomStatus } from '../status/statusEngine';

export async function scanGitHubRepository(url: string, options: any) {
  return { success: true, owner: 'sakshamgupta005', repo: 'velocity' };
}
`,
    'test/statusEngine.test.ts': `import assert from 'node:assert';
import { describe, it } from 'node:test';
import { deriveRoomStatus } from '../src/domain/status/statusEngine';

describe('Deterministic Status Engine', () => {
  it('evaluates status: VERIFIED when relevant passing tests exist', () => {
    assert.strictEqual(deriveRoomStatus({ passingTests: ['test1'] }), 'verified');
  });
});
`,
  },
  knownFacts: {
    name: 'The Living Blueprint (Self)',
    description: 'An interactive developer tool mapping repositories to isometric software architecture houses.',
    entryPoints: ['src/App.tsx'],
    routes: ['POST /api/chat', 'POST /api/investigate', 'GET /api/health'],
    imports: [
      { from: 'src/App.tsx', to: 'src/domain/github/scanner.ts' },
      { from: 'src/domain/github/scanner.ts', to: 'src/domain/status/statusEngine.ts' },
      { from: 'test/statusEngine.test.ts', to: 'src/domain/status/statusEngine.ts' },
    ],
    tests: ['test/statusEngine.test.ts'],
    workflows: ['.github/workflows/ci.yml'],
    expectedRelationships: [
      { source: 'room-scanner', target: 'room-status', type: 'calls' },
      { source: 'room-tests', target: 'room-status', type: 'verifies' },
    ],
    expectedRooms: ['Domain Logic & Architecture', 'Components & UI', 'Testing & Verification'],
    unsupportedOrUncertainFacts: [
      'Remote deployment latency depends on hosting provider',
      'AI companion output variance depends on model availability',
    ],
  },
};
