import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  ScanController,
  type ScanState,
  type WorkspaceFolderInfo,
} from '../src/scanController.ts';
import {
  scanWorkspace,
  getHostFileExcerpt,
  type WorkspaceBlueprintData,
  type FileReader,
} from '../src/workspaceScanner.ts';
import { shouldIgnorePath } from '../src/scanFilters.ts';

const candidatePaths = [
  path.resolve(process.cwd(), 'test', 'fixtures'),
  path.resolve(process.cwd(), 'vscode-extension', 'test', 'fixtures'),
];
const fixturesDir = candidatePaths.find((p) => fs.existsSync(p)) || candidatePaths[0];
const emptyFixture = path.join(fixturesDir, 'empty');
const expressFixture = path.join(fixturesDir, 'small-express');

function createMockBlueprint(workspacePath: string, roomsCount = 1): WorkspaceBlueprintData {
  const fullSummary = { planned: 0, implemented: roomsCount, verified: 0, blocked: 0, unknown: 0 };
  return {
    workspaceName: path.basename(workspacePath),
    workspacePath,
    scannedAt: new Date().toISOString(),
    discoveredFilesCount: roomsCount,
    inspectedFilesCount: roomsCount,
    totalScanBytes: 100,
    statusSummary: fullSummary,
    projectEvaluation: {
      projectId: path.basename(workspacePath),
      rooms: [],
      summary: fullSummary,
    },
    rooms: Array.from({ length: roomsCount }, (_, i) => ({
      id: `room-${i}`,
      name: `Room ${i}`,
      layer: 'core',
      status: 'implemented',
      description: 'Mock room',
      evidence: 'code',
      metrics: {},
      coords: { isoX: 0, isoY: 0, width: 10, height: 10, depth: 10 },
    })),
    pillars: [],
    dependencies: [],
    graph: {
      id: 'mock-graph',
      title: 'Mock Graph',
      bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100, width: 100, height: 100 },
      nodes: [],
      edges: [],
      viewMode: 'modules',
    },
    discoveredFilePaths: ['src/app.ts'],
    inspectedFiles: [{ path: 'src/app.ts', category: 'source', sizeBytes: 100, score: 90 }],
    skippedFiles: [],
    truncated: false,
  };
}

