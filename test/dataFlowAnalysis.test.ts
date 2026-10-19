import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDataFlow } from '../src/domain/dataFlow/index.ts';
import type { CodeIndex } from '../src/domain/codeIndex/types.ts';
import type { ArchitecturalRoom } from '../src/types.ts';

describe('T27: Static Data-Flow and Value-Lineage Analysis', () => {
  it('1. Tracks request input -> validation -> normalization -> storage -> response pipeline', () => {
    const code = `
      export function handleCreateTask(title: string, priority: number) {
        if (!title || title.length === 0) {
          throw new Error('Title required');
        }
        const cleanTitle = title.trim();
        const task = { title: cleanTitle, priority };
        db.save(task);
        return task;
      }
    `;

    const dfg = analyzeDataFlow({
      sourcePath: 'src/tasks/handler.ts',
      content: code,
      functionName: 'handleCreateTask',
    });

    assert.equal(dfg.capabilityLevel, 'full_ast');
    assert.equal(dfg.functionName, 'handleCreateTask');

    // 1. Sources: title, priority
    const sourceNodes = dfg.nodes.filter((n) => n.kind === 'source');
    assert.ok(sourceNodes.some((n) => n.variableName === 'title'));
    assert.ok(sourceNodes.some((n) => n.variableName === 'priority'));

    // 2. Validation: if (!title || ...)
    const valNodes = dfg.nodes.filter((n) => n.kind === 'validation');
    assert.ok(valNodes.length >= 1, 'Must extract validation check node');

    // 3. Normalization transform: cleanTitle = title.trim()
    const normNode = dfg.nodes.find((n) => n.variableName === 'cleanTitle');
    assert.ok(normNode, 'Must extract normalized variable cleanTitle');
    assert.equal(normNode.kind, 'transform');

    // 4. Sink: db.save(task) and return task
    const sinks = dfg.nodes.filter((n) => n.kind === 'sink');
    assert.ok(sinks.length >= 2, 'Should detect db.save and return sinks');

    // 5. Edges have evidence explaining the relationships (Req 3)
    for (const edge of dfg.edges) {
      assert.ok(edge.evidence && edge.evidence.length > 0, 'Every edge must contain evidence');
      assert.ok(edge.confidence, 'Every edge must state confidence');
    }
  });

  it('2. Highlights unvalidated input paths reaching storage sinks', () => {
    const unvalidatedCode = `
      function unsafeUpdateUser(userId: string, rawRole: string) {
        // rawRole is written to database without validation!
        db.update({ userId, role: rawRole });
        return { success: true };
      }
    `;

    const dfg = analyzeDataFlow({
      sourcePath: 'src/users/service.ts',
      content: unvalidatedCode,
      functionName: 'unsafeUpdateUser',
    });

    // Check issues
    const unvalIssues = dfg.issues.filter((i) => i.type === 'unvalidated_input');
    assert.ok(unvalIssues.length >= 1, 'Must flag unvalidated input reaching db.update');
    assert.ok(unvalIssues.some((i) => i.variableName === 'rawRole'));
    assert.ok(dfg.stats.unvalidatedPathsCount >= 1);

    // Tainted edge
    const taintedEdge = dfg.edges.find((e) => e.isTainted);
    assert.ok(taintedEdge, 'Edge connecting unvalidated input to sink must be flagged as tainted');
  });

  it('3. Highlights late normalization occurring after a validation check', () => {
    const lateNormCode = `
      function validateAndClean(title: string) {
        // Line 4: Check raw title length BEFORE trimming whitespace!
        if (title.length === 0) {
          throw new Error('Title cannot be empty');
        }
        // Line 8: Late normalization after check!
        const trimmed = title.trim();
        return trimmed;
      }
    `;

    const dfg = analyzeDataFlow({
      sourcePath: 'src/validation.ts',
      content: lateNormCode,
      functionName: 'validateAndClean',
    });

    const lateIssues = dfg.issues.filter((i) => i.type === 'late_normalization');
    assert.ok(lateIssues.length >= 1, 'Must detect late normalization occurring after condition check');
    assert.equal(lateIssues[0].variableName, 'title');
    assert.ok(lateIssues[0].sourceLine < lateIssues[0].sinkLine!);
  });

  it('4. Distinguishes directly observed, inferred, and unresolved data-flow confidence', () => {
    const crossFuncCode = `
      function orchestrate(orderData: any) {
        const localCopy = orderData; // directly observed
        calculateTax(localCopy);     // inferred if in index, unresolved otherwise
        externalAnalytics(orderData); // unresolved third-party
      }
    `;

    const mockCodeIndex: Partial<CodeIndex> = {
      symbols: [
        {
          id: 'src/tax.ts#calculateTax',
          name: 'calculateTax',
          path: 'src/tax.ts',
          kind: 'function',
          lineRange: { startLine: 1, endLine: 10 },
          isExported: true,
        },
      ],
    };

    const dfg = analyzeDataFlow({
      sourcePath: 'src/checkout.ts',
      content: crossFuncCode,
      functionName: 'orchestrate',
      codeIndex: mockCodeIndex as CodeIndex,
    });

    // Directly observed edge
    const observedEdge = dfg.edges.find((e) => e.confidence === 'directly_observed');
    assert.ok(observedEdge, 'Must have directly observed local assignment edge');

    // Inferred edge to calculateTax
    const inferredEdge = dfg.edges.find((e) => e.confidence === 'inferred');
    assert.ok(inferredEdge, 'Must have inferred edge to indexed function calculateTax');

    // Unresolved edge to externalAnalytics
    const unresolvedEdge = dfg.edges.find((e) => e.confidence === 'unresolved');
    assert.ok(unresolvedEdge, 'Must have unresolved edge to third-party function');
  });

  it('5. Supports multi-language capability levels (JS/TS, Python, Unsupported)', () => {
    // 1. Python pattern_ast
    const pythonCode = `
def process_data(payload):
    if payload:
        return payload
    return None
    `;
    const pyDfg = analyzeDataFlow({
      sourcePath: 'backend/processor.py',
      content: pythonCode,
      functionName: 'process_data',
    });
    assert.equal(pyDfg.capabilityLevel, 'pattern_ast');
    assert.ok(pyDfg.nodes.some((n) => n.kind === 'source'));
    assert.ok(pyDfg.nodes.some((n) => n.kind === 'validation'));
    assert.ok(pyDfg.nodes.some((n) => n.kind === 'sink'));

    // 2. Unsupported document / config file
    const docDfg = analyzeDataFlow({
      sourcePath: 'docs/README.md',
      content: '# Documentation',
    });
    assert.equal(docDfg.capabilityLevel, 'shallow');
    assert.equal(docDfg.nodes.length, 0);
  });

  it('6. Annotates nodes with navigation metadata (room, tests, line numbers)', () => {
    const code = `
      function queryDatabase(id: string) {
        return db.find(id);
      }
    `;

    const sampleRooms: ArchitecturalRoom[] = [
      {
        id: 'room-storage',
        name: 'Database Storage',
        purpose: 'Persistence',
        layer: 'storage',
        status: 'implemented',
        filePaths: ['src/db.ts'],
        evidence: 'db.find',
      },
    ];

    const knownTests = ['test/db.test.ts', 'test/query.test.ts'];

    const dfg = analyzeDataFlow({
      sourcePath: 'src/db.ts',
      content: code,
      functionName: 'queryDatabase',
      rooms: sampleRooms,
      knownTests,
    });

    const paramNode = dfg.nodes.find((n) => n.variableName === 'id');
    assert.ok(paramNode);
    assert.equal(paramNode.roomId, 'room-storage');
    assert.ok(paramNode.relatedTests && paramNode.relatedTests.includes('test/db.test.ts'));
    assert.equal(paramNode.functionName, 'queryDatabase');
    assert.ok(paramNode.lineRange.startLine >= 1);
  });
});
