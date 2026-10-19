import React from 'react';
import type { GitHubScanResult } from '../domain/github/types.ts';

interface ScanDetailsDrawerProps {
  scanResult: GitHubScanResult | null;
  isOpen: boolean;
  onClose: () => void;
}

export const ScanDetailsDrawer: React.FC<ScanDetailsDrawerProps> = ({
  scanResult,
  isOpen,
  onClose,
}) => {
  if (!isOpen || !scanResult) return null;

  return (
    <div
      className="scan-drawer-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="GitHub Repository Scan Details"
    >
      <div className="scan-drawer-content" onClick={(e) => e.stopPropagation()}>
        <div className="scan-drawer-header">
          <div>
            <h3 className="scan-drawer-title">
              Repository Scan Telemetry: {scanResult.owner}/{scanResult.repo}
            </h3>
            <div className="scan-drawer-subtitle">
              Branch: <code>{scanResult.metadata?.defaultBranch || 'default'}</code> · Commit:{' '}
              <code>{scanResult.commitSha ? scanResult.commitSha.slice(0, 7) : 'HEAD'}</code> · Status:{' '}
              <span className={`status-pill ${scanResult.status}`}>
                {scanResult.status.toUpperCase()}
              </span>
              {' '}· Duration: {scanResult.durationMs}ms
            </div>
          </div>
          <button className="room-detail-close" onClick={onClose} title="Close drawer">
            ✕
          </button>
        </div>

        {/* Warnings or Limitations Banner */}
        {scanResult.warnings.length > 0 && (
          <div className="scan-warning-box">
            <strong>Coverage Limitations:</strong>
            <ul>
              {scanResult.warnings.map((w, idx) => (
                <li key={idx}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Rate limit info */}
        {scanResult.rateLimit && (
          <div className="scan-ratelimit-info">
            GitHub REST Quota Remaining: <strong>{scanResult.rateLimit.remaining}</strong> /{' '}
            {scanResult.rateLimit.limit} req/hr (Resets:{' '}
            {new Date(scanResult.rateLimit.resetDate).toLocaleTimeString()})
          </div>
        )}

        {/* Partial Scan Honest Limitation Notice */}
        {scanResult.status === 'partial' && (
          <div className="scan-partial-box" role="status">
            <strong>⚠️ Partial Scan Coverage:</strong> {scanResult.inspectedFiles.length} file contents
            inspected; {scanResult.skippedFiles.length} files were skipped or could not be read.
            Architectural conclusions in rooms lacking inspected source files remain unverified.
          </div>
        )}

        {/* Metrics Grid */}
        <div className="scan-metrics-grid">
          <div className="scan-metric-card">
            <span className="metric-val">{scanResult.totalFilesDiscovered}</span>
            <span className="metric-lbl">Files in Git Tree</span>
          </div>
          <div className="scan-metric-card">
            <span className="metric-val">{scanResult.inspectedFiles.length}</span>
            <span className="metric-lbl">Files Inspected</span>
          </div>
          <div className="scan-metric-card">
            <span className="metric-val">
              {scanResult.skippedFiles.filter((f) => f.reason !== 'content_fetch_failed').length}
            </span>
            <span className="metric-lbl">Files Budget-Skipped</span>
          </div>
          <div className="scan-metric-card">
            <span className="metric-val">
              {scanResult.skippedFiles.filter((f) => f.reason === 'content_fetch_failed').length}
            </span>
            <span className="metric-lbl">Content Fetch Failed</span>
          </div>
        </div>

        {/* Detected Tech */}
        {scanResult.detectedTechnologies.length > 0 && (
          <div className="scan-tech-section">
            <div className="section-label">DETECTED TECHNOLOGIES & TOOLS:</div>
            <div className="tech-tags-list">
              {scanResult.detectedTechnologies.map((tech) => (
                <span key={tech} className="tech-tag">
                  {tech}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* GitHub CI & Check Runs */}
        <div className="scan-ci-section" style={{ marginTop: 16 }}>
          <div className="section-label">
            GITHUB CI & AUTOMATED CHECK RUNS ({scanResult.checkRuns?.length ?? 0}):
          </div>
          {scanResult.checkRuns && scanResult.checkRuns.length > 0 ? (
            <div className="lifecycle-checks-list" style={{ marginTop: 8 }}>
              {scanResult.checkRuns.map((cr) => {
                const concClass =
                  cr.conclusion === 'success'
                    ? 'conc-success'
                    : cr.conclusion === 'failure' || cr.conclusion === 'timed_out'
                    ? 'conc-failure'
                    : 'conc-pending';
                return (
                  <div key={cr.id} className="lifecycle-check-item">
                    <span className={`check-conclusion-tag ${concClass}`}>
                      {cr.conclusion || cr.status}
                    </span>
                    <span className="check-name">{cr.name}</span>
                    <span className="check-relevance">
                      {cr.isRelevantTestCheck ? 'Automated test suite' : 'Non-functional task'}
                    </span>
                    {cr.completedAt && (
                      <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                        {new Date(cr.completedAt).toLocaleTimeString()}
                      </span>
                    )}
                    {cr.htmlUrl && (
                      <a
                        href={cr.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="file-link"
                        title="Open run on GitHub"
                        style={{ marginLeft: 6 }}
                      >
                        ↗
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-subtext" style={{ marginTop: 6 }}>
              Verification evidence unavailable: No GitHub Actions or CI check runs retrieved for
              scanned commit <code>{scanResult.commitSha ? scanResult.commitSha.slice(0, 7) : 'HEAD'}</code>.
            </div>
          )}
        </div>

        {/* Inspected Files List */}
        <div className="scan-files-section">
          <div className="section-label">
            INSPECTED FILES ({scanResult.inspectedFiles.length} bounded sample):
          </div>
          <div className="inspected-files-list">
            {scanResult.inspectedFiles.map((file) => (
              <div key={file.path} className="inspected-file-item">
                <div className="file-item-header">
                  <div className="file-path-row">
                    <span className={`file-category-badge ${file.category}`}>{file.category}</span>
                    <a
                      href={file.githubUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="file-link"
                      title="Open file on GitHub"
                    >
                      {file.path} ↗
                    </a>
                  </div>
                  <span className="file-size">{(file.sizeBytes / 1024).toFixed(1)} KB</span>
                </div>
                {file.contentExcerpt && (
                  <pre className="file-excerpt">{file.contentExcerpt.slice(0, 300)}...</pre>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Skipped / Failed Files List */}
        {scanResult.skippedFiles.length > 0 && (
          <div className="scan-files-section" style={{ marginTop: 20 }}>
            <div className="section-label">
              EXCLUDED & SKIPPED FILES ({scanResult.skippedFiles.length}):
            </div>
            <div className="inspected-files-list">
              {scanResult.skippedFiles.map((skipped, idx) => (
                <div key={idx} className="inspected-file-item skipped-item">
                  <div className="file-item-header">
                    <span className="file-path">{skipped.path}</span>
                    <span className={`skipped-reason-tag ${skipped.reason}`}>
                      {skipped.reason.replace(/_/g, ' ')}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
