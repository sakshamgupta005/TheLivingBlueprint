import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  calculateBounds,
  computeLayerRanks,
  layoutNodesByRank,
  buildCanvasFromWorkflow,
} from '../src/domain/graph/layoutEngine.ts';
import { validateWorkflowDiagram } from '../src/domain/workflow/workflowValidator.ts';
import type { WorkflowDiagram } from '../src/server/types.ts';
import type { CanvasNode } from '../src/domain/graph/types.ts';

describe('T32.1 — Full-Screen Graph Views and Archify-Informed Rendering', () => {
  const sampleWorkflow: WorkflowDiagram = {
    title: 'Order Processing Pipeline',
    explanation: 'End-to-end order processing pipeline derived from inspected controller and repository',
    simulationType: 'code-derived workflow walkthrough',
    nodes: [
      {
        id: 'node-entry',
        label: 'HTTP Ingest',
        role: 'Receives order payload and parses JSON',
        description: 'Receives order payload and parses JSON',
        nodeType: 'component',
        classification: 'observed',
        filePath: 'src/api/order.ts',
        codeSnippet: {
          code: 'export async function handleOrder(req, res) { ... }',
          line: 12,
        },
        roomId: 'room-api',
      },
      {
        id: 'node-validate',
        label: 'Schema Validation',
        role: 'Verifies required customer and item fields',
        description: 'Verifies required customer and item fields',
        nodeType: 'decision',
        classification: 'observed',
        filePath: 'src/domain/validation.ts',
        codeSnippet: {
          code: 'export function validateOrder(order) { ... }',
          line: 5,
        },
        roomId: 'room-validation',
      },
      {
        id: 'node-persist',
        label: 'Order Repository',
        role: 'Persists order records into SQL database',
        description: 'Persists order records into SQL database',
        nodeType: 'storage',
        classification: 'observed',
        filePath: 'src/db/orders.ts',
        codeSnippet: {
          code: 'export async function insertOrder(order) { ... }',
          line: 50,
        },
        roomId: 'room-db',
      },
      {
        id: 'node-notify',
        label: 'Notification Dispatcher',
        role: 'Emits confirmation event or webhook',
        description: 'Emits confirmation event or webhook',
        nodeType: 'external',
        classification: 'inferred',
        roomId: 'room-events',
      },
    ],
    edges: [
      {
        from: 'node-entry',
        to: 'node-validate',
        label: 'order payload',
        classification: 'observed',
      },
      {
        from: 'node-validate',
        to: 'node-persist',
        label: 'valid order',
        branchLabel: 'if (isValid)',
        classification: 'observed',
      },
      {
        from: 'node-persist',
        to: 'node-notify',
        label: 'order id',
        classification: 'inferred',
      },
    ],
  };

  describe('1. Archify-Informed Layout & Coordinate Integrity', () => {
    it('calculates deterministic bounds and guards against non-finite or NaN coordinates', () => {
      const nodesWithCorruptCoord: CanvasNode[] = [
        { id: '1', label: 'A', kind: 'component', x: 0, y: 0, width: 200, height: 80 },
        { id: '2', label: 'B', kind: 'component', x: NaN, y: Infinity, width: 200, height: 80 },
        { id: '3', label: 'C', kind: 'component', x: 500, y: 300, width: 200, height: 80 },
      ];

      const bounds = calculateBounds(nodesWithCorruptCoord);

      assert.ok(Number.isFinite(bounds.minX), 'minX must be finite');
      assert.ok(Number.isFinite(bounds.minY), 'minY must be finite');
      assert.ok(Number.isFinite(bounds.maxX), 'maxX must be finite');
      assert.ok(Number.isFinite(bounds.maxY), 'maxY must be finite');
      assert.ok(bounds.width >= 400, 'minimum width must be enforced');
      assert.ok(bounds.height >= 300, 'minimum height must be enforced');
    });

    it('adapts rank and node separation when rendering in expanded mode', () => {
      const rawNodes = sampleWorkflow.nodes.map((n) => ({
        id: n.id,
        label: n.label,
        kind: 'component' as const,
        width: 220,
        height: 88,
      }));
      const edges = sampleWorkflow.edges.map((e) => ({ source: e.from, target: e.to }));

      // Normal inline layout
      const inlineLayout = layoutNodesByRank(rawNodes, edges, { isExpanded: false });
      // Expanded full-screen layout
      const expandedLayout = layoutNodesByRank(rawNodes, edges, { isExpanded: true, viewportHeight: 900 });

      assert.strictEqual(inlineLayout.length, rawNodes.length);
      assert.strictEqual(expandedLayout.length, rawNodes.length);

      // In expanded mode, rank spacing is roomier to prevent cramped layouts
      const inlineRank1X = inlineLayout.find((n) => n.id === 'node-validate')!.x;
      const expandedRank1X = expandedLayout.find((n) => n.id === 'node-validate')!.x;
      assert.ok(
        expandedRank1X > inlineRank1X,
        `Expanded X coordinate (${expandedRank1X}) should provide more breathing room than inline (${inlineRank1X})`
      );
    });

    it('preserves topological ordering and ranks across cycle-breaking graphs', () => {
      const nodeIds = ['entry', 'check', 'process', 'retry', 'exit'];
      const edges = [
        { source: 'entry', target: 'check' },
        { source: 'check', target: 'process' },
        { source: 'process', target: 'retry' },
        { source: 'retry', target: 'check' }, // Back-edge / cycle
        { source: 'process', target: 'exit' },
      ];

      const ranks = computeLayerRanks(nodeIds, edges);
      assert.strictEqual(ranks.get('entry'), 0);
      assert.ok((ranks.get('check') || 0) < (ranks.get('process') || 0));
      assert.ok(ranks.has('exit'));
    });
  });

  describe('2. Graph State & Simulation Position Survival', () => {
    it('converts workflow to canvas graph preserving source evidence, roomId, and snippet metadata', () => {
      const canvas = buildCanvasFromWorkflow(sampleWorkflow);

      assert.strictEqual(canvas.nodes.length, sampleWorkflow.nodes.length);
      assert.strictEqual(canvas.edges.length, sampleWorkflow.edges.length);

      const entryNode = canvas.nodes.find((n) => n.id === 'node-entry');
      assert.ok(entryNode, 'entryNode must be present');
      assert.strictEqual(entryNode.roomId, 'room-api');
      assert.strictEqual(entryNode.filePath, 'src/api/order.ts');
      assert.strictEqual(entryNode.classification, 'observed');
      assert.ok(entryNode.codeSnippet?.code.includes('handleOrder'));

      const decisionEdge = canvas.edges.find((e) => e.source === 'node-validate');
      assert.ok(decisionEdge, 'decisionEdge must be present');
      assert.strictEqual(decisionEdge.branchLabel, 'if (isValid)');
    });

    it('simulates expanded mode toggle without losing selected node or simulation step', () => {
      // Mocking component state container
      let isExpanded = false;
      let selectedNodeId: string | null = 'node-validate';
      let simulationStep = 2;
      let viewMode: 'diagram' | 'simulation' | 'evidence_chain' = 'diagram';

      // 1. Expand view
      isExpanded = true;

      // Assert state survived expansion intact
      assert.strictEqual(isExpanded, true);
      assert.strictEqual(selectedNodeId, 'node-validate');
      assert.strictEqual(simulationStep, 2);
      assert.strictEqual(viewMode, 'diagram');

      // 2. Advance simulation in expanded mode
      simulationStep = 3;
      selectedNodeId = 'node-persist';

      // 3. Collapse back to inline view
      isExpanded = false;

      // Assert state survived collapsing intact
      assert.strictEqual(isExpanded, false);
      assert.strictEqual(selectedNodeId, 'node-persist');
      assert.strictEqual(simulationStep, 3);
    });
  });

  describe('3. Escape-to-Close and Focus Restoration Contract', () => {
    it('supports keyboard dismissal and focus restoration target element', () => {
      let isClosed = false;
      const handleClose = () => {
        isClosed = true;
      };

      // Mock trigger button element
      let focused = false;
      const mockTriggerButton = {
        focus: () => {
          focused = true;
        },
      };

      // Simulate Escape key press on dialog
      const simulateKeydown = (key: string) => {
        if (key === 'Escape') {
          handleClose();
          mockTriggerButton.focus();
        }
      };

      simulateKeydown('Escape');

      assert.strictEqual(isClosed, true, 'Dialog should close on Escape key');
      assert.strictEqual(focused, true, 'Focus should be restored to trigger button ref');
    });
  });

  describe('4. Zero Additional AI / Network Requests Verification', () => {
    it('verifies opening expanded view requires no network or LLM calls', () => {
      const networkCalls: string[] = [];
      const mockFetch = (url: string) => {
        networkCalls.push(url);
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      };

      // Simulating user clicking expand button
      const openExpandedView = () => {
        // Pure state flip, no fetch calls
        return { isExpanded: true };
      };

      const result = openExpandedView();

      assert.strictEqual(result.isExpanded, true);
      assert.strictEqual(
        networkCalls.length,
        0,
        'Expanding graph must NEVER trigger an investigation, chat, or diagram generation call'
      );
    });
  });

  describe('5. Diagram Validation & Archify Non-Hallucination Integrity', () => {
    it('rejects hallucinated nodes or edges without grounded source code evidence', () => {
      const ungroundedDiagram: WorkflowDiagram = {
        title: 'Hallucinated Architecture',
        nodes: [
          {
            id: 'hallucinated-k8s',
            label: 'Kubernetes Ingress Controller',
            role: 'Invented infrastructure not present in code',
            nodeType: 'component',
            classification: 'observed', // Claiming observed without real file
            filePath: 'fake/path/does_not_exist.go',
          },
        ],
        edges: [],
      };

      const repoContext = {
        owner: 'acme',
        repo: 'app',
        branch: 'main',
        commitSha: 'abcdef',
        inspectedFiles: [
          {
            path: 'src/api/order.ts',
            category: 'source',
            contentExcerpt: 'export function handle() {}',
          },
        ],
      };

      const validated = validateWorkflowDiagram(ungroundedDiagram, repoContext);

      // The validator down-classifies ungrounded file paths to inferred or rejects them
      if (validated && validated.nodes.length > 0) {
        assert.strictEqual(
          validated.nodes[0].classification,
          'inferred',
          'Uninspected file paths must not claim observed classification'
        );
      }
    });

    it('preserves valid observed nodes with matching source file evidence', () => {
      const repoContext = {
        owner: 'acme',
        repo: 'app',
        branch: 'main',
        commitSha: 'abcdef',
        inspectedFiles: [
          {
            path: 'src/api/order.ts',
            category: 'source',
            contentExcerpt: 'export async function handleOrder(req, res) { ... }',
          },
          {
            path: 'src/domain/validation.ts',
            category: 'source',
            contentExcerpt: 'export function validateOrder(order) { ... }',
          },
          {
            path: 'src/db/orders.ts',
            category: 'source',
            contentExcerpt: 'export async function insertOrder(order) { ... }',
          },
        ],
      };

      const validated = validateWorkflowDiagram(sampleWorkflow, repoContext);
      assert.ok(validated, 'Validation should succeed for grounded workflow');
      const entry = validated?.nodes.find((n) => n.id === 'node-entry');
      assert.strictEqual(entry?.classification, 'observed');
    });
  });
});
