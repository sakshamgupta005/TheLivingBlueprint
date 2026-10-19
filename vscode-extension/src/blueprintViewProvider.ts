import * as vscode from 'vscode';
import * as path from 'path';
import type { WorkspaceBlueprintData } from './workspaceScanner';

export class BlueprintViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'livingBlueprint.overviewView';
  private _view?: vscode.WebviewView;
  private _latestData: WorkspaceBlueprintData | null = null;
  private _isScanning = false;
  private _onRefreshRequested?: () => void;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _workspaceRoot?: string,
    onRefreshRequested?: () => void
  ) {
    this._onRefreshRequested = onRefreshRequested;
  }

  public setRefreshHandler(handler: () => void) {
    this._onRefreshRequested = handler;
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

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'openFile': {
          if (message.path && this._workspaceRoot) {
            const fullPath = path.isAbsolute(message.path)
              ? message.path
              : path.join(this._workspaceRoot, message.path);
            try {
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
              await vscode.window.showTextDocument(doc);
            } catch (err) {
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
      }
    });

    if (this._latestData) {
      this.updateData(this._latestData);
    }
  }

  public setScanning(isScanning: boolean) {
    this._isScanning = isScanning;
    if (this._view) {
      this._view.webview.postMessage({
        type: 'scanningStatus',
        isScanning,
      });
    }
  }

  public updateData(data: WorkspaceBlueprintData) {
    this._latestData = data;
    this._isScanning = false;
    if (this._view) {
      this._view.webview.postMessage({
        type: 'blueprintUpdate',
        data,
      });
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Living Blueprint</title>
  <style>
    :root {
      --lb-bg: var(--vscode-editor-background);
      --lb-fg: var(--vscode-editor-foreground);
      --lb-subtext: var(--vscode-descriptionForeground, #8b949e);
      --lb-border: var(--vscode-panel-border, rgba(255, 255, 255, 0.12));
      --lb-card-bg: var(--vscode-sideBar-background, rgba(255, 255, 255, 0.03));
      --lb-card-hover: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.06));
      --lb-accent: #38bdf8;
      --lb-accent-glow: rgba(56, 189, 248, 0.2);
      
      --status-verified: #10b981;
      --status-implemented: #0284c7;
      --status-planned: #f59e0b;
      --status-blocked: #ef4444;
      --status-unknown: #8b5cf6;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      font-size: var(--vscode-font-size, 12px);
      color: var(--lb-fg);
      background-color: var(--lb-bg);
      padding: 12px;
      line-height: 1.45;
    }

    /* Blueprint Header */
    .header {
      border-bottom: 1px solid var(--lb-border);
      padding-bottom: 10px;
      margin-bottom: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .header-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .title-area {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .brand-title {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      color: var(--lb-accent);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .pulse-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background-color: #10b981;
      box-shadow: 0 0 6px #10b981;
      display: inline-block;
      animation: pulse 2s infinite ease-in-out;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }

    .btn-refresh {
      background: none;
      border: 1px solid var(--lb-border);
      color: var(--lb-fg);
      padding: 3px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      display: flex;
      align-items: center;
      gap: 4px;
      transition: background 0.15s ease;
    }

    .btn-refresh:hover {
      background: var(--lb-card-hover);
      border-color: var(--lb-accent);
    }

    .workspace-meta {
      font-size: 11px;
      color: var(--lb-subtext);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    /* Summary Metrics Bar */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 6px;
      margin-bottom: 12px;
    }

    .metric-card {
      background: var(--lb-card-bg);
      border: 1px solid var(--lb-border);
      border-radius: 6px;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .metric-num {
      font-size: 16px;
      font-weight: 700;
      color: var(--lb-accent);
    }

    .metric-label {
      font-size: 10px;
      text-transform: uppercase;
      color: var(--lb-subtext);
      letter-spacing: 0.5px;
    }

    /* Status Ledger */
    .status-pills-row {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 12px;
    }

    .status-pill {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 10px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: 1px solid transparent;
    }

    .pill-verified { background: rgba(16, 185, 129, 0.15); color: #34d399; border-color: rgba(16, 185, 129, 0.3); }
    .pill-implemented { background: rgba(2, 132, 199, 0.15); color: #38bdf8; border-color: rgba(2, 132, 199, 0.3); }
    .pill-planned { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border-color: rgba(245, 158, 11, 0.3); }
    .pill-blocked { background: rgba(239, 68, 68, 0.15); color: #f87171; border-color: rgba(239, 68, 68, 0.3); }
    .pill-unknown { background: rgba(139, 92, 246, 0.15); color: #c084fc; border-color: rgba(139, 92, 246, 0.3); }

    /* Truth Audit Banner */
    .truth-banner {
      background: rgba(56, 189, 248, 0.06);
      border-left: 3px solid var(--lb-accent);
      padding: 6px 8px;
      border-radius: 0 4px 4px 0;
      font-size: 10.5px;
      color: var(--lb-subtext);
      margin-bottom: 12px;
      line-height: 1.35;
    }

    /* Section Headers */
    .section-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--lb-subtext);
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    /* Room Cards */
    .rooms-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 16px;
    }

    .room-card {
      background: var(--lb-card-bg);
      border: 1px solid var(--lb-border);
      border-radius: 6px;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: border-color 0.15s ease, background 0.15s ease;
    }

    .room-card:hover {
      background: var(--lb-card-hover);
      border-color: rgba(56, 189, 248, 0.35);
    }

    .room-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .room-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--lb-fg);
    }

    .room-layer {
      font-size: 9.5px;
      text-transform: uppercase;
      padding: 1px 5px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--lb-subtext);
    }

    .room-desc {
      font-size: 11px;
      color: var(--lb-subtext);
    }

    .room-reason {
      font-size: 10.5px;
      font-style: italic;
      color: #93c5fd;
      border-left: 2px solid rgba(147, 197, 253, 0.4);
      padding-left: 6px;
    }

    .file-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 2px;
    }

    .file-tag {
      font-size: 10px;
      font-family: var(--vscode-editor-font-family, monospace);
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      padding: 1px 5px;
      border-radius: 3px;
      cursor: pointer;
      color: var(--lb-accent);
      text-decoration: none;
      transition: background 0.15s;
    }

    .file-tag:hover {
      background: rgba(56, 189, 248, 0.2);
      border-color: var(--lb-accent);
    }

    /* Pillars */
    .pillars-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 6px;
      margin-bottom: 16px;
    }

    .pillar-card {
      background: var(--lb-card-bg);
      border: 1px solid var(--lb-border);
      border-radius: 5px;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .pillar-name {
      font-size: 11px;
      font-weight: 600;
    }

    .pillar-status {
      font-size: 9.5px;
      text-transform: uppercase;
    }

    .pillar-verified { color: #34d399; }
    .pillar-configured { color: #38bdf8; }
    .pillar-missing { color: var(--lb-subtext); }

    .scanning-indicator {
      display: none;
      font-size: 11px;
      color: var(--lb-accent);
      padding: 4px 0;
      animation: pulse 1.5s infinite ease-in-out;
    }

    .scanning-indicator.active {
      display: block;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-top">
      <div class="title-area">
        <span class="pulse-dot"></span>
        <span class="brand-title">Living Blueprint</span>
      </div>
      <button class="btn-refresh" id="refreshBtn" title="Rescan Workspace">
        ↻ Rescan
      </button>
    </div>
    <div class="workspace-meta">
      <span id="wsName">Scanning workspace...</span>
      <span id="scanTimestamp"></span>
    </div>
    <div class="scanning-indicator" id="scanningIndicator">
      Scanning workspace architecture & evaluating evidence...
    </div>
  </div>

  <div class="metrics-grid">
    <div class="metric-card">
      <span class="metric-num" id="discoveredCount">-</span>
      <span class="metric-label">Files Discovered</span>
    </div>
    <div class="metric-card">
      <span class="metric-num" id="inspectedCount">-</span>
      <span class="metric-label">Files Inspected</span>
    </div>
  </div>

  <div class="status-pills-row" id="summaryPills"></div>

  <div class="truth-banner">
    <strong>Deterministic Engine:</strong> Discovered test files without live execution records produce <em>Implemented</em>, never falsely claiming <em>Verified</em>.
  </div>

  <div class="section-title">
    <span>Architecture Rooms</span>
    <span id="roomsCount" style="font-weight:normal; font-size:10px;"></span>
  </div>
  <div class="rooms-list" id="roomsList">
    <div style="color:var(--lb-subtext); font-style:italic; padding:8px 0;">No architecture modules evaluated yet.</div>
  </div>

  <div class="section-title">Infrastructure Pillars</div>
  <div class="pillars-grid" id="pillarsGrid"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'scanningStatus') {
        const ind = document.getElementById('scanningIndicator');
        if (message.isScanning) {
          ind.classList.add('active');
        } else {
          ind.classList.remove('active');
        }
      } else if (message.type === 'blueprintUpdate') {
        renderBlueprint(message.data);
      }
    });

    function renderBlueprint(data) {
      if (!data) return;

      document.getElementById('wsName').textContent = data.workspaceName || 'Local Workspace';
      document.getElementById('discoveredCount').textContent = data.discoveredFilesCount ?? 0;
      document.getElementById('inspectedCount').textContent = data.inspectedFilesCount ?? 0;

      if (data.scannedAt) {
        const d = new Date(data.scannedAt);
        document.getElementById('scanTimestamp').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

      // Rooms
      const roomsList = document.getElementById('roomsList');
      roomsList.innerHTML = '';
      const rooms = data.rooms || [];
      document.getElementById('roomsCount').textContent = rooms.length + ' rooms';

      rooms.forEach(room => {
        const card = document.createElement('div');
        card.className = 'room-card';

        const top = document.createElement('div');
        top.className = 'room-top';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'room-name';
        nameSpan.textContent = room.name;

        const pill = document.createElement('span');
        pill.className = 'status-pill pill-' + (room.status || 'unknown');
        pill.textContent = (room.status || 'unknown').toUpperCase();

        top.appendChild(nameSpan);
        top.appendChild(pill);
        card.appendChild(top);

        if (room.layer) {
          const layerSpan = document.createElement('span');
          layerSpan.className = 'room-layer';
          layerSpan.style.width = 'fit-content';
          layerSpan.textContent = 'Layer: ' + room.layer;
          card.appendChild(layerSpan);
        }

        if (room.description) {
          const desc = document.createElement('div');
          desc.className = 'room-desc';
          desc.textContent = room.description;
          card.appendChild(desc);
        }

        if (room.evidence) {
          const ev = document.createElement('div');
          ev.className = 'room-reason';
          ev.textContent = room.evidence;
          card.appendChild(ev);
        }

        // Associated files
        if (room.filePaths && room.filePaths.length > 0) {
          const fileTags = document.createElement('div');
          fileTags.className = 'file-tags';
          room.filePaths.slice(0, 6).forEach(fp => {
            const tag = document.createElement('span');
            tag.className = 'file-tag';
            tag.textContent = fp.split('/').pop() || fp;
            tag.title = fp + ' (Click to open in editor)';
            tag.addEventListener('click', () => {
              vscode.postMessage({ command: 'openFile', path: fp });
            });
            fileTags.appendChild(tag);
          });
          if (room.filePaths.length > 6) {
            const more = document.createElement('span');
            more.style.fontSize = '9px';
            more.style.color = 'var(--lb-subtext)';
            more.style.alignSelf = 'center';
            more.textContent = '+' + (room.filePaths.length - 6) + ' more';
            fileTags.appendChild(more);
          }
          card.appendChild(fileTags);
        }

        roomsList.appendChild(card);
      });

      // Pillars
      const pillarsGrid = document.getElementById('pillarsGrid');
      pillarsGrid.innerHTML = '';
      const pillars = data.pillars || [];
      pillars.forEach(p => {
        const card = document.createElement('div');
        card.className = 'pillar-card';

        const name = document.createElement('span');
        name.className = 'pillar-name';
        name.textContent = p.name;

        const stat = document.createElement('span');
        stat.className = 'pillar-status pillar-' + (p.status || 'missing');
        stat.textContent = (p.status || 'missing').toUpperCase();

        card.appendChild(name);
        card.appendChild(stat);
        pillarsGrid.appendChild(card);
      });
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
