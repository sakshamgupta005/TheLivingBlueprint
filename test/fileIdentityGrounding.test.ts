import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanGitHubRepository } from '../src/domain/github/scanner.ts';
import { mapScanResultToHouse } from '../src/domain/github/architectureMapper.ts';
import { validateInvestigationFinding } from '../src/domain/investigation/validator.ts';
import type { InvestigateApiRequest } from '../src/domain/investigation/types.ts';
import type { GitHubScanResult } from '../src/domain/github/types.ts';

describe('T11.1: File Identity Grounding & Evidence Integrity', () => {
  // Mock fetch that mirrors the exact real patchboard-tasks-api tree at commit 4ddfe585adbccd57794efba49ca1102ff654382f
  const mockPatchboardFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('/check-runs')) {
      return new Response(
        JSON.stringify({
          total_count: 1,
          check_runs: [
            {
              id: 991,
              name: 'Run Unit and Integration Tests',
              head_sha: '4ddfe585adbccd57794efba49ca1102ff654382f',
              status: 'completed',
              conclusion: 'failure',
              html_url: 'https://github.com/sakshamgupta005/patchboard-tasks-api/actions/runs/12345',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes('/repos/sakshamgupta005/patchboard-tasks-api/commits/')) {
      return new Response(
        JSON.stringify({
          sha: '4ddfe585adbccd57794efba49ca1102ff654382f',
          commit: { message: 'Initial commit with task api and test suite' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes('/git/trees/')) {
      return new Response(
        JSON.stringify({
          sha: 'tree-patchboard-root',
          tree: [
            { path: '.github', mode: '040000', type: 'tree', sha: 't1', url: '' },
            { path: '.github/workflows', mode: '040000', type: 'tree', sha: 't2', url: '' },
            { path: '.github/workflows/ci.yml', mode: '100644', type: 'blob', sha: 'b1', size: 424, url: '' },
            { path: '.gitignore', mode: '100644', type: 'blob', sha: 'b2', size: 30, url: '' },
            { path: 'LICENSE', mode: '100644', type: 'blob', sha: 'b3', size: 1077, url: '' },
            { path: 'README.md', mode: '100644', type: 'blob', sha: 'b4', size: 2262, url: '' },
            { path: 'docs', mode: '040000', type: 'tree', sha: 't3', url: '' },
            { path: 'docs/requirements.md', mode: '100644', type: 'blob', sha: 'b5', size: 2058, url: '' },
            { path: 'package.json', mode: '100644', type: 'blob', sha: 'b6', size: 425, url: '' },
            { path: 'src', mode: '040000', type: 'tree', sha: 't4', url: '' },
            { path: 'src/server.js', mode: '100644', type: 'blob', sha: 'b7', size: 2052, url: '' },
            { path: 'src/tasks', mode: '040000', type: 'tree', sha: 't5', url: '' },
            { path: 'src/tasks/createTask.js', mode: '100644', type: 'blob', sha: 'b8', size: 614, url: '' },
            { path: 'src/tasks/store.js', mode: '100644', type: 'blob', sha: 'b9', size: 468, url: '' },
            { path: 'src/tasks/validation.js', mode: '100644', type: 'blob', sha: 'b10', size: 611, url: '' },
            { path: 'test', mode: '040000', type: 'tree', sha: 't6', url: '' },
            { path: 'test/createTask.test.js', mode: '100644', type: 'blob', sha: 'b11', size: 2015, url: '' },
            { path: 'test/server.test.js', mode: '100644', type: 'blob', sha: 'b12', size: 2680, url: '' },
          ],
          truncated: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes('/repos/sakshamgupta005/patchboard-tasks-api')) {
      return new Response(
        JSON.stringify({
          name: 'patchboard-tasks-api',
          full_name: 'sakshamgupta005/patchboard-tasks-api',
          default_branch: 'main',
          private: false,
          html_url: 'https://github.com/sakshamgupta005/patchboard-tasks-api',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes('raw.githubusercontent.com')) {
      return new Response('// file content placeholder', { status: 200 });
    }

    return new Response('Not found', { status: 404 });
  };

  it('1. Real Patchboard scan identifies test/createTask.test.js and test/server.test.js (never tests/tasks.test.js)', async () => {
    const scan = await scanGitHubRepository(
      'https://github.com/sakshamgupta005/patchboard-tasks-api',
      { fetchFn: mockPatchboardFetch }
    );

    assert.equal(scan.success, true);
    assert.equal(scan.commitSha, '4ddfe585adbccd57794efba49ca1102ff654382f');

    const inspectedPaths = scan.inspectedFiles.map((f) => f.path);
    assert.ok(inspectedPaths.includes('test/createTask.test.js'), 'Expected test/createTask.test.js in inspected files');
    assert.ok(inspectedPaths.includes('test/server.test.js'), 'Expected test/server.test.js in inspected files');
    assert.equal(inspectedPaths.includes('tests/tasks.test.js'), false, 'tests/tasks.test.js must NEVER appear');

    const testFiles = scan.inspectedFiles.filter((f) => f.category === 'test');
    assert.equal(testFiles.length, 2, 'Exactly 2 test files exist in Patchboard API');
    assert.deepEqual(
      testFiles.map((f) => f.path).sort(),
      ['test/createTask.test.js', 'test/server.test.js'].sort()
    );
  });

  it('2. Architecture mapping strictly derives rooms and filePaths from genuine scanned files', async () => {
    const scan = await scanGitHubRepository(
      'https://github.com/sakshamgupta005/patchboard-tasks-api',
      { fetchFn: mockPatchboardFetch }
    );

    const house = mapScanResultToHouse(scan);
    const testRoom = house.rooms.find((r) => r.id === 'room-tests');
    assert.ok(testRoom, 'Expected Automated Tests & Quality room');
    assert.equal(testRoom.status, 'blocked');

    // Confirm associated real file paths
    assert.deepEqual(testRoom.filePaths?.sort(), ['test/createTask.test.js', 'test/server.test.js'].sort());
    assert.ok(!testRoom.filePaths?.includes('tests/tasks.test.js'));

    // Confirm evidence string only mentions genuine file paths
    assert.ok(testRoom.evidence.includes('test/createTask.test.js'));
    assert.ok(testRoom.evidence.includes('test/server.test.js'));
    assert.ok(!testRoom.evidence.includes('tests/tasks.test.js'));

    // Confirm every room's filePaths resolve to genuine inspected files
    const allInspectedPaths = new Set(scan.inspectedFiles.map((f) => f.path));
    for (const room of house.rooms) {
      for (const fp of room.filePaths || []) {
        assert.ok(allInspectedPaths.has(fp), `Room ${room.name} references non-inspected file: ${fp}`);
      }
    }
  });

  it('3. Fabricated or ungrounded paths in investigation requests are rejected and explicitly recorded', () => {
    const req: InvestigateApiRequest = {
      roomId: 'room-tests',
      roomName: 'Automated Tests & Quality',
      roomLayer: 'gateway',
      roomStatus: 'blocked',
      roomEvidence: 'CI failure',
      repoContext: {
        owner: 'sakshamgupta005',
        repo: 'patchboard-tasks-api',
        branch: 'main',
        commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
        inspectedFiles: [
          { path: 'test/createTask.test.js', category: 'test' },
          { path: 'test/server.test.js', category: 'test' },
          { path: 'src/server.js', category: 'source' },
        ],
        discoveredFilePaths: [
          'test/createTask.test.js',
          'test/server.test.js',
          'src/server.js',
          'package.json',
        ],
        detectedTechnologies: ['JavaScript', 'Node.js'],
      },
    };

    // Simulate an AI provider returning a fabricated path 'tests/tasks.test.js' alongside valid 'test/createTask.test.js'
    const finding = validateInvestigationFinding(
      {
        title: 'Task creation test failure',
        explanation: 'Failing test in task suite.',
        category: 'possible_bug',
        severity: 'high',
        evidenceClassification: 'observed',
        evidencePaths: ['test/createTask.test.js', 'tests/tasks.test.js', 'src/fake/auth.js'],
        recommendedNextStep: 'Fix validation check in createTask.js',
        uncertainties: 'Single test failing.',
      },
      req
    );

    // Only real file is accepted in validated references
    assert.equal(finding.evidenceReferences.length, 1);
    assert.equal(finding.evidenceReferences[0].path, 'test/createTask.test.js');

    // Fabricated paths are explicitly captured in rejectedReferences
    assert.ok(finding.rejectedReferences, 'Expected rejectedReferences to be populated');
    assert.deepEqual(finding.rejectedReferences, ['tests/tasks.test.js', 'src/fake/auth.js']);

    // Finding classification cannot remain 'observed' if references were fabricated
    assert.notEqual(finding.evidenceClassification, 'observed');

    // Uncertainties must contain explicit rejection note
    assert.ok(finding.uncertainties.includes('[REJECTED UNGROUNDED EVIDENCE: Excluded 2 path(s) not found in scanned git tree: tests/tasks.test.js, src/fake/auth.js]'));
  });

  it('4. Real scan never contains mock/sample data (BookNook or auth.test.ts)', async () => {
    const scan = await scanGitHubRepository(
      'https://github.com/sakshamgupta005/patchboard-tasks-api',
      { fetchFn: mockPatchboardFetch }
    );

    const serialized = JSON.stringify(scan);
    assert.ok(!serialized.toLowerCase().includes('booknook'));
    assert.ok(!serialized.includes('tests/auth.test.ts'));
    assert.ok(!serialized.includes('src/auth/jwt.ts'));
  });

  it('5. CI evidence remains strictly bound to exact commit SHA 4ddfe585adbccd57794efba49ca1102ff654382f', async () => {
    const scan = await scanGitHubRepository(
      'https://github.com/sakshamgupta005/patchboard-tasks-api',
      { fetchFn: mockPatchboardFetch }
    );

    assert.equal(scan.commitSha, '4ddfe585adbccd57794efba49ca1102ff654382f');
    assert.ok(scan.checkRuns && scan.checkRuns.length > 0);
    for (const check of scan.checkRuns) {
      assert.equal(check.commitSha, '4ddfe585adbccd57794efba49ca1102ff654382f');
    }
  });
});
