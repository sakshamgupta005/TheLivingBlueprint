/**
 * handoff.ts — Repair-prompt handoff to the user's coding agent (P2-11).
 *
 * Only two adapters exist: copy to clipboard, and save to
 * .living-blueprint/prompts/<findingId>.md after explicit confirmation.
 * There is NO agent execution, auto-submit or chat-history ingestion.
 *
 * Future adapters (Claude Code, Antigravity, Codex) would implement
 * AgentHandoffAdapter and be added to the registry in extension.ts once their
 * official extension APIs have been verified. None are implemented here.
 *
 * Pure TypeScript: no vscode import; all side effects are injected.
 */

import * as nodePath from 'node:path';
import * as nodeFs from 'node:fs/promises';
import { getSnapshotHostExcerpts, type WorkspaceSnapshot } from './snapshot.ts';
import type { ValidatedEvidenceRef } from './evidenceRefs.ts';
import type { FindingView } from '../investigationService.ts';

export interface HandoffPrompt {
  title: string;
  body: string;
  sourceRefs: ValidatedEvidenceRef[];
  findingId: string;
  fingerprint: string;
  roomId: string;
  evidenceClassification: 'observed' | 'inferred' | 'unverified';
}

export type HandoffFailureReason =
  | 'cancelled'
  | 'clipboard_failed'
  | 'write_failed'
  | 'outside_workspace'
  | 'unavailable';

export interface HandoffResult {
  ok: boolean;
  adapterId: string;
  message: string;
  /** Workspace-relative path of the saved file (file adapter only). */
  path?: string;
  reason?: HandoffFailureReason;
}

export interface AgentHandoffAdapter {
  id: string;
  label: string;
  available(): boolean;
  handoff(prompt: HandoffPrompt): Promise<HandoffResult>;
}

// --- prompt construction --------------------------------------------------

export interface ObservedTestCommand {
  command: string;
  source: string;
}

/** Test command only from observed, inspected manifests. Never guessed. */
export function detectTestCommand(snapshot: WorkspaceSnapshot): ObservedTestCommand | undefined {
  const excerpts = getSnapshotHostExcerpts(snapshot);

  const pkg = excerpts.get('package.json');
  if (pkg) {
    try {
      const script = JSON.parse(pkg)?.scripts?.test;
      if (typeof script === 'string' && script.trim()) {
        return { command: 'npm test', source: `package.json scripts.test = "${script.trim()}"` };
      }
    } catch {
      // Truncated or malformed manifest: treat as not observed.
    }
  }

  const makefile = excerpts.get('Makefile');
  if (makefile && /^test\s*:/m.test(makefile)) {
    return { command: 'make test', source: 'Makefile target "test"' };
  }
  return undefined;
}

export function findingIdFor(roomId: string, fingerprint: string): string {
  return `${roomId}-${fingerprint.slice(0, 12)}`.replace(/[^A-Za-z0-9._-]/g, '-');
}

export type BuildPromptResult = { ok: true; prompt: HandoffPrompt } | { ok: false; reason: string };

export function buildHandoffPrompt(record: FindingView | undefined, snapshot: WorkspaceSnapshot): BuildPromptResult {
  if (!record) return { ok: false, reason: 'No investigation finding exists for this room. Run an investigation first.' };
  if (record.stale || record.fingerprint !== snapshot.fingerprint) {
    return { ok: false, reason: 'The finding is stale: the workspace changed since it was produced. Re-investigate first.' };
  }
  const finding = record.finding;
  if (!finding?.generatedPrompt?.trim() || !finding.title) {
    return { ok: false, reason: 'The finding has no generated repair prompt.' };
  }

  const test = detectTestCommand(snapshot);
  const refs = record.navigation?.references ?? [];
  const classification = finding.evidenceClassification;

  const refLines = refs.length
    ? refs.map((r) => `- \`${r.file}:${r.line}\` (${r.status.replace(/_/g, ' ')})${r.note ? ` — ${r.note}` : ''}`).join('\n')
    : '- No source reference could be verified in the current workspace.';

  const classificationNote =
    classification === 'observed'
      ? 'OBSERVED: grounded in inspected source. Still confirm against the current code before editing.'
      : classification === 'inferred'
      ? 'INFERRED: derived from structure and patterns, not confirmed in source. Verify the issue exists before changing code.'
      : 'UNVERIFIED: insufficient evidence. Investigate first; do not change code unless the issue is confirmed.';

  const testSection = test
    ? `- Observed test command: \`${test.command}\` (from ${test.source}).`
    : '- No test command was detected in the inspected files. Any generic test command mentioned below is not observed; find the project\'s real test command before relying on it.';

  const header = `<!-- Living Blueprint repair handoff -->
# Repair handoff: ${finding.title}

- Room: ${finding.roomName} (\`${finding.roomId}\`)
- Generated from workspace fingerprint \`${record.fingerprint}\` at ${record.investigatedAt}
- Evidence classification: **${classification.toUpperCase()}** — ${classificationNote}

## Before you edit
Inspect the current code first. This prompt was generated from a bounded, redacted scan and AI analysis; it is advisory and does not mark anything verified.

## Verified source references
${refLines}

## Acceptance criteria
- The issue is confirmed in the actual code before any change is made.
- ${finding.recommendedNextStep || 'Resolve the confirmed gap without unrelated refactoring.'}
- New or changed behavior is covered by automated tests that actually ran.
${testSection}

---

`;

  const footer = `

---
_Handoff note: this prompt is for manual use with your coding agent. Direct execution in Claude Code, Antigravity or Codex is future work and was not performed._
`;

  return {
    ok: true,
    prompt: {
      title: finding.title,
      body: header + finding.generatedPrompt.trim() + footer,
      sourceRefs: refs,
      findingId: findingIdFor(record.roomId, record.fingerprint),
      fingerprint: record.fingerprint,
      roomId: record.roomId,
      evidenceClassification: classification,
    },
  };
}

