import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRoomInternals } from '../src/domain/workflow/roomInternalsEngine.ts';
import type { ArchitecturalRoom } from '../src/types.ts';
import type { GitHubScanResult } from '../src/domain/github/types.ts';
import type { RoomInvestigationFinding } from '../src/domain/investigation/types.ts';

describe('Room Internals & Logic Visualization Engine', () => {
  const sampleScanResult: GitHubScanResult = {
    owner: 'sakshamgupta005',
    repo: 'patchboard-tasks-api',
    branch: 'main',
    commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
    scannedAt: '2026-10-19T06:00:00Z',
    detectedTechnologies: ['Node.js', 'Express', 'JavaScript'],
    treeSummary: {
      totalFilesCount: 15,
      sourceFilesCount: 8,
      testFilesCount: 3,
      configFilesCount: 4,
      docFilesCount: 0,
    },
    discoveredFilePaths: [
      'src/tasks/validation.js',
      'src/routes.js',
      'src/tasks/storage.js',
      'test/createTask.test.js',
      'package.json',
    ],
    inspectedFiles: [
      {
        path: 'src/tasks/validation.js',
        category: 'source',
        sizeBytes: 420,
        contentExcerpt: `function validateTaskTitle(title) {\n  if (title.length === 0) {\n    return false;\n  }\n  return true;\n}`,
      },
      {
        path: 'src/routes.js',
        category: 'source',
        sizeBytes: 650,
        contentExcerpt: `router.post('/tasks', (req, res) => {\n  const isValid = validateTaskTitle(req.body.title);\n  if (!isValid) return res.status(400).json({ error: 'invalid' });\n  res.status(201).json({ id: 1, title: req.body.title });\n});`,
      },
      {
        path: 'test/createTask.test.js',
        category: 'test',
        sizeBytes: 800,
        contentExcerpt: `describe('POST /tasks', () => {\n  it('rejects whitespace-only task titles', async () => {\n    assert.strictEqual(res.status, 400);\n  });\n});`,
      },
    ],
    ciEvaluation: {
      outcome: 'failed',
      outcomeReason: 'CI check run failed on test/createTask.test.js',
      evaluatedCommitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
      relevantTestChecks: [
        {
          id: 101,
          name: 'test-and-lint',
          status: 'completed',
          conclusion: 'failure',
          detailsUrl: 'https://github.com/sakshamgupta005/patchboard-tasks-api/actions/runs/101',
        },
      ],
    },
    metrics: {
      totalFiles: 15,
      testFilesCount: 3,
      passingCheckRunsCount: 0,
      failingCheckRunsCount: 1,
    },
    isPartial: false,
  };

  const allRooms: ArchitecturalRoom[] = [
    {
      id: 'room-routes',
      name: 'API Routes & Gateway',
      layer: 'gateway',
      status: 'implemented',
      description: 'Dispatches HTTP requests to task controllers',
      evidence: 'Observed route handlers in src/routes.js',
      filePaths: ['src/routes.js'],
      dependencies: ['room-validation'],
      metrics: { filesCount: 1 },
    },
    {
      id: 'room-validation',
      name: 'Task Validation & Rules',
      layer: 'core',
      status: 'blocked',
      description: 'Enforces domain constraints on task input',
      evidence: 'Source in src/tasks/validation.js. Fails whitespace check in CI.',
      filePaths: ['src/tasks/validation.js'],
      dependencies: ['room-storage'],
      metrics: {
        filesCount: 1,
        ciStatus: 'failing',
        ciCheckName: 'test-and-lint',
      },
    },
    {
      id: 'room-storage',
      name: 'Task Storage Repository',
      layer: 'storage',
      status: 'implemented',
      description: 'In-memory collection for task records',
      evidence: 'Referenced in src/tasks/storage.js',
      filePaths: ['src/tasks/storage.js'],
      dependencies: [],
      metrics: { filesCount: 1 },
    },
    {
      id: 'room-tests',
      name: 'Automated CI Test Suite',
      layer: 'ci',
      status: 'blocked',
      description: 'Runs integration tests in GitHub Actions',
      evidence: 'test/createTask.test.js failed check run',
      filePaths: ['test/createTask.test.js'],
      dependencies: [],
      metrics: {
        filesCount: 1,
        ciStatus: 'failing',
        ciCheckName: 'test-and-lint',
      },
    },
  ];

  const validationFinding: RoomInvestigationFinding = {
    roomId: 'room-validation',
    roomName: 'Task Validation & Rules',
    roomLayer: 'core',
    status: 'blocked',
    title: 'Whitespace-Only Task Titles Accepted Without Trimming',
    explanation: 'The validateTaskTitle function checks title.length === 0 without calling .trim(), causing whitespace strings to pass validation.',
    category: 'defect',
    severity: 'high',
    evidenceClassification: 'observed',
    evidenceReferences: [
      { path: 'src/tasks/validation.js', isInspected: true },
      { path: 'test/createTask.test.js', isInspected: true },
    ],
    codeEvidence: {
      filePath: 'src/tasks/validation.js',
      codeSnippet: 'if (title.length === 0) return false;',
      derivedLineNumber: 2,
      isVerified: true,
      explanation: 'Un-trimmed length check allows whitespace-only titles.',
    },
    uncertainties: 'In-memory storage behavior is unaffected once valid tasks are entered.',
    recommendedNextStep: 'Add .trim() to title validation before testing length.',
    companionMessages: [],
  };

  it('1. Generates business_logic archetype with decision branches and governing conditions for validation rooms', () => {
    const valRoom = allRooms.find((r) => r.id === 'room-validation')!;
    const internals = deriveRoomInternals(valRoom, sampleScanResult, false, allRooms, validationFinding);

    assert.strictEqual(internals.primaryArchetype, 'business_logic');
    assert.ok(internals.flows.length >= 2, 'Should offer multiple flows (e.g. decision flow + error flow)');

    const primaryFlow = internals.flows[0];
    assert.strictEqual(primaryFlow.flowArchetype, 'business_logic');
    assert.ok(primaryFlow.nodes.length >= 3);

    // Verify decision node and extracted snippet
    const decisionNode = primaryFlow.nodes.find((n) => n.nodeType === 'decision');
    assert.ok(decisionNode, 'Flow must contain a decision node');
    assert.ok(decisionNode.codeSnippet.line >= 1);
    assert.match(decisionNode.codeSnippet.code, /title\.length === 0/);

    // Verify governing conditions
    const conds = internals.recommendation.governingConditions;
    assert.ok(conds && conds.length >= 2, 'Must provide governing conditions table');
    assert.ok(conds.some((c) => c.condition.includes('length === 0')));
    assert.ok(conds.some((c) => c.condition.includes('whitespace-only')));
  });

  it('2. Generates api_request archetype with client-to-response pathway for gateway rooms', () => {
    const gatewayRoom = allRooms.find((r) => r.id === 'room-routes')!;
    const internals = deriveRoomInternals(gatewayRoom, sampleScanResult, false, allRooms);

    assert.strictEqual(internals.primaryArchetype, 'api_request');
    const flow = internals.flows[0];
    assert.strictEqual(flow.flowArchetype, 'api_request');

    // Check sequence: client -> router -> delegate -> response
    const nodeIds = flow.nodes.map((n) => n.id);
    assert.ok(nodeIds.includes('api-client'));
    assert.ok(nodeIds.includes('api-router'));
    assert.ok(nodeIds.includes('api-response'));

    // Check observed router snippet
    const routerNode = flow.nodes.find((n) => n.id === 'api-router');
    assert.ok(routerNode?.codeSnippet);
    assert.match(routerNode.codeSnippet.code, /router\.post/);
  });

  it('3. Generates testing_ci archetype with check run evidence and test assertions', () => {
    const ciRoom = allRooms.find((r) => r.id === 'room-tests')!;
    const internals = deriveRoomInternals(ciRoom, sampleScanResult, false, allRooms);

    assert.strictEqual(internals.primaryArchetype, 'testing_ci');
    const flow = internals.flows[0];

    const checkRunNode = flow.nodes.find((n) => n.id === 'test-checkrun');
    assert.ok(checkRunNode, 'Must contain CI check run node');
    assert.match(checkRunNode.label, /test-and-lint/);
    assert.strictEqual(checkRunNode.classification, 'observed');

    const failingEdge = flow.edges.find((e) => e.to === 'test-checkrun');
    assert.ok(failingEdge?.branchLabel?.includes('Assertion failure'));
  });

  it('4. Generates data_storage archetype with persistence and query interfaces', () => {
    const storeRoom = allRooms.find((r) => r.id === 'room-storage')!;
    const internals = deriveRoomInternals(storeRoom, sampleScanResult, false, allRooms);

    assert.strictEqual(internals.primaryArchetype, 'data_storage');
    const flow = internals.flows[0];
    assert.ok(flow.nodes.some((n) => n.nodeType === 'storage'));
  });

  it('5. Connects diagram nodes to valid rooms in allRooms for cross-room focus navigation', () => {
    const valRoom = allRooms.find((r) => r.id === 'room-validation')!;
    const internals = deriveRoomInternals(valRoom, sampleScanResult, false, allRooms, validationFinding);

    const storageNode = internals.flows[0].nodes.find((n) => n.id === 'val-storage-dispatch');
    assert.ok(storageNode?.roomId, 'Must map to storage room id');
    assert.strictEqual(storageNode.roomId, 'room-storage');
    assert.ok(allRooms.some((r) => r.id === storageNode.roomId), 'Mapped room must exist in allRooms');
  });

  it('6. Discloses uncertainty and unverified risks without inventing runtime execution', () => {
    const valRoom = allRooms.find((r) => r.id === 'room-validation')!;
    const internals = deriveRoomInternals(valRoom, sampleScanResult, false, allRooms, validationFinding);

    assert.ok(internals.flows[0].uncertainties, 'Must state flow uncertainties');
    assert.ok(internals.recommendation.unverifiedRisks.length > 0, 'Must surface risks');
    assert.strictEqual(internals.flows[0].simulationType, 'code-derived workflow walkthrough');
  });

  it('7. Adapts recommendations dynamically when room or finding changes', () => {
    const valRoom = allRooms.find((r) => r.id === 'room-validation')!;
    const withoutFinding = deriveRoomInternals(valRoom, sampleScanResult, false, allRooms, null);
    const withFinding = deriveRoomInternals(valRoom, sampleScanResult, false, allRooms, validationFinding);

    assert.notStrictEqual(withoutFinding, withFinding);
    assert.ok(withFinding.recommendation.unverifiedRisks.some((r) => r.includes('Whitespace bypass defect')));
  });
});
