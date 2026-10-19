import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  saveWorkspace,
  loadWorkspace,
  loadAllWorkspaces,
  deleteWorkspace,
  getRecentProjects,
  getActiveWorkspaceId,
  setActiveWorkspaceId,
  sanitizeSessionForStorage,
  createWorkspaceSessionFromScan,
  WORKSPACES_STORAGE_KEY,
  ACTIVE_WORKSPACE_STORAGE_KEY,
} from '../src/domain/workspace/workspaceStorage.ts';
import type { WorkspaceSession } from '../src/domain/workspace/types.ts';
import type { GitHubScanResult } from '../src/domain/github/types.ts';
import type { ArchitecturalRoom } from '../src/types.ts';

class MockStorage implements Storage {
  private data: Map<string, string> = new Map();

  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.data.keys())[index] || null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function makeMockScanResult(owner: string, repo: string, commitSha: string): GitHubScanResult {
  return {
    success: true,
    owner,
    repo,
    commitSha,
    scannedAt: '2026-10-18T20:00:00.000Z',
    status: 'completed',
    metadata: {
      defaultBranch: 'main',
      isPrivate: false,
      starsCount: 5,
      forksCount: 1,
      openIssuesCount: 0,
      description: 'Test repository',
    },
    discoveredPaths: ['src/server.js', 'test/server.test.js'],
    inspectedFiles: [
      {
        path: 'src/server.js',
        size: 1024,
        category: 'source',
        sha: 'abc111',
        content: 'const http = require("http");',
      },
    ],
    detectedTechnologies: ['Node.js'],
    ciEvaluation: {
      outcome: 'failed',
      outcomeReason: 'Failing check: Node.js CI / test',
      relevantTestChecks: [
        {
          id: 12345,
          name: 'Node.js CI / test',
          status: 'completed',
          conclusion: 'failure',
          startedAt: '2026-10-18T19:55:00Z',
          completedAt: '2026-10-18T19:56:00Z',
          htmlUrl: 'https://github.com/test/run/1',
          workflowName: 'Node.js CI',
          jobName: 'test',
        },
      ],
      unrelatedChecks: [],
      verificationEvidenceRecords: [],
    },
  };
}

function makeMockRooms(): ArchitecturalRoom[] {
  return [
    {
      id: 'room-server',
      name: 'Server API',
      category: 'api',
      status: 'blocked',
      gridPosition: { x: 0, y: 0, z: 0 },
      filePaths: ['src/server.js'],
      requirements: [],
      evidence: [],
      dependencies: [],
      sourceExcerpts: [{ path: 'src/server.js', excerpt: 'const http = require("http");' }],
    },
  ];
}

