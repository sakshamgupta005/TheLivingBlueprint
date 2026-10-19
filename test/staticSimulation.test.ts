import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  evaluateExpression,
  deriveScenarios,
  runStaticSimulation,
} from '../src/domain/simulation/index.ts';
import { buildControlFlowGraph } from '../src/domain/cfg/cfgBuilder.ts';

describe('T29: Real Static Simulation Workbench', () => {
  it('1. Bounded Expression Evaluator evaluates literals, assignments, and comparisons correctly', () => {
    const scope = {
      title: 'Fix issue',
      count: 10,
      active: true,
      user: { role: 'admin' },
    };

    // Literals and variables
    assert.strictEqual(evaluateExpression('count', scope).value, 10);
    assert.strictEqual(evaluateExpression('title', scope).value, 'Fix issue');
    assert.strictEqual(evaluateExpression('user.role', scope).value, 'admin');

    // Comparisons
    assert.strictEqual(evaluateExpression('count > 5', scope).value, true);
    assert.strictEqual(evaluateExpression('count === 10', scope).value, true);
    assert.strictEqual(evaluateExpression('count < 2', scope).value, false);

    // Booleans and negation
    assert.strictEqual(evaluateExpression('!active', scope).value, false);
    assert.strictEqual(evaluateExpression('active && count > 5', scope).value, true);

    // String operations (.trim().length)
    assert.strictEqual(evaluateExpression('title.trim().length > 0', scope).value, true);
    assert.strictEqual(evaluateExpression('"  ".trim().length === 0', scope).value, true);
  });

  it('2. Evaluates branch decisions and records why a branch was selected', () => {
    const sourceCode = `
      function validateTask(title: string) {
        if (!title || title.trim().length === 0) {
          throw new Error('Title is required');
        }
        return { success: true, title };
      }
    `;

    const cfg = buildControlFlowGraph({
      sourcePath: 'src/validator.ts',
      content: sourceCode,
      functionName: 'validateTask',
    });

    assert.ok(cfg, 'CFG must be built');

    // Scenario A: Valid input -> takes false branch (skips throw) and returns object
    const validSim = runStaticSimulation({
      cfg,
      scenario: {
        id: 'valid',
        name: 'Valid Title',
        description: 'Non-empty string',
        category: 'valid',
        parameters: { title: 'Clean Architecture' },
      },
    });

    assert.strictEqual(validSim.traceKind, 'static_code_simulation');
    assert.strictEqual(validSim.isComplete, true);
    assert.ok(validSim.steps.length >= 2);

    // Find the condition step
    const condStep = validSim.steps.find((s) => s.conditionResult);
    assert.ok(condStep, 'Must find condition step');
    assert.strictEqual(condStep?.conditionResult?.result, false, 'Condition is false for non-empty title');
    assert.ok(condStep?.alternativeBranches.length >= 1, 'Records alternative true branch');
    assert.ok(condStep?.alternativeBranches[0].reasonNotTaken.includes('false'), 'Explains why alternative was skipped');

    // Scenario B: Whitespace input -> takes true branch (throws error)
    const whitespaceSim = runStaticSimulation({
      cfg,
      scenario: {
        id: 'whitespace',
        name: 'Whitespace Title',
        description: 'Whitespace only',
        category: 'whitespace',
        parameters: { title: '    ' },
      },
    });

    assert.strictEqual(whitespaceSim.isComplete, true);
    const wsCondStep = whitespaceSim.steps.find((s) => s.conditionResult);
    assert.ok(wsCondStep);
    assert.strictEqual(wsCondStep?.conditionResult?.result, true, 'Condition is true for whitespace title');
    assert.ok(whitespaceSim.steps.some((s) => s.isError), 'Whitespace input hits error / throw branch');
  });

  it('3. Marks unknown expressions as UNKNOWN instead of fabricating values', () => {
    const scope = { x: 5 };

    // Unknown variable
    const unkVar = evaluateExpression('undefinedGlobalVariable', scope);
    assert.strictEqual(unkVar.isUnknown, true);
    assert.strictEqual(unkVar.value, 'UNKNOWN');

    // Complex / unsupported dynamic call
    const unkExpr = evaluateExpression('crypto.generateSecureHash("test")', scope);
    assert.strictEqual(unkExpr.isUnknown, true);
    assert.strictEqual(unkExpr.value, 'UNKNOWN');

    // Unknown comparison
    const unkComp = evaluateExpression('x === unknownVar', scope);
    assert.strictEqual(unkComp.isUnknown, true);
    assert.strictEqual(unkComp.value, 'UNKNOWN');
  });

  it('4. Enforces bounded execution to prevent infinite loops and runaway simulation', () => {
    const infiniteLoopCode = `
      function foreverLoop() {
        let count = 0;
        while (count < 1000) {
          count = count + 1;
        }
        return count;
      }
    `;

    const sim = runStaticSimulation({
      sourcePath: 'src/loop.ts',
      sourceCode: infiniteLoopCode,
      functionName: 'foreverLoop',
      maxLoopIterations: 3,
      maxSteps: 20,
    });

    assert.strictEqual(sim.terminatedEarly, true, 'Must terminate early when bound is hit');
    assert.ok(
      sim.terminationReason?.includes('bounded') || sim.terminationReason?.includes('bound'),
      'Must state termination reason'
    );
    assert.ok(sim.steps.length <= 20, 'Steps must remain strictly within step bound');
  });

  it('5. Generates meaningful scenarios derived from parameters and test cases', () => {
    const scenarios = deriveScenarios('createItem', ['req', 'res'], 'const { title } = req.body; if (!title) ...');

    assert.ok(scenarios.length >= 4, 'Generates at least 4 scenarios');
    assert.ok(scenarios.some((s) => s.category === 'valid'), 'Includes valid input scenario');
    assert.ok(scenarios.some((s) => s.category === 'whitespace'), 'Includes whitespace scenario');
    assert.ok(scenarios.some((s) => s.category === 'missing_fields'), 'Includes missing fields scenario');
    assert.ok(scenarios.some((s) => s.category === 'boundary'), 'Includes boundary value scenario');
  });

  it('6. Simulates Patchboard whitespace validation bug deterministically', () => {
    // Patchboard validation pattern: checks presence with !title but forgets .trim() before length assertion
    const patchboardCode = `
      function validatePatchboardEntry(title: string) {
        if (!title) {
          return { error: 'Missing title' };
        }
        if (title.length < 3) {
          return { error: 'Title too short' };
        }
        // Late or missing trim
        return { success: true, title };
      }
    `;

    const cfg = buildControlFlowGraph({
      sourcePath: 'src/patchboard.ts',
      content: patchboardCode,
      functionName: 'validatePatchboardEntry',
    });

    // Whitespace input: "   " has length 3, so it erroneously bypasses title.length < 3!
    const bugSim = runStaticSimulation({
      cfg,
      scenario: {
        id: 'whitespace-bug',
        name: 'Whitespace String',
        description: '3 spaces',
        category: 'whitespace',
        parameters: { title: '   ' },
      },
    });

    assert.strictEqual(bugSim.traceKind, 'static_code_simulation');
    assert.strictEqual(bugSim.isComplete, true);
    // Bypassed validation due to missing trim!
    assert.ok(bugSim.steps.length >= 3);
  });

  it('7. Transparently labels simulation as static code simulation without running target code', () => {
    const code = `
      function compute(val: number) {
        return val * 2;
      }
    `;

    const sim = runStaticSimulation({
      sourcePath: 'src/compute.ts',
      sourceCode: code,
      functionName: 'compute',
      scenario: {
        id: 'test-scenario',
        name: 'Test Scenario',
        description: 'Value 5',
        category: 'valid',
        parameters: { val: 5 },
      },
      relevantTests: ['test/compute.test.ts'],
    });

    assert.strictEqual(sim.traceKind, 'static_code_simulation');
    assert.strictEqual(sim.relevantTests?.[0], 'test/compute.test.ts');
    assert.ok(sim.stats.variablesTracked >= 1);
  });
});
