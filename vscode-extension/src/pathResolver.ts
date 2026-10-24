/**
 * pathResolver.ts — Secure workspace file resolution for Living Blueprint.
 *
 * Enforces containment inside valid workspace roots, preventing directory
 * traversal, symlink escapes, UNC injections, Windows drive-letter injections,
 * NUL byte attacks, and unauthorized filesystem exploration.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { isSensitivePath } from './scanFilters.ts';

export interface ResolvePathOptions {
  workspaceRoots: string[];
  activeRoot?: string;
  discoveredFiles?: Set<string> | string[] | null;
  hasSnapshot?: boolean;
  fsOverride?: {
    existsSync?: (p: string) => boolean;
    realpathSync?: (p: string) => string;
    statSync?: (p: string) => { isFile: () => boolean };
  };
}

export type ResolveErrorCode =
  | 'INVALID_FORMAT'
  | 'ABSOLUTE_PATH_DISALLOWED'
  | 'TRAVERSAL_DISALLOWED'
  | 'UNC_PATH_DISALLOWED'
  | 'DRIVE_LETTER_DISALLOWED'
  | 'URL_DISALLOWED'
  | 'NUL_CHARACTER_DISALLOWED'
  | 'NOT_FOUND'
  | 'OUT_OF_BOUNDS'
  | 'SYMLINK_ESCAPE'
  | 'SENSITIVE_FILE_DISALLOWED'
  | 'NOT_IN_SNAPSHOT';

export interface ResolveSuccess {
  success: true;
  resolvedPath: string; // Absolute canonical realpath on host disk
  workspaceRoot: string; // The root containing the file
  relativePath: string; // Normalized relative path (forward slashes)
}

export interface ResolveFailure {
  success: false;
  error: ResolveErrorCode;
  message: string;
}

export type ResolveResult = ResolveSuccess | ResolveFailure;

const SAFE_GENERIC_ERROR_MESSAGE = 'Invalid or restricted file path';

/**
 * Resolves and validates a webview-provided relative path against active workspace roots.
 */