describe('VS Code Extension - Scan Lifecycle & Controller (P2-04)', () => {
  it('1. A change during a scan causes exactly one follow-up scan', async () => {
    let scanCount = 0;
    let resolveFirstScan: ((data: WorkspaceBlueprintData) => void) | undefined;

    const controller = new ScanController({
      debounceMs: 0, // Deterministic immediate scheduling
      scanFn: async (folderPath, signal) => {
        scanCount++;
        if (scanCount === 1) {
          // Keep first scan pending until triggered
          return new Promise<WorkspaceBlueprintData>((resolve, reject) => {
            resolveFirstScan = resolve;
            signal.addEventListener('abort', () => {
              const err = new Error('Aborted');
              err.name = 'AbortError';
              reject(err);
            });
          });
        }
        return createMockBlueprint(folderPath, 2);
      },
      onStateChange: () => {},
      onScanComplete: () => {},
    });

    controller.setFolders([{ uri: { fsPath: '/test/workspace' }, name: 'Test', index: 0 }]);
    // First scan is now in-flight (scanCount === 1)
    assert.strictEqual(scanCount, 1);

    // Request new scan while first is in-flight
    controller.requestScan(true);
    controller.requestScan(true); // Extra requests must coalesce into ONE follow-up

    // Now resolve or abort first scan
    assert.ok(resolveFirstScan);
    resolveFirstScan!(createMockBlueprint('/test/workspace', 1));

    // Allow event loop to process the queued follow-up scan
    await new Promise((r) => setTimeout(r, 20));

    // Exactly one follow-up scan occurred
    assert.strictEqual(scanCount, 2);
    controller.dispose();
  });

  it('2. Fifty rapid events are debounced into one scan request', async () => {
    let scanCount = 0;

    const controller = new ScanController({
      debounceMs: 40,
      scanFn: async (folderPath) => {
        scanCount++;
        return createMockBlueprint(folderPath);
      },
      onStateChange: () => {},
      onScanComplete: () => {},
    });

    controller.setFolders([{ uri: { fsPath: '/test/workspace' }, name: 'Test', index: 0 }]);
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(scanCount, 1, 'Initial scan ran on setFolders');

    // Reset scan counter and fire 50 rapid events
    scanCount = 0;
    for (let i = 0; i < 50; i++) {
      controller.requestScan(false);
    }

    // Still 0 before debounce timer fires
    assert.strictEqual(scanCount, 0, 'No scan should execute before debounce delay');

    // Wait for debounce timer to fire
    await new Promise((r) => setTimeout(r, 80));

    // Debounced into exactly 1 scan execution
    assert.strictEqual(scanCount, 1, '50 rapid events must debounce into exactly 1 scan');
    controller.dispose();
  });

  it('3. Aborting stops subsequent file reads and does not publish a partial snapshot', async () => {
    let published = false;
    let readsCount = 0;

    const abortController = new AbortController();

    const mockReader: FileReader = {
      readFile: async (fp: string) => {
        readsCount++;
        if (readsCount >= 1) {
          abortController.abort(); // Trigger abort after first read
        }
        return `// content for ${fp}`;
      },
      stat: async () => ({ size: 50 }),
      readdir: async () => [
        { name: 'file1.ts', isFile: () => true, isDirectory: () => false } as any,
        { name: 'file2.ts', isFile: () => true, isDirectory: () => false } as any,
        { name: 'file3.ts', isFile: () => true, isDirectory: () => false } as any,
      ],
    };

    let errorThrown: any = null;
    try {
      await scanWorkspace(expressFixture, {
        signal: abortController.signal,
        fileReader: mockReader,
      });
      published = true;
    } catch (err) {
      errorThrown = err;
    }

    // Must have aborted without publishing snapshot
    assert.strictEqual(published, false, 'Partial snapshot must not be published on abort');
    assert.ok(errorThrown, 'Should throw AbortError when aborted');
    assert.strictEqual(errorThrown.name, 'AbortError');
    assert.strictEqual(readsCount, 1, 'File reading must cease promptly upon abort');
  });

  it('4. A failed scan retains the previous snapshot and marks it stale', async () => {
    let shouldFail = false;
    let reportedData: WorkspaceBlueprintData | null = null;
    let reportedIsStale = false;
    let latestState: ScanState | undefined;

    const controller = new ScanController({
      debounceMs: 0,
      scanFn: async (folderPath) => {
        if (shouldFail) {
          throw new Error('EACCES: permission denied');
        }
        return createMockBlueprint(folderPath, 3);
      },
      onStateChange: (state) => {
        latestState = state;
      },
      onScanComplete: (_fp, data, isStale) => {
        reportedData = data;
        reportedIsStale = isStale;
      },
    });

    // Step 1: Initial successful scan
    controller.setFolders([{ uri: { fsPath: '/test/workspace' }, name: 'Test', index: 0 }]);
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(reportedData);
    assert.strictEqual(reportedIsStale, false);
    assert.strictEqual(latestState?.status, 'idle');

    // Step 2: Trigger failing scan
    shouldFail = true;
    controller.requestScan(true);
    await new Promise((r) => setTimeout(r, 10));

    // Stale snapshot preserved
    assert.ok(reportedData, 'Must retain previous snapshot');
    assert.strictEqual(reportedIsStale, true, 'Reported snapshot must be marked stale');
    assert.strictEqual(latestState?.status, 'error');
    assert.strictEqual(latestState?.isStale, true);
    assert.match(latestState?.message || '', /retaining last known/i);
    controller.dispose();
  });

  it('5. The empty fixture produces the empty state and zero rooms', async () => {
    const result = await scanWorkspace(emptyFixture);

    assert.strictEqual(result.discoveredFilesCount, 1, 'Discovered placeholder .gitkeep file');
    assert.strictEqual(result.rooms.length, 0, 'Empty workspace must have 0 fabricated rooms');
    assert.strictEqual(result.pillars.length, 0, 'Empty workspace must have 0 pillars');

    let reportedState: ScanState | undefined;
    const controller = new ScanController({
      debounceMs: 0,
      scanFn: async (fp) => scanWorkspace(fp),
      onStateChange: (state) => {
        reportedState = state;
      },
      onScanComplete: () => {},
    });

    controller.setFolders([{ uri: { fsPath: emptyFixture }, name: 'empty', index: 0 }]);
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(reportedState?.status, 'empty');
    assert.match(reportedState?.message || '', /no architectural files/i);
    controller.dispose();
  });

  it('6. Workspace-folder addition/removal updates active roots and state', () => {
    let currentState: ScanState | undefined;
    const controller = new ScanController({
      debounceMs: 0,
      scanFn: async (fp) => createMockBlueprint(fp),
      onStateChange: (state) => {
        currentState = state;
      },
      onScanComplete: () => {},
    });

    const folderA: WorkspaceFolderInfo = { uri: { fsPath: '/repo/frontend' }, name: 'frontend', index: 0 };
    const folderB: WorkspaceFolderInfo = { uri: { fsPath: '/repo/backend' }, name: 'backend', index: 1 };

    // Initially 2 folders
    controller.setFolders([folderA, folderB]);
    assert.strictEqual(controller.getFolders().length, 2);
    assert.strictEqual(controller.getActiveFolderPath(), '/repo/frontend');

    // Switch active folder
    controller.setActiveFolder('/repo/backend');
    assert.strictEqual(controller.getActiveFolderPath(), '/repo/backend');

    // Remove folderB
    controller.setFolders([folderA]);
    assert.strictEqual(controller.getFolders().length, 1);
    assert.strictEqual(controller.getActiveFolderPath(), '/repo/frontend');

    // Remove all folders
    controller.setFolders([]);
    assert.strictEqual(controller.getFolders().length, 0);
    assert.strictEqual(controller.getActiveFolderPath(), undefined);
    assert.strictEqual(currentState?.status, 'noWorkspace');

    controller.dispose();
  });

  it('7. Dirty-buffer content is used for inspected open files and passes through redaction', async () => {
    // Provide planted secret in dirty buffer for src/server.js
    const dirtyServerContent = [
      'const express = require("express");',
      'const secretKey = "API_KEY=\\"planted_dirty_token_888\\"";',
      'module.exports = express;',
    ].join('\n');

    const dirtyBuffers = new Map<string, string>([
      ['src/server.js', dirtyServerContent],
    ]);

    const result = await scanWorkspace(expressFixture, { dirtyBuffers });

    // Must be marked as having unsaved changes
    assert.strictEqual(result.includesUnsavedChanges, true, 'Snapshot must note includesUnsavedChanges');

    // Host excerpt must contain content from dirty buffer, with secret redacted
    const excerpt = getHostFileExcerpt(result, 'src/server.js');
    assert.ok(excerpt, 'Host excerpt should exist for src/server.js');
    assert.strictEqual(
      excerpt.includes('planted_dirty_token_888'),
      false,
      'Planted token in dirty buffer must be redacted'
    );
    assert.match(excerpt, /\[REDACTED\]/);
    assert.match(excerpt, /const express = require\("express"\);/);
  });

  it('8. Changes inside denied directories do not trigger scans', () => {
    // Verify shouldIgnorePath blocks watcher events for denied files/dirs
    assert.strictEqual(shouldIgnorePath('node_modules/lodash/index.js', false).ignored, true);
    assert.strictEqual(shouldIgnorePath('.git/refs/heads/main', false).ignored, true);
    assert.strictEqual(shouldIgnorePath('dist/bundle.js', false).ignored, true);
    assert.strictEqual(shouldIgnorePath('.aws/credentials', false).ignored, true);
    assert.strictEqual(shouldIgnorePath('.env', false).ignored, true);
    assert.strictEqual(shouldIgnorePath('.env.production', false).ignored, true);

    // Legitimate project files are NOT ignored
    assert.strictEqual(shouldIgnorePath('src/server.js', false).ignored, false);
    assert.strictEqual(shouldIgnorePath('package.json', false).ignored, false);
    assert.strictEqual(shouldIgnorePath('test/auth.test.ts', false).ignored, false);
  });

  it('9. Multi-root: event on non-active folder marks it dirty without rescanning active folder, and switching to it rescans (Medium 4)', async () => {
    let scanCountA = 0;
    let scanCountB = 0;

    const controller = new ScanController({
      debounceMs: 10,
      scanFn: async (folderPath) => {
        if (folderPath.includes('folderA')) {
          scanCountA++;
        } else if (folderPath.includes('folderB')) {
          scanCountB++;
        }
        return createMockBlueprint(folderPath, 1);
      },
    });

    const folderA: WorkspaceFolderInfo = { uri: { fsPath: '/mock/folderA' }, name: 'folderA', index: 0 };
    const folderB: WorkspaceFolderInfo = { uri: { fsPath: '/mock/folderB' }, name: 'folderB', index: 1 };

    controller.setFolders([folderA, folderB]);
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Initially, folderA is active and scanned once
    assert.strictEqual(scanCountA, 1, 'Folder A should be scanned initially');
    assert.strictEqual(scanCountB, 0, 'Folder B should not be scanned initially');

    // Event arrives for folder B while A is active
    controller.requestScan(false, folderB.uri.fsPath);
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Folder A is NOT rescanned
    assert.strictEqual(scanCountA, 1, 'Folder A must not be rescanned when event occurs in folder B');
    assert.strictEqual(scanCountB, 0, 'Folder B must not be rescanned in background while inactive');

    // Switch active folder to folder B -> triggers exactly one scan of B
    controller.setActiveFolder(folderB.uri.fsPath);
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.strictEqual(scanCountB, 1, 'Switching to dirty/unscanned folder B must trigger exactly one scan of B');
    assert.strictEqual(scanCountA, 1, 'Folder A must remain untouched');

    controller.dispose();
  });
});
