import type { TsConfigPathsConfig, UnresolvedReason } from './types.ts';

/**
 * Normalizes a virtual repository path (e.g. "src/routes/../store/./index.ts" -> "src/store/index.ts")
 */
export function normalizeRepoPath(pathStr: string): string {
  const parts = pathStr.replace(/\\/g, '/').replace(/^\.\//, '').split('/');
  const stack: string[] = [];

  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else {
        stack.push('..');
      }
    } else {
      stack.push(part);
    }
  }

  return stack.join('/');
}

const CANDIDATE_EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
  '/__init__.py',
];

/**
 * Probes whether a base path matches any file in availablePaths with common extensions
 */
function probeCandidatePath(basePath: string, availablePaths: Set<string>): string | undefined {
  const normalized = normalizeRepoPath(basePath);

  for (const ext of CANDIDATE_EXTENSIONS) {
    const candidate = normalizeRepoPath(`${normalized}${ext}`);
    if (availablePaths.has(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Resolves a relative import specifier from a source file
 */
export function resolveRelativeImport(
  sourcePath: string,
  specifier: string,
  availablePaths: Set<string>
): string | undefined {
  const normalizedSource = normalizeRepoPath(sourcePath);
  const slashIdx = normalizedSource.lastIndexOf('/');
  const sourceDir = slashIdx !== -1 ? normalizedSource.slice(0, slashIdx) : '';

  // Python relative imports: .module, ..module
  if (specifier.startsWith('.')) {
    // Count leading dots
    const dotMatch = specifier.match(/^(\.+)(.*)$/);
    if (dotMatch) {
      const dotCount = dotMatch[1].length;
      const subPath = dotMatch[2].replace(/\./g, '/'); // Python dot notation: foo.bar -> foo/bar

      const dirParts = sourceDir ? sourceDir.split('/') : [];
      // dotCount: 1 dot = same dir, 2 dots = parent dir, 3 dots = parent's parent
      const popCount = dotCount - 1;
      for (let i = 0; i < popCount; i++) {
        dirParts.pop();
      }

      const joined = [...dirParts, subPath].filter(Boolean).join('/');
      return probeCandidatePath(joined, availablePaths);
    }
  }

  const joined = sourceDir ? `${sourceDir}/${specifier}` : specifier;
  return probeCandidatePath(joined, availablePaths);
}

/**
 * Resolves an import using tsconfig/jsconfig path mappings
 */
export function resolveAliasImport(
  specifier: string,
  tsconfig: TsConfigPathsConfig | undefined,
  availablePaths: Set<string>
): { resolvedPath?: string; isConfiguredAlias: boolean } {
  if (!tsconfig?.paths) {
    // Default fallback check for common "@/" convention if baseUrl/paths not explicitly configured
    if (specifier.startsWith('@/')) {
      const remainder = specifier.slice(2);
      // Try src/remainder or remainder directly
      const candidate1 = probeCandidatePath(`src/${remainder}`, availablePaths);
      if (candidate1) return { resolvedPath: candidate1, isConfiguredAlias: true };
      const candidate2 = probeCandidatePath(remainder, availablePaths);
      if (candidate2) return { resolvedPath: candidate2, isConfiguredAlias: true };
      return { resolvedPath: undefined, isConfiguredAlias: true };
    }
    return { resolvedPath: undefined, isConfiguredAlias: false };
  }

  const baseUrl = tsconfig.baseUrl ? normalizeRepoPath(tsconfig.baseUrl) : '';

  for (const [aliasPattern, targetPatterns] of Object.entries(tsconfig.paths)) {
    // Wildcard mapping: e.g. "@/*" -> ["src/*"]
    if (aliasPattern.endsWith('/*')) {
      const prefix = aliasPattern.slice(0, -2); // "@"
      if (specifier.startsWith(prefix + '/')) {
        const wildcardVal = specifier.slice(prefix.length + 1);

        for (const targetPattern of targetPatterns) {
          const targetPrefix = targetPattern.replace(/\/\*$/, '');
          const mappedBase = baseUrl ? `${baseUrl}/${targetPrefix}/${wildcardVal}` : `${targetPrefix}/${wildcardVal}`;
          const resolved = probeCandidatePath(mappedBase, availablePaths);
          if (resolved) {
            return { resolvedPath: resolved, isConfiguredAlias: true };
          }
        }
        return { resolvedPath: undefined, isConfiguredAlias: true };
      }
    } else if (aliasPattern === specifier) {
      // Exact alias match
      for (const targetPattern of targetPatterns) {
        const mappedBase = baseUrl ? `${baseUrl}/${targetPattern}` : targetPattern;
        const resolved = probeCandidatePath(mappedBase, availablePaths);
        if (resolved) {
          return { resolvedPath: resolved, isConfiguredAlias: true };
        }
      }
      return { resolvedPath: undefined, isConfiguredAlias: true };
    }
  }

  return { resolvedPath: undefined, isConfiguredAlias: false };
}

/**
 * Parses compilerOptions from a tsconfig.json or jsconfig.json content string
 */
export function parseTsConfigPaths(content: string): TsConfigPathsConfig | undefined {
  try {
    // Strip comments from tsconfig JSON
    const stripped = content.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, '$1');
    const parsed = JSON.parse(stripped);
    const compilerOptions = parsed?.compilerOptions;
    if (!compilerOptions) return undefined;

    return {
      baseUrl: compilerOptions.baseUrl,
      paths: compilerOptions.paths,
    };
  } catch {
    return undefined;
  }
}

/**
 * Categorizes the explicit reason for an unresolved import
 */
export function classifyUnresolvedReason(
  _rawSpecifier: string,
  isRelative: boolean,
  isConfiguredAlias: boolean
): UnresolvedReason {
  if (isConfiguredAlias) {
    return 'unresolvable_alias';
  }
  if (isRelative) {
    return 'missing_target_file';
  }
  return 'external_package';
}

/**
 * Detects circular dependency cycles across the resolved module import graph
 * using depth-first search cycle detection.
 */
export function detectCircularDependencies(importGraph: Map<string, Set<string>>): string[][] {
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const cycles: string[][] = [];
  const seenCycleKeys = new Set<string>();

  function dfs(node: string, path: string[]) {
    visited.add(node);
    recStack.add(node);
    path.push(node);

    const neighbors = importGraph.get(node) || new Set();
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor, path);
      } else if (recStack.has(neighbor)) {
        // Cycle found from neighbor to current node
        const cycleStartIndex = path.indexOf(neighbor);
        if (cycleStartIndex !== -1) {
          const rawCycle = [...path.slice(cycleStartIndex), neighbor];
          // Canonicalize cycle representation so that cyclic shifts don't produce duplicates
          const cycleNodes = rawCycle.slice(0, -1);
          if (cycleNodes.length >= 2) {
            const minIndex = cycleNodes.reduce(
              (minIdx, curr, idx, arr) => (curr < arr[minIdx] ? idx : minIdx),
              0
            );
            const canonicalNodes = [
              ...cycleNodes.slice(minIndex),
              ...cycleNodes.slice(0, minIndex),
            ];
            const canonicalCycle = [...canonicalNodes, canonicalNodes[0]];
            const key = canonicalCycle.join(' -> ');

            if (!seenCycleKeys.has(key)) {
              seenCycleKeys.add(key);
              cycles.push(canonicalCycle);
            }
          }
        }
      }
    }

    path.pop();
    recStack.delete(node);
  }

  for (const node of importGraph.keys()) {
    if (!visited.has(node)) {
      dfs(node, []);
    }
  }

  return cycles;
}
