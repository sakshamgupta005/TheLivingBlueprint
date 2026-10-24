/**
 * Pure scan lifecycle controller.
 * Manages state machine, cancellation, single follow-up scan queuing, debouncing,
 * and multi-root workspace management without importing 'vscode'.
 */

import type { WorkspaceBlueprintData } from './workspaceScanner.ts';
import {
  createWorkspaceSnapshot,
  invalidateWorkspaceCaches,
  type WorkspaceSnapshot,
} from './core/snapshot.ts';

export type ScanStateStatus =
  | 'noWorkspace'
  | 'idle'
  | 'scanning'
  | 'error'
  | 'empty'
  | 'truncated';

export interface ScanState {
  status: ScanStateStatus;
  message: string;
  folderPath?: string;
  folderName?: string;
  isStale?: boolean;
  timestamp: string;
  error?: string;
}

export interface WorkspaceFolderInfo {
  uri: { fsPath: string };
  name: string;
  index: number;
}

export interface ScanControllerOptions {
  debounceMs?: number;
  scanFn: (
    folderPath: string,
    signal: AbortSignal,
    dirtyBuffers?: Map<string, string>
  ) => Promise<WorkspaceBlueprintData>;
  onStateChange?: (state: ScanState) => void;
  onScanComplete?: (
    folderPath: string,
    data: WorkspaceBlueprintData,
    isStale: boolean
  ) => void;
  getDirtyBuffers?: (folderPath: string) => Map<string, string>;
}

export class ScanController {
  private _folders: Map<string, WorkspaceFolderInfo> = new Map();
  private _activeFolderPath: string | undefined;
  private _latestSnapshots: Map<string, WorkspaceBlueprintData> = new Map();
  private _dirtyFolders: Set<string> = new Set();
  private _acceptedFingerprints: Map<string, string> = new Map();
  private _currentState: ScanState;
  private _isScanning = false;
  private _rescanQueued = false;
  private _currentAbortController: AbortController | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _debounceMs: number;

  private readonly _options: ScanControllerOptions;

  constructor(options: ScanControllerOptions) {
    this._options = options;
    this._debounceMs = options.debounceMs ?? 400;
    this._currentState = {
      status: 'noWorkspace',
      message: 'No workspace folder open',
      timestamp: new Date().toISOString(),
    };
  }

  public getState(): ScanState {
    return this._currentState;
  }

  public getActiveFolderPath(): string | undefined {
    return this._activeFolderPath;
  }

  public getFolders(): WorkspaceFolderInfo[] {
    return Array.from(this._folders.values());
  }

  public getSnapshot(folderPath: string): WorkspaceBlueprintData | undefined {
    return this._latestSnapshots.get(folderPath);
  }

  public getAcceptedFingerprint(folderPath: string): string | undefined {
    return this._acceptedFingerprints.get(folderPath);
  }