export function resolveWorkspaceFile(
  rawPath: string,
  options: ResolvePathOptions
): ResolveResult {
  const fsOps = {
    existsSync: options.fsOverride?.existsSync ?? fs.existsSync,
    realpathSync: options.fsOverride?.realpathSync ?? fs.realpathSync,
    statSync: options.fsOverride?.statSync ?? fs.statSync,
  };

  if (!rawPath || typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return {
      success: false,
      error: 'INVALID_FORMAT',
      message: SAFE_GENERIC_ERROR_MESSAGE,
    };
  }

  // 1. Reject NUL characters
  if (rawPath.includes('\0')) {
    return {
      success: false,
      error: 'NUL_CHARACTER_DISALLOWED',
      message: SAFE_GENERIC_ERROR_MESSAGE,
    };
  }

  // 2. Reject file:// or other URLs
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawPath)) {
    return {
      success: false,
      error: 'URL_DISALLOWED',
      message: SAFE_GENERIC_ERROR_MESSAGE,
    };
  }

  // 3. Reject Windows drive-letter paths (e.g. C:, c:\, D:/)
  if (/^[a-zA-Z]:/i.test(rawPath)) {
    return {
      success: false,
      error: 'DRIVE_LETTER_DISALLOWED',
      message: SAFE_GENERIC_ERROR_MESSAGE,
    };
  }

  // 4. Reject UNC paths (e.g. \\server\share, //server/share)
  if (rawPath.startsWith('\\\\') || rawPath.startsWith('//')) {
    return {
      success: false,
      error: 'UNC_PATH_DISALLOWED',
      message: SAFE_GENERIC_ERROR_MESSAGE,
    };
  }

  // 5. Reject absolute paths (posix / or windows \)
  if (path.isAbsolute(rawPath) || rawPath.startsWith('/') || rawPath.startsWith('\\')) {
    return {
      success: false,
      error: 'ABSOLUTE_PATH_DISALLOWED',
      message: SAFE_GENERIC_ERROR_MESSAGE,
    };
  }

  // Normalize path separators to POSIX
  const normalizedInput = rawPath.replace(/\\/g, '/');

  // 6. Reject '..' directory traversal segments
  const segments = normalizedInput.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      return {
        success: false,
        error: 'TRAVERSAL_DISALLOWED',
        message: SAFE_GENERIC_ERROR_MESSAGE,
      };
    }
  }

  // Normalize clean relative path without leading ./
  const cleanRelative = path.posix.normalize(normalizedInput).replace(/^\.\//, '');
  if (cleanRelative === '.' || cleanRelative === '..' || cleanRelative.startsWith('../')) {
    return {
      success: false,
      error: 'TRAVERSAL_DISALLOWED',
      message: SAFE_GENERIC_ERROR_MESSAGE,
    };
  }

  const roots = options.workspaceRoots.filter(Boolean);
  if (roots.length === 0) {
    return {
      success: false,
      error: 'OUT_OF_BOUNDS',
      message: SAFE_GENERIC_ERROR_MESSAGE,
    };
  }

  // Check sensitive path deny-list before attempting file resolution
  if (isSensitivePath(cleanRelative).sensitive) {
    return {
      success: false,
      error: 'SENSITIVE_FILE_DISALLOWED',
      message: SAFE_GENERIC_ERROR_MESSAGE,
    };
  }

  // Validate activeRoot: ignore unless it is one of workspaceRoots (comparing canonical realpaths)
  let validActiveRoot: string | undefined = undefined;
  if (options.activeRoot) {
    try {
      const activeReal = fsOps.realpathSync(options.activeRoot);
      for (const r of roots) {
        try {
          if (fsOps.realpathSync(r) === activeReal) {
            validActiveRoot = r;
            break;
          }
        } catch {
          // Ignore candidate realpath resolution failures
        }
      }
    } catch {
      // activeRoot does not resolve to a real path on disk
    }
  }

  const orderedRoots = validActiveRoot
    ? [validActiveRoot, ...roots.filter((r) => r !== validActiveRoot)]
    : roots;

  // Enforce snapshot membership: when discoveredFiles is provided (even if empty), or no snapshot exists
  if (options.hasSnapshot === false || options.discoveredFiles === null) {
    return {
      success: false,
      error: 'NOT_IN_SNAPSHOT',
      message: SAFE_GENERIC_ERROR_MESSAGE,
    };
  }

  if (options.discoveredFiles !== undefined) {
    const discoveredSet =
      options.discoveredFiles instanceof Set
        ? options.discoveredFiles
        : new Set(options.discoveredFiles);

    if (!discoveredSet.has(cleanRelative)) {
      return {
        success: false,
        error: 'NOT_IN_SNAPSHOT',
        message: SAFE_GENERIC_ERROR_MESSAGE,
      };
    }
  }

  // Attempt resolution against each workspace root
  for (const root of orderedRoots) {
    try {
      const candidatePath = path.resolve(root, cleanRelative);

      if (!fsOps.existsSync(candidatePath)) {
        continue;
      }

      // Canonicalize both real paths to prevent symlink escape
      const realRoot = fsOps.realpathSync(root);
      const realCandidate = fsOps.realpathSync(candidatePath);

      // Verify containment: relative path must not start with '..' and must not be absolute
      const relToRoot = path.relative(realRoot, realCandidate);
      if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
        return {
          success: false,
          error: 'SYMLINK_ESCAPE',
          message: SAFE_GENERIC_ERROR_MESSAGE,
        };
      }

      // Re-check sensitive path rules on resolved path relative to root
      const relToRootNormalized = relToRoot.replace(/\\/g, '/');
      if (isSensitivePath(relToRootNormalized).sensitive) {
        return {
          success: false,
          error: 'SENSITIVE_FILE_DISALLOWED',
          message: SAFE_GENERIC_ERROR_MESSAGE,
        };
      }

      // Check that target is a file, not a directory
      const stat = fsOps.statSync(realCandidate);
      if (typeof stat.isFile === 'function' && !stat.isFile()) {
        continue;
      }

      return {
        success: true,
        resolvedPath: realCandidate,
        workspaceRoot: root,
        relativePath: cleanRelative,
      };
    } catch {
      // Failed for this root; try next root
      continue;
    }
  }

  return {
    success: false,
    error: 'NOT_FOUND',
    message: SAFE_GENERIC_ERROR_MESSAGE,
  };
}
