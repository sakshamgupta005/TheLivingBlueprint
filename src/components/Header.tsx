import React from 'react';
import { SAMPLE_PROJECT } from '../data/sampleData';

interface HeaderProps {
  sourceName?: string;
  sourceStatusLabel?: string;
  isRealRepo?: boolean;
  branchName?: string;
  scanStatus?: 'completed' | 'partial' | 'failed';
  isSavedData?: boolean;
  commitSha?: string;
  scannedAt?: string;
  activeViewMode?: 'blueprint' | 'resilience';
  onViewModeChange?: (mode: 'blueprint' | 'resilience') => void;
  hasRiskAlert?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  sourceName = SAMPLE_PROJECT.name,
  sourceStatusLabel = SAMPLE_PROJECT.statusLabel,
  isRealRepo = false,
  branchName,
  scanStatus,
  isSavedData = false,
  commitSha,
  scannedAt,
  activeViewMode = 'blueprint',
  onViewModeChange,
  hasRiskAlert = false,
}) => {
  const formatTime = (iso?: string) => {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  return (
    <header className="app-header">
      <div className="header-brand">
        <div className="brand-title-row">
          <span className="brand-name">The Living Blueprint</span>
          <span className="version-pill">v0.15.0 · Living Blueprint</span>
        </div>
        <p className="brand-purpose">
          Evidence-backed architecture verification for AI coding agent projects
        </p>
      </div>

      <div className="header-status">
        <div
          className={`status-badge ${
            isRealRepo
              ? isSavedData
                ? 'saved-repo'
                : scanStatus === 'partial'
                ? 'partial-repo'
                : 'real-repo'
              : 'sample-data'
          }`}
          title={
            isRealRepo
              ? isSavedData
                ? `Restored from saved scan at ${scannedAt || 'earlier session'}. Not yet refreshed against GitHub.`
                : scanStatus === 'partial'
                ? 'Live repository scan completed with bounded file budget (partial scan)'
                : 'Live repository scan from GitHub REST API'
              : 'Fallback demonstration dataset'
          }
        >
          <span
            className={`status-indicator-dot ${
              isRealRepo
                ? isSavedData
                  ? 'saved'
                  : scanStatus === 'partial'
                  ? 'partial'
                  : 'real'
                : 'sample'
            }`}
          />
          <span>
            Source: <strong>{sourceName}</strong>{' '}
            {branchName && <span className="branch-label">[{branchName}]</span>}{' '}
            {commitSha && <span className="commit-tag">@{commitSha.slice(0, 7)}</span>}{' '}
            ({isRealRepo
              ? isSavedData
                ? `Saved Scan (${formatTime(scannedAt) || 'local'} · Not refreshed)`
                : scanStatus === 'partial'
                ? 'Live Scan · PARTIAL (Bounded)'
                : `Live Scan · ${scanStatus?.toUpperCase() ?? 'COMPLETED'}`
              : sourceStatusLabel})
          </span>
        </div>

        {/* View Mode Segmented Control (Part 2.5) */}
        <div className="header-mode-toggle" role="tablist" aria-label="View Mode">
          <button
            type="button"
            role="tab"
            aria-selected={activeViewMode === 'blueprint'}
            className={`mode-toggle-btn ${activeViewMode === 'blueprint' ? 'active' : ''}`}
            onClick={() => onViewModeChange?.('blueprint')}
            title="Switch to Architecture Blueprint view"
          >
            <span>🏛️ Blueprint</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeViewMode === 'resilience'}
            className={`mode-toggle-btn ${activeViewMode === 'resilience' ? 'active' : ''} ${
              hasRiskAlert ? 'has-risk-alert' : ''
            }`}
            onClick={() => onViewModeChange?.('resilience')}
            title="Switch to Live Risk view"
          >
            <span className="mode-indicator-dot" />
            <span>⚡ Live Risk</span>
            {hasRiskAlert && <span className="risk-pulse-dot" aria-label="Incident risk alert">●</span>}
          </button>
        </div>

        {/* Extension Download Entry Point */}
        <a
          href="/api/download/extension"
          download="living-blueprint-vscode.vsix"
          className="header-download-btn"
          title="Download official VS Code Extension package (.vsix) to install via Extensions: Install from VSIX"
          aria-label="Download VS Code Extension package"
        >
          <span>📦 VS Code Extension</span>
        </a>
      </div>
    </header>
  );
};
