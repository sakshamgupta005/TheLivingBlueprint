import * as vscode from 'vscode';
import * as path from 'path';
import { BlueprintViewProvider } from './blueprintViewProvider.ts';
import { scanWorkspace, type WorkspaceBlueprintData } from './workspaceScanner.ts';
import {
  generateAutomaticCompanionAnalysis,
  answerCompanionQuery,
  type CompanionAnalysisResult,
} from './companionEngine.ts';
import {
  ScanController,
  type WorkspaceFolderInfo,
  type ScanState,
} from './scanController.ts';
import { shouldIgnorePath, isSensitivePath } from './scanFilters.ts';

const SECRET_GEMINI_KEY = 'livingBlueprint.geminiApiKey';
const SECRET_GROQ_KEY = 'livingBlueprint.groqApiKey';
const SECRET_CLOUDFLARE_TOKEN = 'livingBlueprint.cloudflareToken';
const SECRET_CLOUDFLARE_ACCOUNT = 'livingBlueprint.cloudflareAccount';
const STATE_AI_CONSENT = 'livingBlueprint.aiConsent';

let globalScanController: ScanController | undefined;

export async function activate(context: vscode.ExtensionContext) {
  let latestData: WorkspaceBlueprintData | null = null;
  const initialFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Retrieve current security & consent state from SecretStorage / globalState
  const getApiKeys = async () => {
    const geminiKey =
      (await context.secrets.get(SECRET_GEMINI_KEY)) ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_GENAI_API_KEY;
    const groqKey = (await context.secrets.get(SECRET_GROQ_KEY)) || process.env.GROQ_API_KEY;
    const cloudflareToken =
      (await context.secrets.get(SECRET_CLOUDFLARE_TOKEN)) || process.env.CLOUDFLARE_API_TOKEN;
    const cloudflareAccountId =
      (await context.secrets.get(SECRET_CLOUDFLARE_ACCOUNT)) || process.env.CLOUDFLARE_ACCOUNT_ID;

    return {
      geminiKey: geminiKey?.trim() || undefined,
      groqKey: groqKey?.trim() || undefined,
      cloudflareToken: cloudflareToken?.trim() || undefined,
      cloudflareAccountId: cloudflareAccountId?.trim() || undefined,
    };
  };

  const getAiConsent = (): boolean => {
    return Boolean(context.globalState.get<boolean>(STATE_AI_CONSENT, false));
  };

  const setAiConsent = async (enabled: boolean) => {
    await context.globalState.update(STATE_AI_CONSENT, enabled);
    const keys = await getApiKeys();
    const hasKey = Boolean(keys.geminiKey || keys.groqKey || keys.cloudflareToken);
    provider.setSecurityState(hasKey, enabled);
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
  const handleAskCompanion = async (question: string) => {
    if (!latestData) return;
    try {
      const keys = await getApiKeys();
      const consent = getAiConsent();
      const replies = await answerCompanionQuery(question, latestData, keys, consent);
      provider.appendCompanionMessages(replies);
    } catch (err) {
      console.error('[Living Blueprint] Companion query error:', err);
    }
  };

  // Configure API Key securely via VS Code SecretStorage
  const handleConfigureApiKey = async () => {
    const choices = [
      { label: 'Google Gemini API Key', key: SECRET_GEMINI_KEY },
      { label: 'Groq API Key', key: SECRET_GROQ_KEY },
      { label: 'Cloudflare AI API Token', key: SECRET_CLOUDFLARE_TOKEN },
      { label: 'Clear Stored API Keys', key: 'CLEAR' },
    ];

    const selected = await vscode.window.showQuickPick(choices, {
      placeHolder: 'Select provider credential to configure in SecretStorage',
    });
    if (!selected) return;

    if (selected.key === 'CLEAR') {
      await context.secrets.delete(SECRET_GEMINI_KEY);
      await context.secrets.delete(SECRET_GROQ_KEY);
      await context.secrets.delete(SECRET_CLOUDFLARE_TOKEN);
      await context.secrets.delete(SECRET_CLOUDFLARE_ACCOUNT);
      vscode.window.showInformationMessage('Living Blueprint: Stored AI credentials removed.');
      provider.setSecurityState(false, getAiConsent());
      return;
    }

    const inputKey = await vscode.window.showInputBox({
      title: `Enter ${selected.label}`,
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'Paste API key / token (stored securely in VS Code SecretStorage)',
    });

    if (inputKey && inputKey.trim().length > 0) {
      await context.secrets.store(selected.key, inputKey.trim());

      if (selected.key === SECRET_CLOUDFLARE_TOKEN) {
        const accountId = await vscode.window.showInputBox({
          title: 'Enter Cloudflare Account ID',
          ignoreFocusOut: true,
          placeHolder: '32-character hexadecimal account identifier',
        });
        if (accountId && accountId.trim().length > 0) {
          await context.secrets.store(SECRET_CLOUDFLARE_ACCOUNT, accountId.trim());
        }
      }

      vscode.window.showInformationMessage(
        `Living Blueprint: Securely stored ${selected.label} in SecretStorage.`
      );
      provider.setSecurityState(true, getAiConsent());
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
      scanController.setActiveFolder(folderPath);
      provider.postWorkspaceFolders(folderInfos, folderPath);
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
      latestData = blueprintData;

      const companionAnalysis: CompanionAnalysisResult =
        generateAutomaticCompanionAnalysis(blueprintData);

      const keys = await getApiKeys();
      const hasKey = Boolean(keys.geminiKey || keys.groqKey || keys.cloudflareToken);
      provider.setSecurityState(hasKey, getAiConsent());
      provider.updateData(blueprintData, companionAnalysis);

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
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      setupFolderWatchers();
    })
  );

  // Initial folder setup and discovery
  setupFolderWatchers();
}

export function deactivate() {
  if (globalScanController) {
    globalScanController.dispose();
    globalScanController = undefined;
  }
}
