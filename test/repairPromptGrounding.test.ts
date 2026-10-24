import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateRepairPrompt } from '../src/domain/investigation/promptGenerator.ts';
import type { RoomInvestigationFinding } from '../src/domain/investigation/types.ts';

const repoContext = { owner: 'acme', repo: 'shop', branch: 'main', commitSha: 'abc123' };

function finding(overrides: Partial<RoomInvestigationFinding>): RoomInvestigationFinding {
  return {
    roomId: 'room-api',
    roomName: 'API',
    title: 'Whitespace in SKU codes is not trimmed',
    explanation: 'SKU input keeps leading whitespace before lookup.',
    category: 'possible_bug',
    severity: 'medium',
    evidenceClassification: 'observed',
    evidenceReferences: [{ path: 'src/sku/normalize.ts', isInspected: true }],
    recommendedNextStep: 'Trim SKU input before lookup.',
    uncertainties: 'None noted.',
    companionMessages: [],
    ...overrides,
  };
}

describe('Repair prompt grounding: demo-specific guidance block', () => {
  it('is NOT injected into an unrelated finding that merely mentions whitespace', () => {
    const prompt = generateRepairPrompt(finding({}), repoContext);
    assert.ok(!prompt.includes('src/tasks/validation.js'), 'no invented file');
    assert.ok(!prompt.includes('validateTaskTitle'), 'no invented function');
    assert.ok(!prompt.includes('test/createTask.test.js'), 'no invented test');
  });

  it('is NOT injected for a room named room-validation without the cited file', () => {
    const prompt = generateRepairPrompt(finding({ roomId: 'room-validation', title: 'Email format check' }), repoContext);
    assert.ok(!prompt.includes('Target Diagnosis & Implementation Grounding'));
  });

  it('is still injected when the grounded finding cites src/tasks/validation.js', () => {
    const prompt = generateRepairPrompt(
      finding({
        roomId: 'room-validation',
        title: 'Whitespace-only task titles are accepted',
        evidenceReferences: [{ path: 'src/tasks/validation.js', isInspected: true }],
      }),
      repoContext
    );
    assert.ok(prompt.includes('Target Diagnosis & Implementation Grounding'));
    assert.ok(prompt.includes('validateTaskTitle(title)'));
  });
});
