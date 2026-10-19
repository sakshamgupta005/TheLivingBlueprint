import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  prepareSourceContext,
  buildSystemPrompt,
} from '../src/server/contextBuilder.ts';
import {
  buildInvestigationSystemPrompt,
} from '../src/server/investigationProvider.ts';
import { validateInvestigationFinding } from '../src/domain/investigation/validator.ts';
import { generateRepairPrompt } from '../src/domain/investigation/promptGenerator.ts';
import { deriveRoomStatus } from '../src/domain/statusEngine.ts';
import type { ChatApiRequest } from '../src/server/types.ts';
import type { InvestigateApiRequest } from '../src/domain/investigation/types.ts';
import type { RoomModule } from '../src/domain/types.ts';

describe('T12.1: Live AI Source Grounding & Evidence Validation', () => {
  const sampleValidationCode = `/**
 * Validates task creation input according to specifications.
 */
export function validateTaskTitle(title) {
  if (typeof title !== 'string') {
    return {
      valid: false,
      error: 'Task title must be a string.',
    };
  }

  // Baseline implementation defect: checks raw length instead of trimmed length
  if (title.length === 0) {
    return {
      valid: false,
      error: 'Task title cannot be empty.',
    };
  }

  return {
    valid: true,
    sanitizedTitle: title.trim(),
  };
}
`;

  const sampleTestCode = `import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createTask, TaskValidationError } from '../src/tasks/createTask.js';

describe('Task Creation & Validation', () => {
  it('rejects whitespace-only task titles', () => {
    assert.throws(
      () => {
        createTask('   ');
      },
      TaskValidationError
    );
  });
});
`;

  it('1. Inspected file contents actually reach chat context', () => {
    const chatRequest: ChatApiRequest = {
      message: 'Does this repository reject whitespace-only titles?',
      selectedRoomId: 'room-validation',
      repoContext: {
        owner: 'sakshamgupta005',
        repo: 'patchboard-tasks-api',
        branch: 'main',
        commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
        totalFiles: 18,
        inspectedFiles: [
          {
            path: 'src/tasks/validation.js',
            category: 'source',
            contentExcerpt: sampleValidationCode,
          },
          {
            path: 'test/createTask.test.js',
            category: 'test',
            contentExcerpt: sampleTestCode,
          },
        ],
        discoveredFilePaths: [
          'src/tasks/validation.js',
          'test/createTask.test.js',
          'src/server.js',
          '.github/workflows/ci.yml',
        ],
        detectedTechnologies: ['JavaScript', 'Node.js'],
        roomSummaries: [
          {
            id: 'room-validation',
            name: 'Input Validation & Schema',
            layer: 'core',
            status: 'implemented',
            evidence: 'Discovered input validation in src/tasks/validation.js',
            filePaths: ['src/tasks/validation.js'],
          },
        ],
      },
    };

    const prompt = buildSystemPrompt(chatRequest);

    // Source code content must be present in prompt
    assert.ok(prompt.includes('validateTaskTitle(title)'), 'Prompt must contain validateTaskTitle');
    assert.ok(prompt.includes('title.length === 0'), 'Prompt must contain the title length check');
    assert.ok(prompt.includes('src/tasks/validation.js'), 'Prompt must cite file path');
    assert.ok(prompt.includes('[UNTRUSTED REPOSITORY CONTENT'), 'Must delimit untrusted repo content');
    assert.ok(prompt.includes('rejects whitespace-only task titles'), 'Must include test content');
  });

  it('2. Relevant source and test contents reach investigation context', () => {
    const investigateRequest: InvestigateApiRequest = {
      roomId: 'room-validation',
      roomName: 'Input Validation & Schema',
      roomLayer: 'core',
      roomStatus: 'implemented',
      roomEvidence: 'Discovered input validation rules in src/tasks/validation.js',
      roomFilePaths: ['src/tasks/validation.js'],
      repoContext: {
        owner: 'sakshamgupta005',
        repo: 'patchboard-tasks-api',
        branch: 'main',
        commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
        inspectedFiles: [
          {
            path: 'src/tasks/validation.js',
            category: 'source',
            contentExcerpt: sampleValidationCode,
          },
          {
            path: 'test/createTask.test.js',
            category: 'test',
            contentExcerpt: sampleTestCode,
          },
        ],
        discoveredFilePaths: [
          'src/tasks/validation.js',
          'test/createTask.test.js',
          'src/server.js',
        ],
        detectedTechnologies: ['JavaScript', 'Node.js'],
        ciEvaluation: {
          status: 'failing',
          isVerified: false,
          reason: 'Failing check: Run Unit and Integration Tests',
          checkRunsCount: 1,
          failedChecks: ['Run Unit and Integration Tests'],
        },
      },
    };

    const prompt = buildInvestigationSystemPrompt(investigateRequest);

    assert.ok(prompt.includes('validateTaskTitle(title)'), 'Investigation prompt must contain source code');
    assert.ok(prompt.includes('title.length === 0'), 'Must contain actual conditional logic');
    assert.ok(prompt.includes('SCANNED COMMIT SHA: 4ddfe585adbccd57794efba49ca1102ff654382f'), 'Must include commit SHA');
    assert.ok(prompt.includes('VERIFIED CI STATUS FOR SCANNED COMMIT: FAILING'), 'Must link CI status to commit');
  });

  it('3. Context-size enforcement without discarding all relevant source evidence', () => {
    const bigFile1 = 'console.log("file1");\n'.repeat(400); // ~8,800 chars
    const bigFile2 = 'console.log("file2");\n'.repeat(400); // ~8,800 chars
    const priorityFile = 'export function targetFunction() { return 42; }\n';

    const result = prepareSourceContext({
      inspectedFiles: [
        { path: 'src/huge1.js', category: 'source', contentExcerpt: bigFile1 },
        { path: 'src/huge2.js', category: 'source', contentExcerpt: bigFile2 },
        { path: 'src/target.js', category: 'source', contentExcerpt: priorityFile },
      ],
      selectedRoomId: 'room-target',
      selectedRoomFilePaths: ['src/target.js'],
      totalBudgetChars: 6000,
      maxPerFileChars: 2500,
    });

    // Priority file must be included first
    assert.strictEqual(result.includedFiles[0].path, 'src/target.js');
    assert.ok(result.formattedPromptSection.includes('targetFunction'));
    // Total formatted section must respect bounded size
    assert.ok(result.formattedPromptSection.length < 8000, 'Context must stay bounded');
  });

  it('4. Real source excerpt accepted as observed evidence and derives line number', () => {
    const request: InvestigateApiRequest = {
      roomId: 'room-validation',
      roomName: 'Input Validation & Schema',
      roomLayer: 'core',
      roomStatus: 'implemented',
      roomEvidence: 'Validation rules in src/tasks/validation.js',
      roomFilePaths: ['src/tasks/validation.js'],
      repoContext: {
        owner: 'sakshamgupta005',
        repo: 'patchboard-tasks-api',
        branch: 'main',
        commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
        inspectedFiles: [
          {
            path: 'src/tasks/validation.js',
            category: 'source',
            contentExcerpt: sampleValidationCode,
          },
        ],
        discoveredFilePaths: ['src/tasks/validation.js'],
        detectedTechnologies: ['JavaScript'],
      },
    };

    const rawFinding = {
      title: 'Whitespace-Only Title Validation Defect',
      explanation: 'validateTaskTitle checks title.length === 0 instead of trimming whitespace first.',
      category: 'possible_bug',
      severity: 'medium',
      evidenceClassification: 'observed',
      evidencePaths: ['src/tasks/validation.js'],
      codeEvidence: {
        filePath: 'src/tasks/validation.js',
        targetIdentifier: 'validateTaskTitle',
        codeSnippet: 'if (title.length === 0)',
        explanation: 'Checks raw string length without trimming whitespace',
      },
      recommendedNextStep: 'Verify trimmed title length before accepting.',
      uncertainties: 'None. Directly observed in inspected source.',
    };

    const validated = validateInvestigationFinding(rawFinding, request);

    assert.strictEqual(validated.evidenceClassification, 'observed');
    assert.strictEqual(validated.codeEvidence?.isVerified, true);
    assert.strictEqual(validated.codeEvidence?.targetIdentifier, 'validateTaskTitle');
    assert.strictEqual(validated.codeEvidence?.codeSnippet, 'if (title.length === 0)');
    // Line number derived from sampleValidationCode: line 13
    assert.strictEqual(validated.codeEvidence?.derivedLineNumber, 13);
    assert.strictEqual(validated.evidenceReferences[0].derivedLineNumber, 13);
  });

  it('5. Fabricated identifier or source excerpt rejected or downgraded', () => {
    const request: InvestigateApiRequest = {
      roomId: 'room-validation',
      roomName: 'Input Validation & Schema',
      roomLayer: 'core',
      roomStatus: 'implemented',
      roomEvidence: 'Validation rules in src/tasks/validation.js',
      repoContext: {
        owner: 'sakshamgupta005',
        repo: 'patchboard-tasks-api',
        branch: 'main',
        inspectedFiles: [
          {
            path: 'src/tasks/validation.js',
            category: 'source',
            contentExcerpt: sampleValidationCode,
          },
        ],
        discoveredFilePaths: ['src/tasks/validation.js'],
        detectedTechnologies: ['JavaScript'],
      },
    };

    const rawFinding = {
      title: 'Invented Function Bug',
      explanation: 'validateTaskInput checks input.title instead of real code.',
      category: 'possible_bug',
      severity: 'high',
      evidenceClassification: 'observed',
      evidencePaths: ['src/tasks/validation.js'],
      codeEvidence: {
        filePath: 'src/tasks/validation.js',
        targetIdentifier: 'validateTaskInput', // Fabricated identifier!
        codeSnippet: 'if (input.title === "")', // Fabricated snippet!
      },
      recommendedNextStep: 'Fix validateTaskInput function.',
    };

    const validated = validateInvestigationFinding(rawFinding, request);

    // Must be demoted because codeEvidence was rejected
    assert.strictEqual(validated.evidenceClassification, 'inferred');
    assert.ok(validated.rejectedReferences && validated.rejectedReferences.length > 0);
    assert.ok(
      validated.rejectedReferences.some((r) => r.includes('validateTaskInput')),
      'Must record rejected identifier'
    );
    assert.ok(
      validated.rejectedReferences.some((r) => r.includes('if (input.title === "")')),
      'Must record rejected snippet'
    );
    assert.ok(validated.uncertainties.includes('[REJECTED CODE CLAIMS:'));
  });

  it('6. Missing source content prevents an observed code claim', () => {
    const request: InvestigateApiRequest = {
      roomId: 'room-validation',
      roomName: 'Input Validation & Schema',
      roomLayer: 'core',
      roomStatus: 'implemented',
      roomEvidence: 'Validation rules in src/tasks/validation.js',
      repoContext: {
        owner: 'sakshamgupta005',
        repo: 'patchboard-tasks-api',
        branch: 'main',
        inspectedFiles: [
          {
            path: 'src/tasks/validation.js',
            category: 'source',
            contentExcerpt: '', // Empty / unread content
          },
        ],
        discoveredFilePaths: ['src/tasks/validation.js'],
        detectedTechnologies: ['JavaScript'],
      },
    };

    const rawFinding = {
      title: 'Validation Claim Without Code',
      explanation: 'Asserts something about code when content was never fetched.',
      category: 'possible_bug',
      severity: 'high',
      evidenceClassification: 'observed',
      evidencePaths: ['src/tasks/validation.js'],
      codeEvidence: {
        filePath: 'src/tasks/validation.js',
        targetIdentifier: 'validateTaskTitle',
        codeSnippet: 'if (title.length === 0)',
      },
      recommendedNextStep: 'Investigate.',
    };

    const validated = validateInvestigationFinding(rawFinding, request);

    assert.notStrictEqual(validated.evidenceClassification, 'observed');
    assert.ok(validated.rejectedReferences?.some((r) => r.includes('content not inspected')));
  });

  it('7. Stale repository or commit content excluded when no scan is active', () => {
    const idleRequest: ChatApiRequest = {
      message: 'What is this repository?',
    };

    const prompt = buildSystemPrompt(idleRequest);
    assert.ok(prompt.includes('ACTIVE REPOSITORY: None (No repository currently scanned).'));
    assert.ok(!prompt.includes('BookNook'), 'Must not substitute BookNook mock data into prompt');
    assert.ok(!prompt.includes('4ddfe585adbccd57794efba49ca1102ff654382f'));
  });

  it('8. Repair prompts contain validated identifiers rather than unsupported model claims', () => {
    const validatedFinding = {
      roomId: 'room-validation',
      roomName: 'Input Validation & Schema',
      title: 'Whitespace-Only Title Validation Defect',
      explanation: 'The function validateTaskTitle in src/tasks/validation.js checks title.length === 0.',
      category: 'possible_bug' as const,
      severity: 'medium' as const,
      evidenceClassification: 'observed' as const,
      evidenceReferences: [
        {
          path: 'src/tasks/validation.js',
          isInspected: true,
          derivedLineNumber: 15,
          verifiedIdentifier: 'validateTaskTitle',
          verifiedExcerpt: 'if (title.length === 0)',
        },
      ],
      codeEvidence: {
        filePath: 'src/tasks/validation.js',
        targetIdentifier: 'validateTaskTitle',
        codeSnippet: 'if (title.length === 0)',
        derivedLineNumber: 15,
        isVerified: true,
      },
      recommendedNextStep: 'Validate trimmed title before accepting, e.g. title.trim().length === 0.',
      uncertainties: 'None. Grounded in inspected source.',
      companionMessages: [],
    };

    const prompt = generateRepairPrompt(validatedFinding, {
      owner: 'sakshamgupta005',
      repo: 'patchboard-tasks-api',
      branch: 'main',
      commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
    });

    // Check required grounded references
    assert.ok(prompt.includes('src/tasks/validation.js'));
    assert.ok(prompt.includes('validateTaskTitle(title)'));
    assert.ok(prompt.includes('title.length === 0'));
    assert.ok(prompt.includes('test/createTask.test.js'));
    assert.ok(prompt.includes('4ddfe58'));

    // Check prohibited hallucinations
    assert.ok(!prompt.includes('validateTaskInput'), 'Must not contain hallucinated validateTaskInput');
    assert.ok(!prompt.includes('input.title'), 'Must not contain hallucinated input.title');

    // Instructions must direct agent to inspect current code first
    assert.ok(prompt.includes('Inspect the files referenced above before making any edits'));
    assert.ok(prompt.includes('Do NOT assume the fix has already been applied'));
  });

  it('9. CI evidence remains associated with the correct commit', () => {
    const request: InvestigateApiRequest = {
      roomId: 'room-tests',
      roomName: 'Automated Tests & Quality',
      roomLayer: 'gateway',
      roomStatus: 'blocked',
      roomEvidence: 'CI Check Run failure: Run Unit and Integration Tests',
      repoContext: {
        owner: 'sakshamgupta005',
        repo: 'patchboard-tasks-api',
        branch: 'main',
        commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
        inspectedFiles: [
          {
            path: 'test/createTask.test.js',
            category: 'test',
            contentExcerpt: sampleTestCode,
          },
        ],
        discoveredFilePaths: ['test/createTask.test.js'],
        detectedTechnologies: ['Node.js'],
        ciEvaluation: {
          status: 'failing',
          isVerified: false,
          reason: 'Failing check: Run Unit and Integration Tests',
          checkRunsCount: 1,
          failedChecks: ['Run Unit and Integration Tests'],
        },
      },
    };

    const prompt = buildInvestigationSystemPrompt(request);
    assert.ok(prompt.includes('SCANNED COMMIT SHA: 4ddfe585adbccd57794efba49ca1102ff654382f'));
    assert.ok(prompt.includes('VERIFIED CI STATUS FOR SCANNED COMMIT: FAILING'));
  });

  it('10. Existing deterministic status-engine rules remain unchanged', () => {
    const mod: RoomModule = {
      id: 'room-validation',
      name: 'Input Validation & Schema',
      description: 'Validation module',
      layer: 'core',
      requirements: [{ id: 'req-val', title: 'Validate Titles' }],
      evidenceHistory: [
        {
          id: 'ev-1',
          sourceType: 'source_code',
          description: 'Discovered in src/tasks/validation.js',
          timestamp: new Date().toISOString(),
          reference: 'src/tasks/validation.js',
          targetRequirementId: 'req-val',
        },
      ],
    };

    const result = deriveRoomStatus(mod);
    assert.strictEqual(result.status, 'implemented');

    // Add failing test evidence
    mod.evidenceHistory.push({
      id: 'ev-ci',
      sourceType: 'test_result',
      description: 'CI test run failed: Run Unit and Integration Tests',
      timestamp: new Date().toISOString(),
      reference: 'https://github.com/sakshamgupta005/patchboard-tasks-api/actions/runs/1',
      targetRequirementId: 'req-val',
      isBlocker: true,
      verificationResult: {
        status: 'failed',
        testSuite: 'Run Unit and Integration Tests',
        details: 'Whitespace-only title was unexpectedly accepted',
      },
    });

    const blockedResult = deriveRoomStatus(mod);
    assert.strictEqual(blockedResult.status, 'blocked');
  });
});
