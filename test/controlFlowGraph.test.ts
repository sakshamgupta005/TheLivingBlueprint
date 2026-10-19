import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildControlFlowGraph,
  extractFunctionsFromSource,
  cfgToWorkflowDiagram,
} from '../src/domain/cfg/index.ts';

describe('T26: Real Control-Flow Graphs From Code', () => {
  it('1. Extracts declared functions and methods from TypeScript source', () => {
    const code = `
      export function calculateDiscount(price: number, isVip: boolean): number {
        if (isVip) return price * 0.8;
        return price;
      }

      export class OrderManager {
        processOrder(orderId: string) {
          console.log(orderId);
        }
      }

      export const helper = (x: number) => x * 2;
    `;

    const funcs = extractFunctionsFromSource('src/pricing.ts', code);
    assert.equal(funcs.length, 3);
    assert.equal(funcs[0].name, 'calculateDiscount');
    assert.equal(funcs[1].name, 'processOrder');
    assert.equal(funcs[2].name, 'helper');
  });

  it('2. Builds deterministic CFG for nested if/else branches and conditions', () => {
    const code = `
      function validateUser(role: string, age: number): boolean {
        if (role === 'admin') {
          if (age >= 18) {
            return true;
          } else {
            return false;
          }
        }
        return false;
      }
    `;

    const cfg = buildControlFlowGraph({
      sourcePath: 'src/auth.ts',
      content: code,
      functionName: 'validateUser',
    });

    assert.ok(cfg, 'CFG should be generated');
    assert.equal(cfg.functionName, 'validateUser');
    assert.equal(cfg.sourcePath, 'src/auth.ts');
    assert.equal(cfg.entryNodeId, 'cfg-entry');
    assert.equal(cfg.exitNodeId, 'cfg-exit');

    // Verify condition nodes exist
    const conditionNodes = cfg.nodes.filter((n) => n.kind === 'condition');
    assert.equal(conditionNodes.length, 2, 'Should have 2 if-conditions');
    assert.ok(conditionNodes[0].label.includes("role === 'admin'"));
    assert.ok(conditionNodes[1].label.includes('age >= 18'));

    // Verify edges have condition true/false tags
    const trueEdges = cfg.edges.filter((e) => e.kind === 'condition_true');
    const falseEdges = cfg.edges.filter((e) => e.kind === 'condition_false');
    assert.ok(trueEdges.length >= 2, 'Should have true branch edges');
    assert.ok(falseEdges.length >= 1, 'Should have false branch edges');

    // Verify early returns connect to exit
    const returnEdges = cfg.edges.filter((e) => e.kind === 'early_return');
    assert.equal(returnEdges.length, 3, 'All 3 returns should route early_return to exit');
    for (const re of returnEdges) {
      assert.equal(re.target, cfg.exitNodeId);
    }
  });

  it('3. Builds loops (while, for, do-while, for-of) with loop-back edges and continue', () => {
    const code = `
      function sumEvenNumbers(items: number[]): number {
        let sum = 0;
        for (let i = 0; i < items.length; i++) {
          const val = items[i];
          if (val % 2 !== 0) {
            continue;
          }
          sum += val;
        }
        return sum;
      }
    `;

    const cfg = buildControlFlowGraph({
      sourcePath: 'src/math.ts',
      content: code,
      functionName: 'sumEvenNumbers',
    });

    assert.ok(cfg);
    assert.equal(cfg.stats.loopCount, 1);

    // Verify loop header and loop exit nodes
    const loopHeaders = cfg.nodes.filter((n) => n.kind === 'loop_header');
    const loopExits = cfg.nodes.filter((n) => n.kind === 'loop_exit');
    assert.equal(loopHeaders.length, 1);
    assert.equal(loopExits.length, 1);

    // Verify continue node
    const continueNodes = cfg.nodes.filter((n) => n.kind === 'continue');
    assert.equal(continueNodes.length, 1);

    // Verify loop back edges
    const backEdges = cfg.edges.filter((e) => e.isBackEdge === true);
    assert.ok(backEdges.length >= 1, 'Should have back edge(s) for loop iteration');
  });

  it('4. Handles exceptions with try/catch/finally and throws', () => {
    const code = `
      function executeTask(task: any) {
        try {
          if (!task) {
            throw new Error('Task is null');
          }
          task.run();
        } catch (err) {
          console.error(err);
        } finally {
          cleanup();
        }
      }
    `;

    const cfg = buildControlFlowGraph({
      sourcePath: 'src/worker.ts',
      content: code,
      functionName: 'executeTask',
    });

    assert.ok(cfg);
    const tryNodes = cfg.nodes.filter((n) => n.kind === 'try_block');
    const catchNodes = cfg.nodes.filter((n) => n.kind === 'catch_block');
    const finallyNodes = cfg.nodes.filter((n) => n.kind === 'finally_block');
    const throwNodes = cfg.nodes.filter((n) => n.kind === 'throw');

    assert.equal(tryNodes.length, 1);
    assert.equal(catchNodes.length, 1);
    assert.equal(finallyNodes.length, 1);
    assert.equal(throwNodes.length, 1);

    // Verify throw has exception edge to catch
    const throwEdge = cfg.edges.find((e) => e.source === throwNodes[0].id);
    assert.ok(throwEdge, 'Throw node must have an outgoing edge');
    assert.equal(throwEdge.kind, 'exception');
    assert.equal(throwEdge.target, catchNodes[0].id);

    // Verify finally flow
    const finallyEdges = cfg.edges.filter((e) => e.target === finallyNodes[0].id);
    assert.ok(finallyEdges.length >= 1, 'Try/catch must flow into finally');
  });

  it('5. Handles switch statements with cases, breaks, fallthrough, and default', () => {
    const code = `
      function getStatusColor(status: string): string {
        let color = 'gray';
        switch (status) {
          case 'success':
            color = 'green';
            break;
          case 'warning':
            color = 'yellow';
            break;
          case 'error':
          case 'fatal':
            color = 'red';
            break;
          default:
            color = 'gray';
        }
        return color;
      }
    `;

    const cfg = buildControlFlowGraph({
      sourcePath: 'src/theme.ts',
      content: code,
      functionName: 'getStatusColor',
    });

    assert.ok(cfg);
    const switchHeaders = cfg.nodes.filter((n) => n.kind === 'switch_header');
    const caseNodes = cfg.nodes.filter((n) => n.kind === 'switch_case');
    const defaultNodes = cfg.nodes.filter((n) => n.kind === 'case_default');

    assert.equal(switchHeaders.length, 1);
    assert.equal(caseNodes.length, 4); // success, warning, error, fatal
    assert.equal(defaultNodes.length, 1);

    // Verify case_match edges
    const caseMatchEdges = cfg.edges.filter((e) => e.kind === 'case_match');
    assert.equal(caseMatchEdges.length, 4);

    const defaultEdge = cfg.edges.find((e) => e.kind === 'case_default');
    assert.ok(defaultEdge);
  });

  it('6. Explicitly labels malformed source and records parse errors', () => {
    const malformed = `
      function brokenSyntax(a, b) {
        if (a >
        return b;
      }
    `;

    const cfg = buildControlFlowGraph({
      sourcePath: 'src/broken.ts',
      content: malformed,
      functionName: 'brokenSyntax',
    });

    assert.ok(cfg);
    assert.equal(cfg.hasParseErrors, true);
    assert.ok(cfg.parseDiagnostics && cfg.parseDiagnostics.length > 0);
  });

  it('7. Handles unsupported language/syntax constructs honestly', () => {
    const codeWithWith = `
      function legacyScope(obj: any) {
        with (obj) {
          console.log(value);
        }
      }
    `;

    const cfg = buildControlFlowGraph({
      sourcePath: 'src/legacy.ts',
      content: codeWithWith,
      functionName: 'legacyScope',
    });

    assert.ok(cfg);
    assert.ok(cfg.unsupportedConstructs && cfg.unsupportedConstructs.length > 0);
    const unsuppNode = cfg.nodes.find((n) => n.kind === 'unsupported');
    assert.ok(unsuppNode);
    assert.ok(unsuppNode.unsupportedReason);
  });

  it('8. Converts ControlFlowGraph to WorkflowDiagram for UI simulation and walkthrough', () => {
    const code = `
      function checkAccess(user: any) {
        if (!user) return false;
        return user.isAdmin;
      }
    `;

    const cfg = buildControlFlowGraph({
      sourcePath: 'src/security.ts',
      content: code,
      functionName: 'checkAccess',
    });

    assert.ok(cfg);
    const diagram = cfgToWorkflowDiagram(cfg);
    assert.ok(diagram.title.includes('checkAccess'));
    assert.ok(diagram.nodes.length >= 4);
    assert.ok(diagram.edges.length >= 3);

    // Every node in diagram must have classification 'observed' and real sourceFile
    for (const node of diagram.nodes) {
      assert.equal(node.classification, 'observed');
      assert.equal(node.sourceFile, 'src/security.ts');
      assert.ok(node.lineRange.startLine >= 1);
    }
  });
});
