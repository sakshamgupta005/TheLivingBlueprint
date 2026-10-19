import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWalkthroughSteps } from '../src/domain/walkthrough/walkthroughEngine.ts';
import type { WalkthroughEvaluationInput } from '../src/domain/walkthrough/types.ts';
import type { ArchitecturalRoom } from '../src/types.ts';
import type { GitHubScanResult } from '../src/domain/github/types.ts';
import type { RoomInvestigationFinding } from '../src/domain/investigation/types.ts';
import type { FixLifecycleState } from '../src/domain/lifecycle/types.ts';

const mockDemoScanResult: GitHubScanResult = {
  success: true,
  owner: 'sakshamgupta005',
  repo: 'patchboard-tasks-api',
  status: 'completed',
  scannedAt: new Date().toISOString(),
  commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
  totalFilesDiscovered: 18,
  inspectedFiles: [
    {
      path: 'src/tasks/validation.js',
      category: 'source',
      contentExcerpt: 'function validateTaskTitle(title) { ... }',
      sizeBytes: 1024,
    },
    {
      path: 'test/createTask.test.js',
      category: 'test',
      contentExcerpt: 'it("rejects whitespace-only task titles", ...)',
      sizeBytes: 2048,
    },
  ],
  discoveredFilePaths: ['src/tasks/validation.js', 'test/createTask.test.js'],
  detectedTechnologies: ['Node.js', 'JavaScript'],
  metadata: {
    defaultBranch: 'main',
    isPrivate: false,
    stars: 5,
    openIssuesCount: 1,
  },
  ciEvaluation: {
    outcome: 'failed',
    outcomeReason: '1 failing test check run detected on scanned commit',
    relevantTestChecks: [
      {
        id: 101,
        name: 'Run Unit and Integration Tests',
        conclusion: 'failure',
        status: 'completed',
        startedAt: '2026-10-19T00:00:00Z',
        completedAt: '2026-10-19T00:01:00Z',
        url: 'https://github.com/sakshamgupta005/patchboard-tasks-api/actions/runs/1',
      },
    ],
    evaluatedAt: new Date().toISOString(),
    commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
  },
};

const mockRooms: ArchitecturalRoom[] = [
  {
    id: 'room-validation',
    name: 'Input Validation & Schema',
    layer: 'service',
    status: 'blocked',
    description: 'Task schema and whitespace sanitization',
    evidence: 'CI check failed in test/createTask.test.js',
    filePaths: ['src/tasks/validation.js', 'test/createTask.test.js'],
    metrics: {
      filesCount: 2,
      testFilesCount: 1,
      ciStatus: 'failing',
      ciCheckName: 'Run Unit and Integration Tests',
    },
    coords: { isoX: 0, isoY: 0, width: 100, height: 80, depth: 80 },
  },
  {
    id: 'room-routes',
    name: 'Task REST Endpoints',
    layer: 'gateway',
    status: 'implemented',
    description: 'Express task routing',
    evidence: 'Source code in src/routes/tasks.js',
    filePaths: ['src/routes/tasks.js'],
    metrics: {
      filesCount: 1,
      ciStatus: 'not_run',
    },
    coords: { isoX: 0, isoY: 100, width: 100, height: 80, depth: 80 },
  },
];

