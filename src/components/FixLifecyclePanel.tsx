import React, { useState } from 'react';
import type { ArchitecturalRoom } from '../types.ts';
import type { GitHubScanResult } from '../domain/github/types.ts';
import type { RoomInvestigationFinding } from '../domain/investigation/types.ts';
import type { FixLifecycleState, UserFixReport } from '../domain/lifecycle/types.ts';
import { reinspectForFix } from '../domain/lifecycle/reinspectionEngine.ts';
import { PixelPetAvatar } from './PixelPetAvatar.tsx';
import type { RoomModule } from '../domain/types.ts';

interface FixLifecyclePanelProps {
  finding: RoomInvestigationFinding;
  room: ArchitecturalRoom;
  scanResult: GitHubScanResult | null;
  isSampleActive: boolean;
  onRoomUpdated?: (updatedRoom: ArchitecturalRoom) => void;
  savedLifecycleState?: FixLifecycleState | null;
  onLifecycleChange?: (state: FixLifecycleState | null) => void;
}

export const FixLifecyclePanel: React.FC<FixLifecyclePanelProps> = ({
  finding,
  room,
  scanResult,
  isSampleActive,
  onRoomUpdated,
  savedLifecycleState,
  onLifecycleChange,
}) => {
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const [commitRef, setCommitRef] = useState('');
  const [changedFilesInput, setChangedFilesInput] = useState('');
  const [testOutput, setTestOutput] = useState('');
  const [isReinspecting, setIsReinspecting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [lifecycleState, setLifecycleState] = useState<FixLifecycleState | null>(
    savedLifecycleState || null
  );

  const handleRunReinspection = async (reportToUse?: UserFixReport) => {
    if (isSampleActive || !scanResult) {
      setFormError('Re-inspection requires an active real GitHub scan. Please scan a public GitHub repository above.');
      return;
    }

    const rep: UserFixReport = reportToUse || {
      summary: summary.trim(),
      commitRef: commitRef.trim() || undefined,
      changedFiles: changedFilesInput
        .split('\n')
        .map((f) => f.trim())
        .filter((f) => f.length > 0),
      testOutput: testOutput.trim() || undefined,
      investigationFindingId: finding.title,
      originalFindingTitle: finding.title,
      roomId: room.id,
      roomName: room.name,
    };

    if (!rep.summary) {
      setFormError('Please provide a concise summary of the claimed fix.');
      return;
    }

    setIsReinspecting(true);
    setFormError(null);

    try {
      const roomModule: RoomModule = {
        id: room.id,
        name: room.name,
        description: room.description,
        layer: room.layer,
        requirements: [{ id: `req-${room.id}`, title: `${room.name} Requirements` }],
        evidenceHistory: [
          {
            id: `ev-baseline-${room.id}`,
            sourceType: 'source_code',
            description: room.evidence,
            timestamp: new Date().toISOString(),
            targetRequirementId: `req-${room.id}`,
            isBlocker: room.status === 'blocked',
            verificationResult:
              room.status === 'blocked' ? { status: 'failed' } : undefined,
          },
        ],
      };

      const result = await reinspectForFix(
        rep,
        roomModule,
        scanResult.owner,
        scanResult.repo,
        scanResult.metadata?.defaultBranch || 'main',
        scanResult.commitSha
      );

      setLifecycleState(result);
      onLifecycleChange?.(result);

      if (result.resultingStatusEvaluation && onRoomUpdated) {
        onRoomUpdated({
          ...room,
          status: result.resultingStatusEvaluation.status,
          evidence:
            result.newEvidenceRecords.map((e) => e.description).join('; ') || room.evidence,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to re-inspect repository.';
      setFormError(msg);
    } finally {
      setIsReinspecting(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleRunReinspection();
  };

  const handleRefresh = () => {
    if (lifecycleState) {
      handleRunReinspection(lifecycleState.report);
    }
  };

  return (
    <div className="fix-lifecycle-section">
      <div className="lifecycle-action-row">
        <button
          type="button"
          className="btn-report-fix"
          onClick={() => setIsFormOpen(!isFormOpen)}
        >
          {isFormOpen ? '✕ Close Fix Report' : '🛠️ Report fix & re-inspect repository'}
        </button>
      </div>

      {isFormOpen && (
        <form className="fix-report-form" onSubmit={handleSubmit}>
          <div className="form-heading">Report External Coding-Agent Fix</div>
          <p className="form-subtext">
            Submit changes made in Antigravity or Claude Code. Claims are verified against actual repository
            code and CI results; uncorroborated test output remains unverified.
          </p>

          {isSampleActive && (
            <div className="room-setup-banner">
              <strong>Sample Data Mode Active</strong>
              <p>
                To re-inspect real code and CI checks, connect a public GitHub repository using the URL bar above.
              </p>
            </div>
          )}

          {formError && (
            <div className="room-error-banner" role="alert">
              <span>⚠️ {formError}</span>
            </div>
          )}

          <div className="form-field">
            <label htmlFor="fix-summary">Fix Summary (Required)</label>
            <input
              id="fix-summary"
              type="text"
              placeholder="e.g. Added JWT token verification and refresh expiration check"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              required
            />
          </div>

          <div className="form-field">
            <label htmlFor="fix-commit">Commit URL, PR URL, or Commit SHA (Optional)</label>
            <input
              id="fix-commit"
              type="text"
              placeholder="e.g. 7-40 hex SHA or https://github.com/owner/repo/commit/..."
              value={commitRef}
              onChange={(e) => setCommitRef(e.target.value)}
            />
            <span className="field-hint">
              Must match the active repository ({scanResult ? `${scanResult.owner}/${scanResult.repo}` : 'active repo'}).
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="fix-files">Changed File Paths (Optional, one per line)</label>
            <textarea
              id="fix-files"
              rows={2}
              placeholder="src/auth/jwt.ts&#10;tests/auth.test.ts"
              value={changedFilesInput}
              onChange={(e) => setChangedFilesInput(e.target.value)}
            />
          </div>

          <div className="form-field">
            <label htmlFor="fix-test-output">Pasted Test Command & Output (Optional)</label>
            <textarea
              id="fix-test-output"
              rows={3}
              placeholder="npm test -> 12 passed. (Note: Marked as user-reported evidence until corroborated by CI)"
              value={testOutput}
              onChange={(e) => setTestOutput(e.target.value)}
            />
          </div>

          <button
            type="submit"
            className="btn-submit-fix-report"
            disabled={isReinspecting || !summary.trim() || isSampleActive}
          >
            {isReinspecting ? '⚡ Re-inspecting Repository...' : '🔍 Inspect Updated Repository & Verify'}
          </button>
        </form>
      )}

      {/* Lifecycle Result Panel */}
      {lifecycleState && (
        <div className="lifecycle-results-card" role="region" aria-label="Fix Verification Lifecycle">
          <div className="lifecycle-card-header">
            <h4>Verification Lifecycle & Re-Inspection</h4>
            <div className="lifecycle-outcome-badge-wrap">
              <span className={`outcome-pill outcome-${lifecycleState.verificationOutcome}`}>
                {lifecycleState.verificationOutcome.toUpperCase()}
              </span>
            </div>
          </div>

          {/* Original finding & baseline */}
          <div className="lifecycle-meta-grid">
            <div className="meta-box">
              <span className="meta-label">ORIGINAL FINDING</span>
              <span className="meta-val">{finding.title}</span>
            </div>
            <div className="meta-box">
              <span className="meta-label">BASELINE COMMIT</span>
              <span className="meta-val">
                <code>{lifecycleState.baselineCommitSha ? lifecycleState.baselineCommitSha.slice(0, 7) : 'Initial Scan'}</code>
              </span>
            </div>
            <div className="meta-box">
              <span className="meta-label">INSPECTED REVISION</span>
              <span className="meta-val">
                {lifecycleState.inspectedCommit ? (
                  <a
                    href={lifecycleState.inspectedCommit.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="commit-link"
                  >
                    <code>{lifecycleState.inspectedCommit.sha.slice(0, 7)}</code> ↗
                  </a>
                ) : (
                  'Unavailable'
                )}
              </span>
            </div>
          </div>

          {/* User reported summary */}
          <div className="lifecycle-claim-box">
            <strong>Claimed Fix:</strong> {lifecycleState.report.summary}
          </div>

          {/* Inspected Changed Files */}
          <div className="lifecycle-files-box">
            <span className="meta-label">CHANGED FILES INSPECTED IN REVISION:</span>
            {lifecycleState.inspectedChangedFiles.length > 0 ? (
              <ul className="lifecycle-files-list">
                {lifecycleState.inspectedChangedFiles.map((f) => (
                  <li key={f.path} className="lifecycle-file-item">
                    <a href={f.githubUrl} target="_blank" rel="noopener noreferrer">
                      <code>{f.path}</code> ↗
                    </a>
                    <span className="file-cat-tag">({f.category})</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-subtext">No changed files were inspected for this commit.</p>
            )}

            {lifecycleState.uninspectedReportedFiles.length > 0 && (
              <div className="uninspected-warning">
                ⚠️ Reported files not present in commit: {lifecycleState.uninspectedReportedFiles.join(', ')}
              </div>
            )}
          </div>

          {/* CI Checks & Results */}
          <div className="lifecycle-checks-box">
            <span className="meta-label">GITHUB CI & CHECK RUNS:</span>
            {lifecycleState.checks.length > 0 ? (
              <ul className="lifecycle-checks-list">
                {lifecycleState.checks.map((c) => (
                  <li key={c.id} className="lifecycle-check-item">
                    <span className={`check-conclusion-tag conc-${c.conclusion || 'pending'}`}>
                      {c.conclusion || c.status}
                    </span>
                    <span className="check-name">{c.name}</span>
                    <span className="check-relevance">
                      {c.isRelevantTestCheck ? '✓ Test Suite' : '○ Non-functional check'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-subtext">
                No automated CI check-runs found for this commit. Functional verification requires automated test runs.
              </p>
            )}
          </div>

          {/* Outcome Reason & Status Impact */}
          <div className="lifecycle-status-impact">
            <strong>Status Derivation:</strong> {lifecycleState.outcomeReason}
            {lifecycleState.resultingStatusEvaluation && (
              <div className="resulting-status-note">
                Resulting Room Status:{' '}
                <strong style={{ textTransform: 'uppercase' }}>
                  {lifecycleState.resultingStatusEvaluation.status}
                </strong>
              </div>
            )}
          </div>

          {/* Companion Dialogue */}
          {lifecycleState.companionMessages.length > 0 && (
            <div className="finding-dialogue-section">
              {lifecycleState.companionMessages.map((msg, idx) => (
                <div key={idx} className={`finding-companion-quote ${msg.speaker}`}>
                  <PixelPetAvatar speaker={msg.speaker} size={20} />
                  <div>
                    <span className="quote-speaker">
                      {msg.speaker === 'dog' ? 'Barkley:' : 'Cleo:'}
                    </span>{' '}
                    {msg.text}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Warnings */}
          {lifecycleState.warnings.length > 0 && (
            <div className="lifecycle-warnings-box">
              {lifecycleState.warnings.map((w, i) => (
                <div key={i} className="warning-line">
                  ⚠️ {w}
                </div>
              ))}
            </div>
          )}

          {/* Refresh Action */}
          <div className="lifecycle-footer-actions">
            <button
              type="button"
              className="btn-refresh-reinspection"
              onClick={handleRefresh}
              disabled={isReinspecting}
            >
              {isReinspecting ? '⚡ Refreshing...' : '🔄 Refresh and re-inspect'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
