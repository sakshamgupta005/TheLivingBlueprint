import React, { useState, useEffect, useMemo } from 'react';
import type { ArchitecturalRoom } from '../types.ts';
import type { GitHubScanResult } from '../domain/github/types.ts';
import type { RoomInvestigationFinding } from '../domain/investigation/types.ts';
import type { FixLifecycleState } from '../domain/lifecycle/types.ts';
import { PixelPetAvatar } from './PixelPetAvatar.tsx';
import { FixLifecyclePanel } from './FixLifecyclePanel.tsx';
import { RoomInternalsView } from './RoomInternalsView.tsx';
import { AiUsageLimitNotice } from './AiUsageLimitNotice.tsx';
import { deriveRoomInternals } from '../domain/workflow/roomInternalsEngine.ts';
import { scopeRepoContext } from '../server/contextBuilder.ts';
import type { AiErrorInfo } from '../server/types.ts';

interface RoomInspectorProps {
  room: ArchitecturalRoom | null;
  onClose: () => void;
  scanResult: GitHubScanResult | null;
  isSampleActive: boolean;
  allRooms?: ArchitecturalRoom[];
  onSelectRoom?: (roomId: string) => void;
  onRoomUpdated?: (updatedRoom: ArchitecturalRoom) => void;
  savedFinding?: RoomInvestigationFinding | null;
  onFindingChange?: (roomId: string, finding: RoomInvestigationFinding | null) => void;
  savedLifecycleState?: FixLifecycleState | null;
  onLifecycleChange?: (roomId: string, state: FixLifecycleState | null) => void;
}

