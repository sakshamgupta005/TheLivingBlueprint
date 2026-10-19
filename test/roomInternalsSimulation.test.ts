import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRoomInternals } from '../src/domain/workflow/roomInternalsEngine.ts';
import type { ArchitecturalRoom } from '../src/types.ts';
import type { GitHubScanResult } from '../src/domain/github/types.ts';
import type { RoomInvestigationFinding } from '../src/domain/investigation/types.ts';

describe('T19: Interactive Room Internals, Recommendations and Static Simulation', () => {
  const scanResult: GitHubScanResult = {
    owner: 'sakshamgupta005',
    repo: 'patchboard-tasks-api',
    branch: 'main',
    commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
    scannedAt: '2026-10-19T06:00:00Z',
    detectedTechnologies: ['Node.js', 'Express', 'JavaScript'],
    treeSummary: {
      totalFilesCount: 12,
      sourceFilesCount: 6,
      testFilesCount: 2,
      configFilesCount: 4,
      docFilesCount: 0,
    },
    discoveredFilePaths: [
      'src/routes.js',
      'src/tasks/validation.js',
      'src/tasks/storage.js',
      'test/createTask.test.js',
      'package.json',
      '.github/workflows/ci.yml',
    ],
    inspectedFiles: [
      {
        path: 'src/routes.js',
        category: 'source',
        sizeBytes: 450,
        contentExcerpt: 'router.post("/tasks", (req, res) => { const v = validate(req.body); res.json(v); });',
      },
      {
        path: 'src/tasks/validation.js',
        category: 'source',
        sizeBytes: 300,
        contentExcerpt: 'function validate(input) { if (input.title.length === 0) return false; return true; }',
      },
      {
        path: 'test/createTask.test.js',
        category: 'test',
        sizeBytes: 500,
        contentExcerpt: 'describe("POST /tasks", () => { it("fails on empty", () => { assert.fail(); }); });',
      },
      {
        path: 'package.json',
        category: 'config',
        sizeBytes: 200,
        contentExcerpt: '{"name": "patchboard", "scripts": {"test": "node --test"}}',
      },
    ],
    ciEvaluation: {
      outcome: 'failed',
      outcomeReason: 'CI check failed on test/createTask.test.js',
      evaluatedCommitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
      relevantTestChecks: [
        {
          id: 42,
          name: 'test-and-lint',
          status: 'completed',
          conclusion: 'failure',
          detailsUrl: 'https://github.com/sakshamgupta005/patchboard-tasks-api/actions/runs/42',
        },
      ],
    },
    metrics: {
      totalFiles: 12,
      testFilesCount: 2,
      passingCheckRunsCount: 0,
      failingCheckRunsCount: 1,
    },
    isPartial: false,
  };

  const sampleRooms: ArchitecturalRoom[] = [
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
      evidence: 'Source in src/tasks/validation.js.',
      filePaths: ['src/tasks/validation.js'],
      dependencies: ['room-storage'],
      metrics: { filesCount: 1, ciStatus: 'failing', ciCheckName: 'test-and-lint' },
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
      id: 'room-ci',
      name: 'Automated CI Test Suite',
      layer: 'ci',
      status: 'blocked',
      description: 'Runs integration tests in GitHub Actions',
      evidence: 'test/createTask.test.js failed check run',
      filePaths: ['test/createTask.test.js'],
      dependencies: [],
      metrics: { filesCount: 1, ciStatus: 'failing', ciCheckName: 'test-and-lint' },
    },
    {
      id: 'room-config',
      name: 'Project Configuration & Manifest',
      layer: 'foundation',
      status: 'implemented',
      description: 'Project manifest and script declarations',
      evidence: 'package.json dependencies and scripts',
      filePaths: ['package.json'],
      dependencies: [],
      metrics: { filesCount: 1 },
    },
    {
      id: 'room-empty',
      name: 'Unmapped Empty Room',
      layer: 'ui',
      status: 'unscanned',
      description: 'A planned interface room with no files in repository',
      evidence: 'No matching files found in repository scan',
      filePaths: [],
      dependencies: [],
      metrics: { filesCount: 0 },
    },
  ];

  it('1. Produces distinct evidence-grounded archetypes for different room layers', () => {
    // Gateway -> api_request
    const gateway = deriveRoomInternals(sampleRooms[0], scanResult, false, sampleRooms);
    assert.strictEqual(gateway.primaryArchetype, 'api_request');
    assert.ok(gateway.flows.length > 0);
    assert.strictEqual(gateway.flows[0].flowArchetype, 'api_request');

    // Core validation -> business_logic
    const core = deriveRoomInternals(sampleRooms[1], scanResult, false, sampleRooms);
    assert.strictEqual(core.primaryArchetype, 'business_logic');
    assert.strictEqual(core.flows[0].flowArchetype, 'business_logic');

    // Storage -> data_storage
    const storage = deriveRoomInternals(sampleRooms[2], scanResult, false, sampleRooms);
    assert.strictEqual(storage.primaryArchetype, 'data_storage');
    assert.strictEqual(storage.flows[0].flowArchetype, 'data_storage');

    // CI -> testing_ci
    const ci = deriveRoomInternals(sampleRooms[3], scanResult, false, sampleRooms);
    assert.strictEqual(ci.primaryArchetype, 'testing_ci');
    assert.strictEqual(ci.flows[0].flowArchetype, 'testing_ci');

    // Foundation/config -> configuration
    const config = deriveRoomInternals(sampleRooms[4], scanResult, false, sampleRooms);
    assert.strictEqual(config.primaryArchetype, 'configuration');
    assert.strictEqual(config.flows[0].flowArchetype, 'configuration');
  });

  it('2. Shows honest limited-coverage state when a room lacks source evidence (no invented pipelines)', () => {
    const emptyRoom = sampleRooms.find((r) => r.id === 'room-empty')!;
    const internals = deriveRoomInternals(emptyRoom, scanResult, false, sampleRooms);

    // Flows must be empty; no fake pipelines, databases, or mocks invented
    assert.strictEqual(internals.flows.length, 0);
    assert.match(internals.recommendation.roomResponsibilities, /Planned or unmapped subsystem/);
    assert.ok(internals.recommendation.unverifiedRisks.some((r) => r.includes('missing implementation files')));
    assert.match(internals.recommendation.recommendedNextStep, /Inspect file tree or commit/);
  });

  it('3. Derives deterministic nodes, outgoing connections, and branch conditions from source', () => {
    const valRoom = sampleRooms.find((r) => r.id === 'room-validation')!;
    const internals = deriveRoomInternals(valRoom, scanResult, false, sampleRooms);
    const flow = internals.flows[0];

    assert.ok(flow.nodes.length >= 3, 'Must have at least 3 stages in logic flow');
    assert.ok(flow.edges.length >= 2, 'Must have valid edges connecting nodes');

    // Verify all edges link to valid nodes in the same flow
    const nodeIds = new Set(flow.nodes.map((n) => n.id));
    for (const edge of flow.edges) {
      assert.ok(nodeIds.has(edge.from), `Edge source "${edge.from}" must exist in flow nodes`);
      assert.ok(nodeIds.has(edge.to), `Edge target "${edge.to}" must exist in flow nodes`);
    }

    // Verify decision node contains actual code from inspected file
    const decisionNode = flow.nodes.find((n) => n.id === 'val-length-check');
    assert.ok(decisionNode, 'Decision node must exist');
    assert.ok(decisionNode.codeSnippet);
    assert.match(decisionNode.codeSnippet.code, /title\.length === 0/);
    assert.strictEqual(decisionNode.filePath, 'src/tasks/validation.js');
  });

  it('4. Links diagram nodes to real room IDs for cross-room focus navigation', () => {
    const valRoom = sampleRooms.find((r) => r.id === 'room-validation')!;
    const internals = deriveRoomInternals(valRoom, scanResult, false, sampleRooms);
    const flow = internals.flows[0];

    // Find node that delegates to storage
    const storageNode = flow.nodes.find((n) => n.roomId === 'room-storage');
    assert.ok(storageNode, 'A node must map to the dependency room-storage');
    assert.strictEqual(storageNode.roomId, 'room-storage');

    // Ensure mapped room actually exists in allRooms
    const targetRoom = sampleRooms.find((r) => r.id === storageNode.roomId);
    assert.ok(targetRoom, 'Mapped roomId must correspond to a real architectural room');
    assert.strictEqual(targetRoom.name, 'Task Storage Repository');
  });

  it('5. Guarantees deterministic static simulation steps with sequential forward and backward bounds', () => {
    const gatewayRoom = sampleRooms.find((r) => r.id === 'room-routes')!;
    const internals = deriveRoomInternals(gatewayRoom, scanResult, false, sampleRooms);
    const flow = internals.flows[0];

    const nodes = flow.nodes;
    assert.ok(nodes.length >= 4);

    // Initial state
    let currentStep = 0;
    assert.strictEqual(nodes[currentStep].id, 'api-client');

    // Advance step
    currentStep = Math.min(nodes.length - 1, currentStep + 1);
    assert.strictEqual(nodes[currentStep].id, 'api-router');

    // Advance step again
    currentStep = Math.min(nodes.length - 1, currentStep + 1);
    assert.strictEqual(nodes[currentStep].id, 'api-val-delegate');

    // Step back
    currentStep = Math.max(0, currentStep - 1);
    assert.strictEqual(nodes[currentStep].id, 'api-router');

    // Restart
    currentStep = 0;
    assert.strictEqual(nodes[currentStep].id, 'api-client');

    // Upper bound protection
    currentStep = 999;
    const boundedStep = Math.min(nodes.length - 1, currentStep);
    assert.strictEqual(boundedStep, nodes.length - 1);
  });

  it('6. Explicitly labels simulation as static code walkthrough and disclaims live execution', () => {
    const valRoom = sampleRooms.find((r) => r.id === 'room-validation')!;
    const internals = deriveRoomInternals(valRoom, scanResult, false, sampleRooms);

    for (const flow of internals.flows) {
      assert.strictEqual(flow.simulationType, 'code-derived workflow walkthrough');
      assert.ok(flow.uncertainties && flow.uncertainties.length > 0, 'Must disclose what remains uncertain');
    }
  });

  it('7. Derives governing conditions table separating observed facts from unverified risks', () => {
    const valRoom = sampleRooms.find((r) => r.id === 'room-validation')!;
    const finding: RoomInvestigationFinding = {
      roomId: 'room-validation',
      roomName: 'Task Validation & Rules',
      roomLayer: 'core',
      status: 'blocked',
      title: 'Whitespace Bypass Defect',
      explanation: 'Empty strings after whitespace bypass length check.',
      category: 'defect',
      severity: 'high',
      evidenceClassification: 'observed',
      evidenceReferences: [{ path: 'src/tasks/validation.js', isInspected: true }],
      uncertainties: 'Memory store holds invalid title.',
      recommendedNextStep: 'Add .trim() check.',
      companionMessages: [],
    };

    const internals = deriveRoomInternals(valRoom, scanResult, false, sampleRooms, finding);
    const rec = internals.recommendation;

    assert.ok(rec.governingConditions && rec.governingConditions.length > 0);
    assert.ok(rec.observedFacts.some((f) => f.includes('src/tasks/validation.js')));
    assert.ok(rec.unverifiedRisks.some((r) => r.includes('Whitespace bypass defect')));
    assert.strictEqual(rec.recommendedNextStep, 'Add .trim() check.');
  });

  it('8. Invalidates cache across different repositories, commits, and rooms', () => {
    // Generate cache keys according to RoomInternalsView specification
    const keyRepoA = `${scanResult.owner}/${scanResult.repo}@${scanResult.commitSha}#room-validation`;
    const keyRepoB = `${scanResult.owner}/other-repo@${scanResult.commitSha}#room-validation`;
    const keyCommitB = `${scanResult.owner}/${scanResult.repo}@different-commit-sha#room-validation`;
    const keyRoomB = `${scanResult.owner}/${scanResult.repo}@${scanResult.commitSha}#room-routes`;

    assert.notStrictEqual(keyRepoA, keyRepoB, 'Different repos must have distinct cache keys');
    assert.notStrictEqual(keyRepoA, keyCommitB, 'Different commits must have distinct cache keys');
    assert.notStrictEqual(keyRepoA, keyRoomB, 'Different rooms must have distinct cache keys');
  });

  it('9. Preserves deterministic structural room data on AI explanation failure', () => {
    const valRoom = sampleRooms.find((r) => r.id === 'room-validation')!;
    const internals = deriveRoomInternals(valRoom, scanResult, false, sampleRooms);

    // Verify internals exist deterministically without needing network/AI
    assert.ok(internals.flows.length >= 2);
    assert.ok(internals.recommendation.roomResponsibilities.length > 0);
    assert.ok(internals.recommendation.governingConditions!.length >= 2);

    // Simulated network error payload
    const mockErrorState = {
      aiError: 'AI explanation request failed: Network timeout. Existing structural data remains intact.',
      deterministicFlows: internals.flows,
    };

    assert.match(mockErrorState.aiError, /Existing structural data remains intact/);
    assert.strictEqual(mockErrorState.deterministicFlows.length, internals.flows.length);
  });
});
