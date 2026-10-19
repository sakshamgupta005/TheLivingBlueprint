import type { BenchmarkFixture } from './types.ts';
import type { GitTreeEntry } from '../../src/domain/github/types.ts';

export function createFixtureScannerFetch(fixture: BenchmarkFixture): typeof fetch {
  const {
    owner,
    repo,
    defaultBranch = 'main',
    files,
    treeTruncated = false,
    commitSha = 'c0ffee1234567890abcdef1234567890abcdef12',
    checkRuns = [],
  } = fixture;

  const generatedTree: GitTreeEntry[] = fixture.treeEntries || Object.entries(files).map(([path, content]) => ({
    path,
    mode: '100644',
    type: 'blob',
    sha: `sha-${path.replace(/[^a-zA-Z0-9]/g, '_')}`,
    size: Buffer.byteLength(content, 'utf8'),
    url: `https://api.github.com/repos/${owner}/${repo}/git/blobs/sha`,
  }));

  return (async (input: string | URL | Request) => {
    const url = input.toString();

    // 1. Repo Metadata
    if (url === `https://api.github.com/repos/${owner}/${repo}`) {
      return new Response(
        JSON.stringify({
          name: repo,
          full_name: `${owner}/${repo}`,
          description: fixture.knownFacts.description,
          default_branch: defaultBranch,
          private: false,
          html_url: `https://github.com/${owner}/${repo}`,
          stargazers_count: 42,
          forks_count: 5,
          open_issues_count: 1,
          size: 1024,
        }),
        {
          status: 200,
          headers: new Headers({
            'Content-Type': 'application/json',
            'x-ratelimit-limit': '60',
            'x-ratelimit-remaining': '58',
            'x-ratelimit-reset': '1800000000',
          }),
        }
      );
    }

    // 2. Git Tree
    if (url.includes(`/repos/${owner}/${repo}/git/trees/`)) {
      return new Response(
        JSON.stringify({
          sha: `tree-${commitSha.slice(0, 7)}`,
          tree: generatedTree,
          truncated: treeTruncated,
        }),
        {
          status: 200,
          headers: new Headers({
            'Content-Type': 'application/json',
            'x-ratelimit-limit': '60',
            'x-ratelimit-remaining': '57',
            'x-ratelimit-reset': '1800000000',
          }),
        }
      );
    }

    // 3. CI Check Runs (must be checked before generic commits endpoint)
    if (url.includes(`/repos/${owner}/${repo}/commits/`) && url.includes('/check-runs')) {
      return new Response(
        JSON.stringify({
          total_count: checkRuns.length,
          check_runs: checkRuns,
        }),
        {
          status: 200,
          headers: new Headers({
            'Content-Type': 'application/json',
            'x-ratelimit-limit': '60',
            'x-ratelimit-remaining': '55',
            'x-ratelimit-reset': '1800000000',
          }),
        }
      );
    }

    // 4. Commit SHA
    if (url.includes(`/repos/${owner}/${repo}/commits/${defaultBranch}`) || url.includes(`/repos/${owner}/${repo}/commits/${commitSha}`)) {
      return new Response(
        JSON.stringify({
          sha: commitSha,
          commit: {
            message: `Benchmark commit for ${fixture.name}`,
          },
        }),
        {
          status: 200,
          headers: new Headers({
            'Content-Type': 'application/json',
            'x-ratelimit-limit': '60',
            'x-ratelimit-remaining': '56',
            'x-ratelimit-reset': '1800000000',
          }),
        }
      );
    }

    // 5. Raw file content
    const rawPrefix = `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/`;
    if (url.startsWith(rawPrefix)) {
      const filePath = decodeURIComponent(url.slice(rawPrefix.length));
      if (Object.prototype.hasOwnProperty.call(files, filePath)) {
        return new Response(files[filePath], {
          status: 200,
          headers: new Headers({ 'Content-Type': 'text/plain; charset=utf-8' }),
        });
      }
      return new Response('File not found', { status: 404 });
    }

    return new Response('Not Found', { status: 404 });
  }) as unknown as typeof fetch;
}
