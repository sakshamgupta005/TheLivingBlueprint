import * as vscode from 'vscode';
import { BlueprintViewProvider } from './blueprintViewProvider.ts';
import { scanWorkspace, type WorkspaceBlueprintData } from './workspaceScanner.ts';
import {
  generateAutomaticCompanionAnalysis,
  answerCompanionQuery,
  type CompanionAnalysisResult,
} from './companionEngine.ts';

const SECRET_GEMINI_KEY = 'livingBlueprint.geminiApiKey';
const SECRET_GROQ_KEY = 'livingBlueprint.groqApiKey';
const SECRET_CLOUDFLARE_TOKEN = 'livingBlueprint.cloudflareToken';
const SECRET_CLOUDFLARE_ACCOUNT = 'livingBlueprint.cloudflareAccount';
const STATE_AI_CONSENT = 'livingBlueprint.aiConsent';

let debounceTimer: NodeJS.Timeout | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceRoot = workspaceFolder ? workspaceFolder.uri.fsPath : undefined;

  let isScanning = false;
  let latestData: WorkspaceBlueprintData | null = null;

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

  const performScan = async () => {
    if (!workspaceRoot || isScanning) {
      return;
    }
    try {
      isScanning = true;
      provider.setScanning(true);
      const blueprintData = await scanWorkspace(workspaceRoot);
      latestData = blueprintData;

      // Automatically generate grounded companion analysis from discovered workspace architecture
      const companionAnalysis: CompanionAnalysisResult =
        generateAutomaticCompanionAnalysis(blueprintData);

      const keys = await getApiKeys();
      const hasKey = Boolean(keys.geminiKey || keys.groqKey || keys.cloudflareToken);
      provider.setSecurityState(hasKey, getAiConsent());
      provider.updateData(blueprintData, companionAnalysis);
    } catch (err) {
      console.error('[Living Blueprint] Scan failure:', err);
    } finally {
      isScanning = false;
      provider.setScanning(false);
    }
  };

  const scheduleDebouncedScan = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      performScan();
    }, 400);
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

  const provider = new BlueprintViewProvider(context.extensionUri, workspaceRoot, {
    onRefreshRequested: () => performScan(),
    onAskCompanion: handleAskCompanion,
    onConfigureApiKey: handleConfigureApiKey,
    onToggleAiConsent: setAiConsent,
    onOpenEditorRequested: openEditorPanel,
  });

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
      performScan();
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

  // Set up debounced file watcher for automatic workspace updates
  if (workspaceRoot) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');

    const isIgnored = (uri: vscode.Uri) => {
      const p = uri.fsPath.replace(/\\/g, '/');
      return /(?:^|\/)(?:\.git|node_modules|dist|build|\.next|\.nuxt|vendor|coverage|\.vscode|out|target|\.turbo)\//.test(
        p
      );
    };

    watcher.onDidChange((uri) => {
      if (!isIgnored(uri)) scheduleDebouncedScan();
    });
    watcher.onDidCreate((uri) => {
      if (!isIgnored(uri)) scheduleDebouncedScan();
    });
    watcher.onDidDelete((uri) => {
      if (!isIgnored(uri)) scheduleDebouncedScan();
    });

    context.subscriptions.push(watcher);

    // Initial automatic scan & companion analysis on activation
    performScan();
  }
}

export function deactivate() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
}
