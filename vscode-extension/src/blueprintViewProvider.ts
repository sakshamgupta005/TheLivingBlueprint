import * as vscode from 'vscode';
import * as path from 'path';
import type { WorkspaceBlueprintData } from './workspaceScanner.ts';
import type { CompanionAnalysisResult, CompanionMessage } from './companionEngine.ts';

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

  private _onRefreshRequested?: () => void;
  private _onAskCompanion?: (question: string) => Promise<void>;
  private _onConfigureApiKey?: () => Promise<void>;
  private _onToggleAiConsent?: (enabled: boolean) => Promise<void>;
  private _onOpenEditorRequested?: () => void;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _workspaceRoot?: string,
    handlers?: {
      onRefreshRequested?: () => void;
      onAskCompanion?: (question: string) => Promise<void>;
      onConfigureApiKey?: () => Promise<void>;
      onToggleAiConsent?: (enabled: boolean) => Promise<void>;
      onOpenEditorRequested?: () => void;
    }
  ) {
    if (handlers) {
      this._onRefreshRequested = handlers.onRefreshRequested;
      this._onAskCompanion = handlers.onAskCompanion;
      this._onConfigureApiKey = handlers.onConfigureApiKey;
      this._onToggleAiConsent = handlers.onToggleAiConsent;
      this._onOpenEditorRequested = handlers.onOpenEditorRequested;
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
  }

  private _postToAll(message: unknown) {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
    if (this._editorPanel) {
      this._editorPanel.webview.postMessage(message);
    }
  }

  private _attachMessageHandlers(webview: vscode.Webview) {
    webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'openFile': {
          if (message.path && this._workspaceRoot) {
            const rawPath = String(message.path).replace(/^file:\/\//, '');
            const fullPath = path.isAbsolute(rawPath)
              ? rawPath
              : path.join(this._workspaceRoot, rawPath);
            try {
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
              const editor = await vscode.window.showTextDocument(doc);
              const line = parseInt(message.line, 10);
              if (Number.isFinite(line) && line > 0) {
                const lineIdx = line - 1;
                const pos = new vscode.Position(lineIdx, 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
              }
            } catch {
              vscode.window.showErrorMessage(`Could not open file: ${message.path}`);
            }
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
          if (message.question && this._onAskCompanion) {
            this.setCompanionThinking(true);
            await this._onAskCompanion(String(message.question));
            this.setCompanionThinking(false);
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
            await this._onToggleAiConsent(Boolean(message.enabled));
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
      }
    });
  }

  public updateData(data: WorkspaceBlueprintData, companionAnalysis?: CompanionAnalysisResult | null) {
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

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>The Living Blueprint</title>
  <style>
    :root {
      --bg-main: #2B2222;
      --bg-surface: #3A2E2E;
      --bg-surface-elevated: #443737;
      --bg-surface-hover: #4C3C3C;
      --border-subtle: #4D3D3D;
      --border-focus: #7A4F38;
      --accent: #7A4F38;
      --accent-light: #946349;
      --text-primary: #D0C7C1;
      --text-secondary: #A69A92;
      --text-muted: #827670;

      /* Evidence Status Palette (website signature palette) */
      --status-verified: #5B7A58;
      --status-verified-bg: #2C392C;
      --status-progress: #9E7A3E;
      --status-progress-bg: #3E3322;
      --status-planned: #6B625E;
      --status-planned-bg: #342D2A;
      --status-blocked: #9E4A4A;
      --status-blocked-bg: #3F2626;
      --status-unknown: #766782;
      --status-unknown-bg: #2E2835;

      --dog-accent: #E2873A;
      --dog-bg: rgba(226, 135, 58, 0.12);
      --dog-border: rgba(226, 135, 58, 0.4);
      --cat-accent: #767E8F;
      --cat-bg: rgba(118, 126, 143, 0.14);
      --cat-border: rgba(118, 126, 143, 0.4);

      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--font-sans);
      font-size: 13px;
      color: var(--text-primary);
      background-color: var(--bg-main);
      padding: 12px;
      line-height: 1.45;
      overflow-x: hidden;
    }

    /* Web App Header */
    .app-header {
      background-color: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .brand-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }

    .brand-left {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .brand-name {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: var(--text-primary);
    }

    .version-pill {
      font-size: 11px;
      font-family: var(--font-mono);
      padding: 2px 7px;
      background: var(--bg-main);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      color: var(--text-secondary);
    }

    .brand-purpose {
      font-size: 11.5px;
      color: var(--text-secondary);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-family: var(--font-mono);
      background: var(--bg-main);
      border: 1px solid var(--border-subtle);
      color: var(--text-secondary);
    }

    .status-indicator-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background-color: #5B7A58;
      box-shadow: 0 0 6px #5B7A58;
      display: inline-block;
    }

    .btn-action {
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      color: var(--text-primary);
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: background 0.15s ease, border-color 0.15s ease;
    }

    .btn-action:hover {
      background: var(--bg-surface-hover);
      border-color: var(--accent-light);
    }

    .btn-action.btn-accent {
      background: var(--accent);
      border-color: var(--accent-light);
      color: #FFFFFF;
    }
    .btn-action.btn-accent:hover {
      background: var(--accent-light);
    }

    /* View Switcher Tabs */
    .view-tabs {
      display: flex;
      gap: 6px;
      margin-bottom: 12px;
      border-bottom: 1px solid var(--border-subtle);
      padding-bottom: 6px;
      overflow-x: auto;
    }

    .tab-btn {
      background: none;
      border: 1px solid transparent;
      color: var(--text-secondary);
      font-size: 11.5px;
      font-weight: 600;
      padding: 5px 12px;
      border-radius: 6px;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s ease;
    }

    .tab-btn.active {
      color: #FFFFFF;
      background: var(--bg-surface-elevated);
      border-color: var(--border-subtle);
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }

    .tab-btn:hover:not(.active) {
      color: var(--text-primary);
      background: var(--bg-surface);
    }

    /* Metrics Summary Bar */
    .metrics-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      padding: 8px 12px;
      margin-bottom: 12px;
    }

    .metrics-stats {
      display: flex;
      gap: 14px;
      font-size: 11.5px;
    }

    .stat-item strong {
      color: #FFFFFF;
      font-size: 13px;
    }

    .pills-container {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .status-pill {
      font-size: 10px;
      font-family: var(--font-mono);
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: 1px solid transparent;
    }

    .pill-verified { background: var(--status-verified-bg); color: #A8D4A5; border-color: var(--status-verified); }
    .pill-implemented { background: var(--status-progress-bg); color: #E0B565; border-color: var(--status-progress); }
    .pill-planned { background: var(--status-planned-bg); color: #B0A29C; border-color: var(--status-planned); }
    .pill-blocked { background: var(--status-blocked-bg); color: #E28383; border-color: var(--status-blocked); }
    .pill-unknown { background: var(--status-unknown-bg); color: #B6A6C5; border-color: var(--status-unknown); }

    /* Main House Canvas Area */
    .house-canvas-wrapper {
      position: relative;
      background: radial-gradient(circle at 50% 40%, #352828 0%, #1F1717 100%);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 14px;
      box-shadow: inset 0 2px 8px rgba(0,0,0,0.5);
    }

    .house-toolbar {
      position: absolute;
      top: 10px;
      left: 12px;
      right: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      pointer-events: none;
      z-index: 10;
    }

    .canvas-title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: var(--text-secondary);
      background: rgba(43, 34, 34, 0.85);
      border: 1px solid var(--border-subtle);
      padding: 3px 8px;
      border-radius: 4px;
      backdrop-filter: blur(4px);
      pointer-events: auto;
    }

    .zoom-controls {
      display: flex;
      gap: 4px;
      pointer-events: auto;
    }

    .zoom-btn {
      background: rgba(43, 34, 34, 0.85);
      border: 1px solid var(--border-subtle);
      color: var(--text-primary);
      width: 24px;
      height: 24px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 12px;
      font-weight: bold;
    }
    .zoom-btn:hover { background: var(--bg-surface-elevated); border-color: var(--accent-light); }

    .isometric-svg-container {
      width: 100%;
      height: 480px;
      display: flex;
      justify-content: center;
      align-items: center;
    }

    .isometric-svg {
      width: 100%;
      height: 100%;
      user-select: none;
      cursor: default;
    }

    .room-poly {
      cursor: pointer;
      transition: filter 0.15s ease, stroke 0.15s ease;
    }
    .room-poly:hover {
      filter: brightness(1.25);
    }

    /* Room Inspector Drawer */
    .inspector-drawer {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 14px;
      margin-bottom: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .inspector-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border-subtle);
      padding-bottom: 8px;
    }

    .inspector-title {
      font-size: 14px;
      font-weight: 700;
      color: #FFFFFF;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .inspector-layer {
      font-size: 10px;
      font-family: var(--font-mono);
      background: var(--bg-main);
      border: 1px solid var(--border-subtle);
      color: var(--text-secondary);
      padding: 2px 6px;
      border-radius: 3px;
    }

    .inspector-desc {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.4;
    }

    .inspector-evidence {
      font-size: 11.5px;
      color: #E0B565;
      background: var(--status-progress-bg);
      border: 1px solid rgba(158, 122, 62, 0.4);
      padding: 8px 10px;
      border-radius: 6px;
      font-family: var(--font-sans);
    }

    .files-list-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      font-weight: 700;
      margin-bottom: 4px;
    }

    .evidence-files-list {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }

    .file-pill {
      font-size: 11px;
      font-family: var(--font-mono);
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      color: var(--text-primary);
      padding: 3px 8px;
      border-radius: 4px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s ease;
      text-decoration: none;
    }
    .file-pill:hover {
      background: var(--bg-surface-hover);
      border-color: var(--accent-light);
      color: #FFFFFF;
      transform: translateY(-1px);
    }

    /* Companions Section (Barkley & Cleo) */
    .companions-box {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .companions-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border-subtle);
      padding-bottom: 8px;
    }

    .companions-brand {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 700;
      color: #FFFFFF;
    }

    .messages-thread {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-height: 400px;
      overflow-y: auto;
      padding-right: 4px;
    }

    .chat-bubble {
      border-radius: 6px;
      padding: 10px 12px;
      display: flex;
      gap: 10px;
      font-size: 12px;
      line-height: 1.45;
      animation: fadeIn 0.2s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .bubble-dog { background: var(--dog-bg); border: 1px solid var(--dog-border); }
    .bubble-cat { background: var(--cat-bg); border: 1px solid var(--cat-border); }

    .bubble-avatar-col {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .bubble-content-col {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .bubble-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }

    .bubble-speaker { font-weight: 700; font-size: 11.5px; }
    .speaker-dog { color: var(--dog-accent); }
    .speaker-cat { color: var(--cat-accent); }
    .bubble-tagline { font-size: 10px; color: var(--text-muted); }
    .bubble-text { color: var(--text-primary); white-space: pre-wrap; }

    .evidence-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }

    .suggestions-row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
    .suggestion-chip {
      font-size: 10.5px;
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      padding: 3px 9px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .suggestion-chip:hover {
      background: var(--bg-surface-hover);
      color: #FFFFFF;
      border-color: var(--accent-light);
    }

    .chat-input-bar { display: flex; gap: 6px; margin-top: 4px; }
    .chat-input {
      flex: 1;
      background: var(--bg-main);
      color: #FFFFFF;
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 12px;
    }
    .chat-input:focus { outline: 1px solid var(--accent); border-color: var(--accent-light); }

    .companion-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      color: var(--text-muted);
      padding-top: 6px;
      border-top: 1px solid var(--border-subtle);
    }

    /* Graph View */
    .graph-view-box {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .svg-container {
      width: 100%;
      height: 480px;
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      background: #1B1515;
      overflow: hidden;
      position: relative;
    }

    .svg-canvas {
      width: 100%;
      height: 100%;
      cursor: grab;
    }
    .svg-canvas:active { cursor: grabbing; }

    .graph-node { cursor: pointer; transition: transform 0.15s ease; }
    .graph-node:hover rect { stroke-width: 2.5; filter: drop-shadow(0 0 6px var(--accent-light)); }
    .node-title { font-size: 12px; font-weight: 700; fill: #FFFFFF; }
    .node-sub { font-size: 9.5px; font-weight: 600; fill: var(--text-secondary); text-transform: uppercase; }
    .node-tag { font-size: 8.5px; fill: #E0B565; }
    .graph-edge { stroke: rgba(208, 199, 193, 0.25); stroke-width: 1.5; fill: none; }

    .truth-banner {
      background: var(--bg-surface);
      border-left: 3px solid var(--accent-light);
      padding: 8px 12px;
      border-radius: 0 4px 4px 0;
      font-size: 11px;
      color: var(--text-secondary);
      margin-bottom: 12px;
      line-height: 1.4;
    }

    .scanning-indicator {
      display: none;
      font-size: 11px;
      color: #E0B565;
      padding: 4px 0;
      animation: pulse 1.5s infinite ease-in-out;
    }
    .scanning-indicator.active { display: block; }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
  </style>
</head>
<body>
  <!-- Header matching the website -->
  <header class="app-header">
    <div class="brand-title-row">
      <div class="brand-left">
        <span class="brand-name">The Living Blueprint</span>
        <span class="version-pill">v0.15.0 · Living Blueprint</span>
      </div>
      <div class="header-actions">
        <button class="btn-action btn-accent" id="btnOpenCanvas" title="Open Full Canvas Editor Tab">
          ⛶ Full Canvas
        </button>
        <button class="btn-action" id="refreshBtn" title="Rescan Workspace">
          ↻ Rescan
        </button>
      </div>
    </div>
    <p class="brand-purpose">
      Evidence-backed architecture verification for AI coding agent projects
    </p>
    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;">
      <div class="status-badge" id="headerStatusBadge">
        <span class="status-indicator-dot"></span>
        <span id="headerStatusText">Workspace Discovered</span>
      </div>
      <span id="scanTimestamp" style="font-size:10px; color:var(--text-muted); font-family:var(--font-mono);"></span>
    </div>
    <div class="scanning-indicator" id="scanningIndicator">
      Scanning workspace architecture & evaluating evidence...
    </div>
  </header>

  <!-- Navigation View Tabs -->
  <div class="view-tabs">
    <button class="tab-btn active" id="tabHouse">🏠 3D Isometric House</button>
    <button class="tab-btn" id="tabCompanions">🐾 Barkley &amp; Cleo</button>
    <button class="tab-btn" id="tabGraph">🕸 Architecture Graph</button>
    <button class="tab-btn" id="tabLedger">📋 Room Ledger</button>
  </div>

  <!-- Metrics Bar -->
  <div class="metrics-bar">
    <div class="metrics-stats">
      <span class="stat-item"><strong id="discoveredCount">-</strong> Files Discovered</span>
      <span class="stat-item"><strong id="inspectedCount">-</strong> Files Inspected</span>
    </div>
    <div class="pills-container" id="summaryPills"></div>
  </div>

  <!-- Panel 1: 3D Isometric House Canvas -->
  <div id="panelHouse">
    <div class="house-canvas-wrapper">
      <div class="house-toolbar">
        <span class="canvas-title">Interactive Architectural Model</span>
        <div class="zoom-controls">
          <button class="zoom-btn" id="houseZoomIn" title="Zoom In">+</button>
          <button class="zoom-btn" id="houseZoomOut" title="Zoom Out">−</button>
          <button class="zoom-btn" id="houseZoomReset" title="Reset Camera">⟲</button>
        </div>
      </div>

      <div class="isometric-svg-container">
        <svg
          id="isometricSvg"
          viewBox="0 0 900 640"
          class="isometric-svg"
          role="img"
          aria-label="Interactive Software Architecture House"
        >
          <defs>
            <pattern
              id="construction-stripe"
              width="12"
              height="12"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line x1="0" y1="0" x2="0" y2="12" stroke="#9E7A3E" strokeWidth="3" opacity="0.4" />
            </pattern>
            <filter id="soft-shadow" x="-10%" y="-10%" width="130%" height="130%">
              <feDropShadow dx="0" dy="4" stdDeviation="6" floodColor="#000000" floodOpacity="0.4" />
            </filter>
          </defs>

          <g id="houseTransformGroup">
            <!-- Bedrock Pillars -->
            <g id="pillarsLayer" class="structural-pillars"></g>

            <!-- Foundation Base Slab -->
            <g id="foundationLayer" class="foundation-slab"></g>

            <!-- Architectural Room Cubes -->
            <g id="roomsLayer" class="rooms-layer"></g>

            <!-- Translucent Roof Canopy & Trusses -->
            <g id="roofLayer" class="roof-structure" opacity="0.85" pointer-events="none"></g>
          </g>
        </svg>
      </div>
    </div>

    <!-- Room Inspector Drawer -->
    <div class="inspector-drawer" id="roomInspectorDrawer">
      <div class="inspector-header">
        <div class="inspector-title">
          <span id="inspectorRoomName">Select a room to inspect</span>
          <span class="status-pill" id="inspectorRoomPill"></span>
        </div>
        <span class="inspector-layer" id="inspectorRoomLayer"></span>
      </div>
      <div class="inspector-desc" id="inspectorRoomDesc">
        Click any 3D room above or in the list to inspect verified boundaries, source files, and dependencies.
      </div>
      <div class="inspector-evidence" id="inspectorRoomEvidence" style="display:none;"></div>
      <div>
        <div class="files-list-title">Associated Source Files (Click to Open)</div>
        <div class="evidence-files-list" id="inspectorRoomFiles">
          <span style="font-size:11px; color:var(--text-muted); font-style:italic;">None listed</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Panel 2: Companions (Barkley & Cleo) -->
  <div id="panelCompanions" style="display:none;">
    <div class="truth-banner">
      <strong>Grounded Companions:</strong> Barkley explains architectural foundations; Cleo audits evidence gaps. Offline-safe local analysis by default.
    </div>
    <div class="companions-box">
      <div class="companions-top">
        <div class="companions-brand">
          <span style="display:inline-flex; align-items:center; gap:4px;">
            ${renderPixelDogSvg(18)} Barkley
          </span>
          <span>&amp;</span>
          <span style="display:inline-flex; align-items:center; gap:4px;">
            ${renderPixelCatSvg(18)} Cleo
          </span>
        </div>
        <span class="version-pill" id="modeBadge">Offline Safe</span>
      </div>

      <div class="messages-thread" id="companionThread">
        <div style="color:var(--text-muted); font-style:italic; padding:6px 0;">Analyzing workspace architecture...</div>
      </div>

      <div class="suggestions-row" id="suggestionsRow"></div>

      <div class="chat-input-bar">
        <input type="text" class="chat-input" id="companionInput" placeholder="Ask Barkley &amp; Cleo about this architecture..." />
        <button class="btn-action btn-accent" id="sendBtn">Ask</button>
      </div>

      <div class="companion-footer">
        <label style="display:flex; align-items:center; gap:4px; cursor:pointer;" title="When enabled, queries consult configured AI keys. Source code is never sent without consent.">
          <input type="checkbox" id="consentCheckbox" />
          <span>Cloud AI Consent</span>
        </label>
        <button class="btn-action" id="configKeyBtn" style="padding:2px 8px; font-size:10px;">Configure AI Key</button>
      </div>
    </div>
  </div>

  <!-- Panel 3: Architecture Graph -->
  <div id="panelGraph" style="display:none;" class="graph-view-box">
    <div class="truth-banner">
      <strong>Static Module Topology:</strong> Derived from discovered workspace dependencies.
    </div>

    <div class="svg-container">
      <div style="position:absolute; top:8px; right:8px; display:flex; gap:4px; z-index:10;">
        <button class="zoom-btn" id="btnZoomIn" title="Zoom In">+</button>
        <button class="zoom-btn" id="btnZoomOut" title="Zoom Out">−</button>
        <button class="zoom-btn" id="btnZoomReset" title="Reset Fit">⟲</button>
      </div>
      <svg class="svg-canvas" id="graphSvg" viewBox="0 0 800 600">
        <defs>
          <marker id="graphArrow" markerWidth="8" markerHeight="8" refX="7" refY="3.5" orient="auto">
            <polygon points="0 0, 8 3.5, 0 7" fill="rgba(208,199,193,0.4)" />
          </marker>
        </defs>
        <g id="svgViewport">
          <g id="edgesLayer"></g>
          <g id="nodesLayer"></g>
        </g>
      </svg>
    </div>
  </div>

  <!-- Panel 4: Room Ledger -->
  <div id="panelLedger" style="display:none;">
    <div class="truth-banner">
      <strong>Deterministic Status Engine:</strong> Verified requires executed test artifacts; discovered code produces Implemented.
    </div>
    <div style="display:flex; flex-direction:column; gap:8px;" id="ledgerList"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // Tab Switching
    const tabHouse = document.getElementById('tabHouse');
    const tabCompanions = document.getElementById('tabCompanions');
    const tabGraph = document.getElementById('tabGraph');
    const tabLedger = document.getElementById('tabLedger');

    const panelHouse = document.getElementById('panelHouse');
    const panelCompanions = document.getElementById('panelCompanions');
    const panelGraph = document.getElementById('panelGraph');
    const panelLedger = document.getElementById('panelLedger');

    function setActiveTab(activeBtn, activePanel) {
      [tabHouse, tabCompanions, tabGraph, tabLedger].forEach(b => b.classList.remove('active'));
      [panelHouse, panelCompanions, panelGraph, panelLedger].forEach(p => p.style.display = 'none');
      activeBtn.classList.add('active');
      activePanel.style.display = 'block';
    }

    tabHouse.addEventListener('click', () => setActiveTab(tabHouse, panelHouse));
    tabCompanions.addEventListener('click', () => setActiveTab(tabCompanions, panelCompanions));
    tabGraph.addEventListener('click', () => {
      setActiveTab(tabGraph, panelGraph);
      if (currentGraph) renderGraph(currentGraph);
    });
    tabLedger.addEventListener('click', () => setActiveTab(tabLedger, panelLedger));

    // Action Buttons
    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });

    document.getElementById('btnOpenCanvas').addEventListener('click', () => {
      vscode.postMessage({ command: 'openEditorPanel' });
    });

    document.getElementById('configKeyBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'configureApiKey' });
    });

    const consentCheckbox = document.getElementById('consentCheckbox');
    consentCheckbox.addEventListener('change', (e) => {
      vscode.postMessage({ command: 'toggleAiConsent', enabled: e.target.checked });
    });

    // Companion Chat
    const inputEl = document.getElementById('companionInput');
    const sendBtn = document.getElementById('sendBtn');

    function sendQuery() {
      const q = inputEl.value.trim();
      if (!q) return;
      inputEl.value = '';
      appendUserBubble(q);
      vscode.postMessage({ command: 'askCompanion', question: q });
    }

    sendBtn.addEventListener('click', sendQuery);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendQuery();
    });

    function appendUserBubble(text) {
      const thread = document.getElementById('companionThread');
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';
      bubble.style.background = 'var(--bg-surface-elevated)';
      bubble.style.border = '1px solid var(--border-subtle)';
      bubble.innerHTML = '<div class="bubble-content-col"><div class="bubble-header"><span class="bubble-speaker">👤 You</span></div><div class="bubble-text">' + escapeHtml(text) + '</div></div>';
      thread.appendChild(bubble);
      thread.scrollTop = thread.scrollHeight;
    }

    // Isometric 3D Projection Math (matches IsometricHouse.tsx)
    const ORIGIN_X = 450;
    const ORIGIN_Y = 320;

    function toIso(x, y, z) {
      return {
        x: Number((ORIGIN_X + (x - y) * 0.866).toFixed(1)),
        y: Number((ORIGIN_Y + (x + y) * 0.5 - z).toFixed(1))
      };
    }

    function polyPoints(pts) {
      return pts.map(p => p.x + ',' + p.y).join(' ');
    }

    // Global State
    let currentBlueprintData = null;
    let currentSelectedRoomId = null;
    let currentGraph = null;

    let houseZoom = 1.0;
    let housePanX = 0;
    let housePanY = 0;

    document.getElementById('houseZoomIn').addEventListener('click', () => {
      houseZoom = Math.min(2.2, houseZoom + 0.15);
      applyHouseTransform();
    });
    document.getElementById('houseZoomOut').addEventListener('click', () => {
      houseZoom = Math.max(0.6, houseZoom - 0.15);
      applyHouseTransform();
    });
    document.getElementById('houseZoomReset').addEventListener('click', () => {
      houseZoom = 1.0;
      housePanX = 0;
      housePanY = 0;
      applyHouseTransform();
    });

    function applyHouseTransform() {
      const g = document.getElementById('houseTransformGroup');
      g.setAttribute('transform', 'translate(' + housePanX + ',' + housePanY + ') scale(' + houseZoom + ')');
    }

    // Graph Pan & Zoom Controls
    let graphZoom = 1.0;
    let graphPanX = 0;
    let graphPanY = 0;

    document.getElementById('btnZoomIn').addEventListener('click', () => {
      graphZoom = Math.min(2.5, graphZoom + 0.2);
      applyGraphTransform();
    });
    document.getElementById('btnZoomOut').addEventListener('click', () => {
      graphZoom = Math.max(0.4, graphZoom - 0.2);
      applyGraphTransform();
    });
    document.getElementById('btnZoomReset').addEventListener('click', () => {
      graphZoom = 1.0;
      graphPanX = 0;
      graphPanY = 0;
      applyGraphTransform();
    });

    function applyGraphTransform() {
      const vp = document.getElementById('svgViewport');
      vp.setAttribute('transform', 'translate(' + graphPanX + ',' + graphPanY + ') scale(' + graphZoom + ')');
    }

    // Room Style Tokens matching IsometricHouse.tsx
    function getRoomStyles(status, isSelected) {
      switch (status) {
        case 'verified':
          return {
            topFill: isSelected ? '#4A6149' : '#3E4E3D',
            leftFill: isSelected ? '#3D503C' : '#313E30',
            rightFill: isSelected ? '#435842' : '#384637',
            stroke: isSelected ? '#FFD166' : '#5B7A58',
            dash: 'none',
            badgeText: '✓ Verified',
            badgeBg: '#2C392C',
            badgeColor: '#A8D4A5',
          };
        case 'implemented':
        case 'in_progress':
          return {
            topFill: isSelected ? '#635133' : '#52432A',
            leftFill: isSelected ? '#4F4028' : '#3F3420',
            rightFill: isSelected ? '#57462C' : '#473A25',
            stroke: isSelected ? '#FFD166' : '#9E7A3E',
            dash: 'none',
            badgeText: '⚡ Implemented',
            badgeBg: '#3D311F',
            badgeColor: '#E0B565',
          };
        case 'planned':
          return {
            topFill: isSelected ? 'rgba(80, 71, 67, 0.45)' : 'rgba(56, 48, 45, 0.35)',
            leftFill: isSelected ? 'rgba(64, 56, 53, 0.45)' : 'rgba(44, 38, 35, 0.35)',
            rightFill: isSelected ? 'rgba(72, 63, 60, 0.45)' : 'rgba(50, 43, 40, 0.35)',
            stroke: isSelected ? '#FFD166' : '#7A706B',
            dash: '5,4',
            badgeText: '○ Planned',
            badgeBg: '#2E2725',
            badgeColor: '#9C908B',
          };
        case 'blocked':
          return {
            topFill: isSelected ? '#6D3838' : '#572C2C',
            leftFill: isSelected ? '#552B2B' : '#432222',
            rightFill: isSelected ? '#613131' : '#4C2727',
            stroke: isSelected ? '#FFD166' : '#9E4A4A',
            dash: 'none',
            badgeText: '✕ Blocked',
            badgeBg: '#3C2020',
            badgeColor: '#E28383',
          };
        default:
          return {
            topFill: isSelected ? '#4F4756' : '#3E3744',
            leftFill: isSelected ? '#3E3745' : '#2F2B36',
            rightFill: isSelected ? '#463E4D' : '#36313C',
            stroke: isSelected ? '#FFD166' : '#766782',
            dash: '3,3',
            badgeText: '? Unknown',
            badgeBg: '#2E2835',
            badgeColor: '#B6A6C5',
          };
      }
    }

    // Render 3D Isometric House
    function renderIsometricHouse(rooms, selectedRoomId) {
      // 1. Structural Pillars
      const pillarsLayer = document.getElementById('pillarsLayer');
      pillarsLayer.innerHTML = '';
      const pillars = [
        { x: -180, y: -140, w: 16, d: 16, h: 40, z: -64 },
        { x: 164, y: -140, w: 16, d: 16, h: 40, z: -64 },
        { x: -180, y: 134, w: 16, d: 16, h: 40, z: -64 },
        { x: 164, y: 134, w: 16, d: 16, h: 40, z: -64 },
        { x: -8, y: -140, w: 16, d: 16, h: 40, z: -64 },
        { x: -8, y: 134, w: 16, d: 16, h: 40, z: -64 },
      ];

      pillars.forEach(p => {
        const pLeft = [
          toIso(p.x, p.y + p.d, p.z),
          toIso(p.x + p.w, p.y + p.d, p.z),
          toIso(p.x + p.w, p.y + p.d, p.z + p.h),
          toIso(p.x, p.y + p.d, p.z + p.h),
        ];
        const pRight = [
          toIso(p.x + p.w, p.y, p.z),
          toIso(p.x + p.w, p.y + p.d, p.z),
          toIso(p.x + p.w, p.y + p.d, p.z + p.h),
          toIso(p.x + p.w, p.y, p.z + p.h),
        ];
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.innerHTML = '<polygon points="' + polyPoints(pLeft) + '" fill="#221A1A" stroke="#3A2D2D" stroke-width="1" />' +
                      '<polygon points="' + polyPoints(pRight) + '" fill="#1A1414" stroke="#3A2D2D" stroke-width="1" />';
        pillarsLayer.appendChild(g);
      });

      // 2. Foundation Base Slab
      const foundationLayer = document.getElementById('foundationLayer');
      foundationLayer.innerHTML = '';
      const foundation = { x: -190, y: -150, w: 380, d: 300, h: 22, baseZ: -24 };
      const fTop = [
        toIso(foundation.x, foundation.y, 0),
        toIso(foundation.x + foundation.w, foundation.y, 0),
        toIso(foundation.x + foundation.w, foundation.y + foundation.d, 0),
        toIso(foundation.x, foundation.y + foundation.d, 0),
      ];
      const fLeft = [
        toIso(foundation.x, foundation.y + foundation.d, foundation.baseZ),
        toIso(foundation.x + foundation.w, foundation.y + foundation.d, foundation.baseZ),
        toIso(foundation.x + foundation.w, foundation.y + foundation.d, 0),
        toIso(foundation.x, foundation.y + foundation.d, 0),
      ];
      const fRight = [
        toIso(foundation.x + foundation.w, foundation.y, foundation.baseZ),
        toIso(foundation.x + foundation.w, foundation.y + foundation.d, foundation.baseZ),
        toIso(foundation.x + foundation.w, foundation.y + foundation.d, 0),
        toIso(foundation.x + foundation.w, foundation.y, 0),
      ];

      foundationLayer.innerHTML =
        '<polygon points="' + polyPoints(fLeft) + '" fill="#241C1C" stroke="#443535" stroke-width="1.2" />' +
        '<polygon points="' + polyPoints(fRight) + '" fill="#1C1616" stroke="#443535" stroke-width="1.2" />' +
        '<polygon points="' + polyPoints(fTop) + '" fill="#332727" stroke="#4E3D3D" stroke-width="1.5" />' +
        '<line x1="' + toIso(foundation.x, 0, 0).x + '" y1="' + toIso(foundation.x, 0, 0).y + '" x2="' + toIso(foundation.x + foundation.w, 0, 0).x + '" y2="' + toIso(foundation.x + foundation.w, 0, 0).y + '" stroke="#423232" stroke-width="1" stroke-dasharray="4,4" />' +
        '<line x1="' + toIso(0, foundation.y, 0).x + '" y1="' + toIso(0, foundation.y, 0).y + '" x2="' + toIso(0, foundation.y + foundation.d, 0).x + '" y2="' + toIso(0, foundation.y + foundation.d, 0).y + '" stroke="#423232" stroke-width="1" stroke-dasharray="4,4" />' +
        '<text x="' + toIso(-20, foundation.y + foundation.d + 12, foundation.baseZ / 2).x + '" y="' + toIso(-20, foundation.y + foundation.d + 12, foundation.baseZ / 2).y + '" fill="#8C7A70" font-size="10" font-family="ui-monospace, monospace" letter-spacing="1.2" font-weight="600" transform="rotate(18, 450, 480)" pointer-events="none">FOUNDATION: REPOSITORY ROOT · RUNTIME PLATFORM</text>';

      // 3. Rooms Layer (sorted back to front)
      const roomsLayer = document.getElementById('roomsLayer');
      roomsLayer.innerHTML = '';

      const sortedRooms = [...rooms].sort((a, b) => {
        const depthA = (a.coords?.isoX ?? 0) + (a.coords?.isoY ?? 0);
        const depthB = (b.coords?.isoX ?? 0) + (b.coords?.isoY ?? 0);
        return depthA - depthB;
      });

      sortedRooms.forEach(room => {
        const coords = {
          x: room.coords?.isoX ?? 0,
          y: room.coords?.isoY ?? 0,
          w: room.coords?.width ?? 160,
          d: room.coords?.depth ?? 120,
          h: room.coords?.height ?? 80,
          z: 0,
        };

        const isSelected = selectedRoomId === room.id;
        const styles = getRoomStyles(room.status, isSelected);

        const rTop = [
          toIso(coords.x, coords.y, coords.z + coords.h),
          toIso(coords.x + coords.w, coords.y, coords.z + coords.h),
          toIso(coords.x + coords.w, coords.y + coords.d, coords.z + coords.h),
          toIso(coords.x, coords.y + coords.d, coords.z + coords.h),
        ];
        const rLeft = [
          toIso(coords.x, coords.y + coords.d, coords.z),
          toIso(coords.x + coords.w, coords.y + coords.d, coords.z),
          toIso(coords.x + coords.w, coords.y + coords.d, coords.z + coords.h),
          toIso(coords.x, coords.y + coords.d, coords.z + coords.h),
        ];
        const rRight = [
          toIso(coords.x + coords.w, coords.y, coords.z),
          toIso(coords.x + coords.w, coords.y + coords.d, coords.z),
          toIso(coords.x + coords.w, coords.y + coords.d, coords.z + coords.h),
          toIso(coords.x + coords.w, coords.y, coords.z + coords.h),
        ];

        const centerIso = toIso(
          coords.x + coords.w / 2,
          coords.y + coords.d / 2,
          coords.z + coords.h
        );

        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('class', 'room-poly ' + (isSelected ? 'selected' : ''));
        g.setAttribute('id', 'room-node-' + room.id);

        let html =
          '<polygon points="' + polyPoints(rLeft) + '" fill="' + styles.leftFill + '" stroke="' + (isSelected ? '#FFD166' : styles.stroke) + '" stroke-width="' + (isSelected ? '2' : '1.2') + '" stroke-dasharray="' + styles.dash + '" />' +
          '<polygon points="' + polyPoints(rRight) + '" fill="' + styles.rightFill + '" stroke="' + (isSelected ? '#FFD166' : styles.stroke) + '" stroke-width="' + (isSelected ? '2' : '1.2') + '" stroke-dasharray="' + styles.dash + '" />' +
          '<polygon points="' + polyPoints(rTop) + '" fill="' + styles.topFill + '" stroke="' + (isSelected ? '#FFE5A3' : styles.stroke) + '" stroke-width="' + (isSelected ? '2.5' : '1.4') + '" stroke-dasharray="' + styles.dash + '" />';

        if (isSelected) {
          html += '<polygon points="' + polyPoints(rTop) + '" fill="none" stroke="#FFD166" stroke-width="3.5" opacity="0.8" pointer-events="none" />';
        }

        html += '<g pointer-events="none" transform="translate(' + centerIso.x + ', ' + (centerIso.y - 10) + ')">' +
                '<text x="0" y="-4" text-anchor="middle" fill="#E6DFDA" font-size="11" font-weight="600" font-family="-apple-system, BlinkMacSystemFont, sans-serif">' + escapeHtml(room.name) + '</text>' +
                '<rect x="-36" y="5" width="72" height="16" rx="3" fill="' + styles.badgeBg + '" stroke="' + (isSelected ? '#FFD166' : styles.stroke) + '" stroke-width="0.8" />' +
                '<text x="0" y="16" text-anchor="middle" fill="' + styles.badgeColor + '" font-size="9" font-family="ui-monospace, monospace" font-weight="600">' + styles.badgeText + '</text>' +
                '</g>';

        g.innerHTML = html;
        g.addEventListener('click', () => {
          selectRoom(room.id);
        });

        roomsLayer.appendChild(g);
      });

      // 4. Roof Structure
      const roofLayer = document.getElementById('roofLayer');
      const roof = { x: -190, y: -150, w: 380, d: 300, baseZ: 145, peakZ: 195 };
      const roofGableFront = [
        toIso(roof.x, roof.y + roof.d, roof.baseZ),
        toIso(roof.x + roof.w / 2, roof.y + roof.d, roof.peakZ),
        toIso(roof.x + roof.w, roof.y + roof.d, roof.baseZ),
      ];
      const roofLeftSlope = [
        toIso(roof.x, roof.y, roof.baseZ),
        toIso(roof.x + roof.w / 2, roof.y, roof.peakZ),
        toIso(roof.x + roof.w / 2, roof.y + roof.d, roof.peakZ),
        toIso(roof.x, roof.y + roof.d, roof.baseZ),
      ];
      const roofRightSlope = [
        toIso(roof.x + roof.w / 2, roof.y, roof.peakZ),
        toIso(roof.x + roof.w, roof.y, roof.baseZ),
        toIso(roof.x + roof.w, roof.y + roof.d, roof.baseZ),
        toIso(roof.x + roof.w / 2, roof.y + roof.d, roof.peakZ),
      ];

      roofLayer.innerHTML =
        '<line x1="' + toIso(-170, -130, 80).x + '" y1="' + toIso(-170, -130, 80).y + '" x2="' + toIso(-170, -130, 145).x + '" y2="' + toIso(-170, -130, 145).y + '" stroke="#5C4B4B" stroke-width="2" />' +
        '<line x1="' + toIso(170, -130, 80).x + '" y1="' + toIso(170, -130, 80).y + '" x2="' + toIso(170, -130, 145).x + '" y2="' + toIso(170, -130, 145).y + '" stroke="#5C4B4B" stroke-width="2" />' +
        '<line x1="' + toIso(-170, 130, 80).x + '" y1="' + toIso(-170, 130, 80).y + '" x2="' + toIso(-170, 130, 145).x + '" y2="' + toIso(-170, 130, 145).y + '" stroke="#5C4B4B" stroke-width="2" />' +
        '<line x1="' + toIso(170, 130, 80).x + '" y1="' + toIso(170, 130, 80).y + '" x2="' + toIso(170, 130, 145).x + '" y2="' + toIso(170, 130, 145).y + '" stroke="#5C4B4B" stroke-width="2" />' +
        '<polygon points="' + polyPoints(roofLeftSlope) + '" fill="rgba(66, 52, 52, 0.4)" stroke="#7A6060" stroke-width="1.2" />' +
        '<polygon points="' + polyPoints(roofRightSlope) + '" fill="rgba(54, 42, 42, 0.4)" stroke="#7A6060" stroke-width="1.2" />' +
        '<polygon points="' + polyPoints(roofGableFront) + '" fill="rgba(74, 58, 58, 0.25)" stroke="#8A6E6E" stroke-width="1.5" />' +
        '<line x1="' + toIso(roof.x + roof.w / 2, roof.y, roof.peakZ).x + '" y1="' + toIso(roof.x + roof.w / 2, roof.y, roof.peakZ).y + '" x2="' + toIso(roof.x + roof.w / 2, roof.y + roof.d, roof.peakZ).x + '" y2="' + toIso(roof.x + roof.w / 2, roof.y + roof.d, roof.peakZ).y + '" stroke="#A88B8B" stroke-width="2" />';
    }

    function selectRoom(roomId) {
      currentSelectedRoomId = roomId;
      vscode.postMessage({ command: 'selectRoom', roomId });
      updateInspector();
      if (currentBlueprintData) {
        renderIsometricHouse(currentBlueprintData.rooms || [], currentSelectedRoomId);
      }
    }

    function updateInspector() {
      if (!currentBlueprintData || !currentSelectedRoomId) return;
      const room = (currentBlueprintData.rooms || []).find(r => r.id === currentSelectedRoomId);
      if (!room) return;

      document.getElementById('inspectorRoomName').textContent = room.name;
      const pill = document.getElementById('inspectorRoomPill');
      pill.className = 'status-pill pill-' + (room.status || 'unknown');
      pill.textContent = (room.status || 'unknown').toUpperCase();

      document.getElementById('inspectorRoomLayer').textContent = room.layer ? 'LAYER: ' + room.layer.toUpperCase() : '';
      document.getElementById('inspectorRoomDesc').textContent = room.description || 'No description recorded for this module.';

      const evEl = document.getElementById('inspectorRoomEvidence');
      if (room.evidence) {
        evEl.style.display = 'block';
        evEl.textContent = 'Evidence: ' + room.evidence;
      } else {
        evEl.style.display = 'none';
      }

      const filesEl = document.getElementById('inspectorRoomFiles');
      filesEl.innerHTML = '';
      const paths = room.filePaths || [];
      if (paths.length === 0) {
        filesEl.innerHTML = '<span style="font-size:11px; color:var(--text-muted); font-style:italic;">No files tracked directly under this room.</span>';
      } else {
        paths.forEach(fp => {
          const pill = document.createElement('a');
          pill.className = 'file-pill';
          pill.textContent = '📄 ' + (fp.split('/').pop() || fp);
          pill.title = fp + ' (Click to open file in editor)';
          pill.addEventListener('click', (e) => {
            e.preventDefault();
            vscode.postMessage({ command: 'openFile', path: fp, line: 1 });
          });
          filesEl.appendChild(pill);
        });
      }
    }

    // Message Listener
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'scanningStatus': {
          const indicator = document.getElementById('scanningIndicator');
          if (msg.isScanning) indicator.classList.add('active');
          else indicator.classList.remove('active');
          break;
        }
        case 'securityState': {
          const modeBadge = document.getElementById('modeBadge');
          if (msg.hasApiKey && msg.aiConsent) {
            modeBadge.textContent = 'Cloud AI Active';
            modeBadge.style.color = '#E0B565';
          } else {
            modeBadge.textContent = 'Offline Safe';
            modeBadge.style.color = 'var(--text-secondary)';
          }
          consentCheckbox.checked = Boolean(msg.aiConsent);
          break;
        }
        case 'updateBlueprint': {
          currentBlueprintData = msg.data;
          currentSelectedRoomId = msg.selectedRoomId || (msg.data.rooms[0]?.id ?? null);
          currentGraph = msg.data.graph;
          renderBlueprint(msg.data);
          renderIsometricHouse(msg.data.rooms || [], currentSelectedRoomId);
          updateInspector();
          renderLedger(msg.data.rooms || []);
          break;
        }
        case 'companionAnalysis': {
          renderCompanionAnalysis(msg.analysis);
          break;
        }
        case 'companionReplies': {
          appendCompanionReplies(msg.messages);
          break;
        }
        case 'companionThinking': {
          const thread = document.getElementById('companionThread');
          let el = document.getElementById('thinkingBubble');
          if (msg.isThinking) {
            if (!el) {
              el = document.createElement('div');
              el.id = 'thinkingBubble';
              el.className = 'chat-bubble bubble-dog';
              el.innerHTML = '<div class="bubble-avatar-col">' + renderPixelDogSvg(20) + '</div><div class="bubble-content-col"><span class="speaker-dog" style="font-weight:700;">Barkley</span><span style="font-style:italic; font-size:11px;">Consulting architectural scan &amp; evidence ledger...</span></div>';
              thread.appendChild(el);
              thread.scrollTop = thread.scrollHeight;
            }
          } else if (el) {
            el.remove();
          }
          break;
        }
        case 'roomSelected': {
          currentSelectedRoomId = msg.roomId;
          updateInspector();
          if (currentBlueprintData) {
            renderIsometricHouse(currentBlueprintData.rooms || [], currentSelectedRoomId);
          }
          break;
        }
      }
    });

    function renderBlueprint(data) {
      document.getElementById('headerStatusText').textContent = data.workspaceName || 'Workspace Discovered';
      document.getElementById('discoveredCount').textContent = data.discoveredFilesCount ?? 0;
      document.getElementById('inspectedCount').textContent = data.inspectedFilesCount ?? 0;

      if (data.scannedAt) {
        const d = new Date(data.scannedAt);
        document.getElementById('scanTimestamp').textContent = 'Scanned: ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }

      // Summary Pills
      const summaryContainer = document.getElementById('summaryPills');
      summaryContainer.innerHTML = '';
      const summary = data.statusSummary || {};
      const statusTypes = ['verified', 'implemented', 'planned', 'blocked', 'unknown'];
      statusTypes.forEach(st => {
        const count = summary[st] || 0;
        if (count > 0 || st === 'verified' || st === 'implemented') {
          const pill = document.createElement('span');
          pill.className = 'status-pill pill-' + st;
          pill.textContent = count + ' ' + st.charAt(0).toUpperCase() + st.slice(1);
          summaryContainer.appendChild(pill);
        }
      });
    }

    function renderCompanionAnalysis(analysis) {
      if (!analysis) return;
      const thread = document.getElementById('companionThread');
      thread.innerHTML = '';

      (analysis.messages || []).forEach(msg => {
        const isDog = msg.speaker === 'dog';
        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble ' + (isDog ? 'bubble-dog' : 'bubble-cat');

        let html = '<div class="bubble-avatar-col">' + (isDog ? renderPixelDogSvg(24) : renderPixelCatSvg(24)) + '</div>' +
                   '<div class="bubble-content-col">' +
                   '<div class="bubble-header">' +
                   '<span class="bubble-speaker ' + (isDog ? 'speaker-dog' : 'speaker-cat') + '">' + (isDog ? 'Barkley' : 'Cleo') + '</span>' +
                   '<span class="bubble-tagline">' + (isDog ? 'Architectural Companion' : 'Evidence Auditor') + '</span>' +
                   '</div>' +
                   '<div class="bubble-text">' + escapeHtml(msg.text) + '</div>';

        if (msg.evidencePaths && msg.evidencePaths.length > 0) {
          html += '<div class="evidence-chips">';
          msg.evidencePaths.forEach(ep => {
            const raw = ep.split(':');
            const p = raw[0];
            const line = raw[1] || '1';
            html += '<a class="file-pill" data-path="' + escapeHtml(p) + '" data-line="' + escapeHtml(line) + '">🔍 ' + escapeHtml(p.split('/').pop()) + ':' + line + '</a>';
          });
          html += '</div>';
        }

        html += '</div>';
        bubble.innerHTML = html;

        bubble.querySelectorAll('a[data-path]').forEach(a => {
          a.addEventListener('click', (e) => {
            e.preventDefault();
            vscode.postMessage({ command: 'openFile', path: a.getAttribute('data-path'), line: a.getAttribute('data-line') });
          });
        });

        thread.appendChild(bubble);
      });

      // Suggestion Chips
      const suggRow = document.getElementById('suggestionsRow');
      suggRow.innerHTML = '';
      (analysis.suggestedQuestions || []).forEach(q => {
        const chip = document.createElement('button');
        chip.className = 'suggestion-chip';
        chip.textContent = q;
        chip.addEventListener('click', () => {
          appendUserBubble(q);
          vscode.postMessage({ command: 'askCompanion', question: q });
        });
        suggRow.appendChild(chip);
      });

      thread.scrollTop = thread.scrollHeight;
    }

    function appendCompanionReplies(messages) {
      const thread = document.getElementById('companionThread');
      (messages || []).forEach(msg => {
        const isDog = msg.speaker === 'dog';
        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble ' + (isDog ? 'bubble-dog' : 'bubble-cat');

        let html = '<div class="bubble-avatar-col">' + (isDog ? renderPixelDogSvg(24) : renderPixelCatSvg(24)) + '</div>' +
                   '<div class="bubble-content-col">' +
                   '<div class="bubble-header">' +
                   '<span class="bubble-speaker ' + (isDog ? 'speaker-dog' : 'speaker-cat') + '">' + (isDog ? 'Barkley' : 'Cleo') + '</span>' +
                   '<span class="bubble-tagline">' + (isDog ? 'Architectural Companion' : 'Evidence Auditor') + '</span>' +
                   '</div>' +
                   '<div class="bubble-text">' + escapeHtml(msg.text) + '</div>';

        if (msg.evidencePaths && msg.evidencePaths.length > 0) {
          html += '<div class="evidence-chips">';
          msg.evidencePaths.forEach(ep => {
            const raw = ep.split(':');
            const p = raw[0];
            const line = raw[1] || '1';
            html += '<a class="file-pill" data-path="' + escapeHtml(p) + '" data-line="' + escapeHtml(line) + '">🔍 ' + escapeHtml(p.split('/').pop()) + ':' + line + '</a>';
          });
          html += '</div>';
        }

        html += '</div>';
        bubble.innerHTML = html;

        bubble.querySelectorAll('a[data-path]').forEach(a => {
          a.addEventListener('click', (e) => {
            e.preventDefault();
            vscode.postMessage({ command: 'openFile', path: a.getAttribute('data-path'), line: a.getAttribute('data-line') });
          });
        });

        thread.appendChild(bubble);
      });
      thread.scrollTop = thread.scrollHeight;
    }

    function renderLedger(rooms) {
      const list = document.getElementById('ledgerList');
      list.innerHTML = '';
      rooms.forEach(room => {
        const card = document.createElement('div');
        card.style.background = 'var(--bg-surface)';
        card.style.border = '1px solid var(--border-subtle)';
        card.style.borderRadius = '6px';
        card.style.padding = '10px 12px';
        card.style.display = 'flex';
        card.style.flexDirection = 'column';
        card.style.gap = '6px';

        const top = document.createElement('div');
        top.style.display = 'flex';
        top.style.justifyContent = 'space-between';
        top.style.alignItems = 'center';

        const title = document.createElement('span');
        title.style.fontWeight = '700';
        title.style.color = '#FFFFFF';
        title.textContent = room.name;

        const pill = document.createElement('span');
        pill.className = 'status-pill pill-' + (room.status || 'unknown');
        pill.textContent = (room.status || 'unknown').toUpperCase();

        top.appendChild(title);
        top.appendChild(pill);
        card.appendChild(top);

        if (room.description) {
          const desc = document.createElement('div');
          desc.style.fontSize = '12px';
          desc.style.color = 'var(--text-secondary)';
          desc.textContent = room.description;
          card.appendChild(desc);
        }

        if (room.evidence) {
          const ev = document.createElement('div');
          ev.style.fontSize = '11px';
          ev.style.color = '#E0B565';
          ev.textContent = 'Evidence: ' + room.evidence;
          card.appendChild(ev);
        }

        list.appendChild(card);
      });
    }

    function renderGraph(graph) {
      if (!graph || !graph.nodes) return;
      const nodesLayer = document.getElementById('nodesLayer');
      const edgesLayer = document.getElementById('edgesLayer');
      nodesLayer.innerHTML = '';
      edgesLayer.innerHTML = '';

      const nodeMap = new Map();
      graph.nodes.forEach(n => nodeMap.set(n.id, n));

      (graph.edges || []).forEach(edge => {
        const src = nodeMap.get(edge.source);
        const tgt = nodeMap.get(edge.target);
        if (!src || !tgt) return;

        const x1 = src.x + (src.width / 2);
        const y1 = src.y + src.height;
        const x2 = tgt.x + (tgt.width / 2);
        const y2 = tgt.y;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const midY = (y1 + y2) / 2;
        path.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + midY + ', ' + x2 + ' ' + midY + ', ' + x2 + ' ' + y2);
        path.setAttribute('class', 'graph-edge');
        path.setAttribute('marker-end', 'url(#graphArrow)');
        edgesLayer.appendChild(path);
      });

      graph.nodes.forEach(node => {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('class', 'graph-node');
        g.setAttribute('transform', 'translate(' + node.x + ',' + node.y + ')');

        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('width', String(node.width || 200));
        rect.setAttribute('height', String(node.height || 75));
        rect.setAttribute('rx', '6');
        rect.setAttribute('ry', '6');
        rect.setAttribute('fill', '#3A2E2E');

        let strokeColor = '#9E7A3E';
        const st = String(node.importance || '').toLowerCase();
        if (st === 'verified') strokeColor = '#5B7A58';
        else if (st === 'blocked') strokeColor = '#9E4A4A';
        else if (st === 'planned') strokeColor = '#7A706B';

        rect.setAttribute('stroke', strokeColor);
        rect.setAttribute('stroke-width', '1.5');
        g.appendChild(rect);

        const t1 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t1.setAttribute('x', '12');
        t1.setAttribute('y', '26');
        t1.setAttribute('class', 'node-title');
        t1.textContent = node.label.length > 22 ? node.label.slice(0, 20) + '...' : node.label;
        g.appendChild(t1);

        const t2 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t2.setAttribute('x', '12');
        t2.setAttribute('y', '46');
        t2.setAttribute('class', 'node-sub');
        t2.textContent = node.subLabel || '';
        g.appendChild(t2);

        const t3 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t3.setAttribute('x', '12');
        t3.setAttribute('y', '62');
        t3.setAttribute('class', 'node-tag');
        t3.textContent = '[' + (node.classification || 'observed').toUpperCase() + '] ' + (node.filePath ? '📄 ' + node.filePath.split('/').pop() : '');
        g.appendChild(t3);

        g.addEventListener('click', () => {
          if (node.filePath) {
            vscode.postMessage({ command: 'openFile', path: node.filePath, line: 1 });
          }
        });

        nodesLayer.appendChild(g);
      });

      if (graph.bounds) {
        const svg = document.getElementById('graphSvg');
        const b = graph.bounds;
        svg.setAttribute('viewBox', b.minX + ' ' + b.minY + ' ' + Math.max(600, b.width) + ' ' + Math.max(450, b.height));
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/[&<>'"]/g, tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
      }[tag] || tag));
    }

    function renderPixelDogSvg(size) {
      return '<svg viewBox="0 0 16 16" width="' + size + '" height="' + size + '" style="shape-rendering:crispEdges; display:inline-block; vertical-align:middle;">' +
        '<rect x="3" y="1" width="3" height="4" fill="#4A2E1E" />' +
        '<rect x="4" y="2" width="1" height="2" fill="#E2873A" />' +
        '<rect x="10" y="1" width="3" height="4" fill="#4A2E1E" />' +
        '<rect x="11" y="2" width="1" height="2" fill="#E2873A" />' +
        '<rect x="3" y="4" width="10" height="7" fill="#C48E58" />' +
        '<rect x="4" y="4" width="8" height="6" fill="#E2873A" />' +
        '<rect x="7" y="5" width="2" height="2" fill="#FBE9CF" />' +
        '<rect x="4" y="6" width="2" height="2" fill="#22150F" />' +
        '<rect x="5" y="6" width="1" height="1" fill="#FFFFFF" />' +
        '<rect x="10" y="6" width="2" height="2" fill="#22150F" />' +
        '<rect x="10" y="6" width="1" height="1" fill="#FFFFFF" />' +
        '<rect x="5" y="8" width="6" height="4" fill="#FBE9CF" />' +
        '<rect x="7" y="8" width="2" height="2" fill="#1A0F0B" />' +
        '<rect x="7" y="10" width="2" height="1" fill="#C46C2C" />' +
        '<rect x="4" y="11" width="8" height="4" fill="#C48E58" />' +
        '<rect x="6" y="11" width="4" height="4" fill="#FBE9CF" />' +
        '<rect x="4" y="14" width="2" height="1" fill="#E2C9A6" />' +
        '<rect x="10" y="14" width="2" height="1" fill="#E2C9A6" />' +
        '<rect x="1" y="10" width="2" height="3" fill="#E2873A" />' +
        '</svg>';
    }

    function renderPixelCatSvg(size) {
      return '<svg viewBox="0 0 16 16" width="' + size + '" height="' + size + '" style="shape-rendering:crispEdges; display:inline-block; vertical-align:middle;">' +
        '<rect x="3" y="1" width="2" height="4" fill="#545B6B" />' +
        '<rect x="4" y="2" width="1" height="2" fill="#F08D9A" />' +
        '<rect x="11" y="1" width="2" height="4" fill="#545B6B" />' +
        '<rect x="11" y="2" width="1" height="2" fill="#F08D9A" />' +
        '<rect x="3" y="4" width="10" height="7" fill="#767E8F" />' +
        '<rect x="4" y="4" width="8" height="6" fill="#8B909A" />' +
        '<rect x="4" y="6" width="2" height="1" fill="#1B1C22" />' +
        '<rect x="4" y="7" width="2" height="1" fill="#F5C542" />' +
        '<rect x="10" y="6" width="2" height="1" fill="#1B1C22" />' +
        '<rect x="10" y="7" width="2" height="1" fill="#F5C542" />' +
        '<rect x="6" y="8" width="4" height="3" fill="#D9D4CC" />' +
        '<rect x="7" y="8" width="2" height="1" fill="#E07A86" />' +
        '<rect x="2" y="8" width="2" height="1" fill="#D9D4CC" />' +
        '<rect x="12" y="8" width="2" height="1" fill="#D9D4CC" />' +
        '<rect x="4" y="11" width="8" height="4" fill="#767E8F" />' +
        '<rect x="6" y="11" width="4" height="3" fill="#D9D4CC" />' +
        '<rect x="4" y="14" width="2" height="1" fill="#D9D4CC" />' +
        '<rect x="10" y="14" width="2" height="1" fill="#D9D4CC" />' +
        '<rect x="12" y="11" width="2" height="4" fill="#545B6B" />' +
        '</svg>';
    }
  </script>