// --- adapters ---------------------------------------------------------------

export function createClipboardAdapter(deps: { writeText(text: string): Thenable<void> | Promise<void> }): AgentHandoffAdapter {
  return {
    id: 'clipboard',
    label: 'Copy prompt',
    available: () => true,
    async handoff(prompt) {
      try {
        await deps.writeText(prompt.body);
        return { ok: true, adapterId: 'clipboard', message: 'Repair prompt copied to the clipboard.' };
      } catch {
        return { ok: false, adapterId: 'clipboard', reason: 'clipboard_failed', message: 'Could not copy the prompt to the clipboard.' };
      }
    },
  };
}

export interface FileAdapterDeps {
  /** Active workspace folder on disk; undefined disables the adapter. */
  workspaceRoot: string | undefined;
  /** Modal confirmation; must resolve true only on an explicit user choice. */
  confirm(message: string, detail: string): Promise<boolean>;
  mkdir?(dir: string): Promise<unknown>;
  writeFile?(file: string, content: string): Promise<void>;
  realpath?(p: string): Promise<string>;
}

export const PROMPT_DIR = '.living-blueprint/prompts';

function isInside(root: string, target: string): boolean {
  const rel = nodePath.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !nodePath.isAbsolute(rel);
}

export function createFileAdapter(deps: FileAdapterDeps): AgentHandoffAdapter {
  const mkdir = deps.mkdir ?? ((d: string) => nodeFs.mkdir(d, { recursive: true }));
  const writeFile = deps.writeFile ?? ((f: string, c: string) => nodeFs.writeFile(f, c, 'utf8'));
  const realpath = deps.realpath ?? ((p: string) => nodeFs.realpath(p));

  return {
    id: 'file',
    label: 'Save prompt file',
    available: () => Boolean(deps.workspaceRoot),
    async handoff(prompt) {
      const root = deps.workspaceRoot;
      if (!root) {
        return { ok: false, adapterId: 'file', reason: 'unavailable', message: 'No local workspace folder is open.' };
      }
      if (!/^[A-Za-z0-9._-]+$/.test(prompt.findingId) || prompt.findingId.startsWith('.')) {
        return { ok: false, adapterId: 'file', reason: 'outside_workspace', message: 'Invalid finding id for a file name.' };
      }

      const relPath = `${PROMPT_DIR}/${prompt.findingId}.md`;
      const dir = nodePath.resolve(root, PROMPT_DIR);
      const target = nodePath.resolve(dir, `${prompt.findingId}.md`);
      if (!isInside(root, target)) {
        return { ok: false, adapterId: 'file', reason: 'outside_workspace', message: 'Refusing to write outside the workspace.' };
      }

      const confirmed = await deps.confirm(
        `Save the repair prompt to ${relPath}?`,
        'The file is written inside this workspace only. Consider adding .living-blueprint/ to your .gitignore; it is not edited automatically.'
      );
      if (!confirmed) {
        return { ok: false, adapterId: 'file', reason: 'cancelled', message: 'Save cancelled. No file was written.' };
      }

      try {
        await mkdir(dir);
        // Guard against .living-blueprint being a symlink that points outside the workspace.
        const [realRoot, realDir] = await Promise.all([realpath(root), realpath(dir)]);
        if (!isInside(realRoot, nodePath.join(realDir, `${prompt.findingId}.md`))) {
          return { ok: false, adapterId: 'file', reason: 'outside_workspace', message: 'Refusing to write outside the workspace.' };
        }
        await writeFile(target, prompt.body);
        return { ok: true, adapterId: 'file', path: relPath, message: `Repair prompt saved to ${relPath}.` };
      } catch {
        return { ok: false, adapterId: 'file', reason: 'write_failed', message: 'Could not write the prompt file.' };
      }
    },
  };
}
