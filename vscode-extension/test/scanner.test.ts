import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { discoverWorkspaceFiles, scanWorkspace } from '../src/workspaceScanner.ts';

const candidatePaths = [
  path.resolve(process.cwd(), 'test', 'fixtures'),
  path.resolve(process.cwd(), 'vscode-extension', 'test', 'fixtures'),
];
const fixturesDir = candidatePaths.find((p) => fs.existsSync(p)) || candidatePaths[0];

describe('VS Code Extension - Workspace Scanner & Status Engine', () => {
  const expressFixture = path.join(fixturesDir, 'small-express');
  const tsLibFixture = path.join(fixturesDir, 'ts-lib');
  const emptyFixture = path.join(fixturesDir, 'empty');

  it('discovers workspace files while pruning ignored directories (.git, node_modules, etc.)', async () => {
    const discovered = await discoverWorkspaceFiles(expressFixture);

    assert(discovered.length > 0, 'Should discover files in express fixture');
    assert(discovered.includes('package.json'), 'Should discover package.json');
    assert(discovered.includes('src/server.js'), 'Should discover src/server.js');
    assert(discovered.includes('src/routes/tasks.js'), 'Should discover src/routes/tasks.js');
    assert(discovered.includes('test/tasks.test.js'), 'Should discover test/tasks.test.js');

    // Ensure ignored directories were never traversed
    for (const file of discovered) {
      assert(!file.startsWith('node_modules/'), `Should not contain node_modules: ${file}`);
      assert(!file.startsWith('.git/'), `Should not contain .git: ${file}`);
      assert(!file.startsWith('dist/'), `Should not contain dist: ${file}`);
      assert(!file.startsWith('.vscode/'), `Should not contain .vscode: ${file}`);
    }
  });

  it('enforces bounded inspection budget and distinguishes discovered vs inspected files', async () => {
    const maxFilesToInspect = 2;
    const result = await scanWorkspace(expressFixture, {
      maxFilesToInspect,
      maxFileSizeBytes: 50 * 1024,
      totalScanBudgetBytes: 100 * 1024,
    });

    assert.strictEqual(typeof result.workspaceName, 'string');
    assert(result.discoveredFilesCount > 0, 'Discovered count should be > 0');
    assert(result.inspectedFilesCount > 0, 'Inspected count should be > 0');
    assert(
      result.inspectedFilesCount <= maxFilesToInspect,
      `Inspected files (${result.inspectedFilesCount}) should respect maxFilesToInspect (${maxFilesToInspect})`
    );
    assert(
      result.discoveredFilesCount >= result.inspectedFilesCount,
      'Discovered files count must be >= inspected files count'
    );
    assert(result.inspectedFiles.length === result.inspectedFilesCount);
    assert(result.discoveredFilePaths.length === result.discoveredFilesCount);
  });

  it('truthfully maps rooms without claiming tests passed when no execution evidence exists', async () => {
    const result = await scanWorkspace(expressFixture);

    assert(result.rooms.length > 0, 'Should map rooms from workspace files');

    // Verify rooms have valid statuses
    for (const room of result.rooms) {
      assert(['planned', 'implemented', 'verified', 'blocked', 'unknown'].includes(room.status));
    }

    // In a workspace where test files exist but no live test execution records / check runs were fed in,
    // the status engine MUST NOT claim verified for rooms that only have source code or test files.
    const testRoom = result.rooms.find((r) => r.id === 'room-tests');
    assert(testRoom, 'Expected room-tests to be mapped in express fixture');
    assert.strictEqual(
      testRoom.status,
      'implemented',
      'Automated test room without execution records must be implemented, not verified'
    );

    // Overall summary must be populated
    assert(result.statusSummary);
    assert.strictEqual(typeof result.statusSummary.implemented, 'number');
  });

  it('infers infrastructure pillars and project evaluation', async () => {
    const result = await scanWorkspace(expressFixture);

    assert(result.pillars.length > 0, 'Should infer infrastructure pillars');
    assert(result.projectEvaluation, 'Should provide projectEvaluation');
    assert.strictEqual(result.projectEvaluation.rooms.length, result.rooms.length);

    // Verify CanvasGraph generation from layoutEngine
    assert(result.graph, 'Should generate CanvasGraph');
    assert(result.graph.nodes.length > 0, 'Graph should contain nodes');
    assert.strictEqual(result.graph.viewMode, 'modules');
  });

  it('handles empty fixture workspace safely', async () => {
    const result = await scanWorkspace(emptyFixture);
    assert.strictEqual(result.workspaceName, 'empty');
    assert.strictEqual(result.discoveredFilesCount, 1);
  });

  it('scans TypeScript library fixture with auth and test rooms', async () => {
    const result = await scanWorkspace(tsLibFixture);
    assert.strictEqual(result.workspaceName, 'ts-lib');
    const authRoom = result.rooms.find((r) => r.id === 'room-auth');
    assert(authRoom, 'Expected room-auth to be mapped in ts-lib');
    assert.strictEqual(authRoom.status, 'implemented');
  });

  it('optional self-scan smoke test on host repo when accessible', async () => {
    const rootRepoDir = path.resolve(fixturesDir, '..', '..', '..');
    const rootPackageJson = path.join(rootRepoDir, 'package.json');
    if (!fs.existsSync(rootPackageJson)) {
      return; // Cleanly skip if repository checkout layout differs
    }
    const result = await scanWorkspace(rootRepoDir, { maxFilesToInspect: 5 });
    assert(result.discoveredFilesCount > 0, 'Self-scan should find files if root repo is present');
  });
});
