import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildCanvasFromWorkflow,
  buildCanvasFromModules,
  buildCanvasFromCodeIndex,
  computeLayerRanks,
  calculateBounds,
  layoutNodesByRank,
} from '../src/domain/graph/layoutEngine.ts';
import type { WorkflowDiagram } from '../src/server/types.ts';
import type { ArchitecturalRoom } from '../src/types.ts';
import type { CodeIndex } from '../src/domain/codeIndex/types.ts';

describe('T25: Interactive Architecture Graph Canvas Engine & Schema', () => {
  const sampleWorkflow: WorkflowDiagram = {
    id: 'diag-order-flow',
    title: 'Order Processing Workflow',
    explanation: 'Order validation and persistence pipeline',
    simulationType: 'static flow simulation',
    flowArchetype: 'api_request',
    nodes: [
      {
        id: 'node-req',
        label: 'HTTP Client Request',
        role: 'Client Request',
        nodeType: 'external',
        classification: 'observed',
        description: 'Receives POST /orders payload',
        inputs: 'JSON order body',
        outputs: 'Parsed request object',
        filePath: 'src/api/orderRouter.ts',
        codeSnippet: { code: 'router.post("/orders", handleOrder);', line: 12 },
      },
      {
        id: 'node-val',
        label: 'Validate Order Payload',
        role: 'Validation Rule',
        nodeType: 'decision',
        classification: 'observed',
        description: 'Validates quantity and items',
        inputs: 'Parsed request object',
        outputs: 'Validated OrderData or 400 Bad Request',
        filePath: 'src/services/orderValidator.ts',
        codeSnippet: { code: 'export function validateOrder(data) { ... }', line: 25 },
      },
      {
        id: 'node-db',
        label: 'Order Repository',
        role: 'Persistence Storage',
        nodeType: 'storage',
        classification: 'observed',
        roomId: 'room-db',
        description: 'Persists order to SQLite database',
        inputs: 'Validated OrderData',
        outputs: 'Saved order record with generated ID',
        filePath: 'src/db/orderStore.ts',
      },
    ],
    edges: [
      {
        from: 'node-req',
        to: 'node-val',
        label: 'forwards payload',
        classification: 'observed',
      },
      {
        from: 'node-val',
        to: 'node-db',
        label: 'valid order data',
        branchLabel: 'if valid',
        classification: 'observed',
      },
    ],
  };

  describe('1. Workflow to Canvas Graph Transformation', () => {
    it('transforms WorkflowDiagram into a CanvasGraph with deterministic coordinates and bounds', () => {
      const graph = buildCanvasFromWorkflow(sampleWorkflow);

      assert.strictEqual(graph.id, 'diag-order-flow');
      assert.strictEqual(graph.title, 'Order Processing Workflow');
      assert.strictEqual(graph.viewMode, 'workflow');
      assert.strictEqual(graph.nodes.length, 3);
      assert.strictEqual(graph.edges.length, 2);

      // Verify node types and coordinates
      const reqNode = graph.nodes.find((n) => n.id === 'node-req');
      const valNode = graph.nodes.find((n) => n.id === 'node-val');
      const dbNode = graph.nodes.find((n) => n.id === 'node-db');

      assert.ok(reqNode);
      assert.ok(valNode);
      assert.ok(dbNode);

      // Verify horizontal layered progression (ranks)
      assert.ok(valNode.x > reqNode.x, 'Validation node must be positioned to the right of Request node');
      assert.ok(dbNode.x > valNode.x, 'DB node must be positioned to the right of Validation node');

      // Verify source file and line range provenance
      assert.strictEqual(reqNode.filePath, 'src/api/orderRouter.ts');
      assert.strictEqual(reqNode.lineRange?.startLine, 12);
      assert.strictEqual(dbNode.roomId, 'room-db');

      // Verify edge properties and branch labels
      const branchEdge = graph.edges.find((e) => e.source === 'node-val' && e.target === 'node-db');
      assert.ok(branchEdge);
      assert.strictEqual(branchEdge.branchLabel, 'if valid');
      assert.strictEqual(branchEdge.classification, 'observed');

      // Bounding box must encompass all nodes with positive dimensions
      assert.ok(graph.bounds.width > 0);
      assert.ok(graph.bounds.height > 0);
      assert.ok(graph.bounds.maxX > graph.bounds.minX);
      assert.ok(graph.bounds.maxY > graph.bounds.minY);
    });
  });

  describe('2. Module Architecture Graph Generation', () => {
    it('transforms ArchitecturalRoom list into module dependency canvas with layers', () => {
      const sampleRooms: ArchitecturalRoom[] = [
        {
          id: 'room-gateway',
          name: 'API Gateway',
          layer: 'gateway',
          status: 'verified',
          description: 'HTTP entry points',
          evidence: 'Route registrations observed',
          filePaths: ['src/server.ts'],
          dependencies: ['room-core'],
          metrics: { filesCount: 1, ciStatus: 'passing' },
          coords: { isoX: 0, isoY: 0, width: 2, height: 2, depth: 2 },
        },
        {
          id: 'room-core',
          name: 'Task Core Domain',
          layer: 'core',
          status: 'verified',
          description: 'Business logic functions',
          evidence: 'Domain functions inspected',
          filePaths: ['src/tasks/service.ts'],
          dependencies: ['room-database'],
          metrics: { filesCount: 1, ciStatus: 'passing' },
          coords: { isoX: 2, isoY: 0, width: 2, height: 2, depth: 2 },
        },
        {
          id: 'room-database',
          name: 'Database Storage',
          layer: 'foundation',
          status: 'verified',
          description: 'Persistence repository',
          evidence: 'SQLite schema inspected',
          filePaths: ['src/db/sqlite.ts'],
          dependencies: [],
          metrics: { filesCount: 1, ciStatus: 'passing' },
          coords: { isoX: 4, isoY: 0, width: 2, height: 2, depth: 2 },
        },
      ];

      const graph = buildCanvasFromModules(sampleRooms);

      assert.strictEqual(graph.viewMode, 'modules');
      assert.strictEqual(graph.nodes.length, 3);
      assert.strictEqual(graph.edges.length, 2);

      const gatewayNode = graph.nodes.find((n) => n.id === 'room-gateway');
      const coreNode = graph.nodes.find((n) => n.id === 'room-core');
      const dbNode = graph.nodes.find((n) => n.id === 'room-database');

      assert.ok(gatewayNode);
      assert.ok(coreNode);
      assert.ok(dbNode);

      assert.strictEqual(gatewayNode.kind, 'route');
      assert.strictEqual(dbNode.kind, 'storage');

      // Rank layering progression
      assert.ok(coreNode.x > gatewayNode.x, 'Core must be downstream of Gateway');
      assert.ok(dbNode.x > coreNode.x, 'Database must be downstream of Core');
    });
  });

  describe('3. Code Structure Graph & Group Collapsing', () => {
    it('creates function/route nodes from CodeIndex and respects collapsed group boundaries', () => {
      const sampleCodeIndex: CodeIndex = {
        repositorySha: 'sha-index-test',
        indexedAt: new Date().toISOString(),
        files: {
          'src/api/routes.ts': {
            path: 'src/api/routes.ts',
            language: 'TypeScript',
            analysisQuality: 'full_ast',
            symbolsCount: 1,
            importsCount: 1,
            exportsCount: 1,
            routesCount: 1,
          },
          'src/tasks/service.ts': {
            path: 'src/tasks/service.ts',
            language: 'TypeScript',
            analysisQuality: 'full_ast',
            symbolsCount: 2,
            importsCount: 0,
            exportsCount: 2,
            routesCount: 0,
          },
        },
        symbols: [
          {
            id: 'src/api/routes.ts#setupRoutes',
            name: 'setupRoutes',
            path: 'src/api/routes.ts',
            kind: 'function',
            lineRange: { startLine: 5, endLine: 20 },
            isExported: true,
          },
          {
            id: 'src/tasks/service.ts#createTask',
            name: 'createTask',
            path: 'src/tasks/service.ts',
            kind: 'function',
            lineRange: { startLine: 10, endLine: 35 },
            isExported: true,
          },
          {
            id: 'src/tasks/service.ts#getTasks',
            name: 'getTasks',
            path: 'src/tasks/service.ts',
            kind: 'function',
            lineRange: { startLine: 40, endLine: 60 },
            isExported: true,
          },
        ],
        imports: [],
        exports: [],
        relationships: [
          {
            id: 'rel-call-1',
            source: { path: 'src/api/routes.ts', symbol: 'src/api/routes.ts#setupRoutes' },
            target: { path: 'src/tasks/service.ts', symbol: 'src/tasks/service.ts#createTask' },
            type: 'calls',
            provenance: 'syntax',
            confidence: 'confirmed',
            line: 15,
            evidence: 'setupRoutes calls createTask',
          },
        ],
        routes: [
          {
            id: 'route-post-tasks',
            method: 'POST',
            routePath: '/tasks',
            sourcePath: 'src/api/routes.ts',
            lineRange: { startLine: 8, endLine: 12 },
            framework: 'express',
            evidence: "router.post('/tasks', handleCreate)",
          },
        ],
        unresolvedImports: [],
        circularDependencies: [],
        diagnostics: [],
        stats: {
          filesIndexed: 2,
          symbolsIndexed: 3,
          relationshipsCount: 1,
          routesCount: 1,
          syntaxErrorsCount: 0,
          circularDependencyCount: 0,
        },
      };

      // 1. Expanded view: both functions in src/tasks are visible
      const expandedGraph = buildCanvasFromCodeIndex(sampleCodeIndex);
      assert.ok(expandedGraph.nodes.some((n) => n.id === 'src/tasks/service.ts#createTask'));
      assert.ok(expandedGraph.nodes.some((n) => n.id === 'src/tasks/service.ts#getTasks'));
      assert.strictEqual(expandedGraph.nodes.some((n) => n.isGroupCollapsed), false);

      // 2. Collapsed view: collapse "src/tasks" folder
      const collapsedGraph = buildCanvasFromCodeIndex(sampleCodeIndex, {
        collapsedGroupIds: new Set(['src/tasks']),
      });

      // Individual symbols in src/tasks are hidden
      assert.strictEqual(
        collapsedGraph.nodes.some((n) => n.id === 'src/tasks/service.ts#createTask'),
        false
      );
      // Group summary node is present with member count
      const groupNode = collapsedGraph.nodes.find((n) => n.id === 'group-src/tasks');
      assert.ok(groupNode);
      assert.strictEqual(groupNode.isGroupCollapsed, true);
      assert.strictEqual(groupNode.groupMemberCount, 2);
    });
  });

  describe('4. Layered Topological Ordering and Cycle Breaking', () => {
    it('computes layer ranks deterministically and breaks cycles without infinite loops', () => {
      // Directed graph with a cycle: A -> B -> C -> A, and D -> B
      const nodeIds = ['A', 'B', 'C', 'D'];
      const edges = [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'C' },
        { source: 'C', target: 'A' },
        { source: 'D', target: 'B' },
      ];

      const ranks = computeLayerRanks(nodeIds, edges);

      assert.strictEqual(ranks.size, 4);
      for (const id of nodeIds) {
        assert.ok(typeof ranks.get(id) === 'number');
        assert.ok(!isNaN(ranks.get(id)!));
      }
    });

    it('calculates bounding box accurately for empty and populated graphs', () => {
      const emptyBounds = calculateBounds([]);
      assert.ok(emptyBounds.width > 0);
      assert.ok(emptyBounds.height > 0);

      const rawNodes = [
        {
          id: 'n1',
          label: 'Node 1',
          kind: 'component' as const,
          width: 200,
          height: 80,
          classification: 'observed' as const,
        },
        {
          id: 'n2',
          label: 'Node 2',
          kind: 'component' as const,
          width: 200,
          height: 80,
          classification: 'observed' as const,
        },
      ];

      const laidOut = layoutNodesByRank(rawNodes, [{ source: 'n1', target: 'n2' }]);
      assert.strictEqual(laidOut.length, 2);
      assert.strictEqual(laidOut[0].x < laidOut[1].x, true);

      const bounds = calculateBounds(laidOut);
      assert.ok(bounds.width >= laidOut[1].x + laidOut[1].width - bounds.minX);
    });
  });
});
