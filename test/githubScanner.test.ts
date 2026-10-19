import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateGitHubUrl } from '../src/domain/github/url.ts';
import { categorizeFile, isFileIgnored, prioritizeFilesForInspection } from '../src/domain/github/fileFilter.ts';
import { scanGitHubRepository } from '../src/domain/github/scanner.ts';
import { mapScanResultToHouse } from '../src/domain/github/architectureMapper.ts';
import type { GitTreeEntry } from '../src/domain/github/types.ts';

describe('GitHub Ingestion Module', () => {
  describe('URL Validation', () => {
    it('accepts standard https://github.com/owner/repo', () => {
      const res = validateGitHubUrl('https://github.com/facebook/react');
      assert.strictEqual(res.valid, true);
      if (res.valid) {
        assert.strictEqual(res.owner, 'facebook');
        assert.strictEqual(res.repo, 'react');
        assert.strictEqual(res.canonicalUrl, 'https://github.com/facebook/react');
      }
    });

    it('accepts URL with trailing slash and .git suffix', () => {
      const res = validateGitHubUrl('https://github.com/torvalds/linux.git/');
      assert.strictEqual(res.valid, true);
      if (res.valid) {
        assert.strictEqual(res.owner, 'torvalds');
        assert.strictEqual(res.repo, 'linux');
      }
    });

    it('accepts input without scheme: github.com/owner/repo', () => {
      const res = validateGitHubUrl('github.com/owner/my-cool-app');
      assert.strictEqual(res.valid, true);
      if (res.valid) {
        assert.strictEqual(res.owner, 'owner');
        assert.strictEqual(res.repo, 'my-cool-app');
      }
    });

    it('rejects unsupported domains (e.g. gitlab or bitbucket)', () => {
      const res = validateGitHubUrl('https://gitlab.com/owner/repo');
      assert.strictEqual(res.valid, false);
      if (!res.valid) {
        assert.match(res.error, /Only public GitHub repositories/i);
      }
    });

    it('rejects malformed and empty URLs', () => {
      assert.strictEqual(validateGitHubUrl('').valid, false);
      assert.strictEqual(validateGitHubUrl('   ').valid, false);
      assert.strictEqual(validateGitHubUrl('https://github.com/').valid, false);
      assert.strictEqual(validateGitHubUrl('https://github.com/owner').valid, false);
      assert.strictEqual(validateGitHubUrl('not a url').valid, false);
    });
  });

  describe('File Filtering and Prioritisation', () => {
    it('ignores lockfiles, binaries, and build directories', () => {
      assert.strictEqual(isFileIgnored('package-lock.json').ignored, true);
      assert.strictEqual(isFileIgnored('pnpm-lock.yaml').ignored, true);
      assert.strictEqual(isFileIgnored('assets/hero.png').ignored, true);
      assert.strictEqual(isFileIgnored('dist/bundle.js').ignored, true);
      assert.strictEqual(isFileIgnored('node_modules/express/index.js').ignored, true);
      assert.strictEqual(isFileIgnored('src/App.tsx').ignored, false);
    });

    it('categorizes manifests, readme, tests, configs, and source', () => {
      assert.strictEqual(categorizeFile('package.json'), 'manifest');
      assert.strictEqual(categorizeFile('Cargo.toml'), 'manifest');
      assert.strictEqual(categorizeFile('README.md'), 'readme');
      assert.strictEqual(categorizeFile('src/auth.test.ts'), 'test');
      assert.strictEqual(categorizeFile('Dockerfile'), 'config');
      assert.strictEqual(categorizeFile('src/index.ts'), 'source');
    });

    it('prioritizes architectural files up to maxFiles budget', () => {
      const tree: GitTreeEntry[] = [
        { path: 'package.json', mode: '100644', type: 'blob', sha: '1', size: 500, url: '' },
        { path: 'README.md', mode: '100644', type: 'blob', sha: '2', size: 1200, url: '' },
        { path: 'Dockerfile', mode: '100644', type: 'blob', sha: '3', size: 800, url: '' },
        { path: 'src/index.ts', mode: '100644', type: 'blob', sha: '4', size: 2000, url: '' },
        { path: 'test/auth.test.ts', mode: '100644', type: 'blob', sha: '5', size: 1500, url: '' },
        { path: 'assets/logo.png', mode: '100644', type: 'blob', sha: '6', size: 50000, url: '' },
        { path: 'package-lock.json', mode: '100644', type: 'blob', sha: '7', size: 100000, url: '' },
      ];

      const { candidates, skipped } = prioritizeFilesForInspection(tree, 3);
      assert.strictEqual(candidates.length, 3);
      // Package.json and README should be top priorities
      assert.strictEqual(candidates[0].path, 'package.json');
      assert.strictEqual(candidates[1].path, 'README.md');
      // Assets and lockfiles should be skipped
      assert.ok(skipped.some((s) => s.path === 'assets/logo.png' && s.reason === 'binary_asset'));
      assert.ok(skipped.some((s) => s.path === 'package-lock.json' && s.reason === 'lockfile'));
    });
  });

  describe('Mocked Scanner and API Handling', () => {
    it('handles 404 Not Found / Private repo gracefully', async () => {
      const mockFetch = async () =>
        new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
          statusText: 'Not Found',
          headers: new Headers({
            'x-ratelimit-limit': '60',
            'x-ratelimit-remaining': '55',
            'x-ratelimit-reset': '1800000000',
          }),
        });

      const result = await scanGitHubRepository('https://github.com/org/nonexistent-repo', {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'failed');
      assert.match(result.error!, /was not found.*Private repositories are not supported/i);
      assert.strictEqual(result.rateLimit?.remaining, 55);
    });

    it('handles 403 Rate Limiting gracefully without retries', async () => {
      const mockFetch = async () =>
        new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
          status: 403,
          statusText: 'Forbidden',
          headers: new Headers({
            'x-ratelimit-limit': '60',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1800000000',
          }),
        });

      const result = await scanGitHubRepository('https://github.com/org/any-repo', {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'failed');
      assert.match(result.error!, /rate limit exceeded/i);
      assert.strictEqual(result.rateLimit?.remaining, 0);
    });

    it('reports partial scan when git tree is truncated', async () => {
      const mockFetch = async (url: string | URL | Request) => {
        const u = url.toString();
        if (u.includes('/repos/testowner/bigrepo/git/trees/')) {
          return new Response(
            JSON.stringify({
              sha: 'tree-sha-123',
              tree: [
                { path: 'package.json', mode: '100644', type: 'blob', sha: 's1', size: 200, url: '' },
                { path: 'src/main.ts', mode: '100644', type: 'blob', sha: 's2', size: 400, url: '' },
              ],
              truncated: true, // Truncation flag from GitHub!
            }),
            { status: 200 }
          );
        }
        if (u.includes('/repos/testowner/bigrepo')) {
          return new Response(
            JSON.stringify({
              name: 'bigrepo',
              full_name: 'testowner/bigrepo',
              default_branch: 'main',
              private: false,
              stargazers_count: 10,
            }),
            { status: 200 }
          );
        }
        // Raw file contents
        return new Response('{}', { status: 200 });
      };

      const result = await scanGitHubRepository('https://github.com/testowner/bigrepo', {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'partial');
      assert.strictEqual(result.treeTruncated, true);
      assert.ok(result.warnings.some((w) => /truncated/i.test(w)));
    });

    it('ensures finding a test file in repo does NOT produce VERIFIED status', async () => {
      const mockFetch = async (url: string | URL | Request) => {
        const u = url.toString();
        if (u.includes('/repos/sample/app/git/trees/')) {
          return new Response(
            JSON.stringify({
              sha: 'tree-1',
              tree: [
                { path: 'package.json', mode: '100644', type: 'blob', sha: '1', size: 100, url: '' },
                { path: 'tests/auth.test.ts', mode: '100644', type: 'blob', sha: '2', size: 500, url: '' },
              ],
              truncated: false,
            }),
            { status: 200 }
          );
        }
        if (u.includes('/repos/sample/app')) {
          return new Response(
            JSON.stringify({
              name: 'app',
              full_name: 'sample/app',
              default_branch: 'main',
              private: false,
            }),
            { status: 200 }
          );
        }
        return new Response('// test file', { status: 200 });
      };

      const scanRes = await scanGitHubRepository('https://github.com/sample/app', {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      assert.strictEqual(scanRes.success, true);
      const house = mapScanResultToHouse(scanRes);

      const gatewayRoom = house.rooms.find((r) => r.id === 'room-tests' || r.layer === 'gateway');
      assert.ok(gatewayRoom);
      // Finding a test file must evaluate to IMPLEMENTED, NEVER VERIFIED!
      assert.notStrictEqual(gatewayRoom.status, 'verified');
      assert.strictEqual(gatewayRoom.status, 'implemented');
      assert.match(gatewayRoom.evidence, /Automated test execution has not been verified/i);
    });
  });
});
