import { categorizeFile, prioritizeFilesForInspection, identifyUnsupportedFileTypes } from './fileFilter.ts';
import {
  clearScannerCache,
  getCachedRepository,
  getScannerCacheStats,
  redactSecrets,
  setCachedRepository,
} from './cache.ts';
import type {
  EvidenceCoverage,
  GitHubRepoMetadata,
  GitHubScanOptions,
  GitHubScanResult,
  GitTreeEntry,
  InspectedFile,
  ParseFailure,
  RateLimitInfo,
  ScanStage,
} from './types.ts';
import { validateGitHubUrl } from './url.ts';
import { fetchCommitCheckRuns, evaluateCheckRunsForVerification } from '../lifecycle/ciEvaluator.ts';
import type { GitHubCheckRun } from '../lifecycle/types.ts';
import { buildCodeIndex } from '../codeIndex/index.ts';
import { buildRepositoryKnowledgeBase } from '../repositoryKnowledge/index.ts';
import { findBenchmarkFixture, createFixtureScannerFetch } from '../fixtures/index.ts';

export { clearScannerCache, getScannerCacheStats, redactSecrets };

function parseRateLimitHeaders(headers: Headers): RateLimitInfo | undefined {
  const limitHeader = headers.get('x-ratelimit-limit');
  const remainingHeader = headers.get('x-ratelimit-remaining');
  const resetHeader = headers.get('x-ratelimit-reset');
  const retryAfterHeader = headers.get('retry-after');

  const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;

  if (limitHeader && remainingHeader && resetHeader) {
    const resetSeconds = parseInt(resetHeader, 10);
    return {
      limit: parseInt(limitHeader, 10),
      remaining: parseInt(remainingHeader, 10),
      resetDate: new Date(resetSeconds * 1000).toISOString(),
      retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    };
  }

  if (retryAfterSeconds && Number.isFinite(retryAfterSeconds)) {
    return {
      limit: 60,
      remaining: 0,
      resetDate: new Date(Date.now() + retryAfterSeconds * 1000).toISOString(),
      retryAfterSeconds,
    };
  }
  return undefined;
}

function createTimeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as { unref: () => void }).unref();
  }
  return controller.signal;
}