  /**
   * Updates the set of workspace folders (e.g. from onDidChangeWorkspaceFolders).
   */
  public setFolders(folders: WorkspaceFolderInfo[]) {
    this._folders.clear();
    for (const f of folders) {
      this._folders.set(f.uri.fsPath, f);
    }

    if (this._folders.size === 0) {
      this._activeFolderPath = undefined;
      this._setState({
        status: 'noWorkspace',
        message: 'No workspace folder open',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Keep active folder if still valid, otherwise pick first folder
    if (!this._activeFolderPath || !this._folders.has(this._activeFolderPath)) {
      this._activeFolderPath = folders[0].uri.fsPath;
    }

    const currentSnapshot = this._latestSnapshots.get(this._activeFolderPath);
    if (currentSnapshot) {
      this._options.onScanComplete?.(this._activeFolderPath, currentSnapshot, false);
      const status: ScanState['status'] =
        currentSnapshot.discoveredFilesCount === 0 || currentSnapshot.rooms.length === 0
          ? 'empty'
          : currentSnapshot.truncated
          ? 'truncated'
          : 'idle';
      this._setState({
        status,
        message:
          status === 'empty'
            ? 'No architectural files found in workspace'
            : `Workspace architecture ready (${this._folders.get(this._activeFolderPath)?.name})`,
        folderPath: this._activeFolderPath,
        folderName: this._folders.get(this._activeFolderPath)?.name,
        isStale: false,
        timestamp: new Date().toISOString(),
      });
    } else {
      this.requestScan(true);
    }
  }

  /**
   * Switches the active workspace folder in a multi-root setup.
   */
  public setActiveFolder(folderPath: string) {
    if (!this._folders.has(folderPath)) {
      return;
    }
    this._activeFolderPath = folderPath;
    const snapshot = this._latestSnapshots.get(folderPath);
    const isDirty = this._dirtyFolders.has(folderPath);

    if (snapshot && !isDirty) {
      this._options.onScanComplete?.(folderPath, snapshot, false);
      const status: ScanState['status'] =
        snapshot.discoveredFilesCount === 0 || snapshot.rooms.length === 0
          ? 'empty'
          : snapshot.truncated
          ? 'truncated'
          : 'idle';
      this._setState({
        status,
        message:
          status === 'empty'
            ? 'No architectural files found in workspace'
            : `Active workspace: ${this._folders.get(folderPath)?.name}`,
        folderPath,
        folderName: this._folders.get(folderPath)?.name,
        isStale: false,
        timestamp: new Date().toISOString(),
      });
    } else if (snapshot && isDirty) {
      // Show cached snapshot as stale while rescan runs
      this._options.onScanComplete?.(folderPath, snapshot, true);
      this._setState({
        status: 'idle',
        message: `Active workspace: ${this._folders.get(folderPath)?.name} (updating...)`,
        folderPath,
        folderName: this._folders.get(folderPath)?.name,
        isStale: true,
        timestamp: new Date().toISOString(),
      });
      this.requestScan(true);
    } else {
      // Missing snapshot
      this.requestScan(true);
    }
  }

  /**
   * Requests a workspace scan. If immediate is false, uses debouncing.
   * If folderPath is supplied and does not match the active folder, marks that folder dirty.
   */
  public requestScan(immediate = false, folderPath?: string) {
    if (!this._activeFolderPath || this._folders.size === 0) {
      this._setState({
        status: 'noWorkspace',
        message: 'No workspace folder open',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (folderPath && folderPath !== this._activeFolderPath) {
      this._dirtyFolders.add(folderPath);
      return;
    }

    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = undefined;
    }

    if (immediate || this._debounceMs <= 0) {
      void this._executeScan();
    } else {
      this._debounceTimer = setTimeout(() => {
        void this._executeScan();
      }, this._debounceMs);
    }
  }

  private async _executeScan() {
    const folderPath = this._activeFolderPath;
    if (!folderPath) {
      return;
    }
    const folderName = this._folders.get(folderPath)?.name || 'Workspace';

    // If already scanning, abort in-flight scan and queue exactly one follow-up scan
    if (this._isScanning) {
      this._rescanQueued = true;
      if (this._currentAbortController) {
        this._currentAbortController.abort();
      }
      return;
    }

    this._isScanning = true;
    this._rescanQueued = false;
    this._currentAbortController = new AbortController();
    const signal = this._currentAbortController.signal;

    this._setState({
      status: 'scanning',
      message: `Scanning ${folderName}...`,
      folderPath,
      folderName,
      isStale: false,
      timestamp: new Date().toISOString(),
    });

    try {
      const dirtyBuffers = this._options.getDirtyBuffers?.(folderPath);
      const result = await this._options.scanFn(folderPath, signal, dirtyBuffers);

      if (signal.aborted) {
        return; // Aborted; follow-up scan will run
      }

      const snapshot = createWorkspaceSnapshot(result);
      const previousFingerprint = this._acceptedFingerprints.get(folderPath);
      const newFingerprint = snapshot.fingerprint;

      if (previousFingerprint && previousFingerprint !== newFingerprint) {
        invalidateWorkspaceCaches(folderName, previousFingerprint);
      }
      this._acceptedFingerprints.set(folderPath, newFingerprint);
      this._latestSnapshots.set(folderPath, snapshot);
      this._dirtyFolders.delete(folderPath);

      if (snapshot.discoveredFilesCount === 0 || snapshot.rooms.length === 0) {
        // Explicit empty state: clean empty workspace with zero fabricated rooms
        snapshot.rooms = [];
        snapshot.pillars = [];
        this._options.onScanComplete?.(folderPath, snapshot, false);
        this._setState({
          status: 'empty',
          message: 'No architectural files found in workspace',
          folderPath,
          folderName,
          isStale: false,
          timestamp: new Date().toISOString(),
        });
      } else if (snapshot.truncated) {
        this._options.onScanComplete?.(folderPath, snapshot, false);
        this._setState({
          status: 'truncated',
          message: `Scan truncated: ${snapshot.truncationReason || 'limit reached'}`,
          folderPath,
          folderName,
          isStale: false,
          timestamp: new Date().toISOString(),
        });
      } else {
        this._options.onScanComplete?.(folderPath, snapshot, false);
        this._setState({
          status: 'idle',
          message: 'Workspace architecture up to date',
          folderPath,
          folderName,
          isStale: false,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err: any) {
      if (signal.aborted || err?.name === 'AbortError') {
        return; // Normal cancellation
      }

      // Retain last successful snapshot and mark stale
      const previousSnapshot = this._latestSnapshots.get(folderPath);
      if (previousSnapshot) {
        this._options.onScanComplete?.(folderPath, previousSnapshot, true);
      }

      this._setState({
        status: 'error',
        message: 'Scan error occurred; retaining last known architecture snapshot.',
        folderPath,
        folderName,
        isStale: Boolean(previousSnapshot),
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
    } finally {
      this._isScanning = false;
      this._currentAbortController = null;

      // Execute queued scan if a change arrived during execution
      if (this._rescanQueued) {
        this._rescanQueued = false;
        void this._executeScan();
      }
    }
  }

  private _setState(state: ScanState) {
    this._currentState = state;
    this._options.onStateChange?.(state);
  }

  public dispose() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = undefined;
    }
    if (this._currentAbortController) {
      this._currentAbortController.abort();
      this._currentAbortController = null;
    }
    this._rescanQueued = false;
    this._isScanning = false;
  }
}
