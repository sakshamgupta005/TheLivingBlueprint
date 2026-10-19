import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateCommitReference } from '../src/domain/lifecycle/urlValidator.ts';
import { classifyCheckRunRelevance, evaluateCheckRunsForVerification } from '../src/domain/lifecycle/ciEvaluator.ts';
import { reinspectForFix } from '../src/domain/lifecycle/reinspectionEngine.ts';
import type { GitHubCheckRun, UserFixReport } from '../src/domain/lifecycle/types.ts';
import type { EvidenceRecord, Requirement, RoomModule } from '../src/domain/types.ts';
import { deriveRoomStatus } from '../src/domain/statusEngine.ts';

describe('Fix Reporting, Repository Re-Inspection & Verification Lifecycle', () => {
  const activeOwner = 'octocat';
  const activeRepo = 'Spoon-Knife';
  const defaultBranch = 'main';
  const baselineSha = '1111111111111111111111111111111111111111';

  const reqAuth: Requirement = {
    id: 'req-auth',
    title: 'Authentication & Session Integrity',
  };

  const sampleRoom: RoomModule = {
    id: 'room-auth',
    name: 'Authentication Module',
    description: 'Handles tokens and session',
    layer: 'service',
    requirements: [reqAuth],
    evidenceHistory: [],
  };

  describe('Commit and PR Reference Validation', () => {
    it('accepts direct commit SHA within active repo', () => {
      const res = validateCommitReference('a1b2c3d4e5f6789012345678901234567890abcd', activeOwner, activeRepo);
      assert.strictEqual(res.valid, true);
      if (res.valid) {
        assert.strictEqual(res.refType, 'commit_sha');
        assert.strictEqual(res.resolvedRef, 'a1b2c3d4e5f6789012345678901234567890abcd');
      }
    });

    it('accepts short commit SHA (7+ hex chars)', () => {
      const res = validateCommitReference('a1b2c3d', activeOwner, activeRepo);
      assert.strictEqual(res.valid, true);
      if (res.valid) {
        assert.strictEqual(res.refType, 'commit_sha');
        assert.strictEqual(res.resolvedRef, 'a1b2c3d');
      }
    });

    it('accepts valid GitHub commit URL matching active repository', () => {
      const url = `https://github.com/${activeOwner}/${activeRepo}/commit/a1b2c3d4e5f6789012345678901234567890abcd`;
      const res = validateCommitReference(url, activeOwner, activeRepo);
      assert.strictEqual(res.valid, true);
      if (res.valid) {
        assert.strictEqual(res.refType, 'commit_url');
        assert.strictEqual(res.resolvedRef, 'a1b2c3d4e5f6789012345678901234567890abcd');
      }
    });

    it('accepts valid GitHub PR URL matching active repository', () => {
      const url = `https://github.com/${activeOwner}/${activeRepo}/pull/42`;
      const res = validateCommitReference(url, activeOwner, activeRepo);
      assert.strictEqual(res.valid, true);
      if (res.valid) {
        assert.strictEqual(res.refType, 'pull_request_url');
        assert.strictEqual(res.pullNumber, 42);
      }
    });

    it('rejects mismatched repository identities (e.g. evil-org/malicious-repo)', () => {
      const url = 'https://github.com/evil-org/malicious-repo/commit/a1b2c3d4e5f6789012345678901234567890abcd';
      const res = validateCommitReference(url, activeOwner, activeRepo);
      assert.strictEqual(res.valid, false);
      if (!res.valid) {
        assert.match(res.error, /Repository mismatch/i);
      }
    });

    it('rejects unsupported domains (e.g. gitlab.com)', () => {
      const url = `https://gitlab.com/${activeOwner}/${activeRepo}/commit/a1b2c3d4e5f6789012345678901234567890abcd`;
      const res = validateCommitReference(url, activeOwner, activeRepo);
      assert.strictEqual(res.valid, false);
      if (!res.valid) {
        assert.match(res.error, /Unsupported host/i);
      }
    });

    it('rejects malformed inputs and empty strings', () => {
      assert.strictEqual(validateCommitReference('', activeOwner, activeRepo).valid, false);
      assert.strictEqual(validateCommitReference('not-a-valid-sha-or-url!', activeOwner, activeRepo).valid, false);
    });
  });

  describe('CI Check Run Classification & Evidence Minting', () => {
    it('classifies automated test suites as relevant test checks', () => {
      const testNames = ['test', 'unit-tests', 'CI / run-tests', 'jest', 'vitest', 'integration_tests'];
      for (const name of testNames) {
        const cls = classifyCheckRunRelevance(name);
        assert.strictEqual(cls.isRelevantTestCheck, true, `Expected "${name}" to be relevant`);
      }
    });

    it('classifies formatting, docs, and deployments as unrelated checks', () => {
      const unrelatedNames = ['lint', 'eslint', 'prettier', 'deploy/preview', 'github-pages', 'license-check'];
      for (const name of unrelatedNames) {
        const cls = classifyCheckRunRelevance(name);
        assert.strictEqual(cls.isRelevantTestCheck, false, `Expected "${name}" to be unrelated`);
      }
    });

    it('unrelated successful checks do NOT verify requirement (produces implemented_only)', () => {
      const checks: GitHubCheckRun[] = [
        {
          id: 1,
          name: 'linter',
          status: 'completed',
          conclusion: 'success',
          isRelevantTestCheck: false,
          relevanceReason: 'Linter task',
        },
        {
          id: 2,
          name: 'deploy/preview',
          status: 'completed',
          conclusion: 'success',
          isRelevantTestCheck: false,
          relevanceReason: 'Deployment preview',
        },
      ];

      const res = evaluateCheckRunsForVerification(checks, 'req-auth', 'sha123', new Date().toISOString());
      assert.strictEqual(res.outcome, 'implemented_only');
      assert.strictEqual(res.verificationEvidenceRecords.length, 0);
      assert.match(res.outcomeReason, /unrelated green check does not prove functional correctness/i);
    });

    it('mints passing verification evidence when relevant test check succeeds', () => {
      const checks: GitHubCheckRun[] = [
        {
          id: 1,
          name: 'npm test',
          status: 'completed',
          conclusion: 'success',
          isRelevantTestCheck: true,
          relevanceReason: 'Test suite',
        },
      ];

      const res = evaluateCheckRunsForVerification(checks, 'req-auth', 'sha123', new Date().toISOString());
      assert.strictEqual(res.outcome, 'verified');
      assert.strictEqual(res.verificationEvidenceRecords.length, 1);
      assert.strictEqual(res.verificationEvidenceRecords[0].verificationResult?.status, 'passed');
    });

    it('mints failing blocker evidence when relevant test check fails', () => {
      const checks: GitHubCheckRun[] = [
        {
          id: 1,
          name: 'unit-tests',
          status: 'completed',
          conclusion: 'failure',
          isRelevantTestCheck: true,
          relevanceReason: 'Unit test suite',
        },
      ];

      const res = evaluateCheckRunsForVerification(checks, 'req-auth', 'sha123', new Date().toISOString());
      assert.strictEqual(res.outcome, 'failed');
      assert.strictEqual(res.verificationEvidenceRecords.length, 1);
      assert.strictEqual(res.verificationEvidenceRecords[0].isBlocker, true);
      assert.strictEqual(res.verificationEvidenceRecords[0].verificationResult?.status, 'failed');
    });

    it('marks pending/in-progress checks as inconclusive without minting verification', () => {
      const checks: GitHubCheckRun[] = [
        {
          id: 1,
          name: 'ci/test',
          status: 'in_progress',
          conclusion: null,
          isRelevantTestCheck: true,
          relevanceReason: 'Running CI tests',
        },
      ];

      const res = evaluateCheckRunsForVerification(checks, 'req-auth', 'sha123', new Date().toISOString());
      assert.strictEqual(res.outcome, 'inconclusive');
      assert.strictEqual(res.verificationEvidenceRecords.length, 0);
      assert.match(res.outcomeReason, /queued/i);
    });
  });

  describe('Re-Inspection Lifecycle Engine', () => {
    it('detects when branch has not changed (same commit as baseline)', async () => {
      const report: UserFixReport = {
        summary: 'Fixed JWT secret handling',
        commitRef: baselineSha,
        roomId: sampleRoom.id,
        roomName: sampleRoom.name,
      };

      const mockFetch: typeof fetch = async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes('/commits/')) {
          return new Response(
            JSON.stringify({
              sha: baselineSha,
              commit: { message: 'Initial commit', author: { name: 'Dev', date: '2026-10-18T12:00:00Z' } },
              files: [{ filename: 'src/auth/jwt.ts', status: 'modified', additions: 5, deletions: 1, patch: '@@ -1 +1 @@' }],
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes('/check-runs')) {
          return new Response(JSON.stringify({ total_count: 0, check_runs: [] }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      };

      const result = await reinspectForFix(
        report,
        sampleRoom,
        activeOwner,
        activeRepo,
        defaultBranch,
        baselineSha,
        { fetchFn: mockFetch }
      );

      assert.strictEqual(result.isNewRevision, false);
      assert.ok(result.warnings.some((w) => w.includes('Branch / commit has not changed')));
    });

    it('records inspected changed files and flags uninspected reported files', async () => {
      const newSha = '2222222222222222222222222222222222222222';
      const report: UserFixReport = {
        summary: 'Added token validation',
        commitRef: newSha,
        changedFiles: ['src/auth/jwt.ts', 'src/nonexistent/missing.ts'],
        roomId: sampleRoom.id,
        roomName: sampleRoom.name,
      };

      const mockFetch: typeof fetch = async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes('/commits/')) {
          return new Response(
            JSON.stringify({
              sha: newSha,
              commit: { message: 'Fix auth', author: { name: 'Dev' } },
              files: [{ filename: 'src/auth/jwt.ts', status: 'modified', additions: 10, deletions: 2, patch: '+jwt.verify' }],
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes('/check-runs')) {
          return new Response(JSON.stringify({ total_count: 0, check_runs: [] }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      };

      const result = await reinspectForFix(
        report,
        sampleRoom,
        activeOwner,
        activeRepo,
        defaultBranch,
        baselineSha,
        { fetchFn: mockFetch }
      );

      assert.strictEqual(result.isNewRevision, true);
      assert.strictEqual(result.inspectedChangedFiles.length, 1);
      assert.strictEqual(result.inspectedChangedFiles[0].path, 'src/auth/jwt.ts');
      assert.deepStrictEqual(result.uninspectedReportedFiles, ['src/nonexistent/missing.ts']);
      assert.ok(result.warnings.some((w) => w.includes('src/nonexistent/missing.ts')));
    });

    it('stores user test output as user_confirmation, never as independently verified test_result', async () => {
      const newSha = '3333333333333333333333333333333333333333';
      const report: UserFixReport = {
        summary: 'Fixed auth and tests pass locally',
        commitRef: newSha,
        testOutput: 'PASS test/auth.test.ts (12 tests passed)',
        roomId: sampleRoom.id,
        roomName: sampleRoom.name,
      };

      const mockFetch: typeof fetch = async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes('/commits/')) {
          return new Response(
            JSON.stringify({
              sha: newSha,
              commit: { message: 'Fix auth', author: { name: 'Dev' } },
              files: [{ filename: 'src/auth/jwt.ts', status: 'modified', additions: 5, deletions: 1 }],
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes('/check-runs')) {
          return new Response(JSON.stringify({ total_count: 0, check_runs: [] }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      };

      const result = await reinspectForFix(
        report,
        sampleRoom,
        activeOwner,
        activeRepo,
        defaultBranch,
        baselineSha,
        { fetchFn: mockFetch }
      );

      const userEv = result.newEvidenceRecords.find((e) => e.sourceType === 'user_confirmation');
      assert.ok(userEv, 'Must create user_confirmation record');
      assert.match(userEv.description, /Unverified claim from coding agent/i);

      // Verify status: Since only code changes and user claims exist without CI, status MUST be implemented, NOT verified!
      assert.strictEqual(result.resultingStatusEvaluation?.status, 'implemented');
      assert.notStrictEqual(result.resultingStatusEvaluation?.status, 'verified');
    });

    it('supersedes previous failing test when a new relevant CI check passes', async () => {
      const failingEvidence: EvidenceRecord = {
        id: 'ev-prior-fail',
        sourceType: 'test_result',
        description: 'Prior test failed on JWT expiration',
        timestamp: '2026-10-18T10:00:00Z',
        targetRequirementId: 'req-auth',
        isBlocker: true,
        verificationResult: { status: 'failed', testName: 'jwtExpirationTest' },
      };

      const roomWithFailure: RoomModule = {
        ...sampleRoom,
        evidenceHistory: [failingEvidence],
      };

      // Room is initially blocked
      assert.strictEqual(deriveRoomStatus(roomWithFailure).status, 'blocked');

      const newSha = '4444444444444444444444444444444444444444';
      const report: UserFixReport = {
        summary: 'Fixed expiration math',
        commitRef: newSha,
        roomId: roomWithFailure.id,
        roomName: roomWithFailure.name,
      };

      const mockFetch: typeof fetch = async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes('/check-runs')) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              check_runs: [
                {
                  id: 101,
                  name: 'automated-tests',
                  status: 'completed',
                  conclusion: 'success',
                  completed_at: '2026-10-18T11:00:00Z',
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes('/commits/')) {
          return new Response(
            JSON.stringify({
              sha: newSha,
              commit: { message: 'Fix expiration math' },
              files: [{ filename: 'src/auth/jwt.ts', status: 'modified', additions: 2, deletions: 2, patch: 'fix' }],
            }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      };

      const result = await reinspectForFix(
        report,
        roomWithFailure,
        activeOwner,
        activeRepo,
        defaultBranch,
        baselineSha,
        { fetchFn: mockFetch }
      );

      assert.strictEqual(result.verificationOutcome, 'verified');
      assert.strictEqual(result.resultingStatusEvaluation?.status, 'verified');
    });

    it('does NOT supersede failing test if the new CI run also fails', async () => {
      const failingEvidence: EvidenceRecord = {
        id: 'ev-prior-fail-2',
        sourceType: 'test_result',
        description: 'Prior test failed',
        timestamp: '2026-10-18T10:00:00Z',
        targetRequirementId: 'req-auth',
        isBlocker: true,
        verificationResult: { status: 'failed' },
      };

      const roomWithFailure: RoomModule = {
        ...sampleRoom,
        evidenceHistory: [failingEvidence],
      };

      const newSha = '5555555555555555555555555555555555555555';
      const report: UserFixReport = {
        summary: 'Attempted fix but still broken',
        commitRef: newSha,
        roomId: roomWithFailure.id,
        roomName: roomWithFailure.name,
      };

      const mockFetch: typeof fetch = async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes('/check-runs')) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              check_runs: [{ id: 102, name: 'npm test', status: 'completed', conclusion: 'failure' }],
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes('/commits/')) {
          return new Response(
            JSON.stringify({
              sha: newSha,
              commit: { message: 'Attempted fix' },
              files: [{ filename: 'src/auth/jwt.ts', status: 'modified', additions: 1, deletions: 1 }],
            }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      };

      const result = await reinspectForFix(
        report,
        roomWithFailure,
        activeOwner,
        activeRepo,
        defaultBranch,
        baselineSha,
        { fetchFn: mockFetch }
      );

      assert.strictEqual(result.verificationOutcome, 'failed');
      assert.strictEqual(result.resultingStatusEvaluation?.status, 'blocked');
    });

    it('handles GitHub 404 (commit not found) and 403 (rate limit) gracefully without crashing', async () => {
      const report: UserFixReport = {
        summary: 'Fix non-existent commit',
        commitRef: '9999999999999999999999999999999999999999',
        roomId: sampleRoom.id,
        roomName: sampleRoom.name,
      };

      const mockFetch404: typeof fetch = async () => new Response('Not Found', { status: 404 });
      const result404 = await reinspectForFix(
        report,
        sampleRoom,
        activeOwner,
        activeRepo,
        defaultBranch,
        baselineSha,
        { fetchFn: mockFetch404 }
      );
      assert.ok(result404.error?.includes('was not found'));

      const mockFetch403: typeof fetch = async () => new Response('Rate limit', { status: 403 });
      const result403 = await reinspectForFix(
        report,
        sampleRoom,
        activeOwner,
        activeRepo,
        defaultBranch,
        baselineSha,
        { fetchFn: mockFetch403 }
      );
      assert.ok(result403.error?.includes('rate limit exceeded'));
    });

    it('preserves read-only operation and strictly makes no mutations or write requests', async () => {
      const report: UserFixReport = {
        summary: 'Read-only check',
        commitRef: '6666666666666666666666666666666666666666',
        roomId: sampleRoom.id,
        roomName: sampleRoom.name,
      };

      const methodsUsed: string[] = [];
      const mockFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        methodsUsed.push(init?.method || 'GET');
        return new Response(
          JSON.stringify({
            sha: '6666666666666666666666666666666666666666',
            commit: { message: 'Read only test' },
            files: [],
          }),
          { status: 200 }
        );
      };

      await reinspectForFix(
        report,
        sampleRoom,
        activeOwner,
        activeRepo,
        defaultBranch,
        baselineSha,
        { fetchFn: mockFetch }
      );

      // Verify every HTTP request was strictly read-only GET
      assert.ok(methodsUsed.length > 0);
      for (const m of methodsUsed) {
        assert.strictEqual(m, 'GET');
      }
    });
  });
});