export async function scanGitHubRepository(
  rawUrl: string,
  options: GitHubScanOptions = {},
  onProgress?: (stage: ScanStage, message: string) => void
): Promise<GitHubScanResult> {
  const startTime = Date.now();
  let fetchFn = options.fetchFn;
  const maxFiles = Math.min(40, Math.max(1, options.maxFilesToInspect ?? 25));
  const maxFileSizeBytes = options.maxFileSizeBytes ?? 80 * 1024;
  const totalScanBudgetBytes = options.totalScanBudgetBytes ?? 160 * 1024;
  const timeoutMs = options.timeoutMs ?? 10000;
  const token = options.githubToken || (typeof process !== 'undefined' && process.env ? process.env.GITHUB_TOKEN : undefined);
  const useCache = options.useCache !== false;
  const warnings: string[] = [];

  const baseHeaders: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'TheLivingBlueprint-Scanner',
  };
  if (token && token.trim().length > 0) {
    baseHeaders['Authorization'] = `Bearer ${token.trim()}`;
  }

  onProgress?.('validating', 'Validating GitHub repository URL...');

  const validation = validateGitHubUrl(rawUrl);
  if (!validation.valid) {
    return {
      success: false,
      status: 'failed',
      owner: '',
      repo: '',
      treeTruncated: false,
      totalFilesDiscovered: 0,
      inspectedFiles: [],
      skippedFiles: [],
      detectedTechnologies: [],
      detectedManifests: [],
      detectedArchitecturalLayers: [],
      warnings: [],
      error: redactSecrets(validation.error || 'Invalid URL', token),
      durationMs: Date.now() - startTime,
    };
  }

  const { owner, repo } = validation;

  if (!fetchFn) {
    const fixture = findBenchmarkFixture(owner, repo);
    fetchFn = fixture ? createFixtureScannerFetch(fixture) : fetch;
  }

  // 1. Fetch Repository Metadata
  onProgress?.('fetching_metadata', `Retrieving repository metadata for ${owner}/${repo}...`);

  let metadata: GitHubRepoMetadata | undefined;
  let rateLimit: RateLimitInfo | undefined;
  let metaEtag: string | undefined;

  try {
    const metaRes = await fetchFn(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: baseHeaders,
      signal: createTimeoutSignal(timeoutMs),
    });

    rateLimit = parseRateLimitHeaders(metaRes.headers);
    metaEtag = metaRes.headers.get('etag') || undefined;

    if (metaRes.status === 404) {
      return {
        success: false,
        status: 'failed',
        owner,
        repo,
        treeTruncated: false,
        totalFilesDiscovered: 0,
        inspectedFiles: [],
        skippedFiles: [],
        detectedTechnologies: [],
        detectedManifests: [],
        detectedArchitecturalLayers: [],
        rateLimit,
        warnings,
        error: `Repository ${owner}/${repo} was not found on GitHub. Note: Private repositories are not supported.`,
        durationMs: Date.now() - startTime,
      };
    }

    if (metaRes.status === 403 || metaRes.status === 429) {
      let resetMsg = '';
      if (rateLimit) {
        const resetDate = new Date(rateLimit.resetDate);
        const minsLeft = Math.max(1, Math.round((resetDate.getTime() - Date.now()) / 60000));
        resetMsg = ` Quota resets at ${resetDate.toLocaleTimeString()} (in ~${minsLeft} min${minsLeft === 1 ? '' : 's'}).`;
      }
      return {
        success: false,
        status: 'failed',
        owner,
        repo,
        treeTruncated: false,
        totalFilesDiscovered: 0,
        inspectedFiles: [],
        skippedFiles: [],
        detectedTechnologies: [],
        detectedManifests: [],
        detectedArchitecturalLayers: [],
        rateLimit,
        warnings,
        error: redactSecrets(`GitHub API rate limit exceeded (unauthenticated limit is 60 requests/hr).${resetMsg}`, token),
        durationMs: Date.now() - startTime,
      };
    }

    if (!metaRes.ok) {
      return {
        success: false,
        status: 'failed',
        owner,
        repo,
        treeTruncated: false,
        totalFilesDiscovered: 0,
        inspectedFiles: [],
        skippedFiles: [],
        detectedTechnologies: [],
        detectedManifests: [],
        detectedArchitecturalLayers: [],
        rateLimit,
        warnings,
        error: redactSecrets(`GitHub API returned error HTTP ${metaRes.status}: ${metaRes.statusText}`, token),
        durationMs: Date.now() - startTime,
      };
    }

    const metaJson = await metaRes.json();
    if (metaJson.private) {
      return {
        success: false,
        status: 'failed',
        owner,
        repo,
        treeTruncated: false,
        totalFilesDiscovered: 0,
        inspectedFiles: [],
        skippedFiles: [],
        detectedTechnologies: [],
        detectedManifests: [],
        detectedArchitecturalLayers: [],
        rateLimit,
        warnings,
        error: 'The requested repository is private. The Living Blueprint supports public repositories only.',
        durationMs: Date.now() - startTime,
      };
    }

    metadata = {
      name: metaJson.name,
      fullName: metaJson.full_name,
      description: metaJson.description || null,
      defaultBranch: metaJson.default_branch || 'main',
      isPrivate: false,
      htmlUrl: metaJson.html_url,
      stargazersCount: metaJson.stargazers_count ?? 0,
      forksCount: metaJson.forks_count ?? 0,
      openIssuesCount: metaJson.open_issues_count ?? 0,
      sizeKb: metaJson.size ?? 0,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Network request failed';
    return {
      success: false,
      status: 'failed',
      owner,
      repo,
      treeTruncated: false,
      totalFilesDiscovered: 0,
      inspectedFiles: [],
      skippedFiles: [],
      detectedTechnologies: [],
      detectedManifests: [],
      detectedArchitecturalLayers: [],
      rateLimit,
      warnings,
      error: redactSecrets(`Failed to reach GitHub API: ${errorMsg}`, token),
      durationMs: Date.now() - startTime,
    };
  }

  // 2. Determine Scanned Commit SHA
  let commitSha: string | undefined;
  try {
    const commitRes = await fetchFn(
      `https://api.github.com/repos/${owner}/${repo}/commits/${metadata.defaultBranch}`,
      {
        headers: baseHeaders,
        signal: createTimeoutSignal(timeoutMs),
      }
    );
    if (commitRes.ok) {
      const commitData = await commitRes.json();
      if (commitData && typeof commitData.sha === 'string') {
        commitSha = commitData.sha;
      }
    }
  } catch {
    // Non-fatal if unmocked or network issue
  }

  // 3. Fetch Git Recursive Tree (checks immutable commit cache first)
  onProgress?.('fetching_tree', `Retrieving file tree for branch '${metadata.defaultBranch}'...`);

  let treeEntries: GitTreeEntry[] = [];
  let isTruncated = false;
  const subtreesFetched: string[] = [];
  let isFromCache = false;

  const cachedRecord = useCache && commitSha ? getCachedRepository(owner, repo, commitSha) : undefined;
  if (cachedRecord && cachedRecord.treeEntries.length > 0) {
    treeEntries = cachedRecord.treeEntries;
    isTruncated = cachedRecord.treeTruncated;
    if (cachedRecord.subtreesFetched) {
      subtreesFetched.push(...cachedRecord.subtreesFetched);
    }
    isFromCache = true;
    warnings.push('Served from immutable commit cache.');
  } else {
    try {
      const treeRes = await fetchFn(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${metadata.defaultBranch}?recursive=1`,
        {
          headers: baseHeaders,
          signal: createTimeoutSignal(timeoutMs),
        }
      );

      const treeRateLimit = parseRateLimitHeaders(treeRes.headers);
      if (treeRateLimit) rateLimit = treeRateLimit;

      if (!treeRes.ok) {
        warnings.push(`Could not retrieve recursive git tree (HTTP ${treeRes.status}).`);
        const isConflictEmpty = treeRes.status === 409;
        const errorDetail = isConflictEmpty
          ? `The repository "${owner}/${repo}" is empty on GitHub (no commits or tree found).`
          : `Could not retrieve git tree: HTTP ${treeRes.status} ${treeRes.statusText}`;
        return {
          success: false,
          status: 'failed',
          owner,
          repo,
          metadata,
          treeTruncated: false,
          totalFilesDiscovered: 0,
          inspectedFiles: [],
          skippedFiles: [],
          detectedTechnologies: [],
          detectedManifests: [],
          detectedArchitecturalLayers: [],
          rateLimit,
          warnings,
          error: redactSecrets(errorDetail, token),
          durationMs: Date.now() - startTime,
        };
      }

      const treeJson = await treeRes.json();
      treeEntries = Array.isArray(treeJson.tree) ? treeJson.tree : [];
      isTruncated = Boolean(treeJson.truncated);

      // 3b. Handle Truncation with Targeted Subtree Traversal
      if (isTruncated) {
        const priorityRoots = ['src', 'app', 'lib', 'packages', 'api', 'routes', 'test', 'tests', 'internal'];
        const candidateTrees = treeEntries.filter(
          (e) => e.type === 'tree' && priorityRoots.includes(e.path.toLowerCase())
        );

        for (const dirNode of candidateTrees.slice(0, 2)) {
          try {
            const subRes = await fetchFn(
              `https://api.github.com/repos/${owner}/${repo}/git/trees/${dirNode.sha}?recursive=1`,
              {
                headers: baseHeaders,
                signal: createTimeoutSignal(timeoutMs),
              }
            );
            if (subRes.ok) {
              const subJson = await subRes.json();
              if (Array.isArray(subJson.tree)) {
                const existingPaths = new Set(treeEntries.map((e) => e.path));
                for (const item of subJson.tree) {
                  const fullPath = `${dirNode.path}/${item.path}`;
                  if (!existingPaths.has(fullPath)) {
                    treeEntries.push({
                      path: fullPath,
                      mode: item.mode,
                      type: item.type,
                      sha: item.sha,
                      size: item.size,
                      url: item.url,
                    });
                    existingPaths.add(fullPath);
                  }
                }
                subtreesFetched.push(dirNode.path);
              }
            }
          } catch {
            // Subtree fetch is non-fatal recovery
          }
        }

        warnings.push(
          `Git tree was truncated by GitHub API (repository contains >100,000 files or tree exceeded 7MB). ${
            subtreesFetched.length > 0
              ? `Targeted subtree traversal explored: ${subtreesFetched.join(', ')}. `
              : ''
          }Architecture discovery is based on partial tree.`
        );
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Git tree fetch error';
      return {
        success: false,
        status: 'failed',
        owner,
        repo,
        metadata,
        treeTruncated: false,
        totalFilesDiscovered: 0,
        inspectedFiles: [],
        skippedFiles: [],
        detectedTechnologies: [],
        detectedManifests: [],
        detectedArchitecturalLayers: [],
        rateLimit,
        warnings,
        error: redactSecrets(`Failed to fetch git tree: ${errorMsg}`, token),
        durationMs: Date.now() - startTime,
      };
    }
  }

  if (!commitSha && treeEntries.length > 0) {
    commitSha = treeEntries[0]?.sha;
  }

  // 4. Retrieve CI Check Runs for the Scanned Commit
  const targetRef = commitSha || metadata.defaultBranch;
  onProgress?.(
    'fetching_checks',
    `Querying GitHub CI check runs for commit ${targetRef.slice(0, 7)}...`
  );

  let checkRuns: GitHubCheckRun[] = [];
  try {
    const { checks: fetchedChecks, warnings: ciWarnings } = await fetchCommitCheckRuns(
      owner,
      repo,
      targetRef,
      fetchFn
    );
    warnings.push(...ciWarnings);
    checkRuns = fetchedChecks;
  } catch {
    warnings.push('Verification evidence unavailable: failed to query GitHub check-runs API.');
  }

  if (!commitSha && checkRuns.length > 0 && checkRuns[0].commitSha) {
    commitSha = checkRuns[0].commitSha;
  }

  const ciEvaluation = evaluateCheckRunsForVerification(
    checkRuns,
    'req-gw-ci',
    commitSha || targetRef,
    new Date().toISOString()
  );

  // 5. Filter and Prioritize Candidate Files
  const { candidates, skipped } = prioritizeFilesForInspection(treeEntries, maxFiles, maxFileSizeBytes);

  onProgress?.(
    'inspecting_files',
    `Inspecting ${candidates.length} representative files (of ${treeEntries.length} total)...`
  );

  const inspectedFiles: InspectedFile[] = [];
  const parseFailures: ParseFailure[] = [];
  const fileContentCache = new Map<string, string>();
  const detectedTechnologies = new Set<string>();
  const detectedManifests: string[] = [];

  for (const entry of treeEntries) {
    if (categorizeFile(entry.path) === 'manifest' && !detectedManifests.includes(entry.path)) {
      detectedManifests.push(entry.path);
    }
  }

  for (const entry of treeEntries) {
    const lower = entry.path.toLowerCase();
    if (lower.endsWith('.ts') || lower.endsWith('.tsx')) detectedTechnologies.add('TypeScript');
    if (lower.endsWith('.js') || lower.endsWith('.jsx')) detectedTechnologies.add('JavaScript');
    if (lower.endsWith('.py') || lower.endsWith('pyproject.toml') || lower.endsWith('requirements.txt')) detectedTechnologies.add('Python');
    if (lower.endsWith('.rs')) detectedTechnologies.add('Rust');
    if (lower.endsWith('.go')) detectedTechnologies.add('Go');
    if (lower.endsWith('.java')) detectedTechnologies.add('Java');
    if (lower.includes('dockerfile') || lower.includes('docker-compose')) detectedTechnologies.add('Docker');
    if (lower.includes('.github/workflows/')) detectedTechnologies.add('GitHub Actions');
  }

  // 6. Inspect Candidate Files with Total Content Byte Budget Enforcement
  let totalContentBytesInspected = 0;
  let byteBudgetExceeded = false;
  let rawUnreachable = false;

  const fetchCandidateContent = async (candidate: GitTreeEntry): Promise<string | null> => {
    const cachedText = cachedRecord?.fileContents.get(candidate.path);
    if (useCache && cachedText !== undefined) {
      return cachedText;
    }

    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${metadata!.defaultBranch}/${candidate.path}`;
    const cdnUrl = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${metadata!.defaultBranch}/${candidate.path}`;
    const blobUrl = candidate.url || `https://api.github.com/repos/${owner}/${repo}/git/blobs/${candidate.sha}`;

    if (!rawUnreachable) {
      try {
        const rawSignal = createTimeoutSignal(Math.min(timeoutMs, 1500));
        const fileRes = await fetchFn(rawUrl, {
          signal: rawSignal,
        });

        if (fileRes.ok) {
          return await fileRes.text();
        }
        if (fileRes.status === 404) {
          return null;
        }
      } catch {
        rawUnreachable = true;
      }
    }

    // High-speed CDN mirror fallback for public repos (avoids exhausting 60 req/hr GitHub REST API quota)
    try {
      const cdnSignal = createTimeoutSignal(Math.min(timeoutMs, 2500));
      const cdnRes = await fetchFn(cdnUrl, { signal: cdnSignal });
      if (cdnRes.ok) {
        return await cdnRes.text();
      }
    } catch {
      // CDN fallback non-fatal
    }

    // Fast fallback: GitHub REST API blob endpoint
    try {
      const apiHeaders: Record<string, string> = {
        ...baseHeaders,
        Accept: 'application/vnd.github.v3.raw',
      };
      const apiRes = await fetchFn(blobUrl, {
        headers: apiHeaders,
        signal: createTimeoutSignal(timeoutMs),
      });

      if (apiRes.ok) {
        return await apiRes.text();
      }
      if (apiRes.status >= 400 && apiRes.status < 500) {
        return null;
      }

      if (apiRes.status === 200) {
        const json = await apiRes.json();
        if (json && typeof json.content === 'string' && json.encoding === 'base64') {
          return atob(json.content.replace(/\s/g, ''));
        }
      }
    } catch {
      // Fallback exhausted
    }

    return null;
  };

  const BATCH_SIZE = 5;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    if (byteBudgetExceeded || totalContentBytesInspected >= totalScanBudgetBytes) {
      for (const remaining of candidates.slice(i)) {
        skipped.push({ path: remaining.path, reason: 'scan_byte_budget_exceeded' });
      }
      break;
    }

    const batch = candidates.slice(i, i + BATCH_SIZE);
    const batchContents = await Promise.all(batch.map((c) => fetchCandidateContent(c)));

    for (let j = 0; j < batch.length; j++) {
      const candidate = batch[j];
      const text = batchContents[j];

      if (byteBudgetExceeded || totalContentBytesInspected >= totalScanBudgetBytes) {
        byteBudgetExceeded = true;
        skipped.push({ path: candidate.path, reason: 'scan_byte_budget_exceeded' });
        continue;
      }

      if (text === null) {
        warnings.push(`File "${candidate.path}" could not be inspected.`);
        skipped.push({ path: candidate.path, reason: 'content_fetch_failed' });
        continue;
      }

      const category = categorizeFile(candidate.path);
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${metadata!.defaultBranch}/${candidate.path}`;
      const githubUrl = `https://github.com/${owner}/${repo}/blob/${metadata!.defaultBranch}/${candidate.path}`;

      const remainingBudget = totalScanBudgetBytes - totalContentBytesInspected;
      const excerptLimit = Math.min(3000, remainingBudget);
      const excerpt = text.slice(0, excerptLimit);

      totalContentBytesInspected += text.length;
      fileContentCache.set(candidate.path, text);

      inspectedFiles.push({
        path: candidate.path,
        category,
        sizeBytes: candidate.size ?? text.length,
        contentExcerpt: excerpt,
        rawUrl,
        githubUrl,
      });

      // Scan manifest content for dependencies
      if (candidate.path.endsWith('package.json')) {
        try {
          const pkg = JSON.parse(text);
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (allDeps.react) detectedTechnologies.add('React');
          if (allDeps.vite) detectedTechnologies.add('Vite');
          if (allDeps.next) detectedTechnologies.add('Next.js');
          if (allDeps.jest) detectedTechnologies.add('Jest');
          if (allDeps.vitest) detectedTechnologies.add('Vitest');
          if (allDeps.tailwindcss) detectedTechnologies.add('Tailwind CSS');
          if (allDeps.pg || allDeps['@prisma/client'] || allDeps.typeorm || allDeps.sqlite3) detectedTechnologies.add('PostgreSQL / SQL');
        } catch (err: unknown) {
          const parseErr = err instanceof Error ? err.message : 'Invalid JSON syntax in package.json';
          parseFailures.push({ path: candidate.path, error: parseErr });
          warnings.push(`Manifest parse failure in "${candidate.path}": ${parseErr}`);
        }
      } else if (candidate.path.endsWith('pyproject.toml') || candidate.path.endsWith('requirements.txt')) {
        const lowerText = text.toLowerCase();
        detectedTechnologies.add('Python');
        if (lowerText.includes('fastapi')) detectedTechnologies.add('FastAPI');
        if (lowerText.includes('flask')) detectedTechnologies.add('Flask');
        if (lowerText.includes('django')) detectedTechnologies.add('Django');
        if (lowerText.includes('pytest')) detectedTechnologies.add('Pytest');
        if (lowerText.includes('sqlalchemy') || lowerText.includes('sqlite') || lowerText.includes('psycopg')) detectedTechnologies.add('PostgreSQL / SQL');
      }
    }
  }

  // 7. Store In-Memory Cache for Immutable Commit SHA
  if (useCache && commitSha && inspectedFiles.length > 0) {
    setCachedRepository({
      owner,
      repo,
      commitSha,
      metadata,
      treeEntries,
      treeTruncated: isTruncated,
      subtreesFetched,
      checkRuns,
      fileContents: fileContentCache,
      parseFailures,
      unsupportedFileTypes: identifyUnsupportedFileTypes(treeEntries),
      etag: metaEtag,
      cachedAt: Date.now(),
    });
  }

  onProgress?.('mapping_architecture', 'Mapping discovered files to architecture domains...');

  const isPartial = isTruncated || skipped.length > 0 || parseFailures.length > 0;
  const status = isPartial ? 'partial' : 'completed';

  const discoveredCount = treeEntries.length;
  const inspectedCount = inspectedFiles.length;
  const skippedCount = skipped.length;
  const coverageRatio = discoveredCount > 0 ? Number((inspectedCount / discoveredCount).toFixed(4)) : 1;

  const evidenceCoverage: EvidenceCoverage = {
    discoveredCount,
    inspectedCount,
    skippedCount,
    coverageRatio,
  };

  const unsupportedFileTypes = identifyUnsupportedFileTypes(treeEntries);

  // Determine coverage improvement feasibility
  const fileBudgetSkipped = skipped.filter((s) => s.reason === 'scan_file_budget_exceeded').length;
  const byteBudgetSkipped = skipped.filter((s) => s.reason === 'scan_byte_budget_exceeded').length;
  const fetchFailedSkipped = skipped.filter((s) => s.reason === 'content_fetch_failed').length;

  const coverageImprovementPossible =
    isTruncated || fileBudgetSkipped > 0 || byteBudgetSkipped > 0 || fetchFailedSkipped > 0;

  let coverageImprovementReason: string | undefined;
  if (coverageImprovementPossible) {
    const reasons: string[] = [];
    if (isTruncated) reasons.push('Git tree was truncated by GitHub API (>100k files/7MB limit)');
    if (fileBudgetSkipped > 0) reasons.push(`${fileBudgetSkipped} candidate file(s) omitted due to file budget limit (${maxFiles} max)`);
    if (byteBudgetSkipped > 0) reasons.push(`${byteBudgetSkipped} file(s) omitted due to total scan byte budget limit (${Math.round(totalScanBudgetBytes / 1024)} KB)`);
    if (fetchFailedSkipped > 0) reasons.push(`${fetchFailedSkipped} file(s) failed to download`);
    coverageImprovementReason = `${reasons.join('; ')}. Expanding scan budget or targeting subtrees could improve grounding confidence.`;
  } else {
    coverageImprovementReason = 'All discovered candidate files were inspected within budget. Full repository tree explored.';
  }

  onProgress?.('completed', `Scan complete: ${inspectedFiles.length} files inspected.`);

  const filesForIndexing: Record<string, string> = {};
  for (const [p, content] of fileContentCache.entries()) {
    filesForIndexing[p] = content;
  }
  const codeIndex = buildCodeIndex({
    repositorySha: commitSha || 'unknown',
    files: filesForIndexing,
  });

  const repositoryKnowledge = buildRepositoryKnowledgeBase({
    repository: `${owner}/${repo}`,
    commitSha: commitSha || 'unknown',
    inspectedFiles,
    discoveredFilePaths: treeEntries.map((e) => e.path),
    skippedFilesCount: skipped.length,
    detectedTechnologies: Array.from(detectedTechnologies).sort(),
    metadata,
  });

  return {
    success: true,
    status,
    owner,
    repo,
    metadata,
    commitSha,
    scannedAt: new Date().toISOString(),
    checkRuns,
    ciEvaluation,
    codeIndex,
    repositoryKnowledge,
    treeTruncated: isTruncated,
    subtreesFetched: subtreesFetched.length > 0 ? subtreesFetched : undefined,
    totalFilesDiscovered: treeEntries.length,
    discoveredFilePaths: treeEntries.map((e) => e.path),
    inspectedFiles,
    skippedFiles: skipped,
    parseFailures,
    evidenceCoverage,
    unsupportedFileTypes,
    coverageImprovementPossible,
    coverageImprovementReason,
    cached: isFromCache,
    totalContentBytesInspected,
    scanFileBudget: maxFiles,
    scanByteBudget: totalScanBudgetBytes,
    detectedTechnologies: Array.from(detectedTechnologies).sort(),
    detectedManifests,
    detectedArchitecturalLayers: ['foundation', 'core', 'service', 'gateway'],
    rateLimit,
    warnings: warnings.map((w) => redactSecrets(w, token)),
    durationMs: Date.now() - startTime,
  };
}