describe('T15: Guided Demonstration Walkthrough Engine', () => {
  it('1. Initial sample state starts with 0 completed steps and does not fake completion', () => {
    const input: WalkthroughEvaluationInput = {
      isSampleActive: true,
      lastScanResult: null,
      selectedRoom: mockRooms[0],
      rooms: mockRooms,
      chatMessages: [],
      findingsByRoomId: {},
      fixLifecyclesByRoomId: {},
      isAiConfigured: true,
    };

    const res = evaluateWalkthroughSteps(input);
    assert.equal(res.completedCount, 0);
    assert.equal(res.isAllCompleted, false);
    assert.equal(res.nextStepIndex, 0);
    assert.equal(res.steps[0].isComplete, false);
    assert.equal(res.steps[0].actionId, 'prefill_demo');
  });

  it('2. Failed scan does NOT mark Step 1 (Scan repo) complete', () => {
    const failedScanResult: GitHubScanResult = {
      success: false,
      owner: 'sakshamgupta005',
      repo: 'patchboard-tasks-api',
      error: 'HTTP 403 Rate limit exceeded',
      totalFilesDiscovered: 0,
      inspectedFiles: [],
      detectedTechnologies: [],
    };

    const input: WalkthroughEvaluationInput = {
      isSampleActive: false,
      lastScanResult: failedScanResult,
      selectedRoom: null,
      rooms: [],
      chatMessages: [],
      findingsByRoomId: {},
      fixLifecyclesByRoomId: {},
    };

    const res = evaluateWalkthroughSteps(input);
    assert.equal(res.steps[0].isComplete, false);
    assert.match(res.steps[0].statusNote, /Awaiting real repository scan/);
  });

  it('3. Successful real scan of patchboard-tasks-api completes Step 1 honestly', () => {
    const input: WalkthroughEvaluationInput = {
      isSampleActive: false,
      lastScanResult: mockDemoScanResult,
      selectedRoom: null,
      rooms: mockRooms,
      chatMessages: [],
      findingsByRoomId: {},
      fixLifecyclesByRoomId: {},
    };

    const res = evaluateWalkthroughSteps(input);
    assert.equal(res.steps[0].isComplete, true);
    assert.match(res.steps[0].statusNote, /4ddfe58/);
    assert.equal(res.steps[1].isComplete, false);
  });

  it('4. Selecting a room completes Step 2 (Explore dynamically derived rooms)', () => {
    const input: WalkthroughEvaluationInput = {
      isSampleActive: false,
      lastScanResult: mockDemoScanResult,
      selectedRoom: mockRooms[1], // Task REST Endpoints (implemented, not blocked)
      rooms: mockRooms,
      chatMessages: [],
      findingsByRoomId: {},
      fixLifecyclesByRoomId: {},
    };

    const res = evaluateWalkthroughSteps(input);
    assert.equal(res.steps[0].isComplete, true);
    assert.equal(res.steps[1].isComplete, true);
    assert.match(res.steps[1].statusNote, /Task REST Endpoints/);
    // Step 3 (failing evidence) is NOT complete because selected room is not failing
    assert.equal(res.steps[2].isComplete, false);
    assert.equal(res.steps[2].actionId, 'focus_blocked_room');
  });

  it('5. Selecting failing / blocked room completes Step 3 (Inspect blocker evidence)', () => {
    const input: WalkthroughEvaluationInput = {
      isSampleActive: false,
      lastScanResult: mockDemoScanResult,
      selectedRoom: mockRooms[0], // Input Validation & Schema (blocked, failing CI)
      rooms: mockRooms,
      chatMessages: [],
      findingsByRoomId: {},
      fixLifecyclesByRoomId: {},
    };

    const res = evaluateWalkthroughSteps(input);
    assert.equal(res.steps[2].isComplete, true);
    assert.match(res.steps[2].statusNote, /BLOCKED/);
    assert.match(res.steps[2].statusNote, /Run Unit and Integration Tests: failing/);
  });

  it('6. Step 4 completes only when user sends genuine chat question', () => {
    const withoutUserMsg: WalkthroughEvaluationInput = {
      isSampleActive: false,
      lastScanResult: mockDemoScanResult,
      selectedRoom: mockRooms[0],
      rooms: mockRooms,
      chatMessages: [
        { id: '1', sender: 'dog', text: 'Woof! Ready to inspect.', timestamp: '12:00' },
        { id: '2', sender: 'cat', text: 'Show me the tests.', timestamp: '12:00' },
      ],
      findingsByRoomId: {},
      fixLifecyclesByRoomId: {},
    };

    let res = evaluateWalkthroughSteps(withoutUserMsg);
    assert.equal(res.steps[3].isComplete, false);

    const withUserMsg: WalkthroughEvaluationInput = {
      ...withoutUserMsg,
      chatMessages: [
        ...withoutUserMsg.chatMessages,
        { id: '3', sender: 'user', text: 'Why is validation failing?', timestamp: '12:01' },
      ],
    };

    res = evaluateWalkthroughSteps(withUserMsg);
    assert.equal(res.steps[3].isComplete, true);
    assert.match(res.steps[3].statusNote, /1 question\(s\) asked/);
  });

  it('7. Step 5 completes only when genuine finding with repair prompt is generated', () => {
    const findingWithoutPrompt: RoomInvestigationFinding = {
      title: 'Whitespace bypass',
      category: 'code_quality',
      severity: 'high',
      evidenceClassification: 'observed',
      explanation: 'Title length is checked without trimming.',
      uncertainties: 'None',
      evidenceReferences: [{ path: 'src/tasks/validation.js', isInspected: true }],
      recommendedNextStep: 'Trim whitespace.',
      companionMessages: [],
    };

    const inputWithoutPrompt: WalkthroughEvaluationInput = {
      isSampleActive: false,
      lastScanResult: mockDemoScanResult,
      selectedRoom: mockRooms[0],
      rooms: mockRooms,
      chatMessages: [{ id: '1', sender: 'user', text: 'hi', timestamp: '12:00' }],
      findingsByRoomId: { 'room-validation': findingWithoutPrompt },
      fixLifecyclesByRoomId: {},
    };

    let res = evaluateWalkthroughSteps(inputWithoutPrompt);
    assert.equal(res.steps[4].isComplete, false);

    const findingWithPrompt: RoomInvestigationFinding = {
      ...findingWithoutPrompt,
      generatedPrompt: 'Please update validateTaskTitle(title) to check title.trim().length === 0',
    };

    const inputWithPrompt: WalkthroughEvaluationInput = {
      ...inputWithoutPrompt,
      findingsByRoomId: { 'room-validation': findingWithPrompt },
    };

    res = evaluateWalkthroughSteps(inputWithPrompt);
    assert.equal(res.steps[4].isComplete, true);
    assert.match(res.steps[4].statusNote, /Whitespace bypass/);
  });

  it('8. Step 6 completes when a fix report lifecycle is initiated', () => {
    const mockLifecycle: FixLifecycleState = {
      report: {
        summary: 'Trim whitespace in validateTaskTitle',
        investigationFindingId: 'Whitespace bypass',
        originalFindingTitle: 'Whitespace bypass',
        roomId: 'room-validation',
        roomName: 'Input Validation & Schema',
      },
      newEvidenceRecords: [],
      resultingStatusEvaluation: {
        status: 'implemented',
        reasons: ['User claimed fix reported'],
        applicableRequirements: [],
      },
      inspectedChangedFiles: [],
      uninspectedClaimedFiles: [],
      warnings: [],
      timestamp: new Date().toISOString(),
    };

    const input: WalkthroughEvaluationInput = {
      isSampleActive: false,
      lastScanResult: mockDemoScanResult,
      selectedRoom: mockRooms[0],
      rooms: mockRooms,
      chatMessages: [{ id: '1', sender: 'user', text: 'hi', timestamp: '12:00' }],
      findingsByRoomId: {
        'room-validation': {
          title: 'Whitespace bypass',
          category: 'code_quality',
          severity: 'high',
          evidenceClassification: 'observed',
          explanation: 'Title length is checked without trimming.',
          uncertainties: 'None',
          evidenceReferences: [{ path: 'src/tasks/validation.js', isInspected: true }],
          recommendedNextStep: 'Trim whitespace.',
          companionMessages: [],
          generatedPrompt: 'Prompt',
        },
      },
      fixLifecyclesByRoomId: { 'room-validation': mockLifecycle },
    };

    const res = evaluateWalkthroughSteps(input);
    assert.equal(res.steps[5].isComplete, true);
    assert.equal(res.completedCount, 6);
    assert.equal(res.isAllCompleted, true);
  });

  it('9. Walkthrough step evaluation is pure and strictly does not mutate inputs', () => {
    const originalRooms = JSON.parse(JSON.stringify(mockRooms));
    const input: WalkthroughEvaluationInput = {
      isSampleActive: false,
      lastScanResult: mockDemoScanResult,
      selectedRoom: mockRooms[0],
      rooms: mockRooms,
      chatMessages: [],
      findingsByRoomId: {},
      fixLifecyclesByRoomId: {},
    };

    evaluateWalkthroughSteps(input);
    assert.deepEqual(mockRooms, originalRooms);
  });
});
