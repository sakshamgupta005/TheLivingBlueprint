import * as vscode from 'vscode';
import { BlueprintViewProvider } from './blueprintViewProvider';
import { scanWorkspace } from './workspaceScanner';

let debounceTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceRoot = workspaceFolder ? workspaceFolder.uri.fsPath : undefined;

  let isScanning = false;

  const performScan = async () => {
    if (!workspaceRoot) {
      return;
    }
    if (isScanning) {
      return;
    }
    try {
      isScanning = true;
      provider.setScanning(true);
      const blueprintData = await scanWorkspace(workspaceRoot);
      provider.updateData(blueprintData);
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

  const provider = new BlueprintViewProvider(
    context.extensionUri,
    workspaceRoot,
    () => {
      performScan();
    }
  );

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

  // Set up debounced file watcher for automatic workspace updates
  if (workspaceRoot) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');

    const isIgnored = (uri: vscode.Uri) => {
      const p = uri.fsPath.replace(/\\/g, '/');
      return /(?:^|\/)(?:\.git|node_modules|dist|build|\.next|\.nuxt|vendor|coverage|\.vscode|out|target|\.turbo)\//.test(p);
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

    // Initial automatic scan on activation
    performScan();
  }
}

export function deactivate() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
}