describe('T13: Workspace Persistence and Session Recovery', () => {
  it('1. Persists and restores complete workspace session without loss', () => {
    const storage = new MockStorage();
    const scanResult = makeMockScanResult('sakshamgupta005', 'patchboard-tasks-api', '4ddfe585adbccd57794efba49ca1102ff654382f');
    const rooms = makeMockRooms();

    const session: WorkspaceSession = {
      id: 'sakshamgupta005/patchboard-tasks-api',
      owner: 'sakshamgupta005',
      repo: 'patchboard-tasks-api',
      branch: 'main',
      commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
      scannedAt: '2026-10-18T20:00:00.000Z',
      isSavedData: false,
      scanResult,
      rooms,
      selectedRoomId: 'room-server',
      chatMessages: [
        {
          id: 'msg-1',
          sender: 'user',
          text: 'Where is the bug in server.js?',
          timestamp: '20:01',
        },
      ],
      findingsByRoomId: {
        'room-server': {
          id: 'f-1',
          title: 'Off-by-one error in task array',
          category: 'logic_error',
          severity: 'high',
          classification: 'observed',
          summary: 'Array bounds issue',
          problemAnalysis: 'Analysis details',
          recommendation: 'Fix index offset',
          evidenceReferences: ['src/server.js'],
          affectedFiles: ['src/server.js'],
          validationStatus: 'validated',
        },
      },
      fixLifecyclesByRoomId: {},
    };

    const saved = saveWorkspace(session, storage);
    assert.equal(saved, true);

    const loaded = loadWorkspace('sakshamgupta005/patchboard-tasks-api', storage);
    assert.ok(loaded);
    assert.equal(loaded.id, 'sakshamgupta005/patchboard-tasks-api');
    assert.equal(loaded.commitSha, '4ddfe585adbccd57794efba49ca1102ff654382f');
    assert.equal(loaded.rooms.length, 1);
    assert.equal(loaded.selectedRoomId, 'room-server');
    assert.equal(loaded.chatMessages.length, 1);
    assert.equal(loaded.chatMessages[0].text, 'Where is the bug in server.js?');
    assert.ok(loaded.findingsByRoomId['room-server']);
    assert.equal(loaded.findingsByRoomId['room-server'].title, 'Off-by-one error in task array');
    assert.equal(loaded.scanResult.ciEvaluation?.outcome, 'failed');
  });

  it('2. Restored workspace is honestly labeled as saved data (isSavedData: true)', () => {
    const storage = new MockStorage();
    const scanResult = makeMockScanResult('owner', 'repo', 'abcdef123456');
    const rooms = makeMockRooms();

    const session = createWorkspaceSessionFromScan(scanResult, rooms);
    assert.equal(session.isSavedData, false, 'fresh scan is not saved data');

    saveWorkspace(session, storage);
    const loaded = loadWorkspace('owner/repo', storage);
    assert.ok(loaded);
    assert.equal(loaded.isSavedData, true, 'restored scan MUST be labeled as saved data');
  });

  it('3. Never persists BookNook sample data into workspaces', () => {
    const storage = new MockStorage();
    const sampleSession: WorkspaceSession = {
      id: 'demo/booknook-sample',
      owner: 'demo',
      repo: 'booknook-sample',
      branch: 'main',
      commitSha: 'sample-commit',
      scannedAt: new Date().toISOString(),
      isSavedData: false,
      scanResult: makeMockScanResult('demo', 'booknook-sample', 'sample-commit'),
      rooms: makeMockRooms(),
      selectedRoomId: null,
      chatMessages: [],
      findingsByRoomId: {},
      fixLifecyclesByRoomId: {},
    };

    const saved = saveWorkspace(sampleSession, storage);
    assert.equal(saved, false, 'sample BookNook data must not be saved');

    const loaded = loadWorkspace('demo/booknook-sample', storage);
    assert.equal(loaded, null);
    assert.equal(loadAllWorkspaces(storage).length, 0);
  });

  it('4. Redacts secrets, tokens, and credentials before writing to storage', () => {
    const session: WorkspaceSession = {
      id: 'owner/repo',
      owner: 'owner',
      repo: 'repo',
      branch: 'main',
      commitSha: 'c123456',
      scannedAt: '2026-10-18T20:00:00Z',
      isSavedData: false,
      scanResult: makeMockScanResult('owner', 'repo', 'c123456'),
      rooms: makeMockRooms(),
      selectedRoomId: null,
      chatMessages: [
        {
          id: 'msg-sec',
          sender: 'user',
          text: 'Using token ghp_1234567890123456789012345 and AIzaSyD9876543210123456789012345678901',
          timestamp: 'now',
        },
      ],
      findingsByRoomId: {},
      fixLifecyclesByRoomId: {},
    };

    const sanitized = sanitizeSessionForStorage(session);
    assert.ok(!sanitized.chatMessages[0].text.includes('ghp_'));
    assert.ok(!sanitized.chatMessages[0].text.includes('AIzaSy'));
    assert.ok(sanitized.chatMessages[0].text.includes('[REDACTED_CREDENTIAL]'));
  });

  it('5. Lists recent projects with compact summary and correct CI status', () => {
    const storage = new MockStorage();
    const scan1 = makeMockScanResult('org1', 'repo-alpha', 'sha1111');
    const scan2 = makeMockScanResult('org2', 'repo-beta', 'sha2222');

    saveWorkspace(createWorkspaceSessionFromScan(scan1, makeMockRooms()), storage);
    saveWorkspace(createWorkspaceSessionFromScan(scan2, makeMockRooms()), storage);

    const recents = getRecentProjects(storage);
    assert.equal(recents.length, 2);
    // Most recently saved (repo-beta) is first
    assert.equal(recents[0].id, 'org2/repo-beta');
    assert.equal(recents[0].commitSha, 'sha2222');
    assert.equal(recents[0].ciStatus, 'failing');

    assert.equal(recents[1].id, 'org1/repo-alpha');
    assert.equal(recents[1].commitSha, 'sha1111');
  });

  it('6. Deletes workspace and clears active id cleanly', () => {
    const storage = new MockStorage();
    const scan = makeMockScanResult('org', 'repo-to-delete', 'sha3333');

    saveWorkspace(createWorkspaceSessionFromScan(scan, makeMockRooms()), storage);
    assert.equal(getActiveWorkspaceId(storage), 'org/repo-to-delete');

    const deleted = deleteWorkspace('org/repo-to-delete', storage);
    assert.equal(deleted, true);
    assert.equal(loadWorkspace('org/repo-to-delete', storage), null);
    assert.equal(getActiveWorkspaceId(storage), null);
  });

  it('7. Handles corrupted storage gracefully without crashing', () => {
    const storage = new MockStorage();
    storage.setItem(WORKSPACES_STORAGE_KEY, '{ invalid JSON ]');

    const workspaces = loadAllWorkspaces(storage);
    assert.deepEqual(workspaces, []);

    const loaded = loadWorkspace('any/repo', storage);
    assert.equal(loaded, null);
  });

  it('8. Switching projects isolates rooms, findings, and chat history', () => {
    const storage = new MockStorage();

    const scanA = makeMockScanResult('org', 'project-a', 'commitA');
    const scanB = makeMockScanResult('org', 'project-b', 'commitB');

    const sessionA = createWorkspaceSessionFromScan(scanA, [
      {
        id: 'room-a',
        name: 'Room A',
        category: 'core',
        status: 'implemented',
        gridPosition: { x: 0, y: 0, z: 0 },
        filePaths: ['a.js'],
        requirements: [],
        evidence: [],
        dependencies: [],
      },
    ]);
    sessionA.chatMessages = [{ id: 'm1', sender: 'user', text: 'Talk about A', timestamp: '1' }];

    const sessionB = createWorkspaceSessionFromScan(scanB, [
      {
        id: 'room-b',
        name: 'Room B',
        category: 'database',
        status: 'verified',
        gridPosition: { x: 1, y: 0, z: 0 },
        filePaths: ['b.js'],
        requirements: [],
        evidence: [],
        dependencies: [],
      },
    ]);
    sessionB.chatMessages = [{ id: 'm2', sender: 'user', text: 'Talk about B', timestamp: '2' }];

    saveWorkspace(sessionA, storage);
    saveWorkspace(sessionB, storage);

    const loadedA = loadWorkspace('org/project-a', storage);
    const loadedB = loadWorkspace('org/project-b', storage);

    assert.ok(loadedA && loadedB);
    assert.equal(loadedA.rooms[0].name, 'Room A');
    assert.equal(loadedB.rooms[0].name, 'Room B');
    assert.equal(loadedA.chatMessages[0].text, 'Talk about A');
    assert.equal(loadedB.chatMessages[0].text, 'Talk about B');
  });
});
