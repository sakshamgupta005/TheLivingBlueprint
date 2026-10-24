import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { WorkspaceBlueprintData } from './workspaceScanner.ts';
import type { CompanionAnalysisResult, CompanionMessage } from './companionEngine.ts';
import { validateInboundMessage } from './protocol.ts';
import { resolveWorkspaceFile } from './pathResolver.ts';

export class BlueprintViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'livingBlueprint.overviewView';
  private _view?: vscode.WebviewView;
  private _editorPanel?: vscode.WebviewPanel;
  private _latestData: WorkspaceBlueprintData | null = null;
  private _latestCompanionAnalysis: CompanionAnalysisResult | null = null;
  private _isScanning = false;
  private _hasApiKey = false;
  private _aiConsent = false;
  private _selectedRoomId: string | null = null;
  private _latestScanState?: any;
  private _latestFolders?: { folders: any[]; activeFolderPath?: string };

  private _onRefreshRequested?: () => void;
  private _onAskCompanion?: (question: string) => Promise<void>;
  private _onConfigureApiKey?: () => Promise<void>;
  private _onToggleAiConsent?: (enabled: boolean) => Promise<void>;
  private _onOpenEditorRequested?: () => void;
  private _onSelectFolder?: (folderPath: string) => void;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _workspaceRoot?: string,
    handlers?: {
      onRefreshRequested?: () => void;
      onAskCompanion?: (question: string) => Promise<void>;
      onConfigureApiKey?: () => Promise<void>;
      onToggleAiConsent?: (enabled: boolean) => Promise<void>;
      onOpenEditorRequested?: () => void;
      onSelectFolder?: (folderPath: string) => void;
    }
  ) {
    if (handlers) {
      this._onRefreshRequested = handlers.onRefreshRequested;
      this._onAskCompanion = handlers.onAskCompanion;
      this._onConfigureApiKey = handlers.onConfigureApiKey;
      this._onToggleAiConsent = handlers.onToggleAiConsent;
      this._onOpenEditorRequested = handlers.onOpenEditorRequested;
      this._onSelectFolder = handlers.onSelectFolder;
    }
  }

  public setSecurityState(hasApiKey: boolean, aiConsent: boolean) {
    this._hasApiKey = hasApiKey;
    this._aiConsent = aiConsent;
    this._postToAll({
      type: 'securityState',
      hasApiKey,
      aiConsent,
    });
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
  }

  private _postToAll(message: unknown) {
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
    const wsFolders = vscode.workspace.workspaceFolders;
    const roots =
      wsFolders && wsFolders.length > 0
        ? wsFolders.map((f) => f.uri.fsPath)
        : this._workspaceRoot
        ? [this._workspaceRoot]
        : [];

    const candidate = this._latestFolders?.activeFolderPath;
    if (candidate && roots.includes(candidate)) {
      return candidate;
    }
    return this._workspaceRoot || roots[0];
  }

  private _attachMessageHandlers(webview: vscode.Webview) {
    webview.onDidReceiveMessage(async (rawMessage) => {
      const validRoomIds = this._latestData?.rooms.map((r) => r.id);
      const validation = validateInboundMessage(rawMessage, { validRoomIds });

      if (!validation.valid) {
        console.warn(`[Living Blueprint] Inbound message rejected: ${validation.reason}`);
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
              await this._onAskCompanion(message.question);
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
          this._selectedRoomId = message.roomId || null;
          this._postToAll({
            type: 'roomSelected',
            roomId: this._selectedRoomId,
          });
          break;
        }
        case 'selectFolder': {
          if (this._onSelectFolder) {
            this._onSelectFolder(message.folderPath);
          }
          break;
        }
      }
    });
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
    if (!this._selectedRoomId && data.rooms.length > 0) {
      this._selectedRoomId = data.rooms[0].id;
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

  public appendCompanionMessages(messages: CompanionMessage[]) {
    this._postToAll({
      type: 'companionReplies',
      messages,
    });
  }

  public setScanning(isScanning: boolean) {
    this._isScanning = isScanning;
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