</body>
</html>`;
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

function renderPixelDogSvg(size: number): string {
  return '<svg viewBox="0 0 16 16" width="' + size + '" height="' + size + '" style="shape-rendering:crispEdges; display:inline-block; vertical-align:middle;">' +
    '<rect x="3" y="1" width="3" height="4" fill="#4A2E1E" />' +
    '<rect x="4" y="2" width="1" height="2" fill="#E2873A" />' +
    '<rect x="10" y="1" width="3" height="4" fill="#4A2E1E" />' +
    '<rect x="11" y="2" width="1" height="2" fill="#E2873A" />' +
    '<rect x="3" y="4" width="10" height="7" fill="#C48E58" />' +
    '<rect x="4" y="4" width="8" height="6" fill="#E2873A" />' +
    '<rect x="7" y="5" width="2" height="2" fill="#FBE9CF" />' +
    '<rect x="4" y="6" width="2" height="2" fill="#22150F" />' +
    '<rect x="5" y="6" width="1" height="1" fill="#FFFFFF" />' +
    '<rect x="10" y="6" width="2" height="2" fill="#22150F" />' +
    '<rect x="10" y="6" width="1" height="1" fill="#FFFFFF" />' +
    '<rect x="5" y="8" width="6" height="4" fill="#FBE9CF" />' +
    '<rect x="7" y="8" width="2" height="2" fill="#1A0F0B" />' +
    '<rect x="7" y="10" width="2" height="1" fill="#C46C2C" />' +
    '<rect x="4" y="11" width="8" height="4" fill="#C48E58" />' +
    '<rect x="6" y="11" width="4" height="4" fill="#FBE9CF" />' +
    '<rect x="4" y="14" width="2" height="1" fill="#E2C9A6" />' +
    '<rect x="10" y="14" width="2" height="1" fill="#E2C9A6" />' +
    '<rect x="1" y="10" width="2" height="3" fill="#E2873A" />' +
    '</svg>';
}

function renderPixelCatSvg(size: number): string {
  return '<svg viewBox="0 0 16 16" width="' + size + '" height="' + size + '" style="shape-rendering:crispEdges; display:inline-block; vertical-align:middle;">' +
    '<rect x="3" y="1" width="2" height="4" fill="#545B6B" />' +
    '<rect x="4" y="2" width="1" height="2" fill="#F08D9A" />' +
    '<rect x="11" y="1" width="2" height="4" fill="#545B6B" />' +
    '<rect x="11" y="2" width="1" height="2" fill="#F08D9A" />' +
    '<rect x="3" y="4" width="10" height="7" fill="#767E8F" />' +
    '<rect x="4" y="4" width="8" height="6" fill="#8B909A" />' +
    '<rect x="4" y="6" width="2" height="1" fill="#1B1C22" />' +
    '<rect x="4" y="7" width="2" height="1" fill="#F5C542" />' +
    '<rect x="10" y="6" width="2" height="1" fill="#1B1C22" />' +
    '<rect x="10" y="7" width="2" height="1" fill="#F5C542" />' +
    '<rect x="6" y="8" width="4" height="3" fill="#D9D4CC" />' +
    '<rect x="7" y="8" width="2" height="1" fill="#E07A86" />' +
    '<rect x="2" y="8" width="2" height="1" fill="#D9D4CC" />' +
    '<rect x="12" y="8" width="2" height="1" fill="#D9D4CC" />' +
    '<rect x="4" y="11" width="8" height="4" fill="#767E8F" />' +
    '<rect x="6" y="11" width="4" height="3" fill="#D9D4CC" />' +
    '<rect x="4" y="14" width="2" height="1" fill="#D9D4CC" />' +
    '<rect x="10" y="14" width="2" height="1" fill="#D9D4CC" />' +
    '<rect x="12" y="11" width="2" height="4" fill="#545B6B" />' +
    '</svg>';
}
