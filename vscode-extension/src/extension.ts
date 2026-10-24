import * as vscode from 'vscode';
import * as path from 'path';
import { BlueprintViewProvider } from './blueprintViewProvider.ts';
import { scanWorkspace, type WorkspaceBlueprintData } from './workspaceScanner.ts';
import {
  generateAutomaticCompanionAnalysis,
  askCompanion,
  type CompanionAnalysisResult,
} from './companionEngine.ts';
import { createChatSessionStore, DEFAULT_EXPLANATION_LEVEL } from './chatSession.ts';
import { createFindingsStore, investigateRoom } from './investigationService.ts';
import { buildHandoffPrompt, createClipboardAdapter, createFileAdapter } from './core/handoff.ts';
import { buildLensView } from './core/lenses.ts';
import { buildEvidenceChainView } from './core/evidenceChainView.ts';
import type { ArchitectureLensIdValue } from './protocol.ts';
import { applyLocalTestEvidence, createTestRunStore, runObservedTests } from './core/localEvidence.ts';
import { executeTestTask } from './testRunner.ts';
import { reinspectFinding } from './core/localReinspection.ts';
import type { ExplanationLevelValue } from './protocol.ts';
import {
  ScanController,
  type WorkspaceFolderInfo,
  type ScanState,
} from './scanController.ts';
import { shouldIgnorePath, isSensitivePath } from './scanFilters.ts';
import { createConsentManager } from './security/consent.ts';
import { createCredentialService, InvalidCredentialError, type CredentialId } from './security/credentials.ts';
import { evaluateAiGate, buildPayloadPreview, type AiGateContext } from './security/aiGate.ts';
import { createWorkspaceSnapshot, type WorkspaceSnapshot } from './core/snapshot.ts';

let globalScanController: ScanController | undefined;

