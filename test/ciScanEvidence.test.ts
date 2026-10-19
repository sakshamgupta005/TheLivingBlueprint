import { describe, it } from 'node:test';
import assert from 'node:assert';
import { scanGitHubRepository } from '../src/domain/github/scanner.ts';
import { mapScanResultToHouse } from '../src/domain/github/architectureMapper.ts';
import {
  evaluateCheckRunsForVerification,
  fetchCommitCheckRuns,
} from '../src/domain/lifecycle/ciEvaluator.ts';
import type { GitHubCheckRun } from '../src/domain/lifecycle/types.ts';

describe('Real CI Evidence During Repository Scanning (T10)', () => {
  const commitSha = '4ddfe585adbccd57794efba49ca1102ff654382f';

  function createMockScannerFetch(checkRunsPayload: any, checkRunsStatus = 200) {
    return async (url: string | URL | Request) => {
      const u = url.toString();

      if (u.includes(`/repos/sample/repo/commits/${commitSha}/check-runs`) || u.includes('/repos/sample/repo/commits/main/check-runs')) {
        if (checkRunsStatus !== 200) {
          return new Response(JSON.stringify(checkRunsPayload), {
            status: checkRunsStatus,
            statusText: checkRunsStatus === 403 ? 'Forbidden' : 'Error',
          });
        }
        return new Response(JSON.stringify(checkRunsPayload), { status: 200 });
      }

      if (u.includes('/commits/main') || u.includes(`/commits/${commitSha}`)) {
        return new Response(
          JSON.stringify({
            sha: commitSha,
            commit: { message: 'Initial commit with failing test' },
          }),
          { status: 200 }
        );
      }

      if (u.includes('/git/trees/')) {
        return new Response(
          JSON.stringify({
            sha: 'tree-sha-root',
            tree: [
              { path: 'package.json', mode: '100644', type: 'blob', sha: 'blob1', size: 200, url: '' },
              { path: 'src/server.js', mode: '100644', type: 'blob', sha: 'blob2', size: 800, url: '' },
              { path: 'test/createTask.test.js', mode: '100644', type: 'blob', sha: 'blob3', size: 1200, url: '' },
              { path: 'test/server.test.js', mode: '100644', type: 'blob', sha: 'blob4', size: 1400, url: '' },
            ],
            truncated: false,
          }),
          { status: 200 }
        );
      }

      if (u.includes('/repos/sample/repo')) {
        return new Response(
          JSON.stringify({
            name: 'patchboard-tasks-api',
            full_name: 'sample/repo',
            default_branch: 'main',
            private: false,
          }),
          { status: 200 }
        );
      }

      // Raw file content
      if (u.includes('package.json')) {
        return new Response(JSON.stringify({ name: 'tasks-api', scripts: { test: 'node --test' } }), { status: 200 });
      }
      return new Response('// file content', { status: 200 });
    };
  }

  it('1. Matching failing test check sets room to BLOCKED with real check link', async () => {
    const checkPayload = {
      total_count: 1,
      check_runs: [
        {
          id: 117772098048,
          name: 'Run Unit and Integration Tests',
          status: 'completed',
          conclusion: 'failure',
          head_sha: commitSha,
          completed_at: '2026-10-18T19:47:14Z',
          html_url: 'https://github.com/sample/repo/actions/runs/39160329324/job/117772098048',
        },
      ],
    };

    const mockFetch = createMockScannerFetch(checkPayload);
    const scanResult = await scanGitHubRepository('https://github.com/sample/repo', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    assert.strictEqual(scanResult.success, true);
    assert.strictEqual(scanResult.commitSha, commitSha);
    assert.strictEqual(scanResult.checkRuns?.length, 1);
    assert.strictEqual(scanResult.checkRuns![0].conclusion, 'failure');
    assert.strictEqual(scanResult.checkRuns![0].isRelevantTestCheck, true);
    assert.strictEqual(scanResult.ciEvaluation?.outcome, 'failed');

    const house = mapScanResultToHouse(scanResult);
    const gatewayRoom = house.rooms.find((r) => r.id === 'room-tests' || r.layer === 'gateway');
    assert.ok(gatewayRoom);
    // Deterministic status engine must block the room
    assert.strictEqual(gatewayRoom.status, 'blocked');
    assert.strictEqual(gatewayRoom.metrics.ciStatus, 'failing');
    assert.strictEqual(gatewayRoom.metrics.ciUrl, 'https://github.com/sample/repo/actions/runs/39160329324/job/117772098048');
    assert.match(gatewayRoom.evidence, /Run Unit and Integration Tests/i);
  });

  it('2. Matching passing test check establishes VERIFIED room status', async () => {
    const checkPayload = {
      total_count: 1,
      check_runs: [
        {
          id: 200000000001,
          name: 'Run Unit and Integration Tests',
          status: 'completed',
          conclusion: 'success',
          head_sha: commitSha,
          completed_at: '2026-10-19T01:00:00Z',
          html_url: 'https://github.com/sample/repo/actions/runs/101/job/200000000001',
        },
      ],
    };

    const mockFetch = createMockScannerFetch(checkPayload);
    const scanResult = await scanGitHubRepository('https://github.com/sample/repo', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    assert.strictEqual(scanResult.ciEvaluation?.outcome, 'verified');
    const house = mapScanResultToHouse(scanResult);
    const gatewayRoom = house.rooms.find((r) => r.id === 'room-tests' || r.layer === 'gateway');
    assert.ok(gatewayRoom);
    assert.strictEqual(gatewayRoom.status, 'verified');
    assert.strictEqual(gatewayRoom.metrics.ciStatus, 'passing');
  });

  it('3. Pending/in-progress test check remains inconclusive without claiming verification', async () => {
    const checkPayload = {
      total_count: 1,
      check_runs: [
        {
          id: 300000000001,
          name: 'CI Unit Tests',
          status: 'in_progress',
          conclusion: null,
          head_sha: commitSha,
          html_url: 'https://github.com/sample/repo/actions/runs/102/job/300000000001',
        },
      ],
    };

    const mockFetch = createMockScannerFetch(checkPayload);
    const scanResult = await scanGitHubRepository('https://github.com/sample/repo', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    assert.strictEqual(scanResult.ciEvaluation?.outcome, 'inconclusive');
    const house = mapScanResultToHouse(scanResult);
    const gatewayRoom = house.rooms.find((r) => r.id === 'room-tests' || r.layer === 'gateway');
    assert.ok(gatewayRoom);
    // Not verified, not blocked
    assert.strictEqual(gatewayRoom.status, 'implemented');
    assert.strictEqual(gatewayRoom.metrics.ciStatus, 'pending');
  });

  it('4. Unrelated passing check (linter/deploy) does NOT verify application functionality', async () => {
    const checkPayload = {
      total_count: 1,
      check_runs: [
        {
          id: 400000000001,
          name: 'Lint and Code Style',
          status: 'completed',
          conclusion: 'success',
          head_sha: commitSha,
          completed_at: '2026-10-19T01:00:00Z',
          html_url: 'https://github.com/sample/repo/actions/runs/103/job/400000000001',
        },
      ],
    };

    const mockFetch = createMockScannerFetch(checkPayload);
    const scanResult = await scanGitHubRepository('https://github.com/sample/repo', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    assert.strictEqual(scanResult.ciEvaluation?.outcome, 'implemented_only');
    const house = mapScanResultToHouse(scanResult);
    const gatewayRoom = house.rooms.find((r) => r.id === 'room-tests' || r.layer === 'gateway');
    assert.ok(gatewayRoom);
    // Must remain implemented, NEVER verified by a linter
    assert.strictEqual(gatewayRoom.status, 'implemented');
    assert.strictEqual(gatewayRoom.metrics.ciStatus, 'not_run');
  });

  it('5. Check whose commit SHA does not match scanned revision is rejected', () => {
    const checks: GitHubCheckRun[] = [
      {
        id: 500000000001,
        name: 'Unit Tests',
        status: 'completed',
        conclusion: 'success',
        commitSha: 'mismatched-old-commit-sha',
        isRelevantTestCheck: true,
        relevanceReason: 'matches test pattern',
      },
    ];

    const evalResult = evaluateCheckRunsForVerification(
      checks,
      'req-gw-ci',
      commitSha,
      new Date().toISOString()
    );

    assert.strictEqual(evalResult.outcome, 'inconclusive');
    assert.strictEqual(evalResult.verificationEvidenceRecords.length, 0);
    assert.match(evalResult.outcomeReason, /does not match scanned revision/i);
  });

  it('6. Missing or inaccessible check-run data indicates unavailable CI without fabricating status', async () => {
    const checkPayload = {
      total_count: 0,
      check_runs: [],
    };

    const mockFetch = createMockScannerFetch(checkPayload);
    const scanResult = await scanGitHubRepository('https://github.com/sample/repo', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    assert.strictEqual(scanResult.checkRuns?.length, 0);
    assert.strictEqual(scanResult.ciEvaluation?.outcome, 'no_checks');
    const house = mapScanResultToHouse(scanResult);
    const gatewayRoom = house.rooms.find((r) => r.id === 'room-tests' || r.layer === 'gateway');
    assert.ok(gatewayRoom);
    assert.strictEqual(gatewayRoom.status, 'implemented');
    assert.strictEqual(gatewayRoom.metrics.ciStatus, 'unavailable');
  });

  it('7. Rate limiting on check-runs API records warning gracefully and preserves scan', async () => {
    const mockFetch = createMockScannerFetch({ message: 'API rate limit exceeded' }, 403);
    const scanResult = await scanGitHubRepository('https://github.com/sample/repo', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    assert.strictEqual(scanResult.success, true);
    assert.ok(scanResult.warnings.some((w) => /rate limit exceeded/i.test(w)));
    assert.strictEqual(scanResult.checkRuns?.length, 0);
    assert.strictEqual(scanResult.ciEvaluation?.outcome, 'no_checks');
  });

  it('8. Truthfully distinguishes detected test files from executed test cases', async () => {
    const checkPayload = {
      total_count: 1,
      check_runs: [
        {
          id: 800000000001,
          name: 'Run Unit and Integration Tests',
          status: 'completed',
          conclusion: 'failure',
          head_sha: commitSha,
          completed_at: '2026-10-18T19:47:14Z',
          html_url: 'https://github.com/sample/repo/actions/runs/39160329324/job/800000000001',
        },
      ],
    };

    const mockFetch = createMockScannerFetch(checkPayload);
    const scanResult = await scanGitHubRepository('https://github.com/sample/repo', {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const house = mapScanResultToHouse(scanResult);
    const gatewayRoom = house.rooms.find((r) => r.id === 'room-tests' || r.layer === 'gateway');
    assert.ok(gatewayRoom);

    // Number of test files detected is 2 (test/createTask.test.js and test/server.test.js)
    assert.strictEqual(gatewayRoom.metrics.testFilesCount, 2);
    // Must NOT invent test case pass/fail counts
    assert.strictEqual(gatewayRoom.metrics.testsPassed, undefined);
    assert.strictEqual(gatewayRoom.metrics.totalTests, undefined);
  });

  it('9. Network failure querying check-runs endpoint never produces successful evidence', async () => {
    const { checks, warnings } = await fetchCommitCheckRuns(
      'sample',
      'repo',
      commitSha,
      async () => {
        throw new Error('Connection refused');
      }
    );

    assert.strictEqual(checks.length, 0);
    assert.ok(warnings.some((w) => /check results unavailable/i.test(w)));

    const evalResult = evaluateCheckRunsForVerification(checks, 'req-gw-ci', commitSha, new Date().toISOString());
    assert.strictEqual(evalResult.outcome, 'no_checks');
    assert.strictEqual(evalResult.verificationEvidenceRecords.length, 0);
  });

  it('10. Fallback retrieves workflow run from actions/runs when check-runs API is empty', async () => {
    const mockFetch = async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.includes('/check-runs')) {
        return new Response(JSON.stringify({ total_count: 0, check_runs: [] }), { status: 200 });
      }
      if (u.includes('/actions/runs')) {
        return new Response(
          JSON.stringify({
            total_count: 1,
            workflow_runs: [
              {
                id: 998877,
                name: 'CI Workflow Tests',
                status: 'completed',
                conclusion: 'failure',
                html_url: 'https://github.com/sample/repo/actions/runs/998877',
                head_sha: commitSha,
                updated_at: '2026-10-18T20:00:00Z',
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    };

    const { checks, warnings } = await fetchCommitCheckRuns('sample', 'repo', commitSha, mockFetch as unknown as typeof fetch);
    assert.strictEqual(checks.length, 1);
    assert.strictEqual(checks[0].name, 'CI Workflow Tests');
    assert.strictEqual(checks[0].conclusion, 'failure');
    assert.strictEqual(checks[0].isRelevantTestCheck, true);
    assert.strictEqual(warnings.length, 0);
  });

  it('11. Repository with only unrelated checks and no test files does NOT fabricate an Automated Tests room', () => {
    const scanResult: GitHubScanResult = {
      success: true,
      owner: 'acme',
      repo: 'static-site',
      scannedAt: '2026-10-19T01:00:00Z',
      commitSha,
      totalFilesDiscovered: 2,
      inspectedFiles: [
        { path: 'src/index.html', sizeBytes: 200, category: 'source', contentExcerpt: '<html />' },
        { path: 'src/style.css', sizeBytes: 150, category: 'source', contentExcerpt: 'body {}' },
      ],
      discoveredFilePaths: ['src/index.html', 'src/style.css'],
      detectedTechnologies: ['HTML', 'CSS'],
      warnings: [],
      checkRuns: [
        {
          id: 7001,
          name: 'Deploy to Cloudflare Pages',
          status: 'completed',
          conclusion: 'success',
          commitSha,
          isRelevantTestCheck: false,
          relevanceReason: 'deployment task',
        },
      ],
    };

    const house = mapScanResultToHouse(scanResult);
    const roomIds = house.rooms.map((r) => r.id);
    // Must NOT fabricate a test room when no test files or relevant test checks exist
    assert.strictEqual(roomIds.includes('room-tests'), false);
    // CI check remains preserved at scanResult level for repository telemetry
    assert.strictEqual(scanResult.checkRuns.length, 1);
  });

  it('12. Module-specific check run associates CI evidence with that specific module', () => {
    const scanResult: GitHubScanResult = {
      success: true,
      owner: 'acme',
      repo: 'modular-app',
      scannedAt: '2026-10-19T01:00:00Z',
      commitSha,
      totalFilesDiscovered: 3,
      inspectedFiles: [
        { path: 'src/server.ts', sizeBytes: 500, category: 'source', contentExcerpt: 'export const server = {}' },
        { path: 'test/server.test.ts', sizeBytes: 300, category: 'test', contentExcerpt: 'test()' },
      ],
      discoveredFilePaths: ['src/server.ts', 'test/server.test.ts'],
      detectedTechnologies: ['TypeScript'],
      warnings: [],
      checkRuns: [
        {
          id: 8001,
          name: 'build:server',
          status: 'completed',
          conclusion: 'success',
          commitSha,
          isRelevantTestCheck: false,
          html_url: 'https://github.com/acme/modular-app/actions/runs/8001',
        },
      ],
    };

    const house = mapScanResultToHouse(scanResult);
    const serverRoom = house.rooms.find((r) => r.id === 'room-server');
    assert.ok(serverRoom);
    assert.strictEqual(serverRoom.metrics.ciStatus, 'passing');
    assert.strictEqual(serverRoom.metrics.ciCheckName, 'build:server');
  });

  it('13. Switching commit or repository clears previous CI blocker evidence and re-evaluates', () => {
    const failingScan: GitHubScanResult = {
      success: true,
      owner: 'sakshamgupta005',
      repo: 'patchboard-tasks-api',
      scannedAt: '2026-10-19T01:00:00Z',
      commitSha: 'commit-failing-1',
      totalFilesDiscovered: 2,
      inspectedFiles: [
        { path: 'src/index.js', sizeBytes: 200, category: 'source', contentExcerpt: '' },
        { path: 'test/index.test.js', sizeBytes: 200, category: 'test', contentExcerpt: '' },
      ],
      discoveredFilePaths: ['src/index.js', 'test/index.test.js'],
      detectedTechnologies: ['Node.js'],
      warnings: [],
      checkRuns: [
        {
          id: 9001,
          name: 'Run Tests',
          status: 'completed',
          conclusion: 'failure',
          commitSha: 'commit-failing-1',
          isRelevantTestCheck: true,
        },
      ],
    };

    const house1 = mapScanResultToHouse(failingScan);
    const testRoom1 = house1.rooms.find((r) => r.id === 'room-tests')!;
    assert.strictEqual(testRoom1.status, 'blocked');
    assert.strictEqual(testRoom1.metrics.ciStatus, 'failing');

    // Rescan a fixed commit with passing check
    const fixedScan: GitHubScanResult = {
      ...failingScan,
      commitSha: 'commit-fixed-2',
      checkRuns: [
        {
          id: 9002,
          name: 'Run Tests',
          status: 'completed',
          conclusion: 'success',
          commitSha: 'commit-fixed-2',
          isRelevantTestCheck: true,
        },
      ],
    };

    const house2 = mapScanResultToHouse(fixedScan);
    const testRoom2 = house2.rooms.find((r) => r.id === 'room-tests')!;
    assert.strictEqual(testRoom2.status, 'verified');
    assert.strictEqual(testRoom2.metrics.ciStatus, 'passing');
  });
});