export const RoomInspector: React.FC<RoomInspectorProps> = ({
  room,
  onClose,
  scanResult,
  isSampleActive,
  allRooms = [],
  onSelectRoom,
  onRoomUpdated,
  savedFinding,
  onFindingChange,
  savedLifecycleState,
  onLifecycleChange,
}) => {
  const [isInvestigating, setIsInvestigating] = useState(false);
  const [investigationStage, setInvestigationStage] = useState<string>('');
  const [finding, setFinding] = useState<RoomInvestigationFinding | null>(savedFinding || null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorInfo, setErrorInfo] = useState<AiErrorInfo | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [showPrompt, setShowPrompt] = useState(Boolean(savedFinding?.generatedPrompt));
  const [copySuccess, setCopySuccess] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const [internalsViewMode, setInternalsViewMode] = useState<'diagram' | 'simulation' | 'evidence_chain'>('diagram');

  const handleJumpTo = (target: 'graph' | 'simulation' | 'test_evidence' | 'source' | 'related_room', extraId?: string) => {
    if (target === 'graph') {
      setInternalsViewMode('diagram');
      setIsExpanded(false);
      setTimeout(() => {
        document.querySelector('.room-internals-container')?.scrollIntoView({ behavior: 'smooth' });
      }, 60);
    } else if (target === 'simulation') {
      setInternalsViewMode('simulation');
      setIsExpanded(false);
      setTimeout(() => {
        document.querySelector('.room-internals-container')?.scrollIntoView({ behavior: 'smooth' });
      }, 60);
    } else if (target === 'test_evidence') {
      setInternalsViewMode('evidence_chain');
      setIsExpanded(false);
      setTimeout(() => {
        document.querySelector('.room-internals-container')?.scrollIntoView({ behavior: 'smooth' });
      }, 60);
    } else if (target === 'source') {
      const el = document.querySelector('.finding-code-evidence-box');
      el?.scrollIntoView({ behavior: 'smooth' });
    } else if (target === 'related_room' && extraId && onSelectRoom) {
      setIsExpanded(false);
      onSelectRoom(extraId);
    }
  };

  const isInvestigatingRef = React.useRef(false);
  const investigateAbortControllerRef = React.useRef<AbortController | null>(null);
  const activeTargetRef = React.useRef<{ roomId: string; commitSha?: string }>({
    roomId: room?.id || '',
    commitSha: scanResult?.commitSha,
  });
  const lastActiveElementRef = React.useRef<HTMLElement | null>(null);
  const expandedDialogRef = React.useRef<HTMLDivElement | null>(null);

  // Abort any in-flight request when component unmounts
  useEffect(() => {
    return () => {
      investigateAbortControllerRef.current?.abort();
    };
  }, []);

  // Restore or clear investigation and prompt state when switching rooms, repository, or scanned commit
  useEffect(() => {
    investigateAbortControllerRef.current?.abort();
    activeTargetRef.current = {
      roomId: room?.id || '',
      commitSha: scanResult?.commitSha,
    };
    setFinding(savedFinding || null);
    setErrorMessage(null);
    setErrorInfo(null);
    setSetupRequired(false);
    setShowPrompt(Boolean(savedFinding?.generatedPrompt));
    setCopySuccess(false);
    setIsDismissed(false);
  }, [room?.id, scanResult?.owner, scanResult?.repo, scanResult?.commitSha, isSampleActive, savedFinding]);

  const internalsData = useMemo(() => {
    if (!room) return null;
    return deriveRoomInternals(room, scanResult, isSampleActive, allRooms, finding);
  }, [room, scanResult, isSampleActive, allRooms, finding]);

  // Handle keyboard Escape, focus management, and background scroll locking for expanded modal
  useEffect(() => {
    if (!isExpanded) return;

    lastActiveElementRef.current = document.activeElement as HTMLElement | null;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsExpanded(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    const timer = setTimeout(() => {
      expandedDialogRef.current?.focus();
    }, 50);

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = originalOverflow;
      clearTimeout(timer);
      lastActiveElementRef.current?.focus?.();
    };
  }, [isExpanded]);

  if (!room) {
    if (isDismissed) return null;
    return (
      <div
        className="room-detail-panel room-inspector-empty"
        role="region"
        aria-label="Room Architecture Inspector"
      >
        <div className="room-detail-header">
          <div>
            <div className="room-detail-title">🔍 Room Inspector</div>
            <div
              style={{
                fontSize: '0.72rem',
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              No room selected
            </div>
          </div>
          <button
            className="room-detail-close"
            onClick={() => setIsDismissed(true)}
            aria-label="Dismiss inspector guide"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
        <div className="room-empty-guide-content">
          <p className="room-empty-guide-text">
            Select a room in the architecture house above to inspect verified evidence, run AI diagnostics, or generate repair prompts.
          </p>
          <div className="room-empty-guide-tip">
            💡 Tip: Click any room in the isometric house to inspect what is implemented, verified, or failing.
          </div>
        </div>
      </div>
    );
  }

  const getStatusBadge = (status: ArchitecturalRoom['status']) => {
    switch (status) {
      case 'verified':
        return <span style={{ color: 'var(--status-verified)' }}>✓ Verified by Evidence</span>;
      case 'implemented':
      case 'in_progress':
        return <span style={{ color: 'var(--status-progress)' }}>⚡ Implemented (Verification Pending)</span>;
      case 'planned':
        return <span style={{ color: 'var(--status-planned)' }}>○ Planned (Wireframe Spec)</span>;
      case 'blocked':
        return <span style={{ color: 'var(--status-blocked)' }}>✕ Failing / Blocked</span>;
      case 'unknown':
        return <span style={{ color: '#B6A6C5' }}>? Unknown / Insufficient Evidence</span>;
    }
  };

  const getStatusMeaning = (status: ArchitecturalRoom['status']) => {
    switch (status) {
      case 'verified':
        return 'Relevant, current verification evidence supports the requirement.';
      case 'implemented':
      case 'in_progress':
        return 'Relevant source evidence exists, but automated verification is absent or pending.';
      case 'planned':
        return 'Sufficient implementation evidence is absent.';
      case 'blocked':
        return 'Relevant unresolved failing evidence exists.';
      case 'unknown':
        return 'Evidence is insufficient or contradictory.';
    }
  };

  const handleInvestigate = async () => {
    if (isInvestigating || isInvestigatingRef.current) return;
    isInvestigatingRef.current = true;
    setIsInvestigating(true);
    setInvestigationStage('Stage 1/3: Preparing room and repository context...');
    setErrorMessage(null);
    setErrorInfo(null);
    setSetupRequired(false);
    setShowPrompt(false);

    // Cancel any previous in-flight request before launching new investigation
    investigateAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    investigateAbortControllerRef.current = abortController;

    const stageTimer1 = setTimeout(() => {
      setInvestigationStage('Stage 2/3: Querying Gemini AI diagnostic engine...');
    }, 1200);

    const stageTimer2 = setTimeout(() => {
      setInvestigationStage('Stage 3/3: Grounding findings & validating code evidence...');
    }, 3800);

    const rawRepoContext = !isSampleActive && scanResult
      ? {
          owner: scanResult.owner,
          repo: scanResult.repo,
          branch: scanResult.metadata?.defaultBranch || 'main',
          commitSha: scanResult.commitSha,
          inspectedFiles: scanResult.inspectedFiles.map((f) => ({
            path: f.path,
            category: f.category,
            contentExcerpt: f.contentExcerpt,
            sizeBytes: f.sizeBytes,
          })),
          discoveredFilePaths: scanResult.discoveredFilePaths || scanResult.inspectedFiles.map((f) => f.path),
          detectedTechnologies: scanResult.detectedTechnologies,
          dependencies: room.dependencies,
          ciEvaluation: scanResult.ciEvaluation
            ? {
                status:
                  scanResult.ciEvaluation.outcome === 'failed'
                    ? 'failing'
                    : scanResult.ciEvaluation.outcome === 'verified'
                    ? 'passing'
                    : 'inconclusive',
                isVerified: scanResult.ciEvaluation.outcome === 'verified',
                reason: scanResult.ciEvaluation.outcomeReason,
                checkRunsCount: scanResult.ciEvaluation.relevantTestChecks.length,
                failedChecks: scanResult.ciEvaluation.relevantTestChecks
                  .filter((c) => c.conclusion === 'failure' || c.conclusion === 'timed_out')
                  .map((c) => c.name),
              }
            : undefined,
        }
      : undefined;

    const repoContext = rawRepoContext
      ? scopeRepoContext(rawRepoContext, {
          selectedRoomId: room.id,
          selectedRoomFilePaths: room.filePaths,
          dependencies: room.dependencies,
        })
      : {
          owner: 'example',
          repo: 'booknook-demo',
          branch: 'main',
          inspectedFiles: [
            { path: 'src/auth/jwt.ts', category: 'source', contentExcerpt: 'export function signToken() { ... }' },
            { path: 'src/catalog/books.ts', category: 'source', contentExcerpt: 'export const getBooks = () => []' },
            { path: 'tests/auth.test.ts', category: 'test', contentExcerpt: 'describe("Auth", () => { ... })' },
          ],
          discoveredFilePaths: [
            'src/auth/jwt.ts',
            'src/catalog/books.ts',
            'tests/auth.test.ts',
            'Dockerfile',
            'package.json',
          ],
          detectedTechnologies: ['TypeScript', 'React', 'PostgreSQL', 'Docker'],
        };

    const targetRoomId = room.id;
    const targetCommitSha = scanResult?.commitSha;

    try {
      const response = await fetch('/api/investigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortController.signal,
        body: JSON.stringify({
          roomId: room.id,
          roomName: room.name,
          roomLayer: room.layer,
          roomStatus: room.status,
          roomEvidence: room.evidence,
          roomFilePaths: room.filePaths,
          bypassCache: true,
          repoContext,
        }),
      });

      const data = await response.json();

      // Discard late response if user switched room or commit while request was in-flight
      if (
        activeTargetRef.current.roomId !== targetRoomId ||
        activeTargetRef.current.commitSha !== targetCommitSha
      ) {
        return;
      }

      if (!response.ok || !data.success) {
        if (data.code === 'CONFIG_REQUIRED') {
          setSetupRequired(true);
        } else {
          const baseMsg = data.error || 'Investigation failed.';
          const preservedNotice = finding ? ' (Preserving previous finding from earlier run)' : '';
          setErrorMessage(`${baseMsg}${preservedNotice}`);
          setErrorInfo(data.errorInfo || null);
        }
        return;
      }

      const newFinding = data.finding || null;
      setFinding(newFinding);
      setErrorInfo(null);
      if (room?.id && onFindingChange) {
        onFindingChange(room.id, newFinding);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      if (
        activeTargetRef.current.roomId !== targetRoomId ||
        activeTargetRef.current.commitSha !== targetCommitSha
      ) {
        return;
      }
      const msg = err instanceof Error ? err.message : 'Network failure';
      const preservedNotice = finding ? ' (Preserving previous finding from earlier run)' : '';
      setErrorMessage(`Investigation request failed: ${msg}. You can retry.${preservedNotice}`);
      setErrorInfo({
        kind: 'network_error',
        title: 'Network connection issue',
        message: 'Unable to reach the AI provider network. Please check your internet connection.',
        retryable: true,
        proHint: false,
      });
    } finally {
      clearTimeout(stageTimer1);
      clearTimeout(stageTimer2);
      isInvestigatingRef.current = false;
      setIsInvestigating(false);
      setInvestigationStage('');
    }
  };

  const handleCopyPrompt = async () => {
    if (!finding?.generatedPrompt) return;
    try {
      await navigator.clipboard.writeText(finding.generatedPrompt);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2500);
    } catch {
      // Fallback if clipboard API is blocked
      const textArea = document.createElement('textarea');
      textArea.value = finding.generatedPrompt;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2500);
    }
  };

  return (
    <>
      <div
        className={`room-detail-panel ${finding ? 'expanded-investigation' : ''}`}
        role="region"
        aria-label="Room Architecture Inspector"
      >
        <div className="room-detail-header">
          <div>
            <div className="room-detail-title">{room.name}</div>
            <div
              style={{
                fontSize: '0.72rem',
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Layer: {room.layer} · Status: {getStatusBadge(room.status)}
            </div>
          </div>
          <button
            className="room-detail-close"
            onClick={onClose}
            aria-label="Close room details"
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* 1. Primary Investigation Action: Prominent and immediately visible */}
        <div className="room-primary-investigate-banner">
          <div className="investigate-action-row">
            <button
              type="button"
              className="btn-investigate-room-primary"
              onClick={handleInvestigate}
              disabled={isInvestigating}
              aria-label={`Investigate ${room.name} room`}
            >
              {isInvestigating ? (
                <span className="investigating-spin">⚡ Investigating {room.name}...</span>
              ) : finding ? (
                <span>🔍 Re-investigate room</span>
              ) : (
                <span>🔍 Investigate this room</span>
              )}
            </button>
            {finding && (
              <button
                type="button"
                className="btn-expand-investigation-trigger"
                onClick={() => setIsExpanded(true)}
                aria-label="Expand investigation into reading view"
                title="Expand investigation into reading view"
              >
                ⤢ Expand view
              </button>
            )}
          </div>
          {isInvestigating && (
            <div className="investigation-inline-progress" role="status" aria-live="polite">
              <span className="inline-progress-stage">⚡ {investigationStage}</span>
            </div>
          )}
          <p className="investigate-supporting-text">
            Find potential issues, understand the evidence, and explore what needs attention.
          </p>
        </div>

        {/* Explanatory definition for the 5 canonical statuses */}
        <div className="room-status-definition-banner" role="note">
          <span className="definition-label">Status Meaning:</span> {getStatusMeaning(room.status)}
        </div>

        {/* Next Action & Unverified Scope Guidance */}
        <div className="room-next-action-card">
          <div className="next-action-row">
            <span className="action-step-badge">NEXT ACTION</span>
            <span className="next-action-text">
              {finding
                ? 'Review finding below, copy the repair prompt, or report fix when ready.'
                : room.status === 'blocked'
                ? 'Click "🔍 Investigate this room" above to diagnose the failing test and generate a repair prompt.'
                : 'Click "🔍 Investigate this room" above to run evidence-backed diagnosis, or ask companions in chat.'}
            </span>
          </div>
          {!finding && (
            <div className="unverified-coverage-note">
              <span className="unverified-label">Unverified scope:</span>{' '}
              {room.status === 'blocked'
                ? 'Active blocker detected in CI; fix must be committed and re-inspected before status can change.'
                : room.status === 'implemented'
                ? 'Source exists, but automated test suite or CI verification has not validated this room.'
                : room.status === 'verified'
                ? 'Current CI/test verification passes; no known blocker evidence.'
                : 'Implementation details are incomplete or not yet inspected in repository scan.'}
            </div>
          )}
        </div>

        <p className="room-detail-desc">{room.description}</p>

        <div className="room-detail-evidence">
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4 }}>
            {isSampleActive ? 'VERIFIED EVIDENCE (SAMPLE DATA):' : 'SCANNED EVIDENCE:'}
          </div>
          <div>{room.evidence}</div>
        </div>

        <div className="room-detail-metrics">
          <span>Files: {room.metrics.filesCount ?? 0}</span>
          {room.metrics.testFilesCount !== undefined ? (
            <span>Test files detected: {room.metrics.testFilesCount}</span>
          ) : null}
          {room.metrics.testsPassed !== undefined && room.metrics.totalTests !== undefined ? (
            <span>
              Tests executed: {room.metrics.testsPassed}/{room.metrics.totalTests} passing
            </span>
          ) : room.metrics.testFilesCount !== undefined ? (
            <span>
              Execution: {room.metrics.ciStatus === 'failing' ? 'Failing in CI' : room.metrics.ciStatus === 'passing' ? 'Passing in CI' : room.metrics.ciStatus === 'pending' ? 'In progress in CI' : 'not verified'}
            </span>
          ) : null}
          {room.metrics.ciStatus && (
            <span className={`ci-badge-status ci-${room.metrics.ciStatus}`}>
              CI: {room.metrics.ciStatus === 'failing' ? 'failing' : room.metrics.ciStatus === 'passing' ? 'passing' : room.metrics.ciStatus === 'pending' ? 'pending' : room.metrics.ciStatus === 'not_run' ? 'not run' : 'unavailable'}
              {room.metrics.ciCheckName ? ` (${room.metrics.ciCheckName})` : ''}
              {room.metrics.ciUrl && (
                <a
                  href={room.metrics.ciUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={room.metrics.ciCheckName || 'View GitHub CI run'}
                  style={{ marginLeft: 6, color: 'inherit', textDecoration: 'underline' }}
                >
                  ↗
                </a>
              )}
            </span>
          )}
        </div>

        {/* Detected Dependencies */}
        {room.dependencies && room.dependencies.length > 0 && (
          <div className="room-detail-dependencies" style={{ marginBottom: 10 }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase' }}>
              Derived Dependencies ({room.dependencies.length}):
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {room.dependencies.map((dep) => (
                <span
                  key={dep}
                  style={{
                    background: '#2B2220',
                    border: '1px solid #483835',
                    color: '#D4C5B9',
                    padding: '2px 8px',
                    borderRadius: '12px',
                    fontSize: '0.72rem',
                    fontFamily: 'ui-monospace, monospace',
                  }}
                >
                  {dep}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Associated Scanned Repository Files */}
        {room.filePaths && room.filePaths.length > 0 && (
          <div className="room-detail-file-paths" style={{ marginBottom: 12 }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase' }}>
              Associated Real Files ({room.filePaths.length}):
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                maxHeight: '100px',
                overflowY: 'auto',
                background: 'rgba(0, 0, 0, 0.25)',
                padding: '6px 8px',
                borderRadius: '4px',
                border: '1px solid #3A2E2C',
              }}
            >
              {room.filePaths.map((fp) => (
                <span
                  key={fp}
                  style={{
                    fontSize: '0.75rem',
                    fontFamily: 'ui-monospace, monospace',
                    color: '#E0D4CC',
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                    overflow: 'hidden',
                  }}
                  title={fp}
                >
                  📄 {fp}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Inside This Room: Dynamic Internals & Logic Visualization */}
        {internalsData && (
          <RoomInternalsView
            room={room}
            internalsData={internalsData}
            scanResult={scanResult}
            isSampleActive={isSampleActive}
            allRooms={allRooms}
            onSelectRoom={onSelectRoom}
            activeViewMode={internalsViewMode}
            onViewModeChange={setInternalsViewMode}
          />
        )}

        {/* Missing API Key Setup Banner */}
        {setupRequired && (
          <div className="room-setup-banner">
            <strong>AI Provider Key Required</strong>
            <p>
              Add <code>GEMINI_API_KEY</code> to your server environment or <code>.env</code> file to run
              investigations.
            </p>
          </div>
        )}

        {/* Rate-Limit or Diagnostic Error Notice: integrates room-error-banner and btn-retry-investigate */}
        {(errorMessage || errorInfo) && !setupRequired && (
          <div className="room-error-banner-host">
            <AiUsageLimitNotice
              errorInfo={errorInfo}
              errorMessage={errorMessage}
              onRetry={handleInvestigate}
              onDismiss={() => {
                setErrorMessage(null);
                setErrorInfo(null);
              }}
              isLoading={isInvestigating}
              hasSelectedRoom={Boolean(room)}
              selectedRoomName={room?.name}
              contextType="investigation"
            />
          </div>
        )}

        {/* 2. Investigation Finding Card with Clear 7-Level Hierarchy (T34) */}
        {finding && (
          <div className="investigation-finding-card" role="region" aria-label="Investigation Finding">
            {/* Header: Title, Eyebrow, Expand Trigger, and Badges */}
            <div className="finding-header">
              <div className="finding-header-top-row">
                <div className="finding-title-group">
                  <span className="finding-section-eyebrow">1. DIAGNOSTIC FINDING & SEVERITY</span>
                  <h4 className="finding-title">{finding.title}</h4>
                </div>
                <button
                  type="button"
                  className="btn-expand-finding"
                  onClick={() => setIsExpanded(true)}
                  aria-label="Expand investigation into reading view"
                  title="Open near-full-screen reading workspace"
                >
                  ⤢ Expand view
                </button>
              </div>

              {/* Assessment Badges Row */}
              <div className="finding-badges-row">
                <span className={`category-pill cat-${finding.category}`}>
                  {finding.category.replace('_', ' ')}
                </span>
                <span className={`severity-pill sev-${finding.severity}`} title={`Severity: ${finding.severity.toUpperCase()} (bounded by inspected evidence)`}>
                  {finding.severity.toUpperCase()}
                </span>
                <span className={`classification-pill class-${finding.evidenceClassification}`} title={`Certainty: ${finding.evidenceClassification.toUpperCase()}`}>
                  {finding.evidenceClassification.toUpperCase()}
                </span>
                {savedLifecycleState && (
                  <span
                    className={`lifecycle-status-pill ${savedLifecycleState.verificationOutcome === 'verified' ? 'verified' : 'reported'}`}
                    title={savedLifecycleState.outcomeReason}
                  >
                    {savedLifecycleState.verificationOutcome === 'verified'
                      ? '✓ Fix Verified in CI'
                      : '⚠️ Fix Reported (Pending CI Retest)'}
                  </span>
                )}
                {(finding.fallbackUsed || finding.provider === 'groq' || finding.providerUsed === 'groq' || finding.provider === 'cloudflare' || finding.providerUsed === 'cloudflare') && (
                  <span
                    className="backup-ai-indicator"
                    title={`Generated by ${finding.provider === 'cloudflare' || finding.providerUsed === 'cloudflare' ? 'Cloudflare Workers AI' : 'Groq'} backup AI`}
                  >
                    🛡️ Using backup AI ({finding.provider === 'cloudflare' || finding.providerUsed === 'cloudflare' ? 'Cloudflare' : 'Groq'})
                  </span>
                )}
                {finding.timing && (
                  <span
                    className="timing-pill"
                    title={`End-to-end: ${finding.timing.totalMs}ms | Model: ${finding.timing.upstreamMs}ms (${finding.provider || finding.providerUsed || 'gemini'}) | Context prep: ${finding.timing.contextPrepMs}ms | Validation: ${finding.timing.validationMs}ms | Tokens: ${finding.timing.totalTokens ?? 'n/a'}`}
                  >
                    ⚡ {finding.timing.totalMs}ms
                  </span>
                )}
              </div>
            </div>

            {finding.timing && (
              <div
                className="companion-timing-badge"
                style={{ marginBottom: 10 }}
                title={`End-to-end: ${finding.timing.totalMs}ms | Provider: ${finding.timing.provider || finding.timing.providerUsed || 'gemini'} (${finding.timing.upstreamMs}ms) | Fallback: ${finding.timing.fallbackMs || 0}ms | Validation: ${finding.timing.validationMs}ms | Context: ${finding.timing.contextPrepMs}ms | Tokens: ${finding.timing.totalTokens ?? 'n/a'}`}
              >
                {(finding.timing.fallbackUsed || finding.timing.provider === 'groq' || finding.timing.providerUsed === 'groq' || finding.timing.provider === 'cloudflare' || finding.timing.providerUsed === 'cloudflare') && (
                  <span className="backup-ai-indicator" title={`Generated by ${finding.timing.provider === 'cloudflare' || finding.timing.providerUsed === 'cloudflare' ? 'Cloudflare Workers AI' : 'Groq'} backup AI`}>🛡️ Using backup AI · </span>
                )}
                ⚡ {finding.timing.totalMs}ms (model: {finding.timing.upstreamMs}ms{finding.timing.fallbackMs ? `, fallback: ${finding.timing.fallbackMs}ms` : ''})
              </div>
            )}

            {/* 1. Finding Overview & Explanation */}
            <p className="finding-explanation">{finding.explanation}</p>

            {/* 2. Why It Matters: User-Visible & System-Level Consequence */}
            {finding.whyItMatters && (
              <div className="finding-evidence-section">
                <span className="finding-section-label">2. WHY IT MATTERS (CONSEQUENCE):</span>
                <div className="finding-why-it-matters-box">
                  {finding.whyItMatters}
                </div>
              </div>
            )}

            {/* 3. Evidence: Validated Source Excerpts, Line Ranges, and Quick Navigation Jumps */}
            <div className="finding-evidence-section">
              <span className="finding-section-label">3. VALIDATED EVIDENCE:</span>

              {/* Jump buttons connecting finding to source, graph, simulation, related room, and test evidence */}
              <div className="finding-nav-jumps-row" role="navigation" aria-label="Evidence navigation jumps">
                <button
                  type="button"
                  className="btn-jump-pill"
                  onClick={() => handleJumpTo('graph')}
                  title="Jump to stage-by-stage architecture graph"
                >
                  📊 Graph view
                </button>
                <button
                  type="button"
                  className="btn-jump-pill"
                  onClick={() => handleJumpTo('simulation')}
                  title="Jump to static execution simulation workbench"
                >
                  ⚡ Simulation
                </button>
                <button
                  type="button"
                  className="btn-jump-pill"
                  onClick={() => handleJumpTo('test_evidence')}
                  title="Jump to test mapping and CI check evidence chain"
                >
                  🔗 Test evidence
                </button>
                {finding.codeEvidence && (
                  <button
                    type="button"
                    className="btn-jump-pill"
                    onClick={() => handleJumpTo('source')}
                    title="Focus on inspected source excerpt"
                  >
                    📄 Source excerpt
                  </button>
                )}
                {room.dependencies && room.dependencies.map((dep) => (
                  <button
                    key={dep}
                    type="button"
                    className="btn-jump-pill"
                    onClick={() => handleJumpTo('related_room', dep)}
                    title={`Jump to dependent room ${dep}`}
                  >
                    🚪 Room: {dep}
                  </button>
                ))}
              </div>

              {finding.codeEvidence && finding.codeEvidence.codeSnippet && (
                <div className="finding-code-evidence-box">
                  <div className="code-evidence-header">
                    <span className={`code-evidence-badge ${finding.codeEvidence.isVerified ? 'verified' : 'unverified'}`}>
                      {finding.codeEvidence.isVerified ? '✓ VERIFIED SOURCE EXCERPT' : '○ UNVERIFIED SNIPPET'}
                    </span>
                    <span className="code-evidence-file">
                      📄 <code>{finding.codeEvidence.filePath}</code>
                      {finding.codeEvidence.lineRange ? (
                        <span className="code-line-range-badge">{finding.codeEvidence.lineRange}</span>
                      ) : finding.codeEvidence.derivedLineNumber ? (
                        <span className="code-line-range-badge">Line {finding.codeEvidence.derivedLineNumber}</span>
                      ) : null}
                    </span>
                  </div>
                  <pre className="code-evidence-pre">
                    <code>{finding.codeEvidence.codeSnippet}</code>
                  </pre>
                  {finding.codeEvidence.explanation && (
                    <div className="code-evidence-note">{finding.codeEvidence.explanation}</div>
                  )}
                </div>
              )}

              {finding.evidenceReferences.length > 0 && (
                <ul className="finding-refs-list">
                  {finding.evidenceReferences.map((ref) => (
                    <li key={ref.path} className="finding-ref-item">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {ref.githubUrl ? (
                          <a
                            href={ref.githubUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="file-link"
                          >
                            <code>{ref.path}</code> ↗
                          </a>
                        ) : (
                          <code>{ref.path}</code>
                        )}
                        {ref.lineRange && (
                          <span className="code-line-range-badge">{ref.lineRange}</span>
                        )}
                      </div>
                      <span className="ref-inspection-badge">
                        {ref.isInspected ? 'Inspected in scan' : 'Discovered in tree (uninspected)'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 4. Reasoning: Direct Facts vs Inferences */}
            {finding.reasoning && (
              <div className="finding-evidence-section">
                <span className="finding-section-label">4. REASONING (DIRECT FACTS VS INFERENCES):</span>
                <div className="finding-reasoning-section">
                  <div className="reasoning-subgroup">
                    <span className="reasoning-sub-label">Direct Observed Facts:</span>
                    {finding.reasoning.facts.map((fact, idx) => (
                      <div key={idx} className="reasoning-item fact">
                        <span>✓</span>
                        <span>{fact}</span>
                      </div>
                    ))}
                  </div>
                  <div className="reasoning-subgroup">
                    <span className="reasoning-sub-label">Architectural Inferences:</span>
                    {finding.reasoning.inferences.map((inf, idx) => (
                      <div key={idx} className="reasoning-item inference">
                        <span>↳</span>
                        <span>{inf}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* 5. What Remains Uncertain: Caveats and Grounding Limitations */}
            <div className="finding-uncertainties-wrapper">
              <span className="finding-section-label">5. WHAT REMAINS UNCERTAIN:</span>

              {finding.evidenceClassification !== 'observed' && (
                <div className="finding-uncertainty-banner" role="status">
                  ℹ️ <strong>Result Classification: {finding.evidenceClassification.toUpperCase()}</strong>.
                  {finding.evidenceClassification === 'inferred'
                    ? ' Derivation is based on architectural inference without directly observed failing tests.'
                    : ' Grounding is limited by uninspected files. Verify actual code before acting.'}
                </div>
              )}

              {finding.rejectedReferences && finding.rejectedReferences.length > 0 && (
                <div className="finding-uncertainty-banner" role="status">
                  ⚠️ <strong>Ungrounded Files Excluded:</strong> {finding.rejectedReferences.join(', ')} do not exist in the repository tree and were stripped.
                </div>
              )}

              <div className="finding-uncertainties-box">
                <strong>Known vs Uncertain:</strong> {finding.uncertainties}
              </div>
            </div>

            {/* 6. Recommended Next Step & Companion Dialogue */}
            <div className="finding-recommendation-wrapper">
              <span className="finding-section-label">6. RECOMMENDED NEXT STEP:</span>
              <div className="finding-recommendation-box">
                {finding.recommendedNextStep}
              </div>

              {finding.companionMessages.length > 0 && (
                <div className="finding-dialogue-section">
                  {finding.companionMessages.map((msg, idx) => (
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
            </div>

            {/* 7. Repair Prompt: Separate Copy-Ready Section with Prominent Action */}
            <div className="repair-prompt-section">
              <div className="repair-prompt-header-row">
                <span className="finding-section-label">7. CODING AGENT REPAIR PROMPT:</span>
                {finding.generatedPrompt && (
                  <button
                    type="button"
                    className={`btn-copy-prompt ${copySuccess ? 'copied' : ''}`}
                    onClick={handleCopyPrompt}
                  >
                    {copySuccess ? '✓ Copied to clipboard!' : '📋 Copy prompt for coding agent'}
                  </button>
                )}
              </div>

              <div className="repair-prompt-controls">
                <button
                  type="button"
                  className="btn-toggle-prompt"
                  onClick={() => setShowPrompt(!showPrompt)}
                >
                  {showPrompt ? 'Hide prompt preview' : '⚡ Show prompt preview'}
                </button>
              </div>

              {showPrompt && finding.generatedPrompt && (
                <div className="prompt-display-container">
                  <div className="prompt-meta-note">
                    Copy and paste this self-contained prompt directly into Antigravity, Claude Code, or
                    your coding agent:
                  </div>
                  <textarea
                    className="repair-prompt-textarea"
                    readOnly
                    value={finding.generatedPrompt}
                    rows={8}
                    aria-label="Repair prompt preview"
                  />
                </div>
              )}
            </div>

            {/* Fix Reporting & Verification Lifecycle Section (T06) */}
            <FixLifecyclePanel
              finding={finding}
              room={room}
              scanResult={scanResult}
              isSampleActive={isSampleActive}
              onRoomUpdated={onRoomUpdated}
              savedLifecycleState={savedLifecycleState}
              onLifecycleChange={(state) => room && onLifecycleChange?.(room.id, state)}
            />
          </div>
        )}
      </div>

      {/* 3. Near-Full-Screen Expanded Reading Mode Modal (T17) */}
      {isExpanded && finding && (
        <div
          className="investigation-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsExpanded(false);
          }}
          role="presentation"
        >
          <div
            className="investigation-expanded-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="expanded-investigation-title"
            tabIndex={-1}
            ref={expandedDialogRef}
          >
            <div className="expanded-dialog-header">
              <div className="expanded-header-left">
                <span className="expanded-eyebrow">
                  EXPANDED INVESTIGATION WORKSPACE · {room.layer.toUpperCase()} LAYER
                </span>
                <h3 id="expanded-investigation-title" className="expanded-dialog-title">
                  {room.name}: {finding.title}
                </h3>
                <div className="expanded-dialog-badges">
                  <span className="expanded-status-badge">{getStatusBadge(room.status)}</span>
                  <span className={`category-pill cat-${finding.category}`}>
                    {finding.category.replace('_', ' ')}
                  </span>
                  <span className={`severity-pill sev-${finding.severity}`}>
                    {finding.severity.toUpperCase()}
                  </span>
                  <span className={`classification-pill class-${finding.evidenceClassification}`}>
                    {finding.evidenceClassification.toUpperCase()}
                  </span>
                  {(finding.fallbackUsed || finding.provider === 'groq' || finding.providerUsed === 'groq' || finding.provider === 'cloudflare' || finding.providerUsed === 'cloudflare') && (
                    <span
                      className="backup-ai-indicator"
                      title={`Generated by ${finding.provider === 'cloudflare' || finding.providerUsed === 'cloudflare' ? 'Cloudflare Workers AI' : 'Groq'} backup AI`}
                    >
                      🛡️ Using backup AI ({finding.provider === 'cloudflare' || finding.providerUsed === 'cloudflare' ? 'Cloudflare' : 'Groq'})
                    </span>
                  )}
                  {finding.timing && (
                    <span
                      className="timing-pill"
                      title={`End-to-end: ${finding.timing.totalMs}ms | Model: ${finding.timing.upstreamMs}ms (${finding.provider || finding.providerUsed || 'gemini'})`}
                    >
                      ⚡ {finding.timing.totalMs}ms
                    </span>
                  )}
                </div>
              </div>

              <div className="expanded-header-actions">
                <button
                  type="button"
                  className="btn-investigate-room-secondary"
                  onClick={handleInvestigate}
                  disabled={isInvestigating}
                  aria-label="Re-run investigation"
                >
                  {isInvestigating ? '⚡ Investigating...' : '🔄 Re-investigate'}
                </button>
                <button
                  type="button"
                  className="btn-close-expanded"
                  onClick={() => setIsExpanded(false)}
                  aria-label="Close expanded investigation view"
                  title="Close (Esc)"
                >
                  ✕ Close
                </button>
              </div>
            </div>

            <div className="expanded-dialog-body">
              <div className="expanded-left-pane">
                {/* 1. Finding Overview & Severity */}
                <section className="expanded-section" aria-label="1. Finding Overview & Severity">
                  <div className="finding-section-eyebrow" style={{ marginBottom: 4 }}>1. DIAGNOSTIC FINDING & SEVERITY</div>
                  <h4 className="expanded-section-title">{finding.title}</h4>
                  <p className="expanded-finding-explanation">{finding.explanation}</p>
                </section>

                {/* 2. Why It Matters: User-Visible & System-Level Consequence */}
                {finding.whyItMatters && (
                  <section className="expanded-section" aria-label="2. Why It Matters">
                    <div className="finding-section-eyebrow" style={{ marginBottom: 4 }}>2. WHY IT MATTERS (CONSEQUENCE)</div>
                    <div className="finding-why-it-matters-box">
                      {finding.whyItMatters}
                    </div>
                  </section>
                )}

                {/* 3. Validated Evidence & Quick Jumps */}
                <section className="expanded-section" aria-label="3. Validated Evidence & Jumps">
                  <div className="finding-section-eyebrow" style={{ marginBottom: 4 }}>3. VALIDATED EVIDENCE & JUMPS</div>
                  
                  {/* Jump buttons connecting finding to source, graph, simulation, related room, and test evidence */}
                  <div className="finding-nav-jumps-row" role="navigation" aria-label="Expanded evidence navigation jumps">
                    <button
                      type="button"
                      className="btn-jump-pill"
                      onClick={() => handleJumpTo('graph')}
                      title="Jump to stage-by-stage architecture graph"
                    >
                      📊 Graph view
                    </button>
                    <button
                      type="button"
                      className="btn-jump-pill"
                      onClick={() => handleJumpTo('simulation')}
                      title="Jump to static execution simulation workbench"
                    >
                      ⚡ Simulation
                    </button>
                    <button
                      type="button"
                      className="btn-jump-pill"
                      onClick={() => handleJumpTo('test_evidence')}
                      title="Jump to test mapping and CI check evidence chain"
                    >
                      🔗 Test evidence
                    </button>
                    {finding.codeEvidence && (
                      <button
                        type="button"
                        className="btn-jump-pill"
                        onClick={() => handleJumpTo('source')}
                        title="Focus on inspected source excerpt"
                      >
                        📄 Source excerpt
                      </button>
                    )}
                    {room.dependencies && room.dependencies.map((dep) => (
                      <button
                        key={dep}
                        type="button"
                        className="btn-jump-pill"
                        onClick={() => handleJumpTo('related_room', dep)}
                        title={`Jump to dependent room ${dep}`}
                      >
                        🚪 Room: {dep}
                      </button>
                    ))}
                  </div>

                  {finding.codeEvidence && finding.codeEvidence.codeSnippet && (
                    <div className="finding-code-evidence-box expanded-code-box">
                      <div className="code-evidence-header">
                        <span className={`code-evidence-badge ${finding.codeEvidence.isVerified ? 'verified' : 'unverified'}`}>
                          {finding.codeEvidence.isVerified ? '✓ VERIFIED SOURCE EXCERPT' : '○ UNVERIFIED SNIPPET'}
                        </span>
                        <span className="code-evidence-file">
                          📄 <code>{finding.codeEvidence.filePath}</code>
                          {finding.codeEvidence.lineRange ? (
                            <span className="code-line-range-badge">{finding.codeEvidence.lineRange}</span>
                          ) : finding.codeEvidence.derivedLineNumber ? (
                            <span className="code-line-range-badge">Line {finding.codeEvidence.derivedLineNumber}</span>
                          ) : null}
                        </span>
                      </div>
                      <pre className="code-evidence-pre">
                        <code>{finding.codeEvidence.codeSnippet}</code>
                      </pre>
                      {finding.codeEvidence.explanation && (
                        <div className="code-evidence-note">{finding.codeEvidence.explanation}</div>
                      )}
                    </div>
                  )}

                  {finding.evidenceReferences.length > 0 ? (
                    <div className="finding-refs-section">
                      <span className="finding-section-label">VALIDATED FILE REFERENCES:</span>
                      <ul className="finding-refs-list">
                        {finding.evidenceReferences.map((ref) => (
                          <li key={ref.path} className="finding-ref-item">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              {ref.githubUrl ? (
                                <a
                                  href={ref.githubUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="file-link"
                                >
                                  <code>{ref.path}</code> ↗
                                </a>
                              ) : (
                                <code>{ref.path}</code>
                              )}
                              {ref.lineRange && (
                                <span className="code-line-range-badge">{ref.lineRange}</span>
                              )}
                            </div>
                            <span className="ref-inspection-badge">
                              {ref.isInspected ? 'Inspected in scan' : 'Discovered in tree (uninspected)'}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <div className="finding-no-refs-note">
                      No direct source files were observed for this finding.
                    </div>
                  )}
                </section>

                {/* 4. Reasoning: Direct Facts vs Inferences */}
                {finding.reasoning && (
                  <section className="expanded-section" aria-label="4. Reasoning: Direct Facts vs Inferences">
                    <div className="finding-section-eyebrow" style={{ marginBottom: 4 }}>4. REASONING (DIRECT FACTS VS INFERENCES)</div>
                    <div className="finding-reasoning-section">
                      <div className="reasoning-subgroup">
                        <span className="reasoning-sub-label">Direct Observed Facts:</span>
                        {finding.reasoning.facts.map((fact, idx) => (
                          <div key={idx} className="reasoning-item fact">
                            <span>✓</span>
                            <span>{fact}</span>
                          </div>
                        ))}
                      </div>
                      <div className="reasoning-subgroup">
                        <span className="reasoning-sub-label">Architectural Inferences:</span>
                        {finding.reasoning.inferences.map((inf, idx) => (
                          <div key={idx} className="reasoning-item inference">
                            <span>↳</span>
                            <span>{inf}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </section>
                )}

                {/* 5. Uncertainties and Limitations */}
                <section className="expanded-section" aria-label="5. Uncertainties and Limitations">
                  <div className="finding-section-eyebrow" style={{ marginBottom: 4 }}>5. WHAT REMAINS UNCERTAIN</div>

                  {finding.evidenceClassification !== 'observed' && (
                    <div className="finding-uncertainty-banner" role="status">
                      ℹ️ <strong>Result Classification: {finding.evidenceClassification.toUpperCase()}</strong>.
                      {finding.evidenceClassification === 'inferred'
                        ? ' This diagnosis is derived by architectural inference because exact verified source files or failing CI logs were not directly observed.'
                        : ' Grounding is limited by missing or uninspected files. Review actual source before acting.'}
                    </div>
                  )}

                  {finding.rejectedReferences && finding.rejectedReferences.length > 0 && (
                    <div className="finding-uncertainty-banner" role="status">
                      ⚠️ <strong>Ungrounded Files Excluded:</strong> {finding.rejectedReferences.join(', ')} do not exist in the repository tree and were stripped from evidence.
                    </div>
                  )}

                  <div className="finding-uncertainties-box">
                    <strong>Known vs Uncertain:</strong> {finding.uncertainties}
                  </div>
                </section>

                {/* 6. Recommendation & Companion Dialogue */}
                <section className="expanded-section" aria-label="6. Recommendation and Dialogue">
                  <div className="finding-section-eyebrow" style={{ marginBottom: 4 }}>6. RECOMMENDED NEXT STEP</div>
                  <div className="finding-recommendation-box">
                    <strong>Next Action:</strong> {finding.recommendedNextStep}
                  </div>

                  {finding.companionMessages.length > 0 && (
                    <div className="finding-dialogue-section" style={{ marginTop: 12 }}>
                      <span className="finding-section-label">AI COMPANION OBSERVATIONS:</span>
                      {finding.companionMessages.map((msg, idx) => (
                        <div key={idx} className={`finding-companion-quote ${msg.speaker}`}>
                          <PixelPetAvatar speaker={msg.speaker} size={22} />
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
                </section>
              </div>

              <div className="expanded-right-pane">
                {/* 7. Repair Prompt Section */}
                <section className="expanded-section prompt-pane" aria-label="7. Coding Agent Repair Prompt">
                  <div className="expanded-prompt-header">
                    <div>
                      <div className="finding-section-eyebrow" style={{ marginBottom: 4 }}>7. CODING AGENT REPAIR PROMPT</div>
                      <h4 className="expanded-section-title">Coding Agent Repair Prompt</h4>
                      <p className="prompt-meta-note">
                        Self-contained prompt with acceptance criteria ready for Antigravity or Claude Code:
                      </p>
                    </div>
                    {finding.generatedPrompt && (
                      <button
                        type="button"
                        className={`btn-copy-prompt-primary ${copySuccess ? 'copied' : ''}`}
                        onClick={handleCopyPrompt}
                        aria-label="Copy repair prompt to clipboard"
                      >
                        {copySuccess ? '✓ Copied to clipboard!' : '📋 Copy Prompt'}
                      </button>
                    )}
                  </div>

                  {finding.generatedPrompt ? (
                    <textarea
                      className="repair-prompt-textarea expanded-textarea"
                      readOnly
                      value={finding.generatedPrompt}
                      aria-label="Coding agent repair prompt content"
                    />
                  ) : (
                    <div className="prompt-empty-note">No prompt generated for this finding.</div>
                  )}
                </section>

                {/* 6. Fix Reporting & Verification Lifecycle Section */}
                <section className="expanded-section" aria-label="Fix Verification Lifecycle">
                  <FixLifecyclePanel
                    finding={finding}
                    room={room}
                    scanResult={scanResult}
                    isSampleActive={isSampleActive}
                    onRoomUpdated={onRoomUpdated}
                    savedLifecycleState={savedLifecycleState}
                    onLifecycleChange={(state) => room && onLifecycleChange?.(room.id, state)}
                  />
                </section>
              </div>
            </div>

            <div className="expanded-dialog-footer">
              <span className="expanded-footer-hint">
                Press <kbd>Esc</kbd> or click <strong>Close</strong> to return to room inspector
              </span>
              <button
                type="button"
                className="btn-close-expanded-footer"
                onClick={() => setIsExpanded(false)}
              >
                Close View
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