export async function activate(context: vscode.ExtensionContext) {
  let latestData: WorkspaceBlueprintData | null = null;
  /** Scan output before local test evidence is applied (evidence is always applied to this base). */
  let baseData: WorkspaceBlueprintData | null = null;
  const initialFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // P2-07: per-folder consent (workspaceState), SecretStorage credentials, one AI gate.
  // Folder identity everywhere is folder.uri.toString(). The old global consent flag is ignored.
  const getConfig = () => vscode.workspace.getConfiguration('livingBlueprint');
  const consent = createConsentManager(context.workspaceState);
  const credentials = createCredentialService({
    secrets: context.secrets,
    getPolicy: () => ({ allowEnvCredentials: getConfig().get<boolean>('allowEnvCredentials', false) === true }),
    // Only consulted when livingBlueprint.allowEnvCredentials is explicitly true.
    env: process.env,
  });
  const openFolderUris = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString());
  const activeFolderUri = (): string | undefined => {
    const fsPath = scanController.getActiveFolderPath();
    return vscode.workspace.workspaceFolders?.find((f) => f.uri.fsPath === fsPath)?.uri.toString();
  };
  const gateContext: AiGateContext = {
    isTrusted: () => vscode.workspace.isTrusted,
    isAiEnabled: () => getConfig().get<boolean>('ai.enabled', true) !== false,
    getActiveFolderUri: activeFolderUri,
    getOpenFolderUris: openFolderUris,
    consent,
    credentials,
  };

  // Pushes trust/consent/key state to the webview. Credentials are read only when trust, setting and consent pass.
  const refreshSecurityState = async () => {
    const gate = await evaluateAiGate(gateContext);
    const folderUri = activeFolderUri();
    const granted = folderUri ? consent.isGranted(folderUri, openFolderUris()) : false;
    provider.setSecurityState(gate.status?.anyConfigured ?? false, granted, vscode.workspace.isTrusted);
  };

  const setAiConsent = async (enabled: boolean) => {
    const folderUri = activeFolderUri();
    if (!enabled) {
      if (folderUri) await consent.revoke(folderUri);
    } else if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('Living Blueprint: AI is disabled in untrusted workspaces.');
    } else if (folderUri) {
      const folderName = vscode.workspace.workspaceFolders?.find((f) => f.uri.toString() === folderUri)?.name;
      const choice = await vscode.window.showWarningMessage(
        `Allow Living Blueprint to send redacted architecture context from "${folderName ?? 'this folder'}" to your configured AI providers?`,
        {
          modal: true,
          detail:
            'Secret files are never read. Run "Living Blueprint: Preview AI Payload" to see the prepared context. You can revoke this at any time.',
        },
        'Allow'
      );
      if (choice === 'Allow') await consent.grant(folderUri, openFolderUris());
    }
    await refreshSecurityState();
  };

  // Sanitized preview of prepared context. Never includes credentials and never calls a provider.
  const buildPreview = async () => {
    const folderPath = scanController.getActiveFolderPath();
    const data = folderPath ? scanController.getSnapshot(folderPath) : undefined;
    if (!data) {
      return { notice: 'No workspace snapshot yet. Run a scan first.', previewOnly: true, networkCallMade: false, credentialsIncluded: false };
    }
    const snapshot = 'fingerprint' in data ? (data as WorkspaceSnapshot) : createWorkspaceSnapshot(data);
    return buildPayloadPreview(snapshot, undefined, await evaluateAiGate(gateContext));
  };

  // Collect dirty buffers from open documents without leaking sensitive files
  const getDirtyBuffersForFolder = (folderPath: string): Map<string, string> => {
    const dirtyMap = new Map<string, string>();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isDirty && doc.uri.scheme === 'file') {
        const filePath = doc.uri.fsPath;
        const relPath = path.relative(folderPath, filePath).replace(/\\/g, '/');
        if (!relPath.startsWith('..') && !path.isAbsolute(relPath)) {
          // Do not read or include dirty buffers for sensitive files
          if (!isSensitivePath(relPath).sensitive) {
            dirtyMap.set(relPath, doc.getText());
          }
        }
      }
    }
    return dirtyMap;
  };

  let editorPanel: vscode.WebviewPanel | undefined;

  const openEditorPanel = () => {
    if (editorPanel) {
      editorPanel.reveal(vscode.ViewColumn.One);
      return;
    }
    editorPanel = vscode.window.createWebviewPanel(
      'livingBlueprint.editorCanvas',
      'The Living Blueprint',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri],
      }
    );
    provider.attachEditorPanel(editorPanel);
    editorPanel.onDidDispose(() => {
      editorPanel = undefined;
    });
  };

  // Companion Q&A handler
  // P2-08: per-folder conversation, shared executeAiChat engine, stale questions cancelled.
  const chatStore = createChatSessionStore(context.workspaceState);
  let inFlight: AbortController | undefined;
  const cancelInFlight = () => {
    inFlight?.abort();
    inFlight = undefined;
  };

  // Full replacement of the visible conversation for the active folder (idempotent).
  // P2-10: findings per folder/room keyed to the snapshot fingerprint (stale, never silently deleted).
  const findingsStore = createFindingsStore(context.workspaceState);
  const currentFingerprint = (): string | undefined =>
    latestData && 'fingerprint' in latestData ? (latestData as WorkspaceSnapshot).fingerprint : undefined;

  // Findings (with stale flags) change on every scan. History and level only change per folder,
  // so they are not re-sent on rescans: re-sending would reset a question that is still pending.
  let historyPostedFor: string | undefined;
  const postConversation = (force = false) => {
    const folderUri = activeFolderUri();
    const fp = currentFingerprint();
    provider.post({
      type: 'investigationFindings',
      findings: folderUri && fp ? findingsStore.all(folderUri, fp) : {},
    });
    if (!force && folderUri === historyPostedFor) return;
    historyPostedFor = folderUri;
    provider.post({ type: 'conversationHistory', turns: folderUri ? chatStore.getTurns(folderUri) : [] });
    provider.post({
      type: 'explanationLevel',
      level: folderUri ? chatStore.getExplanationLevel(folderUri) : DEFAULT_EXPLANATION_LEVEL,
    });
  };

  const handleAskCompanion = async (
    question: string,
    roomId?: string,
    explanationLevel?: ExplanationLevelValue
  ) => {
    if (!latestData) {
      provider.post({ type: 'companionError', question, roomId, error: 'The workspace scan has not finished yet. Try again in a moment.' });
      return;
    }
    const folderUri = activeFolderUri();
    // A level sent with the question becomes the folder's persisted choice; otherwise use the stored one.
    if (folderUri && explanationLevel) await chatStore.setExplanationLevel(folderUri, explanationLevel);
    const level = folderUri ? chatStore.getExplanationLevel(folderUri) : explanationLevel ?? DEFAULT_EXPLANATION_LEVEL;
    cancelInFlight();
    const controller = new AbortController();
    inFlight = controller;
    try {
      // The P2-07 gate is evaluated inside askCompanion, at the network-call path.
      const result = await askCompanion(question, latestData, gateContext, {
        selectedRoomId: roomId,
        explanationLevel: level,
        history: folderUri ? chatStore.getHistory(folderUri) : [],
        // Only findings produced for the current snapshot are given to the companions.
        investigationFindings:
          folderUri && currentFingerprint() ? findingsStore.currentFindings(folderUri, currentFingerprint()!) : undefined,
        signal: controller.signal,
      });
      if (result.superseded || controller.signal.aborted) return;

      const meta = {
        mode: result.mode,
        offlineReason: result.offlineReason,
        providerUsed: result.providerUsed,
        fallbackUsed: result.fallbackUsed,
        cached: result.cached,
        timing: result.timing,
        warning: result.warning,
      };

      if (result.errorInfo || result.error) {
        provider.post({
          type: 'companionError',
          question,
          roomId,
          errorInfo: result.errorInfo,
          error: result.error,
          code: result.code,
          meta,
        });
        const info = result.errorInfo;
        const retry = info?.retryAfterSeconds ? ` Retry in ${info.retryAfterSeconds}s.` : '';
        void vscode.window.showWarningMessage(
          `Living Blueprint: ${info?.title ?? 'AI request failed'}. ${info?.message ?? result.error ?? ''}${retry}`
        );
        return;
      }

      provider.post({ type: 'companionReplies', question, roomId, messages: result.messages, meta });
      if (folderUri) {
        await chatStore.appendTurn(folderUri, {
          question,
          replies: result.messages.map((m) => ({ speaker: m.speaker, text: m.text, evidenceRefs: m.evidenceRefs })),
          selectedRoomId: roomId,
          mode: result.mode,
          at: new Date().toISOString(),
        });
      }
    } catch (err) {
      provider.post({ type: 'companionError', question, roomId, error: 'The companion request failed unexpectedly.' });
      console.error('[Living Blueprint] Companion query error:', err instanceof Error ? err.name : 'unknown');
    } finally {
      if (inFlight === controller) inFlight = undefined;
    }
  };

  const handleInvestigateRoom = async (roomId: string, bypassCache: boolean) => {
    const folderUri = activeFolderUri();
    if (!latestData || !folderUri) {
      provider.post({ type: 'investigationUnavailable', roomId, state: 'offline', reason: 'No workspace snapshot yet' });
      return;
    }
    provider.post({ type: 'investigationState', roomId, status: 'loading' });
    let outcome: Awaited<ReturnType<typeof investigateRoom>>;
    try {
      outcome = await investigateRoom({
        roomId,
        data: latestData,
        folderUri,
        gateContext,
        store: findingsStore,
        bypassCache,
      });
    } catch (err) {
      // Never leave the UI in a loading state.
      provider.post({ type: 'investigationError', roomId, error: 'The investigation failed unexpectedly.', previous: findingsStore.get(folderUri, roomId, currentFingerprint() ?? '') });
      console.error('[Living Blueprint] Investigation error:', err instanceof Error ? err.name : 'unknown');
      return;
    }

    switch (outcome.status) {
      case 'success':
        provider.post({ type: 'investigationResult', roomId, record: outcome.record, meta: outcome.meta });
        break;
      case 'invalid_room':
        provider.post({ type: 'investigationError', roomId, error: outcome.reason, code: 'INVALID_REQUEST' });
        break;
      case 'unavailable':
        provider.post({
          type: 'investigationUnavailable',
          roomId,
          state: outcome.state,
          reason: outcome.reason,
          previous: outcome.previous,
        });
        break;
      case 'error': {
        provider.post({
          type: 'investigationError',
          roomId,
          errorInfo: outcome.errorInfo,
          error: outcome.error,
          code: outcome.code,
          previous: outcome.previous,
          meta: outcome.meta,
        });
        const info = outcome.errorInfo;
        const retry = info?.retryAfterSeconds ? ` Retry in ${info.retryAfterSeconds}s.` : '';
        void vscode.window.showWarningMessage(
          `Living Blueprint: ${info?.title ?? 'Investigation failed'}. ${info?.message ?? outcome.error ?? ''}${retry}`
        );
        break;
      }
    }
  };

  // P2-11: copy/save handoff of a current finding's repair prompt. No agent execution.
  const handoffAdapters = {
    copy: createClipboardAdapter({ writeText: (text) => vscode.env.clipboard.writeText(text) }),
    save: () =>
      createFileAdapter({
        workspaceRoot: scanController.getActiveFolderPath(),
        confirm: async (message, detail) =>
          (await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Save')) === 'Save',
      }),
  };

  const handleHandoffRepairPrompt = async (roomId: string, action: 'copy' | 'save') => {
    const folderUri = activeFolderUri();
    const fp = currentFingerprint();
    const snapshot = latestData && fp ? (latestData as WorkspaceSnapshot) : undefined;
    if (!folderUri || !snapshot || !fp) {
      provider.post({ type: 'handoffResult', roomId, action, ok: false, reason: 'unavailable', message: 'No workspace snapshot yet.' });
      return;
    }
    const built = buildHandoffPrompt(findingsStore.get(folderUri, roomId, fp), snapshot);
    if (!built.ok) {
      provider.post({ type: 'handoffResult', roomId, action, ok: false, reason: 'invalid_finding', message: built.reason });
      return;
    }
    const adapter = action === 'copy' ? handoffAdapters.copy : handoffAdapters.save();
    const result = await adapter.handoff(built.prompt);
    provider.post({ type: 'handoffResult', roomId, action, findingId: built.prompt.findingId, ...result });
    if (result.ok) void vscode.window.showInformationMessage(`Living Blueprint: ${result.message}`);
    else if (result.reason !== 'cancelled') void vscode.window.showWarningMessage(`Living Blueprint: ${result.message}`);
  };

  // P2-12: architecture lenses and read-only evidence chain from the current snapshot.
  const currentSnapshot = (): WorkspaceSnapshot | undefined =>
    latestData && 'fingerprint' in latestData ? (latestData as WorkspaceSnapshot) : undefined;

  const handleSelectArchitectureLens = (lensId: ArchitectureLensIdValue) => {
    const snapshot = currentSnapshot();
    if (!snapshot) {
      provider.post({ type: 'architectureLens', lensId, graph: null, sufficientEvidence: false, message: 'No workspace snapshot yet.' });
      return;
    }
    provider.post({ type: 'architectureLens', ...buildLensView(lensId, snapshot) });
  };

  const handleRequestEvidenceChain = (roomId: string) => {
    const snapshot = currentSnapshot();
    const folderUri = activeFolderUri();
    const localRun = folderUri ? testRunStore.get(folderUri) : undefined;
    const result = snapshot
      ? buildEvidenceChainView(snapshot, roomId, localRun)
      : { ok: false as const, reason: 'No workspace snapshot yet.' };
    if (!result.ok) {
      provider.post({ type: 'evidenceChain', roomId, items: [], runEvidenceAvailable: false, droppedCount: 0, error: result.reason });
      return;
    }
    provider.post({ type: 'evidenceChain', ...result.view });
  };

  // P2-13: opt-in local test run as observed, snapshot-bound evidence.
  const testRunStore = createTestRunStore(context.workspaceState);
  let testRunInProgress = false;

  const withLocalTestEvidence = (data: WorkspaceBlueprintData): WorkspaceBlueprintData => {
    const folderUri = activeFolderUri();
    if (!folderUri || !('fingerprint' in data)) return data;
    return applyLocalTestEvidence(data as WorkspaceSnapshot, testRunStore.get(folderUri)).snapshot;
  };

  const postTestEvidenceState = () => {
    const folderUri = activeFolderUri();
    const record = folderUri ? testRunStore.get(folderUri) : undefined;
    const snapshot = baseData && 'fingerprint' in baseData ? (baseData as WorkspaceSnapshot) : undefined;
    if (!record || !snapshot) return;
    const applied = applyLocalTestEvidence(snapshot, record);
    provider.post({
      type: 'testRunEvidence',
      status: record.status,
      exitCode: record.exitCode,
      fingerprint: record.fingerprint,
      at: record.at,
      applied: applied.applied,
      stale: applied.stale,
      message: applied.reason,
    });
  };

  const handleRunProjectTests = async () => {
    if (testRunInProgress) {
      provider.post({ type: 'testRunState', state: 'running', message: 'A test run is already in progress.' });
      return;
    }
    const folderPath = scanController.getActiveFolderPath();
    const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.fsPath === folderPath);
    const folderUri = folder?.uri.toString();
    const snapshot = baseData && 'fingerprint' in baseData ? (baseData as WorkspaceSnapshot) : undefined;

    testRunInProgress = true;
    provider.post({ type: 'testRunState', state: 'running', message: 'Waiting for confirmation…' });
    try {
      const { result, record } = await runObservedTests({
        isTrusted: () => vscode.workspace.isTrusted,
        snapshot,
        cwd: folder ? folderPath : undefined,
        confirm: async (command, cwd) =>
          (await vscode.window.showWarningMessage(
            `Run \`${command}\` in ${cwd}?`,
            {
              modal: true,
              detail:
                'Runs in a visible terminal with a 120 s timeout. The exit code is recorded as test evidence for this workspace snapshot only. AI provider keys are not passed to the process.',
            },
            'Run tests'
          )) === 'Run tests',
        execute: (command, cwd, timeoutMs) => {
          provider.post({ type: 'testRunState', state: 'running', message: `Running \`${command}\`…` });
          return executeTestTask(folder!, command, cwd, timeoutMs);
        },
      });

      if (record && folderUri) {
        await testRunStore.save(folderUri, record);
        if (baseData) {
          latestData = withLocalTestEvidence(baseData);
          // Statuses only; no new companion analysis, which would replace the visible chat.
          provider.updateData(latestData);
        }
        postTestEvidenceState();
      }
      provider.post(result);
    } finally {
      testRunInProgress = false;
      provider.post({ type: 'testRunState', state: 'idle', message: '' });
    }
  };

  // P2-14: local, source-grounded re-inspection of a finding. No AI call, never "fixed".
  const handleReinspectFinding = async (roomId: string) => {
    const folderPath = scanController.getActiveFolderPath();
    const folderUri = activeFolderUri();
    if (!folderPath || !folderUri) {
      provider.post({ type: 'reinspectionResult', roomId, classification: 'not_comparable', message: 'No workspace folder is open.', evidence: [], testsPassedForCurrentSnapshot: false });
      return;
    }
    // Fresh scan (including unsaved editor changes) so the comparison uses the current files.
    const fresh = createWorkspaceSnapshot(
      await scanWorkspace(folderPath, { dirtyBuffers: getDirtyBuffersForFolder(folderPath) })
    );
    const record = findingsStore.get(folderUri, roomId, fresh.fingerprint);
    if (!record) {
      provider.post({
        type: 'reinspectionResult',
        roomId,
        fingerprint: fresh.fingerprint,
        classification: 'not_comparable',
        message: 'There is no investigation finding for this room to re-inspect.',
        evidence: [],
        testsPassedForCurrentSnapshot: false,
      });
      return;
    }
    const result = reinspectFinding(record, fresh, testRunStore.get(folderUri));
    await findingsStore.attachReinspection(folderUri, roomId, result);
    provider.post({ type: 'reinspectionResult', ...result });
    scanController.requestScan(true); // refresh the shown snapshot; findings then replay with stale flags
  };

  const handleClearConversation = async () => {
    cancelInFlight();
    const folderUri = activeFolderUri();
    if (folderUri) await chatStore.clear(folderUri);
    postConversation(true);
  };

  // Configure API Key securely via VS Code SecretStorage
  const handleConfigureApiKey = async () => {
    const choices: Array<{ label: string; id: CredentialId | 'CLEAR' | 'OMNIROUTE' }> = [
      { label: 'Google Gemini API Key', id: 'gemini' },
      { label: 'Groq API Key', id: 'groq' },
      { label: 'Cloudflare AI API Token', id: 'cloudflareToken' },
      { label: 'OmniRoute Gateway (optional, self-hosted)', id: 'OMNIROUTE' },
      { label: 'Clear Stored API Keys', id: 'CLEAR' },
    ];

    const selected = await vscode.window.showQuickPick(choices, {
      placeHolder: 'Select provider credential to configure in SecretStorage',
    });
    if (!selected) return;

    try {
      if (selected.id === 'CLEAR') {
        await credentials.clearAll();
        vscode.window.showInformationMessage('Living Blueprint: Stored AI credentials removed.');
        return;
      }

      if (selected.id === 'OMNIROUTE') {
        // OmniRoute is OpenAI-compatible; it is used only once a model is set.
        const baseUrl = await vscode.window.showInputBox({
          title: 'OmniRoute base URL',
          ignoreFocusOut: true,
          value: 'http://localhost:20128/v1',
          prompt: 'The /v1 endpoint of your running OmniRoute gateway.',
        });
        if (!baseUrl) return;
        const model = await vscode.window.showInputBox({
          title: 'OmniRoute model or combo',
          ignoreFocusOut: true,
          prompt: 'A model or combo id from your OmniRoute dashboard (required to enable it).',
        });
        if (!model || !model.trim()) return;
        const key = await vscode.window.showInputBox({
          title: 'OmniRoute gateway API key (optional)',
          password: true,
          ignoreFocusOut: true,
          prompt: 'Create one on the OmniRoute API Keys page. Leave empty if your gateway has no key.',
        });
        await credentials.setCredential('omnirouteBaseUrl', baseUrl);
        await credentials.setCredential('omnirouteModel', model);
        if (key && key.trim()) await credentials.setCredential('omnirouteKey', key);
        vscode.window.showInformationMessage(
          'Living Blueprint: OmniRoute configured. It is used alongside your other providers; the fastest answer wins.'
        );
        return;
      }

      const inputKey = await vscode.window.showInputBox({
        title: `Enter ${selected.label}`,
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'Paste API key / token (stored securely in VS Code SecretStorage)',
      });
      if (!inputKey || inputKey.trim().length === 0) return;
      await credentials.setCredential(selected.id, inputKey);

      if (selected.id === 'cloudflareToken') {
        const accountId = await vscode.window.showInputBox({
          title: 'Enter Cloudflare Account ID',
          ignoreFocusOut: true,
          placeHolder: '32-character hexadecimal account identifier',
        });
        if (accountId && accountId.trim().length > 0) {
          await credentials.setCredential('cloudflareAccount', accountId);
        }
        if (!(await credentials.getStatus()).cloudflare) {
          vscode.window.showWarningMessage(
            'Living Blueprint: Cloudflare needs both an API token and an account ID before it can be used.'
          );
        }
      }

      vscode.window.showInformationMessage(
        `Living Blueprint: Securely stored ${selected.label} in SecretStorage.`
      );
    } catch (err) {
      // InvalidCredentialError messages never contain the value.
      const message = err instanceof InvalidCredentialError ? err.message : 'Could not store the credential.';
      vscode.window.showErrorMessage(`Living Blueprint: ${message}`);
    } finally {
      await refreshSecurityState();
    }
  };

  const provider = new BlueprintViewProvider(context.extensionUri, initialFolder, {
    onRefreshRequested: () => scanController.requestScan(true),
    onAskCompanion: handleAskCompanion,
    onConfigureApiKey: handleConfigureApiKey,
    onToggleAiConsent: setAiConsent,
    onOpenEditorRequested: openEditorPanel,
    onSelectFolder: (folderPath: string) => {
      const folderInfos = scanController.getFolders();
      if (!folderInfos.some((f) => f.uri.fsPath === folderPath)) {
        return;
      }
      cancelInFlight();
      scanController.setActiveFolder(folderPath);
      provider.postWorkspaceFolders(folderInfos, folderPath);
      void refreshSecurityState(); // consent is per folder
      postConversation(); // conversation is per folder
    },
    onRequestPayloadPreview: buildPreview,
    onRoomSelected: () => cancelInFlight(), // a room switch supersedes the pending question
    onClearConversation: handleClearConversation,
    onInvestigateRoom: handleInvestigateRoom,
    onHandoffRepairPrompt: handleHandoffRepairPrompt,
    onSelectArchitectureLens: handleSelectArchitectureLens,
    onRunProjectTests: handleRunProjectTests,
    onReinspectFinding: handleReinspectFinding,
    onRequestEvidenceChain: handleRequestEvidenceChain,
    onSetExplanationLevel: async (level) => {
      const folderUri = activeFolderUri();
      if (folderUri) await chatStore.setExplanationLevel(folderUri, level);
      provider.post({ type: 'explanationLevel', level });
    },
  });

  const scanController = new ScanController({
    debounceMs: 400,
    getDirtyBuffers: getDirtyBuffersForFolder,
    scanFn: async (folderPath, signal, dirtyBuffers) => {
      return scanWorkspace(folderPath, { signal, dirtyBuffers });
    },
    onStateChange: (state: ScanState) => {
      provider.postScanState(state);
      provider.setScanning(state.status === 'scanning');
    },
    onScanComplete: async (_folderPath, blueprintData, isStale) => {
      // Statuses shown are the scan's, re-evaluated with any local test run for this exact fingerprint.
      baseData = blueprintData;
      latestData = withLocalTestEvidence(blueprintData);

      const companionAnalysis: CompanionAnalysisResult =
        generateAutomaticCompanionAnalysis(latestData);

      await refreshSecurityState();
      provider.updateData(latestData, companionAnalysis);
      postConversation();
      postTestEvidenceState();

      if (isStale) {
        provider.postScanState({
          status: 'error',
          message: 'Displaying previous architecture snapshot (stale).',
          isStale: true,
          timestamp: new Date().toISOString(),
        });
      }
    },
  });

  globalScanController = scanController;

  // A view opened after the first scan gets history, level, findings and test evidence too.
  provider.onViewReady = () => {
    postConversation(true);
    postTestEvidenceState();
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(BlueprintViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('livingBlueprint.focus', () => {
      vscode.commands.executeCommand('livingBlueprint.overviewView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('livingBlueprint.refresh', () => {
      scanController.requestScan(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('livingBlueprint.openEditor', () => {
      openEditorPanel();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('livingBlueprint.setApiKey', () => {
      handleConfigureApiKey();
    })
  );

  // Set up per-workspace-folder file watchers with RelativePattern and unified filter
  const activeWatchers: vscode.FileSystemWatcher[] = [];

  const setupFolderWatchers = () => {
    // Dispose previous watchers
    for (const w of activeWatchers) {
      w.dispose();
    }
    activeWatchers.length = 0;

    const folders = vscode.workspace.workspaceFolders || [];
    const folderInfos: WorkspaceFolderInfo[] = folders.map((f, idx) => ({
      uri: { fsPath: f.uri.fsPath },
      name: f.name,
      index: idx,
    }));

    for (const folder of folders) {
      const pattern = new vscode.RelativePattern(folder, '**/*');
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);

      const handleEvent = (uri: vscode.Uri) => {
        const relPath = path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
        // Reuse exact same ignore predicate as scanner
        const decision = shouldIgnorePath(relPath, false);
        if (!decision.ignored) {
          scanController.requestScan(false, folder.uri.fsPath);
        }
      };

      watcher.onDidChange(handleEvent);
      watcher.onDidCreate(handleEvent);
      watcher.onDidDelete(handleEvent);

      activeWatchers.push(watcher);
      context.subscriptions.push(watcher);
    }

    scanController.setFolders(folderInfos);
    provider.postWorkspaceFolders(folderInfos, scanController.getActiveFolderPath());
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('livingBlueprint.runProjectTests', () => handleRunProjectTests())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('livingBlueprint.previewAiPayload', async () => {
      const preview = await buildPreview();
      const doc = await vscode.workspace.openTextDocument({
        language: 'json',
        content: JSON.stringify(preview, null, 2),
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    })
  );

  // Consent is bound to the open folder set: prune stale grants whenever it changes.
  const pruneConsentAndRefresh = async () => {
    await consent.pruneStale(openFolderUris());
    await refreshSecurityState();
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      setupFolderWatchers();
      void pruneConsentAndRefresh();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void refreshSecurityState();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('livingBlueprint')) void refreshSecurityState();
    })
  );

  // Initial folder setup and discovery
  setupFolderWatchers();
  void pruneConsentAndRefresh();

  // Read-only hook for the opt-in Extension Development Host smoke suite (P2-15).
  // Exposes no secrets, credentials or excerpts: only state the webview already receives.
  return {
    __test: {
      getScanState: () => scanController.getState(),
      getRoomIds: () => (latestData?.rooms ?? []).map((r) => r.id),
      getFingerprint: () => currentFingerprint(),
      /** Drives the real validated webview message path. */
      dispatch: (message: unknown) => provider.handleInboundMessage(message),
      /** Observes host→webview messages (undefined to stop). */
      tap: (listener: ((message: unknown) => void) | undefined) => {
        provider.testTap = listener;
      },
    },
  };
}

export function deactivate() {
  if (globalScanController) {
    globalScanController.dispose();
    globalScanController = undefined;
  }
}
