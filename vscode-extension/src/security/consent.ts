/**
 * consent.ts — Per-workspace-folder AI consent (P2-07).
 *
 * Consent defaults to off, is stored per folder, and is bound to the exact
 * set of open workspace folders at grant time. Any change to that set
 * (folder added, removed or swapped) invalidates the grant automatically,
 * so consent can never leak to a folder the user did not approve.
 *
 * Pure TypeScript: no vscode import. Pass `context.workspaceState` as the store.
 * The legacy global flag `livingBlueprint.aiConsent` (globalState) is
 * intentionally NOT read or migrated: every workspace starts with consent off.
 */

/** Structural subset of vscode.Memento. */
export interface ConsentStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
  keys(): readonly string[];
}

interface ConsentRecord {
  granted: true;
  folderSet: string;
  grantedAt: string;
}

const KEY_PREFIX = 'livingBlueprint.aiConsent.v2:';

function normalizeUri(uri: string): string {
  return uri.trim().replace(/\/+$/, '');
}

/** Order-independent identity of the open folder set. */
export function folderSetId(workspaceFolderUris: readonly string[]): string {
  return [...new Set(workspaceFolderUris.map(normalizeUri))].sort().join('\n');
}

function keyFor(folderUri: string): string {
  return KEY_PREFIX + normalizeUri(folderUri);
}

function isConsentRecord(value: unknown): value is ConsentRecord {
  const v = value as ConsentRecord | undefined;
  return Boolean(v && v.granted === true && typeof v.folderSet === 'string');
}

export interface ConsentManager {
  /** True only if this folder was granted while exactly the current folder set was open. */
  isGranted(folderUri: string, workspaceFolderUris: readonly string[]): boolean;
  /** Grants consent for one open folder. Returns false (and stores nothing) if the folder is not open. */
  grant(folderUri: string, workspaceFolderUris: readonly string[]): Promise<boolean>;
  revoke(folderUri: string): Promise<void>;
  /** Deletes grants for folders that are closed or were granted under a different folder set. */
  pruneStale(workspaceFolderUris: readonly string[]): Promise<void>;
  revokeAll(): Promise<void>;
}

export function createConsentManager(store: ConsentStore): ConsentManager {
  const ownKeys = () => store.keys().filter((k) => k.startsWith(KEY_PREFIX));

  return {
    isGranted(folderUri, workspaceFolderUris) {
      const normalized = normalizeUri(folderUri);
      if (!workspaceFolderUris.map(normalizeUri).includes(normalized)) return false;
      const record = store.get<unknown>(keyFor(normalized));
      return isConsentRecord(record) && record.folderSet === folderSetId(workspaceFolderUris);
    },

    async grant(folderUri, workspaceFolderUris) {
      const normalized = normalizeUri(folderUri);
      if (!normalized || !workspaceFolderUris.map(normalizeUri).includes(normalized)) return false;
      const record: ConsentRecord = {
        granted: true,
        folderSet: folderSetId(workspaceFolderUris),
        grantedAt: new Date().toISOString(),
      };
      await store.update(keyFor(normalized), record);
      return true;
    },

    async revoke(folderUri) {
      await store.update(keyFor(folderUri), undefined);
    },

    async pruneStale(workspaceFolderUris) {
      const open = new Set(workspaceFolderUris.map(normalizeUri));
      const currentSet = folderSetId(workspaceFolderUris);
      for (const key of ownKeys()) {
        const record = store.get<unknown>(key);
        const folder = key.slice(KEY_PREFIX.length);
        if (!isConsentRecord(record) || !open.has(folder) || record.folderSet !== currentSet) {
          await store.update(key, undefined);
        }
      }
    },

    async revokeAll() {
      for (const key of ownKeys()) {
        await store.update(key, undefined);
      }
    },
  };
}
