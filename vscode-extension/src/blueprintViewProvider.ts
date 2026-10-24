import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { WorkspaceBlueprintData } from './workspaceScanner.ts';
import type { CompanionAnalysisResult } from './companionEngine.ts';
import { validateInboundMessage, type ExplanationLevelValue, type ArchitectureLensIdValue } from './protocol.ts';
import { resolveWorkspaceFile } from './pathResolver.ts';

export type AskCompanionHandler = (
  question: string,
  roomId?: string,
  explanationLevel?: ExplanationLevelValue
) => Promise<void>;

export class BlueprintViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'livingBlueprint.overviewView';
  private _view?: vscode.WebviewView;
  private _editorPanel?: vscode.WebviewPanel;
  private _latestData: WorkspaceBlueprintData | null = null;
  private _latestCompanionAnalysis: CompanionAnalysisResult | null = null;
  private _hasApiKey = false;
  private _aiConsent = false;
  private _selectedRoomId: string | null = null;
  private _latestScanState?: any;
  private _latestFolders?: { folders: any[]; activeFolderPath?: string };

  private _onRefreshRequested?: () => void;
  private _onAskCompanion?: AskCompanionHandler;
  private _onConfigureApiKey?: () => Promise<void>;
  private _onToggleAiConsent?: (enabled: boolean) => Promise<void>;
  private _onOpenEditorRequested?: () => void;
  private _onSelectFolder?: (folderPath: string) => void;
  private _onRequestPayloadPreview?: () => Promise<unknown>;
  private _onRoomSelected?: (roomId: string | null) => void;
  private _onClearConversation?: () => Promise<void>;
  private _onSetExplanationLevel?: (level: ExplanationLevelValue) => Promise<void>;
  private _onInvestigateRoom?: (roomId: string, bypassCache: boolean) => Promise<void>;
  private _onHandoffRepairPrompt?: (roomId: string, action: 'copy' | 'save') => Promise<void>;
  private _onSelectArchitectureLens?: (lensId: ArchitectureLensIdValue) => void;
  private _onRequestEvidenceChain?: (roomId: string) => void;
  private _onRunProjectTests?: () => Promise<void>;
  private _onReinspectFinding?: (roomId: string) => Promise<void>;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _workspaceRoot?: string,
    handlers?: {
      onRefreshRequested?: () => void;
      onAskCompanion?: AskCompanionHandler;
      onConfigureApiKey?: () => Promise<void>;
      onToggleAiConsent?: (enabled: boolean) => Promise<void>;
      onOpenEditorRequested?: () => void;
      onSelectFolder?: (folderPath: string) => void;
      onRequestPayloadPreview?: () => Promise<unknown>;
      onRoomSelected?: (roomId: string | null) => void;
      onClearConversation?: () => Promise<void>;
      onSetExplanationLevel?: (level: ExplanationLevelValue) => Promise<void>;
      onInvestigateRoom?: (roomId: string, bypassCache: boolean) => Promise<void>;
      onHandoffRepairPrompt?: (roomId: string, action: 'copy' | 'save') => Promise<void>;
      onSelectArchitectureLens?: (lensId: ArchitectureLensIdValue) => void;
      onRequestEvidenceChain?: (roomId: string) => void;
      onRunProjectTests?: () => Promise<void>;
      onReinspectFinding?: (roomId: string) => Promise<void>;
    }
  ) {
    if (handlers) {
      this._onRefreshRequested = handlers.onRefreshRequested;
      this._onAskCompanion = handlers.onAskCompanion;
      this._onConfigureApiKey = handlers.onConfigureApiKey;
      this._onToggleAiConsent = handlers.onToggleAiConsent;
      this._onOpenEditorRequested = handlers.onOpenEditorRequested;
      this._onSelectFolder = handlers.onSelectFolder;
      this._onRequestPayloadPreview = handlers.onRequestPayloadPreview;
      this._onRoomSelected = handlers.onRoomSelected;
      this._onClearConversation = handlers.onClearConversation;
      this._onSetExplanationLevel = handlers.onSetExplanationLevel;
      this._onInvestigateRoom = handlers.onInvestigateRoom;
      this._onHandoffRepairPrompt = handlers.onHandoffRepairPrompt;
      this._onSelectArchitectureLens = handlers.onSelectArchitectureLens;
      this._onRequestEvidenceChain = handlers.onRequestEvidenceChain;
      this._onRunProjectTests = handlers.onRunProjectTests;
      this._onReinspectFinding = handlers.onReinspectFinding;
    }
  }

  /** Posts a host message to every open Living Blueprint webview. */
  public post(message: unknown) {
    this._postToAll(message);
  }

  public setSecurityState(hasApiKey: boolean, aiConsent: boolean, isTrusted = true) {
    this._hasApiKey = hasApiKey;
    this._aiConsent = aiConsent;
    this._isTrusted = isTrusted;
    this._postToAll(this._securityMessage());
  }

  private _isTrusted = true;
  /** Called after a webview (sidebar or editor panel) is created, so the host can replay its state. */
  public onViewReady?: () => void;

  private _securityMessage() {
    return { type: 'securityState', hasApiKey: this._hasApiKey, aiConsent: this._aiConsent, isTrusted: this._isTrusted };
  }

  /** Replays state a newly opened view would otherwise miss until the next scan. */
  private _replayHostState(webview: vscode.Webview) {
    webview.postMessage(this._securityMessage());
    this.onViewReady?.();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    this._attachMessageHandlers(webviewView.webview);

    if (this._latestData) {
      this.updateData(this._latestData, this._latestCompanionAnalysis);
    }
    if (this._latestScanState) {
      webviewView.webview.postMessage({ type: 'scanState', state: this._latestScanState });
    }
    if (this._latestFolders) {
      webviewView.webview.postMessage({ type: 'workspaceFolders', ...this._latestFolders });
    }
    this._replayHostState(webviewView.webview);
  }

  public attachEditorPanel(panel: vscode.WebviewPanel) {
    this._editorPanel = panel;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    panel.webview.html = this._getHtmlForWebview(panel.webview);
    this._attachMessageHandlers(panel.webview);

    panel.onDidDispose(() => {
      this._editorPanel = undefined;
    });

    if (this._latestData) {
      panel.webview.postMessage({
        type: 'updateBlueprint',
        data: this._latestData,
        selectedRoomId: this._selectedRoomId,
      });
      if (this._latestCompanionAnalysis) {
        panel.webview.postMessage({
          type: 'companionAnalysis',
          analysis: this._latestCompanionAnalysis,
        });
      }
    }
    if (this._latestScanState) {
      panel.webview.postMessage({ type: 'scanState', state: this._latestScanState });
    }
    if (this._latestFolders) {
      panel.webview.postMessage({ type: 'workspaceFolders', ...this._latestFolders });
    }
    this._replayHostState(panel.webview);
  }

  private _postToAll(message: unknown) {
    this.testTap?.(message);
    if (this._view) {
      this._view.webview.postMessage(message);
    }
    if (this._editorPanel) {
      this._editorPanel.webview.postMessage(message);
    }
  }

  private _getWorkspaceRoots(): string[] {
    const wsFolders = vscode.workspace.workspaceFolders;
    if (wsFolders && wsFolders.length > 0) {
      return wsFolders.map((f) => f.uri.fsPath);
    }
    return this._workspaceRoot ? [this._workspaceRoot] : [];
  }

  private _getActiveRoot(): string | undefined {
    const roots = this._getWorkspaceRoots();
    const candidate = this._latestFolders?.activeFolderPath;
    if (candidate && roots.includes(candidate)) {
      return candidate;
    }
    return this._workspaceRoot || roots[0];
  }

  private _attachMessageHandlers(webview: vscode.Webview) {
    webview.onDidReceiveMessage((rawMessage) => this.handleInboundMessage(rawMessage));
  }

  /** Optional observer of every host→webview message (read-only; used by host smoke tests). */
  public testTap?: (message: unknown) => void;

  /** The single validated entry point for webview messages (also driven by host smoke tests). */
  public async handleInboundMessage(rawMessage: unknown): Promise<void> {
    const validRoomIds = this._latestData?.rooms.map((r) => r.id);
    const validation = validateInboundMessage(rawMessage, { validRoomIds });

    if (!validation.valid) {
      console.warn(`[Living Blueprint] Inbound message rejected: ${validation.reason}`);
      // Tell the UI so a pending spinner or watchdog can stop instead of hanging.
      const raw = rawMessage as { command?: unknown; roomId?: unknown } | null;
      this._postToAll({
        type: 'requestRejected',
        command: typeof raw?.command === 'string' ? raw.command.slice(0, 64) : undefined,
        roomId: typeof raw?.roomId === 'string' ? raw.roomId.slice(0, 256) : undefined,
        reason: validation.reason,
      });
      return;
    }

    const message = validation.message;
    switch (message.command) {
      case 'openFile': {
        const workspaceRoots = this._getWorkspaceRoots();
        const activeRoot = this._getActiveRoot();
        const resolution = resolveWorkspaceFile(message.path, {
          workspaceRoots,
          activeRoot,
          discoveredFiles: this._latestData ? this._latestData.discoveredFilePaths : null,
          hasSnapshot: Boolean(this._latestData),
        });

        if (!resolution.success) {
          vscode.window.showWarningMessage('Invalid or restricted file path');
          return;
        }

        try {
          const doc = await vscode.workspace.openTextDocument(
            vscode.Uri.file(resolution.resolvedPath)
          );
          const editor = await vscode.window.showTextDocument(doc);
          if (message.line !== undefined && message.line > 0) {
            const lineIdx = message.line - 1;
            const pos = new vscode.Position(lineIdx, 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(
              new vscode.Range(pos, pos),
              vscode.TextEditorRevealType.InCenter
            );
          }
        } catch {
          vscode.window.showErrorMessage('Could not open file in editor');
        }
        break;
      }
      case 'refresh': {
        if (this._onRefreshRequested) {
          this._onRefreshRequested();
        }
        break;
      }
      case 'openEditorPanel': {
        if (this._onOpenEditorRequested) {
          this._onOpenEditorRequested();
        }
        break;
      }
      case 'askCompanion': {
        if (this._onAskCompanion) {
          this.setCompanionThinking(true);
          try {
            await this._onAskCompanion(
              message.question,
              message.roomId ?? this._selectedRoomId ?? undefined,
              message.explanationLevel
            );
          } finally {
            this.setCompanionThinking(false);
          }
        }
        break;
      }
      case 'configureApiKey': {
        if (this._onConfigureApiKey) {
          await this._onConfigureApiKey();
        }
        break;
      }
      case 'toggleAiConsent': {
        if (this._onToggleAiConsent) {
          await this._onToggleAiConsent(message.enabled);
        }
        break;
      }
      case 'selectRoom': {
        const changed = (message.roomId || null) !== this._selectedRoomId;
        this._selectedRoomId = message.roomId || null;
        this._postToAll({
          type: 'roomSelected',
          roomId: this._selectedRoomId,
        });
        if (changed) this._onRoomSelected?.(this._selectedRoomId);
        break;
      }
      case 'clearConversation': {
        await this._onClearConversation?.();
        break;
      }
      case 'setExplanationLevel': {
        await this._onSetExplanationLevel?.(message.level);
        break;
      }
      case 'investigateRoom': {
        await this._onInvestigateRoom?.(message.roomId, message.bypassCache === true);
        break;
      }
      case 'handoffRepairPrompt': {
        await this._onHandoffRepairPrompt?.(message.roomId, message.action);
        break;
      }
      case 'selectArchitectureLens': {
        this._onSelectArchitectureLens?.(message.lensId);
        break;
      }
      case 'requestEvidenceChain': {
        this._onRequestEvidenceChain?.(message.roomId);
        break;
      }
      case 'runProjectTests': {
        await this._onRunProjectTests?.();
        break;
      }
      case 'reinspectFinding': {
        await this._onReinspectFinding?.(message.roomId);
        break;
      }
      case 'selectFolder': {
        if (this._onSelectFolder) {
          this._onSelectFolder(message.folderPath);
        }
        break;
      }
      case 'requestPayloadPreview': {
        if (this._onRequestPayloadPreview) {
          const payload = await this._onRequestPayloadPreview();
          this._postToAll({ type: 'payloadPreview', payload });
        }
        break;
      }
    }
  }

  public postScanState(state: any) {
    this._latestScanState = state;
    this._postToAll({
      type: 'scanState',
      state,
    });
  }

  public postWorkspaceFolders(folders: any[], activeFolderPath?: string) {
    this._latestFolders = { folders, activeFolderPath };
    this._postToAll({
      type: 'workspaceFolders',
      folders,
      activeFolderPath,
    });
  }

  public updateData(
    data: WorkspaceBlueprintData,
    companionAnalysis?: CompanionAnalysisResult | null
  ) {
    this._latestData = data;
    if (companionAnalysis) {
      this._latestCompanionAnalysis = companionAnalysis;
    }
    // Reset a selection that no longer exists (e.g. after a folder switch); otherwise
    // every room-scoped request would be rejected as a stale room id.
    if (!this._selectedRoomId || !data.rooms.some((r) => r.id === this._selectedRoomId)) {
      this._selectedRoomId = data.rooms[0]?.id ?? null;
    }

    this._postToAll({
      type: 'updateBlueprint',
      data,
      selectedRoomId: this._selectedRoomId,
    });

    if (companionAnalysis) {
      this._postToAll({
        type: 'companionAnalysis',
        analysis: companionAnalysis,
      });
    }
  }

  public setScanning(isScanning: boolean) {
    this._postToAll({
      type: 'scanningStatus',
      isScanning,
    });
  }

  public setCompanionThinking(isThinking: boolean) {
    this._postToAll({
      type: 'companionThinking',
      isThinking,
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    const htmlPath = path.join(this._extensionUri.fsPath, 'media', 'webview', 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'webview', 'styles.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'webview', 'main.js')
    );

    html = html
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{cspSource}}/g, webview.cspSource)
      .replace(/{{styleUri}}/g, styleUri.toString())
      .replace(/{{scriptUri}}/g, scriptUri.toString());

    return html;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
