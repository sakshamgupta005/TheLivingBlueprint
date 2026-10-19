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
      </div>
    </header>
  );
};
