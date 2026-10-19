import React, { useState } from 'react';
import type { GitHubScanResult, ScanStage } from '../domain/github/types.ts';
import { scanGitHubRepository } from '../domain/github/scanner.ts';
import type { WorkspaceSummary } from '../domain/workspace/types.ts';

interface RepoConnectBarProps {
  onScanComplete: (result: GitHubScanResult) => void;
  onResetSample: () => void;
  isSampleActive: boolean;
  onOpenDetails: () => void;
  lastScanResult: GitHubScanResult | null;
  recentProjects?: WorkspaceSummary[];
  activeWorkspaceId?: string | null;
  onSelectRecentProject?: (id: string) => void;
  onDeleteRecentProject?: (id: string) => void;
  isSavedData?: boolean;
  externalUrl?: string;
}

export const RepoConnectBar: React.FC<RepoConnectBarProps> = ({
  onScanComplete,
  onResetSample,
  isSampleActive,
  onOpenDetails,
  lastScanResult,
  recentProjects = [],
  activeWorkspaceId,
  onSelectRecentProject,
  onDeleteRecentProject,
  isSavedData = false,
  externalUrl,
}) => {
  const [urlInput, setUrlInput] = useState(externalUrl || '');
  const [isScanning, setIsScanning] = useState(false);
  const [stageMessage, setStageMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryUrl, setRetryUrl] = useState<{ url: string; isRefresh: boolean } | null>(null);

  React.useEffect(() => {
    if (externalUrl) {
      setUrlInput(externalUrl);
      setErrorMessage(null);
    }
  }, [externalUrl]);

  const performScan = async (repoUrl: string, isRefresh = false) => {
    setErrorMessage(null);
    setIsScanning(true);
    setStageMessage(isRefresh ? 'Checking GitHub for updates...' : 'Initiating scan...');

    try {
      const result = await scanGitHubRepository(
        repoUrl,
        { maxFilesToInspect: 12 },
        (_stage: ScanStage, msg: string) => {
          setStageMessage(msg);
        }
      );

      if (!result.success) {
        const errorText = result.error || (isRefresh ? 'Unable to fetch newer commit' : 'Repository scan failed.');
        const isRateLimit = errorText.toLowerCase().includes('rate limit');

        if (isRefresh) {
          setErrorMessage(`Refresh failed: ${errorText}. Preserving saved scan.`);
        } else {
          setErrorMessage(errorText);
        }

        // Only allow immediate retry if not rate-limited
        if (!isRateLimit) {
          setRetryUrl({ url: repoUrl, isRefresh });
        } else {
          setRetryUrl(null);
        }
      } else {
        setRetryUrl(null);
        onScanComplete(result);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error during scan';
      const isRateLimit = msg.toLowerCase().includes('rate limit');

      if (isRefresh) {
        setErrorMessage(`Refresh failed: ${msg}. Preserving saved scan.`);
      } else {
        setErrorMessage(msg);
      }

      if (!isRateLimit) {
        setRetryUrl({ url: repoUrl, isRefresh });
      } else {
        setRetryUrl(null);
      }
    } finally {
      setIsScanning(false);
      setStageMessage('');
    }
  };

  const handleScan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlInput.trim()) return;
    await performScan(urlInput.trim(), false);
  };

  const handleRefresh = async () => {
    if (!lastScanResult?.owner || !lastScanResult?.repo) return;
    const repoUrl = `https://github.com/${lastScanResult.owner}/${lastScanResult.repo}`;
    await performScan(repoUrl, true);
  };

  const formatScannedTime = (iso?: string) => {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  return (
    <div className="repo-connect-bar" role="region" aria-label="GitHub Repository Connection">
      <form onSubmit={handleScan} className="repo-input-form">
        <div className="input-group">
          <input
            type="text"
            className="repo-url-input"
            placeholder="https://github.com/owner/repository"
            value={urlInput}
            onChange={(e) => {
              setUrlInput(e.target.value);
              if (errorMessage) setErrorMessage(null);
            }}
            disabled={isScanning}
            aria-label="Public GitHub repository URL"
          />
          <button
            type="button"
            className="btn-demo-quickfill"
            onClick={() => {
              setUrlInput('https://github.com/sakshamgupta005/patchboard-tasks-api');
              if (errorMessage) setErrorMessage(null);
            }}
            disabled={isScanning}
            title="Pre-fill public Patchboard Tasks API demo repository"
          >
            Demo Repo
          </button>
          <select
            className="preset-repo-dropdown"
            aria-label="Preset demonstration and benchmark repositories"
            disabled={isScanning}
            onChange={(e) => {
              const selected = e.target.value;
              if (selected) {
                setUrlInput(selected);
                if (errorMessage) setErrorMessage(null);
                performScan(selected, false);
              }
            }}
            value=""
          >
            <option value="">⚡ Presets / Fixtures...</option>
            <option value="https://github.com/sakshamgupta005/patchboard-tasks-api">
              🎯 Patchboard Tasks API (Demo CI Failure)
            </option>
            <option value="https://github.com/sakshamgupta005/velocity">
              🏠 The Living Blueprint (Self Repository)
            </option>
            <option value="https://github.com/benchmark-org/vite-react-dashboard">
              ⚛️ TypeScript Frontend (React + Vite + Vitest)
            </option>
            <option value="https://github.com/benchmark-org/fastapi-inventory-api">
              🐍 Python API (FastAPI + Pydantic + SQL)
            </option>
            <option value="https://github.com/benchmark-org/saas-platform-monorepo">
              📦 Monorepo (Multi-package Workspaces)
            </option>
            <option value="https://github.com/benchmark-org/express-task-service">
              🟢 Small JS API (Express + SQLite)
            </option>
            <option value="https://github.com/benchmark-org/legacy-fortran-solver">
              ⚠️ Unsupported / Malformed (Fortran + Bad JSON)
            </option>
            <option value="https://github.com/benchmark-org/open-docs-portal">
              📄 Doc-Heavy Non-Code Repository
            </option>
          </select>
          <button
            type="submit"
            className="btn-scan"
            disabled={isScanning || !urlInput.trim()}
          >
            {isScanning ? 'Scanning...' : 'Scan repository'}
          </button>
        </div>

        {/* Compact Recent Projects Selector */}
        {recentProjects.length > 0 && (
          <div className="recent-projects-selector" role="group" aria-label="Recent Projects">
            <label htmlFor="recent-projects-select" className="recent-projects-label">
              Recent:
            </label>
            <select
              id="recent-projects-select"
              className="recent-projects-dropdown"
              value={!isSampleActive && activeWorkspaceId ? activeWorkspaceId : ''}
              onChange={(e) => {
                const targetId = e.target.value;
                if (targetId && onSelectRecentProject) {
                  onSelectRecentProject(targetId);
                }
              }}
              disabled={isScanning}
              aria-label="Select from previously scanned workspaces"
            >
              <option value="">-- Recent Projects ({recentProjects.length}) --</option>
              {recentProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} (@{p.commitSha.slice(0, 7)}) · {formatScannedTime(p.scannedAt)}
                  {p.ciStatus === 'failing' ? ' [CI ✕]' : p.ciStatus === 'passing' ? ' [CI ✓]' : ''}
                </option>
              ))}
            </select>

            {!isSampleActive && activeWorkspaceId && onDeleteRecentProject && (
              <button
                type="button"
                className="btn-delete-recent"
                onClick={() => onDeleteRecentProject(activeWorkspaceId)}
                title="Remove current workspace from local saved history"
                disabled={isScanning}
                aria-label={`Remove ${activeWorkspaceId} from history`}
              >
                ✕
              </button>
            )}
          </div>
        )}

        {/* Refresh / Rescan Button for active real repo */}
        {!isSampleActive && lastScanResult && (
          <button
            type="button"
            className={`btn-refresh-repo ${isSavedData ? 'highlight-refresh' : ''}`}
            onClick={handleRefresh}
            disabled={isScanning}
            title={
              isSavedData
                ? 'Check GitHub for newer commits and updated CI check runs'
                : 'Rescan repository to refresh commit and check runs'
            }
          >
            {isScanning ? 'Refreshing...' : isSavedData ? '🔄 Refresh from GitHub' : '🔄 Rescan'}
          </button>
        )}

        {!isSampleActive && (
          <button
            type="button"
            className="btn-reset-sample"
            onClick={onResetSample}
            disabled={isScanning}
            title="Switch back to BookNook demonstration dataset"
          >
            Reset to Sample Data
          </button>
        )}

        {lastScanResult && lastScanResult.success && (
          <button
            type="button"
            className="btn-view-telemetry"
            onClick={onOpenDetails}
            title="Inspect scan coverage and files inspected"
          >
            Scan Telemetry ({lastScanResult.inspectedFiles.length} files)
          </button>
        )}
      </form>

      {/* Helper text and status */}
      <div className="repo-connect-help">
        <div className="repo-help-status-line">
          <span>Public repositories only · GitHub API rate limit: 60 req/hr · Bounded to 12 files</span>
          {isSavedData && lastScanResult && (
            <span className="saved-data-indicator" role="status">
              💾 Saved scan (@{lastScanResult.commitSha ? lastScanResult.commitSha.slice(0, 7) : 'unknown'} · {formatScannedTime(lastScanResult.scannedAt)}) · Unverified against latest remote until refreshed
            </span>
          )}
          {!isSampleActive && lastScanResult && lastScanResult.status === 'partial' && (
            <span className="partial-scan-badge" role="status" title="Scan bounded to partial files. Open telemetry for details.">
              ⚡ Partial scan ({lastScanResult.inspectedFiles.length} inspected, {lastScanResult.skippedFiles.length} skipped)
            </span>
          )}
        </div>
        {isScanning && <span className="scan-progress-indicator">⚡ {stageMessage}</span>}
      </div>

      {/* Error banner */}
      {errorMessage && (
        <div className="repo-error-banner" role="alert">
          <span className="error-icon">⚠️</span>
          <span>{errorMessage}</span>
          {retryUrl && (
            <button
              type="button"
              className="btn-retry-scan"
              onClick={() => performScan(retryUrl.url, retryUrl.isRefresh)}
              disabled={isScanning}
              title="Retry repository request"
            >
              Retry
            </button>
          )}
          <button
            type="button"
            className="error-dismiss-btn"
            onClick={() => {
              setErrorMessage(null);
              setRetryUrl(null);
            }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
};
