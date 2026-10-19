import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  scanGitHubRepository,
  clearScannerCache,
  getScannerCacheStats,
  redactSecrets,
} from '../src/domain/github/scanner.ts';
import type { GitTreeEntry } from '../src/domain/github/types.ts';

describe('T23: Advanced GitHub Repository Scanning & Truth Assurance', () => {
  beforeEach(() => {
    clearScannerCache();
  });

  describe('1. Truncated Trees & Subtree Traversal', () => {
    it('detects truncated tree, traverses key subtrees, and marks status as partial', async () => {
      const mockFetch = async (input: string | URL | Request) => {
        const url = input.toString();

        if (url.includes('/repos/org/giant-repo/git/trees/src-sha')) {
          // Subtree response for 'src'
          return new Response(
            JSON.stringify({
              sha: 'src-sha',
              tree: [
                { path: 'index.ts', mode: '100644', type: 'blob', sha: 'b1', size: 400 },
                { path: 'controller.ts', mode: '100644', type: 'blob', sha: 'b2', size: 600 },
              ],
              truncated: false,
            }),
            { status: 200 }
          );
        }

        if (url.includes('/repos/org/giant-repo/git/trees/')) {
          // Root tree with truncation
          return new Response(
            JSON.stringify({
              sha: 'root-tree-sha',
              tree: [
                { path: 'package.json', mode: '100644', type: 'blob', sha: 'b0', size: 200 },
                { path: 'src', mode: '040000', type: 'tree', sha: 'src-sha' },
              ],
              truncated: true,
            }),
            { status: 200 }
          );
        }

        if (url.includes('/repos/org/giant-repo/commits/')) {
          return new Response(
            JSON.stringify({ sha: 'commit-sha-giant', commit: { message: 'Large repo' } }),
            { status: 200 }
          );
        }

        if (url.includes('/repos/org/giant-repo')) {
          return new Response(
            JSON.stringify({
              name: 'giant-repo',
              full_name: 'org/giant-repo',
              default_branch: 'main',
              private: false,
            }),
            { status: 200 }
          );
        }

        // Raw files
        return new Response('export const ok = true;', { status: 200 });
      };

      const result = await scanGitHubRepository('https://github.com/org/giant-repo', {
        fetchFn: mockFetch as unknown as typeof fetch,
        useCache: false,
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.treeTruncated, true);
      assert.strictEqual(result.status, 'partial', 'Truncated tree must never be reported as completed');
      assert.ok(result.subtreesFetched?.includes('src'), 'Should traverse src directory tree node');
      assert.ok(result.discoveredFilePaths?.includes('src/index.ts'));
      assert.ok(result.discoveredFilePaths?.includes('src/controller.ts'));
      assert.strictEqual(result.coverageImprovementPossible, true);
      assert.match(result.coverageImprovementReason!, /truncated/i);
    });
  });

  describe('2. Strict Scan Budgets (File and Byte Limits)', () => {
    it('enforces total scan byte budget and records scan_byte_budget_exceeded', async () => {
      const mockTree: GitTreeEntry[] = [
        { path: 'package.json', mode: '100644', type: 'blob', sha: '1', size: 500, url: '' },
        { path: 'src/main.ts', mode: '100644', type: 'blob', sha: '2', size: 800, url: '' },
        { path: 'src/heavy1.ts', mode: '100644', type: 'blob', sha: '3', size: 3000, url: '' },
        { path: 'src/heavy2.ts', mode: '100644', type: 'blob', sha: '4', size: 3000, url: '' },
        { path: 'src/heavy3.ts', mode: '100644', type: 'blob', sha: '5', size: 3000, url: '' },
      ];

      const mockFetch = async (input: string | URL | Request) => {
        const url = input.toString();
        if (url.includes('/git/trees/')) {
          return new Response(JSON.stringify({ sha: 't', tree: mockTree, truncated: false }), { status: 200 });
        }
        if (url.includes('/repos/org/budget-repo')) {
          return new Response(
            JSON.stringify({ name: 'budget-repo', full_name: 'org/budget-repo', default_branch: 'main', private: false }),
            { status: 200 }
          );
        }
        // Generates 3000 chars of source content
        return new Response('A'.repeat(3000), { status: 200 });
      };

      // Strict budget: max 5KB total content
      const result = await scanGitHubRepository('https://github.com/org/budget-repo', {
        fetchFn: mockFetch as unknown as typeof fetch,
        totalScanBudgetBytes: 5000,
        maxFilesToInspect: 10,
        useCache: false,
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'partial');
      assert.ok(result.totalContentBytesInspected! <= 6500);
      assert.ok(result.skippedFiles.some((s) => s.reason === 'scan_byte_budget_exceeded'));
      assert.strictEqual(result.coverageImprovementPossible, true);
      assert.match(result.coverageImprovementReason!, /byte budget limit/i);
    });

    it('clamps maxFilesToInspect at 40 max to prevent unbounded requests', async () => {
      const entries: GitTreeEntry[] = Array.from({ length: 60 }, (_, i) => ({
        path: `src/file_${i}.ts`,
        mode: '100644',
        type: 'blob',
        sha: `sha_${i}`,
        size: 100,
        url: '',
      }));

      const mockFetch = async (input: string | URL | Request) => {
        const url = input.toString();
        if (url.includes('/git/trees/')) {
          return new Response(JSON.stringify({ sha: 't', tree: entries, truncated: false }), { status: 200 });
        }
        if (url.includes('/repos/org/large-dir')) {
          return new Response(
            JSON.stringify({ name: 'large-dir', full_name: 'org/large-dir', default_branch: 'main', private: false }),
            { status: 200 }
          );
        }
        return new Response('export const v = 1;', { status: 200 });
      };

      const result = await scanGitHubRepository('https://github.com/org/large-dir', {
        fetchFn: mockFetch as unknown as typeof fetch,
        maxFilesToInspect: 100, // Requesting 100 files
        useCache: false,
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.scanFileBudget, 40, 'Must clamp maxFilesToInspect at 40');
      assert.strictEqual(result.inspectedFiles.length, 40);
      assert.strictEqual(result.skippedFiles.filter((s) => s.reason === 'scan_file_budget_exceeded').length, 20);
    });
  });

  describe('3. Missing Files & Content Fetch Errors', () => {
    it('handles 404/500 content errors cleanly and marks status as partial', async () => {
      const mockFetch = async (input: string | URL | Request) => {
        const url = input.toString();
        if (url.includes('/git/trees/')) {
          return new Response(
            JSON.stringify({
              sha: 't',
              tree: [
                { path: 'package.json', mode: '100644', type: 'blob', sha: '1', size: 100 },
                { path: 'src/missing.ts', mode: '100644', type: 'blob', sha: '2', size: 200 },
              ],
              truncated: false,
            }),
            { status: 200 }
          );
        }
        if (url.includes('/repos/org/missing-repo')) {
          return new Response(
            JSON.stringify({ name: 'missing-repo', full_name: 'org/missing-repo', default_branch: 'main', private: false }),
            { status: 200 }
          );
        }
        if (url.includes('missing.ts')) {
          return new Response('Not Found', { status: 404, statusText: 'Not Found' });
        }
        return new Response('{}', { status: 200 });
      };

      const result = await scanGitHubRepository('https://github.com/org/missing-repo', {
        fetchFn: mockFetch as unknown as typeof fetch,
        useCache: false,
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'partial');
      assert.ok(result.skippedFiles.some((s) => s.path === 'src/missing.ts' && s.reason === 'content_fetch_failed'));
      assert.ok(result.warnings.some((w) => /missing\.ts.*could not be inspected/i.test(w)));
    });
  });

  describe('4. API Throttling (403 and 429)', () => {
    it('handles 429 Too Many Requests cleanly with retry-after header', async () => {
      const mockFetch = async () => {
        return new Response(JSON.stringify({ message: 'Too Many Requests' }), {
          status: 429,
          statusText: 'Too Many Requests',
          headers: new Headers({
            'retry-after': '120',
          }),
        });
      };

      const result = await scanGitHubRepository('https://github.com/org/rate-limited', {
        fetchFn: mockFetch as unknown as typeof fetch,
        useCache: false,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'failed');
      assert.match(result.error!, /rate limit exceeded/i);
      assert.match(result.error!, /Quota resets/i);
    });
  });

  describe('5. Timeout Handling', () => {
    it('aborts cleanly on request timeout and returns descriptive error', async () => {
      const hangingFetch = async (_input: string | URL | Request, init?: RequestInit) => {
        return new Promise<Response>((_, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              reject(new Error('The operation was aborted due to timeout'));
            });
          }
        });
      };

      const result = await scanGitHubRepository('https://github.com/org/hanging-repo', {
        fetchFn: hangingFetch as unknown as typeof fetch,
        timeoutMs: 50,
        useCache: false,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'failed');
      assert.match(result.error!, /aborted due to timeout/i);
    });
  });

  describe('6. Immutable Commit SHA Caching', () => {
    it('returns cached results on identical commit rescan without re-fetching tree or files', async () => {
      let treeCalls = 0;
      let rawFileCalls = 0;
      const commitSha = 'deadbeef1234567890abcdef1234567890abcdef';

      const mockFetch = async (input: string | URL | Request) => {
        const url = input.toString();
        if (url.includes('/git/trees/')) {
          treeCalls++;
          return new Response(
            JSON.stringify({
              sha: 't',
              tree: [{ path: 'package.json', mode: '100644', type: 'blob', sha: 'b1', size: 100 }],
              truncated: false,
            }),
            { status: 200 }
          );
        }
        if (url.includes('/commits/main') || url.includes(`/commits/${commitSha}`)) {
          return new Response(JSON.stringify({ sha: commitSha, commit: { message: 'Cached commit' } }), {
            status: 200,
          });
        }
        if (url.includes('/check-runs')) {
          return new Response(JSON.stringify({ total_count: 0, check_runs: [] }), { status: 200 });
        }
        if (url.includes('/repos/org/cached-repo')) {
          return new Response(
            JSON.stringify({ name: 'cached-repo', full_name: 'org/cached-repo', default_branch: 'main', private: false }),
            { status: 200 }
          );
        }
        if (url.includes('raw.githubusercontent.com') || url.includes('/package.json')) {
          rawFileCalls++;
          return new Response('{"name": "cached"}', { status: 200 });
        }
        return new Response('{}', { status: 200 });
      };

      // 1. Initial scan: populates cache
      const firstResult = await scanGitHubRepository('https://github.com/org/cached-repo', {
        fetchFn: mockFetch as unknown as typeof fetch,
        useCache: true,
      });
      assert.strictEqual(firstResult.success, true);
      assert.strictEqual(firstResult.cached, false);
      assert.strictEqual(treeCalls, 1);
      assert.strictEqual(rawFileCalls, 1);

      // 2. Second scan: served from cache
      const secondResult = await scanGitHubRepository('https://github.com/org/cached-repo', {
        fetchFn: mockFetch as unknown as typeof fetch,
        useCache: true,
      });
      assert.strictEqual(secondResult.success, true);
      assert.strictEqual(secondResult.cached, true);
      assert.strictEqual(secondResult.commitSha, commitSha);
      assert.strictEqual(secondResult.inspectedFiles.length, 1);
      assert.strictEqual(getScannerCacheStats().hits, 1);

      // Verify tree and raw file requests were completely skipped on rescan
      assert.strictEqual(treeCalls, 1, 'Tree endpoint should not be re-queried on commit cache hit');
      assert.strictEqual(rawFileCalls, 1, 'Raw file content should not be re-downloaded on commit cache hit');
    });
  });

  describe('7. Secret Redaction & Token Handling', () => {
    it('uses optional token in headers while strictly redacting it from errors and warnings', async () => {
      const secretToken = 'ghp_secretTokenVal1234567890ABCDEF1234567890';
      let capturedAuthHeader: string | null = null;

      const mockFetch = async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        capturedAuthHeader = headers?.['Authorization'] || null;
        // Simulate an error message containing the token
        throw new Error(`Upstream error with token ${secretToken} in response`);
      };

      const result = await scanGitHubRepository('https://github.com/org/secret-repo', {
        fetchFn: mockFetch as unknown as typeof fetch,
        githubToken: secretToken,
        useCache: false,
      });

      // Token was sent in headers
      assert.strictEqual(capturedAuthHeader, `Bearer ${secretToken}`);

      // Token MUST NOT appear anywhere in the result error or warnings!
      assert.strictEqual(result.success, false);
      assert.ok(!result.error!.includes(secretToken), 'Token must be redacted from error message');
      assert.ok(result.error!.includes('[REDACTED_GITHUB_TOKEN]'));

      // Test utility redaction directly
      assert.strictEqual(
        redactSecrets(`Error: ${secretToken} leaked!`, secretToken),
        'Error: [REDACTED_GITHUB_TOKEN] leaked!'
      );
    });
  });
});
