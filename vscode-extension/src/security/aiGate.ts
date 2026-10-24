/**
 * aiGate.ts — The single gate every AI provider request must pass (P2-07).
 *
 * Check order: workspace trust → livingBlueprint.ai.enabled → an active folder
 * → consent for that folder → credentials. Credentials are read only after the
 * first four checks pass, so an untrusted or non-consenting workspace never
 * touches SecretStorage or the environment.
 *
 * Pure TypeScript: no vscode import. extension.ts supplies the context.
 */

import type { ConsentManager } from './consent.ts';
import type { CredentialService, CredentialStatus, ProviderEnv } from './credentials.ts';
import { toChatRepoContext } from '../core/chatRequest.ts';
import { getSnapshotHostExcerpts, type WorkspaceSnapshot } from '../core/snapshot.ts';

export type AiState = 'blockedUntrusted' | 'disabled' | 'offline' | 'needsKey' | 'ready';

export interface AiGateContext {
  isTrusted(): boolean;
  isAiEnabled(): boolean;
  /** Stable folder identity: folder.uri.toString(). */
  getActiveFolderUri(): string | undefined;
  getOpenFolderUris(): readonly string[];
  consent: ConsentManager;
  credentials: CredentialService;
}

export type AiGateResult =
  | { allowed: true; state: 'ready'; folderUri: string; env: ProviderEnv; status: CredentialStatus }
  | { allowed: false; state: Exclude<AiState, 'ready'>; reason: string; status?: CredentialStatus };

type Preconditions =
  | { ok: true; folderUri: string }
  | { ok: false; state: Exclude<AiState, 'ready' | 'needsKey'>; reason: string };

/** Synchronous checks that never read credentials. */
export function checkAiPreconditions(ctx: AiGateContext, folderUri = ctx.getActiveFolderUri()): Preconditions {
  if (!ctx.isTrusted()) {
    return { ok: false, state: 'blockedUntrusted', reason: 'Workspace is not trusted' };
  }
  if (!ctx.isAiEnabled()) {
    return { ok: false, state: 'disabled', reason: 'AI is disabled in settings (livingBlueprint.ai.enabled)' };
  }
  if (!folderUri) {
    return { ok: false, state: 'offline', reason: 'No workspace folder is open' };
  }
  if (!ctx.consent.isGranted(folderUri, ctx.getOpenFolderUris())) {
    return { ok: false, state: 'offline', reason: 'AI consent has not been granted for this workspace folder' };
  }
  return { ok: true, folderUri };
}

export async function evaluateAiGate(ctx: AiGateContext): Promise<AiGateResult> {
  const pre = checkAiPreconditions(ctx);
  if (!pre.ok) {
    return { allowed: false, state: pre.state, reason: pre.reason };
  }
  const status = await ctx.credentials.getStatus();
  if (!status.anyConfigured) {
    return { allowed: false, state: 'needsKey', reason: 'No complete AI provider credentials are configured', status };
  }
  return { allowed: true, state: 'ready', folderUri: pre.folderUri, env: await ctx.credentials.buildProviderEnv(), status };
}

/**
 * Wraps fetch so every provider attempt re-checks trust, the setting and consent
 * for the folder the request started in. Revoking consent mid-request blocks
 * any further provider calls (including fallbacks to the next provider).
 */
export function guardFetch(fetchFn: typeof fetch, ctx: AiGateContext, folderUri: string): typeof fetch {
  const guarded = (...args: Parameters<typeof fetch>) => {
    const pre = checkAiPreconditions(ctx, folderUri);
    if (!pre.ok) {
      return Promise.reject(new Error(`AI request blocked: ${pre.reason}`));
    }
    return fetchFn(...args);
  };
  return guarded as typeof fetch;
}

/**
 * Builds a credential-free, webview-safe preview of the repository context that
 * toChatRepoContext produces. Excerpt text stays on the host: only per-file
 * character counts are included. Makes no network call.
 */
export function buildPayloadPreview(
  snapshot: WorkspaceSnapshot,
  selectedRoomId: string | undefined,
  gate: AiGateResult
) {
  const repoContext = toChatRepoContext(snapshot, selectedRoomId);
  const excerpts = getSnapshotHostExcerpts(snapshot);
  const inspectedFiles = repoContext.inspectedFiles.map((f) => ({
    path: f.path,
    category: f.category,
    sizeBytes: f.sizeBytes,
    excerptChars: excerpts.get(f.path)?.length ?? 0,
  }));

  return {
    notice:
      'Preview of the repository context built by toChatRepoContext. The current live chat is not yet connected ' +
      'to this adapter (planned for P2-08) and sends less: no file excerpts. Excerpt text is shown as counts only.',
    previewOnly: true,
    networkCallMade: false,
    credentialsIncluded: false,
    aiState: gate.state,
    aiStateReason: gate.allowed ? 'AI requests are allowed' : gate.reason,
    // Provider names are listed only when the gate reached the credential check.
    providersConfigured: gate.status
      ? (['gemini', 'groq', 'omniroute', 'cloudflare'] as const).filter((p) => gate.status?.[p])
      : 'not checked (consent off, AI disabled or workspace untrusted)',
    usingEnvironmentCredentials: gate.status?.usingEnvironment ?? false,
    repository: { name: repoContext.repo, owner: repoContext.owner, fingerprint: repoContext.commitSha },
    discoveredFilesCount: snapshot.discoveredFilesCount,
    inspectedFilesCount: snapshot.inspectedFilesCount,
    skippedFilesCount: snapshot.skippedFiles.length,
    excerptTotals: {
      files: inspectedFiles.filter((f) => f.excerptChars > 0).length,
      chars: inspectedFiles.reduce((sum, f) => sum + f.excerptChars, 0),
    },
    repoContext: { ...repoContext, inspectedFiles },
  };
}
