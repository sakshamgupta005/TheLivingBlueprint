/**
 * evidenceRefs.ts — Source-reference validation for companion messages (P2-09).
 *
 * Every clickable reference must point at a file in the current snapshot:
 * - unknown paths are dropped and counted;
 * - inspected files get their line checked against the host-only redacted
 *   excerpt, and a cited identifier is located at its real 1-based line;
 * - discovered but uninspected files are kept only as an explicitly labelled
 *   "unverified reference (not inspected)" opening at line 1.
 *
 * Pure TypeScript: no vscode import. Never changes room status.
 */

import { getSnapshotHostExcerpts, type WorkspaceSnapshot } from './snapshot.ts';

/** Scanner retains at most this many redacted characters per inspected file. */
export const HOST_EXCERPT_LIMIT = 3000;

export interface EvidenceRefCandidate {
  file: string;
  line?: number;
  /** Function/class/variable name the reply cites for this file, if any. */
  identifier?: string;
  /** Found in free text rather than an explicit reference field. */
  fromText?: boolean;
}

export type EvidenceRefStatus =
  /** File inspected; line confirmed (or clamped) against the excerpt, or identifier located. */
  | 'verified'
  /** File inspected, but the cited line lies beyond the retained excerpt. */
  | 'line_unverified'
  /** File discovered but never read; opens at line 1. */
  | 'unverified_not_inspected';

export interface ValidatedEvidenceRef {
  file: string;
  line: number;
  label: string;
  status: EvidenceRefStatus;
  note?: string;
}

export interface EvidenceRefValidation {
  refs: ValidatedEvidenceRef[];
  droppedCount: number;
  unverifiedCount: number;
}

type SnapshotLike = Pick<WorkspaceSnapshot, 'discoveredFilePaths' | 'inspectedFiles'>;

function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function basename(p: string): string {
  return p.split('/').pop() || p;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 1-based line of the first whole-word occurrence of `identifier`, or undefined. */
export function locateIdentifier(source: string, identifier: string): number | undefined {
  if (!/^[A-Za-z_$][\w$]{1,80}$/.test(identifier)) return undefined;
  const re = new RegExp(`(^|[^\\w$])${escapeRegex(identifier)}(?![\\w$])`);
  const idx = source.split(/\r?\n/).findIndex((l) => re.test(l));
  return idx >= 0 ? idx + 1 : undefined;
}

export function validateEvidenceRefs(
  candidates: EvidenceRefCandidate[],
  snapshot: SnapshotLike,
  excerpts: Map<string, string> = getSnapshotHostExcerpts(snapshot as WorkspaceSnapshot)
): EvidenceRefValidation {
  const discovered = new Set(snapshot.discoveredFilePaths);
  const inspected = new Set(snapshot.inspectedFiles.map((f) => f.path));
  const refs: ValidatedEvidenceRef[] = [];
  const seen = new Set<string>();
  let droppedCount = 0;
  let unverifiedCount = 0;

  const resolve = (raw: string): string | undefined => {
    const file = normalizePath(raw);
    if (discovered.has(file)) return file;
    if (file.includes('/')) return undefined;
    // A bare file name resolves only when exactly one snapshot file has that name.
    const matches = snapshot.discoveredFilePaths.filter((p) => basename(p) === file);
    return matches.length === 1 ? matches[0] : undefined;
  };

  const push = (ref: ValidatedEvidenceRef) => {
    const key = `${ref.file}:${ref.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
    if (ref.status !== 'verified') unverifiedCount++;
  };

  for (const candidate of candidates) {
    const file = candidate.file ? resolve(candidate.file) : undefined;
    if (!file) {
      // Words like "Node.js" in prose are not references; only path-like or explicit ones count as dropped.
      if (!candidate.fromText || normalizePath(candidate.file || '').includes('/')) droppedCount++;
      continue;
    }

    const source = inspected.has(file) ? excerpts.get(file) : undefined;
    if (source === undefined) {
      push({
        file,
        line: 1,
        label: `${basename(file)} (unverified reference, not inspected)`,
        status: 'unverified_not_inspected',
        note: 'File exists in the workspace but was not inspected; the cited location is unverified.',
      });
      continue;
    }

    const located = candidate.identifier ? locateIdentifier(source, candidate.identifier) : undefined;
    if (located) {
      push({ file, line: located, label: `${basename(file)}:${located}`, status: 'verified' });
      continue;
    }

    const lineCount = source.split(/\r?\n/).length;
    const excerptComplete = source.length < HOST_EXCERPT_LIMIT;
    const requested = Number.isInteger(candidate.line) && candidate.line! > 0 ? candidate.line! : 1;

    if (requested <= lineCount) {
      push({ file, line: requested, label: `${basename(file)}:${requested}`, status: 'verified' });
    } else if (excerptComplete) {
      push({
        file,
        line: lineCount,
        label: `${basename(file)}:${lineCount}`,
        status: 'verified',
        note: `Cited line ${requested} is past the end of the file; clamped to the last line.`,
      });
    } else {
      push({
        file,
        line: requested,
        label: `${basename(file)}:${requested} (line unverified)`,
        status: 'line_unverified',
        note: 'Cited line lies beyond the inspected excerpt and could not be checked.',
      });
    }
  }

  return { refs, droppedCount, unverifiedCount };
}

const PATH_LINE = /([A-Za-z0-9_.\-/\\]+\.[A-Za-z0-9]+)(?::(\d+))?/g;
const BACKTICK_IDENT = /`([A-Za-z_$][\w$]{1,80})(?:\(\))?`/g;
const REF_IDENT = /^\s*(?:#|::|\()\s*([A-Za-z_$][\w$]{1,80})/;

/**
 * Extracts unvalidated reference candidates from a reply. `evidenceReference`
 * may look like "src/auth.ts:42", "src/auth.ts#validateToken" or
 * "src/auth.ts:42 (validateToken)". Backticked identifiers in the text are
 * offered as identifier hints for cited files.
 */
export function extractRefCandidates(text: string, evidenceReference?: string): EvidenceRefCandidate[] {
  const hint = [...text.matchAll(BACKTICK_IDENT)].map((m) => m[1])[0];
  const candidates: EvidenceRefCandidate[] = [];

  const scan = (source: string, fromText: boolean) => {
    for (const m of source.matchAll(PATH_LINE)) {
      const rest = source.slice((m.index ?? 0) + m[0].length);
      candidates.push({
        file: m[1],
        line: m[2] ? parseInt(m[2], 10) : undefined,
        identifier: (fromText ? undefined : REF_IDENT.exec(rest)?.[1]) ?? hint,
        fromText,
      });
    }
  };

  if (evidenceReference) scan(evidenceReference, false);
  scan(text, true);
  return candidates;
}
