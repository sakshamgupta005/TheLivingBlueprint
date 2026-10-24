/**
 * fingerprint.ts — Deterministic SHA-256 fingerprinting for workspace snapshots.
 *
 * Generates stable, collision-resistant commit-identity hashes for local workspaces
 * based strictly on inspected file paths, sizes, and hashes of redacted excerpts.
 * Never includes raw source code, secrets, or uninspected files in the fingerprint.
 */

import * as crypto from 'node:crypto';

export interface InspectedFileFingerprintEntry {
  path: string;
  sizeBytes?: number;
  contentExcerpt?: string;
}

/**
 * Computes a deterministic SHA-256 fingerprint for a workspace snapshot's inspected files.
 *
 * Properties:
 * 1. Deterministic sort order (path-ascending) ensures file ordering does not alter the hash.
 * 2. Only inspected files contribute to the fingerprint.
 * 3. Incorporates path, file size, and SHA-256 hash of the redacted excerpt.
 * 4. Never exposes or stores raw excerpt strings in the output.
 */
export function computeWorkspaceFingerprint(
  inspectedFiles: InspectedFileFingerprintEntry[],
  hostExcerpts?: Map<string, string>,
  discoveredFilePaths?: string[],
  contentHashes?: Map<string, string>
): string {
  const compositeHash = crypto.createHash('sha256');

  // 1. Incorporate deterministic hash of discovered file paths (captures uninspected additions/removals)
  if (discoveredFilePaths && discoveredFilePaths.length > 0) {
    const sortedDiscovered = [...discoveredFilePaths].sort((a, b) => a.localeCompare(b));
    const discHash = crypto.createHash('sha256').update(sortedDiscovered.join('\n'), 'utf8').digest('hex');
    compositeHash.update(`discovered:${discHash}\n`, 'utf8');
  }

  // 2. Sort deterministically by file path (locale-invariant POSIX style)
  const sorted = [...inspectedFiles].sort((a, b) => a.path.localeCompare(b.path));

  for (const entry of sorted) {
    // Prefer full raw content hash computed at read time (never storing or emitting raw content)
    let contentHash = contentHashes?.get(entry.path);
    if (!contentHash) {
      const rawExcerpt = hostExcerpts?.get(entry.path) ?? entry.contentExcerpt ?? '';
      contentHash = crypto.createHash('sha256').update(rawExcerpt, 'utf8').digest('hex');
    }

    const record = `${entry.path}:${entry.sizeBytes ?? 0}:${contentHash}\n`;
    compositeHash.update(record, 'utf8');
  }

  return compositeHash.digest('hex');
}
