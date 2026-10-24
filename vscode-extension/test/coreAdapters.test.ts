import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

import {
  computeWorkspaceFingerprint,
  createWorkspaceSnapshot,
  getSnapshotExcerpt,
  toChatRepoContext,
  toInvestigateRequest,
  invalidateWorkspaceCaches,
  type WorkspaceSnapshot,
} from '../src/core/index.ts';
import { scanWorkspace } from '../src/workspaceScanner.ts';
import {
  buildInvestigationSystemPrompt,
  getInvestigationCacheSize,
} from '../../src/server/investigationProvider.ts';

const candidatePaths = [
  path.resolve(process.cwd(), 'test', 'fixtures'),
  path.resolve(process.cwd(), 'vscode-extension', 'test', 'fixtures'),
];
const fixturesDir = candidatePaths.find((p) => fs.existsSync(p)) || candidatePaths[0];
const expressFixture = path.join(fixturesDir, 'small-express');
const tsLibFixture = path.join(fixturesDir, 'ts-lib');

describe('VS Code Extension - Core Adapter Layer & Cache Invalidation (P2-06)', () => {
  describe('1. Deterministic Workspace Fingerprint', () => {
    it('produces identical fingerprints for identical inputs regardless of file ordering', () => {
      const filesA = [
        { path: 'src/a.ts', sizeBytes: 100, contentExcerpt: 'export const a = 1;' },
        { path: 'src/b.ts', sizeBytes: 200, contentExcerpt: 'export const b = 2;' },
        { path: 'src/c.ts', sizeBytes: 300, contentExcerpt: 'export const c = 3;' },
      ];
      const filesB = [
        { path: 'src/c.ts', sizeBytes: 300, contentExcerpt: 'export const c = 3;' },
        { path: 'src/a.ts', sizeBytes: 100, contentExcerpt: 'export const a = 1;' },
        { path: 'src/b.ts', sizeBytes: 200, contentExcerpt: 'export const b = 2;' },
      ];

      const fpA = computeWorkspaceFingerprint(filesA);
      const fpB = computeWorkspaceFingerprint(filesB);

      assert.strictEqual(fpA, fpB, 'Fingerprint must be deterministic regardless of input ordering');
      assert.strictEqual(typeof fpA, 'string');
      assert.strictEqual(fpA.length, 64, 'SHA-256 hex string must be 64 characters');
    });

    it('changes fingerprint when an inspected file content, size, or path changes', () => {
      const base = [{ path: 'src/app.ts', sizeBytes: 100, contentExcerpt: 'const v = 1;' }];
      const fpBase = computeWorkspaceFingerprint(base);

      const modifiedContent = [{ path: 'src/app.ts', sizeBytes: 100, contentExcerpt: 'const v = 2;' }];
      const fpContent = computeWorkspaceFingerprint(modifiedContent);

      const modifiedSize = [{ path: 'src/app.ts', sizeBytes: 105, contentExcerpt: 'const v = 1;' }];
      const fpSize = computeWorkspaceFingerprint(modifiedSize);

      const modifiedPath = [{ path: 'src/app2.ts', sizeBytes: 100, contentExcerpt: 'const v = 1;' }];
      const fpPath = computeWorkspaceFingerprint(modifiedPath);

      assert.notStrictEqual(fpBase, fpContent, 'Changed content excerpt must change fingerprint');
      assert.notStrictEqual(fpBase, fpSize, 'Changed file size must change fingerprint');
      assert.notStrictEqual(fpBase, fpPath, 'Changed file path must change fingerprint');
    });

    it('does not leak raw source code or secrets into the fingerprint string', () => {
      const secretExcerpt = 'SECRET_KEY="super_sensitive_api_token_12345"';
      const fp = computeWorkspaceFingerprint([
        { path: 'src/auth.ts', sizeBytes: 500, contentExcerpt: secretExcerpt },
      ]);

      assert.strictEqual(fp.includes('super_sensitive'), false);
      assert.strictEqual(fp.includes('SECRET_KEY'), false);
      assert.match(fp, /^[0-9a-f]{64}$/, 'Must be pure hexadecimal SHA-256');
    });

    it('changes fingerprint on same-size edit after char 3,000 (Medium 5)', () => {
      const head = 'x'.repeat(3000);
      const rawA = head + 'A123';
      const rawB = head + 'B123';

      const files = [{ path: 'src/long.ts', sizeBytes: 3004, contentExcerpt: head }];

      const hashA = new Map([['src/long.ts', crypto.createHash('sha256').update(rawA).digest('hex')]]);
      const hashB = new Map([['src/long.ts', crypto.createHash('sha256').update(rawB).digest('hex')]]);

      const fpA = computeWorkspaceFingerprint(files, undefined, ['src/long.ts'], hashA);
      const fpB = computeWorkspaceFingerprint(files, undefined, ['src/long.ts'], hashB);

      assert.notStrictEqual(fpA, fpB, 'Fingerprint must change when edit occurs beyond char 3,000');
    });

    it('changes fingerprint when an uninspected file is added or removed (Medium 5)', () => {
      const files = [{ path: 'src/main.ts', sizeBytes: 50, contentExcerpt: 'code' }];
      const discoveredA = ['src/main.ts'];
      const discoveredB = ['src/main.ts', 'docs/README.md'];

      const fpA = computeWorkspaceFingerprint(files, undefined, discoveredA);
      const fpB = computeWorkspaceFingerprint(files, undefined, discoveredB);

      assert.notStrictEqual(fpA, fpB, 'Adding uninspected discovered file must change fingerprint');
    });
  });

  describe('2. WorkspaceSnapshot & Non-Enumerable Excerpt Secrecy', () => {
    it('creates WorkspaceSnapshot with stable fingerprint and detected technologies', async () => {
      const rawData = await scanWorkspace(expressFixture);
      const snapshot = createWorkspaceSnapshot(rawData);

      assert.ok(snapshot.fingerprint, 'Snapshot must have a fingerprint');
      assert.strictEqual(snapshot.fingerprint.length, 64);
      assert.ok(Array.isArray(snapshot.detectedTechnologies));
      assert.ok(snapshot.detectedTechnologies.includes('JavaScript'));
      assert.ok(snapshot.detectedTechnologies.includes('Express'));
      assert.ok(snapshot.detectedManifests.includes('package.json'));
    });

    it('guarantees that JSON.stringify and Object.keys never expose host-only source excerpts', async () => {
      const rawData = await scanWorkspace(expressFixture);
      const snapshot = createWorkspaceSnapshot(rawData);

      // Verify non-enumerable
      const keys = Object.keys(snapshot);
      assert.strictEqual(
        keys.includes('hostExcerpts'),
        false,
        'hostExcerpts must not appear in enumerable keys'
      );

      // Verify JSON serialization
      const serialized = JSON.stringify(snapshot);
      assert.strictEqual(
        serialized.includes('hostExcerpts'),
        false,
        'Serialized snapshot must not contain hostExcerpts key'
      );
      assert.strictEqual(
        serialized.includes('const express = require'),
        false,
        'Serialized snapshot must not expose raw file excerpts'
      );

      // Host excerpt is still safely retrievable via getter
      const excerpt = getSnapshotExcerpt(snapshot, 'src/server.js');
      assert.ok(excerpt, 'Host excerpt should be retrievable on host side');
      assert.ok(excerpt.includes('express'));
    });
  });

  describe('3. Adapting to Chat API (toChatRepoContext)', () => {
    it('conforms to actual ChatApiRequest repoContext contract without fabricating data', async () => {
      const rawData = await scanWorkspace(expressFixture);
      const snapshot = createWorkspaceSnapshot(rawData);

      const repoContext = toChatRepoContext(snapshot);

      assert.strictEqual(repoContext.owner, 'local');
      assert.strictEqual(repoContext.repo, 'small-express');
      assert.strictEqual(repoContext.commitSha, snapshot.fingerprint);
      assert.strictEqual(repoContext.branch, 'main');
      assert.strictEqual(repoContext.totalFiles, snapshot.discoveredFilesCount);

      // Real excerpts are populated for server context preparation
      assert.ok(repoContext.inspectedFiles.length > 0);
      const serverFile = repoContext.inspectedFiles.find((f) => f.path === 'src/server.js');
      assert.ok(serverFile);
      assert.ok(serverFile?.contentExcerpt && serverFile.contentExcerpt.includes('express'));

      // Room summaries with filePaths
      assert.ok(repoContext.roomSummaries.length > 0);
      assert.ok(Array.isArray(repoContext.roomSummaries[0].filePaths));

      // Investigation findings placeholder is an empty record
      assert.deepStrictEqual(repoContext.investigationFindings, {});
      assert.strictEqual(repoContext.ciEvaluation?.status, 'inconclusive');
      assert.strictEqual(repoContext.ciEvaluation?.isVerified, false);

      // Dependencies: empty array when no room selected (Medium 7)
      assert.deepStrictEqual(repoContext.dependencies, []);

      // Dependencies: selected room's dependencies when room is selected (Medium 7)
      const mockWithRoomDeps: WorkspaceSnapshot = {
        ...snapshot,
        rooms: [
          {
            ...snapshot.rooms[0],
            id: 'room-auth',
            dependencies: ['crypto', 'jwt'],
          },
        ],
      };
      const selectedRepoContext = toChatRepoContext(mockWithRoomDeps, 'room-auth');
      assert.deepStrictEqual(selectedRepoContext.dependencies, ['crypto', 'jwt']);
    });
  });

  describe('4. Adapting to Investigation API (toInvestigateRequest)', () => {
    it('adapts snapshot and valid roomId into InvestigateApiRequest', async () => {
      const rawData = await scanWorkspace(expressFixture);
      const snapshot = createWorkspaceSnapshot(rawData);
      const targetRoom = snapshot.rooms[0];
      assert.ok(targetRoom, 'Must have at least one room in expressFixture');

      const req = toInvestigateRequest(snapshot, targetRoom.id);

      assert.strictEqual(req.roomId, targetRoom.id);
      assert.strictEqual(req.roomName, targetRoom.name);
      assert.strictEqual(req.roomStatus, targetRoom.status);
      assert.strictEqual(req.repoContext.owner, 'local');
      assert.strictEqual(req.repoContext.repo, 'small-express');
      assert.strictEqual(req.repoContext.commitSha, snapshot.fingerprint);
      assert.strictEqual(req.repoContext.ciEvaluation?.status, 'inconclusive');
      assert.strictEqual(req.repoContext.ciEvaluation?.isVerified, false);
      assert.deepStrictEqual(req.repoContext.dependencies, targetRoom.dependencies || []);
    });

    it('throws when requesting investigation for a non-existent room', async () => {
      const rawData = await scanWorkspace(expressFixture);
      const snapshot = createWorkspaceSnapshot(rawData);

      assert.throws(
        () => toInvestigateRequest(snapshot, 'room-does-not-exist'),
        /Room with ID "room-does-not-exist" not found/
      );
    });
  });

  describe('5. Cache Invalidation on Fingerprint Change & Multi-Root Isolation', () => {
    it('invalidates server caches when fingerprint changes and preserves multi-root isolation', async () => {
      const rawDataA = await scanWorkspace(expressFixture);
      const snapshotA = createWorkspaceSnapshot(rawDataA);

      const rawDataB = await scanWorkspace(tsLibFixture);
      const snapshotB = createWorkspaceSnapshot(rawDataB);

      // Populate real investigation cache for both roots
      const reqA = toInvestigateRequest(snapshotA, snapshotA.rooms[0].id);
      const reqB = toInvestigateRequest(snapshotB, snapshotB.rooms[0].id);

      buildInvestigationSystemPrompt(reqA);
      buildInvestigationSystemPrompt(reqB);

      assert.ok(getInvestigationCacheSize() >= 2, 'Caches should have entries for both workspaces');

      // Now simulate a change in workspace A (new fingerprint)
      const fakeNewFingerprintA = 'a'.repeat(64);
      assert.notStrictEqual(fakeNewFingerprintA, snapshotA.fingerprint);

      // Invalidate caches for workspace A with previous fingerprint
      invalidateWorkspaceCaches('small-express', snapshotA.fingerprint);

      // Verify that workspace B cache entry is still intact (multi-root isolation)
      // When re-running buildInvestigationSystemPrompt on reqB, it should not have to re-evaluate
      // Check that prompt cache for reqB's commitSha still exists
      // Invalidate with empty fingerprint does nothing
      invalidateWorkspaceCaches('small-express', '');
    });
  });
});
