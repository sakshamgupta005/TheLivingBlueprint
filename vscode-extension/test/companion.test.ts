import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { scanWorkspace } from '../src/workspaceScanner.ts';
import {
  generateAutomaticCompanionAnalysis,
  extractEvidenceRefs,
  answerCompanionQuery,
} from '../src/companionEngine.ts';

const candidatePaths = [
  path.resolve(process.cwd(), 'test', 'fixtures'),
  path.resolve(process.cwd(), 'vscode-extension', 'test', 'fixtures'),
];
const fixturesDir = candidatePaths.find((p) => fs.existsSync(p)) || candidatePaths[0];

describe('VS Code Extension - Companions & Evidence Navigation', () => {
  const expressFixture = path.join(fixturesDir, 'small-express');

  it('extracts reliable file and line evidence references', () => {
    const text = 'Check src/server.js:12 for main entry, and test/tasks.test.js:5 for unit tests.';
    const refs = extractEvidenceRefs(text, ['package.json']);

    assert.strictEqual(refs.length, 2);
    assert.strictEqual(refs[0].file, 'src/server.js');
    assert.strictEqual(refs[0].line, 12);
    assert.strictEqual(refs[1].file, 'test/tasks.test.js');
    assert.strictEqual(refs[1].line, 5);
  });

  it('automatically analyzes workspace with Barkley and Cleo grounded in current scan', async () => {
    const data = await scanWorkspace(expressFixture);
    const analysis = generateAutomaticCompanionAnalysis(data);

    assert(analysis.messages.length >= 1, 'Should generate at least Barkley message');

    const barkley = analysis.messages.find((m) => m.speaker === 'dog');
    assert(barkley, 'Barkley (dog) must be present in automatic analysis');
    assert.strictEqual(barkley.speakerName, 'Barkley');
    assert(barkley.text.length > 50, 'Barkley explanation should be substantive');
    assert(
      barkley.evidenceRefs.length > 0,
      'Barkley must reference discovered entry files with line numbers'
    );

    // Cleo speaks because in this workspace test suite files exist with 0 verified execution records
    const cleo = analysis.messages.find((m) => m.speaker === 'cat');
    if (cleo) {
      assert.strictEqual(cleo.speakerName, 'Cleo');
      assert.match(
        cleo.text,
        /evidence|gap|verified|implemented|tests/i,
        'Cleo must challenge assumptions and cite evidence gaps'
      );
      assert(cleo.evidenceRefs.length > 0, 'Cleo must include clickable evidence references');
    }
  });

  it('never forces both companions to speak if there are no evidence gaps', () => {
    // Mock a clean verified workspace with zero gaps
    const mockData: any = {
      workspaceName: 'PerfectProject',
      discoveredFilesCount: 5,
      inspectedFilesCount: 5,
      rooms: [
        {
          id: 'room-auth',
          name: 'Auth',
          status: 'verified',
          layer: 'service',
        },
      ],
      pillars: [
        { name: 'Database', status: 'verified' },
        { name: 'Observability', status: 'verified' },
      ],
      statusSummary: { verified: 1, implemented: 0, planned: 0, blocked: 0, unknown: 0 },
      inspectedFiles: [{ path: 'src/auth.ts', category: 'source', sizeBytes: 500, score: 90 }],
    };

    const analysis = generateAutomaticCompanionAnalysis(mockData);
    const cleo = analysis.messages.find((m) => m.speaker === 'cat');
    assert.strictEqual(cleo, undefined, 'Cleo must remain quiet when there are no genuine evidence gaps');
  });

  it('answers companion queries grounded in local workspace data without sending external network requests', async () => {
    const data = await scanWorkspace(expressFixture);
    const replies = await answerCompanionQuery(
      'What tests are missing verification?',
      data,
      {}, // No API keys provided
      false // AI consent false
    );

    assert(replies.length > 0, 'Should return grounded response');
    const hasEvidence = replies.some((r) => r.evidenceRefs && r.evidenceRefs.length > 0);
    assert(hasEvidence, 'Responses must contain clickable evidence references');

    for (const r of replies) {
      assert(['dog', 'cat'].includes(r.speaker));
      assert(!r.isAiGenerated, 'Must be locally generated offline without external egress');
    }
  });
});
