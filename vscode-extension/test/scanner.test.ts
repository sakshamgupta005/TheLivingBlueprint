import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import { discoverWorkspaceFiles, scanWorkspace } from '../src/workspaceScanner.ts';

describe('VS Code Extension - Workspace Scanner & Status Engine', () => {
  const rootDir = path.resolve(process.cwd(), '..');

  it('discovers workspace files while pruning ignored directories (.git, node_modules, etc.)', async () => {
    const discovered = await discoverWorkspaceFiles(rootDir);

    assert(discovered.length > 0, 'Should discover files in current workspace');
    assert(discovered.includes('package.json'), 'Should discover package.json');
    assert(discovered.includes('src/App.tsx'), 'Should discover src/App.tsx');

    // Ensure ignored directories were never traversed
    for (const file of discovered) {
      assert(!file.startsWith('node_modules/'), `Should not contain node_modules: ${file}`);
      assert(!file.startsWith('.git/'), `Should not contain .git: ${file}`);
      assert(!file.startsWith('dist/'), `Should not contain dist: ${file}`);
      assert(!file.startsWith('.vscode/'), `Should not contain .vscode: ${file}`);
    }
  });

  it('enforces bounded inspection budget and distinguishes discovered vs inspected files', async () => {
    const maxFilesToInspect = 15;
    const result = await scanWorkspace(rootDir, {
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
    const result = await scanWorkspace(rootDir);

    assert(result.rooms.length > 0, 'Should map rooms from workspace files');

    // Verify rooms have valid statuses
    for (const room of result.rooms) {
      assert(['planned', 'implemented', 'verified', 'blocked', 'unknown'].includes(room.status));
    }

    // In a workspace where test files exist but no live test execution records / check runs were fed in,
    // the status engine MUST NOT claim verified for rooms that only have source code or test files.
    const testRoom = result.rooms.find((r) => r.id === 'room-tests');
    if (testRoom) {
      // Test suite files detected in source code without test runner output result in implemented
      assert.strictEqual(
        testRoom.status,
        'implemented',
        'Automated test room without execution records must be implemented, not verified'
      );
    }

    // Overall summary must be populated
    assert(result.statusSummary);
    assert.strictEqual(typeof result.statusSummary.implemented, 'number');
  });

  it('infers infrastructure pillars and project evaluation', async () => {
    const result = await scanWorkspace(rootDir);

    assert(result.pillars.length > 0, 'Should infer infrastructure pillars');
    assert(result.projectEvaluation, 'Should provide projectEvaluation');
    assert.strictEqual(result.projectEvaluation.rooms.length, result.rooms.length);
  });
});
