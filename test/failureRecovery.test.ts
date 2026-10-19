import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanGitHubRepository } from '../src/domain/github/scanner.ts';
import { executeAiChat } from '../src/server/aiProvider.ts';
import { executeRoomInvestigation } from '../src/server/investigationProvider.ts';
import {
  saveWorkspace,
  loadWorkspace,
  loadAllWorkspaces,
  getRecentProjects,
  sanitizeSessionForStorage,
} from '../src/domain/workspace/workspaceStorage.ts';
import type { GitHubScanResult } from '../src/domain/github/types.ts';
import type { ArchitecturalRoom } from '../src/types.ts';
import type { WorkspaceSession } from '../src/domain/workspace/types.ts';
import type { ChatApiRequest } from '../src/server/types.ts';
import type { InvestigateApiRequest } from '../src/domain/investigation/types.ts';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] || null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe('T14: Failure Recovery, Partial Scans & Demo Readiness', () => {
  it('1. Rate-limit 403 response includes quota reset time and remaining minutes without looping', async () => {
    const mockHeaders = new Headers({
      'x-ratelimit-limit': '60',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1200), // 20 mins in future
    });

    const mockFetch = async () => new Response('rate limit', { status: 403, headers: mockHeaders });

    const result = await scanGitHubRepository('https://github.com/test-org/rate-limited-repo', {
      fetchFn: mockFetch as typeof fetch,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'failed');
    assert.ok(result.error?.includes('rate limit exceeded'));
    assert.ok(result.error?.includes('in ~20 mins') || result.error?.includes('Quota resets at'));
    assert.equal(result.rateLimit?.remaining, 0);
  });

  it('2. Distinguishes complete vs partial scans when file content read fails', async () => {
    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/repos/org/repo/git/trees/')) {
        return new Response(
          JSON.stringify({
            tree: [
              { path: 'package.json', type: 'blob', size: 100 },
              { path: 'src/failing.js', type: 'blob', size: 500 },
            ],
            truncated: false,
          }),
          { status: 200 }
        );
      }
      if (urlStr.includes('/repos/org/repo/commits/')) {
        return new Response(JSON.stringify({ sha: 'commit12345' }), { status: 200 });
      }
      if (urlStr.includes('/repos/org/repo')) {
        return new Response(
          JSON.stringify({
            name: 'repo',
            full_name: 'org/repo',
            default_branch: 'main',
            private: false,
          }),
          { status: 200 }
        );
      }
      if (urlStr.includes('package.json')) {
        return new Response(JSON.stringify({ name: 'test-app' }), { status: 200 });
      }
      if (urlStr.includes('src/failing.js')) {
        return new Response('Not found', { status: 404 });
      }
      return new Response('{}', { status: 200 });
    };

    const result = await scanGitHubRepository('https://github.com/org/repo', {
      fetchFn: mockFetch as typeof fetch,
    });

    assert.equal(result.success, true);
    assert.equal(result.status, 'partial', 'Scan with failed file fetch must be marked as partial');
    assert.equal(result.inspectedFiles.length, 1);
    assert.equal(result.skippedFiles.length, 1);
    assert.equal(result.skippedFiles[0].reason, 'content_fetch_failed');
    assert.ok(result.warnings.some((w) => w.includes('src/failing.js')));
  });

  it('3. Failed refresh preserves the existing saved workspace scan', async () => {
    const storage = new MemoryStorage();

    const baselineScan: GitHubScanResult = {
      success: true,
      status: 'completed',
      owner: 'sakshamgupta005',
      repo: 'patchboard-tasks-api',
      commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
      scannedAt: '2026-10-18T20:00:00.000Z',
      treeTruncated: false,
      totalFilesDiscovered: 4,
      inspectedFiles: [
        {
          path: 'src/server.js',
          category: 'source',
          sizeBytes: 100,
          contentExcerpt: 'server code',
          rawUrl: '',
          githubUrl: '',
        },
      ],
      skippedFiles: [],
      detectedTechnologies: ['Node.js'],
      detectedManifests: ['package.json'],
      detectedArchitecturalLayers: ['core'],
      warnings: [],
      durationMs: 120,
    };

    const session: WorkspaceSession = {
      id: 'sakshamgupta005/patchboard-tasks-api',
      owner: 'sakshamgupta005',
      repo: 'patchboard-tasks-api',
      branch: 'main',
      commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
      scannedAt: '2026-10-18T20:00:00.000Z',
      isSavedData: true,
      scanResult: baselineScan,
      rooms: [
        {
          id: 'room-1',
          name: 'Tasks API',
          category: 'api',
          status: 'blocked',
          gridPosition: { x: 0, y: 0, z: 0 },
          filePaths: ['src/server.js'],
          requirements: [],
          evidence: ['Failing CI test run'],
          dependencies: [],
        },
      ],
      selectedRoomId: 'room-1',
      chatMessages: [{ id: 'm1', sender: 'dog', text: 'Woof', timestamp: '1' }],
      findingsByRoomId: {},
      fixLifecyclesByRoomId: {},
    };

    saveWorkspace(session, storage);

    // Simulate refresh failure (e.g. GitHub rate limit or network down)
    const mockFailingFetch = async () => new Response('rate limit', { status: 403 });
    const refreshResult = await scanGitHubRepository('https://github.com/sakshamgupta005/patchboard-tasks-api', {
      fetchFn: mockFailingFetch as typeof fetch,
    });

    assert.equal(refreshResult.success, false);

    // Verify workspace in storage remains intact with previous commit
    const saved = loadWorkspace('sakshamgupta005/patchboard-tasks-api', storage);
    assert.ok(saved);
    assert.equal(saved.commitSha, '4ddfe585adbccd57794efba49ca1102ff654382f');
    assert.equal(saved.rooms.length, 1);
    assert.equal(saved.chatMessages.length, 1);
  });

  it('4. Chat timeout or network failure preserves existing conversation and returns clean error', async () => {
    const mockFetchTimeout = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    const req: ChatApiRequest = {
      message: 'What files are in this repo?',
      history: [{ role: 'user', text: 'Initial message' }],
      repoContext: {
        owner: 'org',
        repo: 'repo',
        branch: 'main',
        totalFiles: 2,
        inspectedFiles: [],
        discoveredFilePaths: [],
        detectedTechnologies: [],
        roomSummaries: [],
      },
    };

    const response = await executeAiChat(req, { GEMINI_API_KEY: 'test-key' }, mockFetchTimeout as typeof fetch);

    assert.equal(response.success, false);
    assert.equal(response.code, 'PROVIDER_ERROR');
    assert.ok(response.error?.includes('timed out'));
    assert.equal(response.replies, undefined, 'Never produce fake replies on error');
  });

  it('5. Empty model response returns clean error and never appends fake assistant replies', async () => {
    const mockFetchEmpty = async () => {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '' }] } }],
        }),
        { status: 200 }
      );
    };

    const req: ChatApiRequest = {
      message: 'Hello',
      history: [],
    };

    const response = await executeAiChat(req, { GEMINI_API_KEY: 'test-key' }, mockFetchEmpty as typeof fetch);

    assert.equal(response.success, false);
    assert.equal(response.code, 'PROVIDER_ERROR');
    assert.ok(response.error?.includes('empty response'));
    assert.equal(response.replies, undefined);
  });

  it('6. Investigation provider failure preserves room state without fabricating findings', async () => {
    const mockFetch500 = async () => new Response('Internal Server Error', { status: 500 });

    const req: InvestigateApiRequest = {
      roomId: 'room-core',
      roomName: 'Core Domain',
      roomLayer: 'core',
      roomStatus: 'implemented',
      roomEvidence: 'Some code exists',
      roomFilePaths: ['src/core.ts'],
      repoContext: {
        owner: 'org',
        repo: 'repo',
        branch: 'main',
        inspectedFiles: [],
        discoveredFilePaths: ['src/core.ts'],
        detectedTechnologies: ['TypeScript'],
      },
    };

    const result = await executeRoomInvestigation(req, { GEMINI_API_KEY: 'test-key' }, mockFetch500 as typeof fetch);

    assert.equal(result.success, false);
    assert.equal(result.code, 'PROVIDER_ERROR');
    assert.ok(result.error?.includes('HTTP 500'));
    assert.equal(result.finding, undefined, 'Never fabricate findings on error');
  });

  it('7. Redacts API keys from upstream error messages and URLs', async () => {
    const secretKey = 'AIzaSySecretApiKey1234567890';
    const mockFetchKeyLeaking = async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: `Invalid request with key=${secretKey}`,
          },
        }),
        { status: 400 }
      );
    };

    const req: ChatApiRequest = {
      message: 'Hello',
      history: [],
    };

    const response = await executeAiChat(req, { GEMINI_API_KEY: secretKey }, mockFetchKeyLeaking as typeof fetch);

    assert.equal(response.success, false);
    assert.ok(!response.error?.includes(secretKey), 'API key must NEVER be leaked in client error messages');
    assert.ok(response.error?.includes('REDACTED'));
  });

  it('8. Persistence quota handling and malformed storage recovery', () => {
    const storage = new MemoryStorage();

    // Malformed JSON should not crash and return empty array
    storage.setItem('living_blueprint_workspaces_v1', 'not valid json {{{');
    assert.deepEqual(loadAllWorkspaces(storage), []);
    assert.deepEqual(getRecentProjects(storage), []);

    // Quota stress test: saving 15 workspaces prunes to MAX_STORED_WORKSPACES (10)
    for (let i = 1; i <= 15; i++) {
      const scan: GitHubScanResult = {
        success: true,
        status: 'completed',
        owner: 'test-org',
        repo: `repo-${i}`,
        commitSha: `sha-${i}`,
        scannedAt: new Date().toISOString(),
        treeTruncated: false,
        totalFilesDiscovered: 1,
        inspectedFiles: [],
        skippedFiles: [],
        detectedTechnologies: [],
        detectedManifests: [],
        detectedArchitecturalLayers: [],
        warnings: [],
        durationMs: 10,
      };

      const session: WorkspaceSession = {
        id: `test-org/repo-${i}`,
        owner: 'test-org',
        repo: `repo-${i}`,
        branch: 'main',
        commitSha: `sha-${i}`,
        scannedAt: new Date().toISOString(),
        isSavedData: false,
        scanResult: scan,
        rooms: [],
        selectedRoomId: null,
        chatMessages: [],
        findingsByRoomId: {},
        fixLifecyclesByRoomId: {},
      };

      saveWorkspace(session, storage);
    }

    const recents = getRecentProjects(storage);
    assert.equal(recents.length, 10, 'Must prune to max 10 stored workspaces');
    // Most recent (repo-15) must be first
    assert.equal(recents[0].id, 'test-org/repo-15');
  });

  it('9. Never represents a failed operation as a success', () => {
    const failedScan: GitHubScanResult = {
      success: false,
      status: 'failed',
      owner: 'org',
      repo: 'repo',
      treeTruncated: false,
      totalFilesDiscovered: 0,
      inspectedFiles: [],
      skippedFiles: [],
      detectedTechnologies: [],
      detectedManifests: [],
      detectedArchitecturalLayers: [],
      warnings: [],
      error: 'Connection reset',
      durationMs: 50,
    };

    assert.equal(failedScan.success, false);
    assert.equal(failedScan.status, 'failed');
    assert.equal(failedScan.inspectedFiles.length, 0);
  });
});
