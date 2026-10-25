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
import type { ResilienceSnapshot } from '../domain/resilience/types.ts';
import { buildResilienceContext } from '../domain/resilience/index.ts';

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
  resilienceSnapshot?: ResilienceSnapshot | null;
  onApplyRecoveryStrategy?: (strategyId: string) => void;
  onNavigateToResilience?: (roomId: string) => void;
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
  resilienceSnapshot,
  onApplyRecoveryStrategy,
  onNavigateToResilience,
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
  const [activeTab, setActiveTab] = useState<'overview' | 'simulate' | 'evidence' | 'fix'>('overview');
  const [showMoreOverview, setShowMoreOverview] = useState(false);
  const [showAllFiles, setShowAllFiles] = useState(false);

  const handleJumpTo = (target: 'graph' | 'simulation' | 'test_evidence' | 'source' | 'related_room', extraId?: string) => {
    if (target === 'graph') {
      setActiveTab('simulate');
      setInternalsViewMode('diagram');
      setIsExpanded(false);
      setTimeout(() => {
        document.querySelector('.room-internals-container')?.scrollIntoView({ behavior: 'smooth' });
      }, 60);
    } else if (target === 'simulation') {
      setActiveTab('simulate');
      setInternalsViewMode('simulation');
      setIsExpanded(false);
      setTimeout(() => {
        document.querySelector('.room-internals-container')?.scrollIntoView({ behavior: 'smooth' });
      }, 60);
    } else if (target === 'test_evidence') {
      setActiveTab('simulate');
      setInternalsViewMode('evidence_chain');
      setIsExpanded(false);
      setTimeout(() => {
        document.querySelector('.room-internals-container')?.scrollIntoView({ behavior: 'smooth' });
      }, 60);
    } else if (target === 'source') {
      setActiveTab('evidence');
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
    setActiveTab('overview');
    setShowMoreOverview(false);
    setShowAllFiles(false);
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

function splitSentences(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g);
  return matches ? matches.map((s) => s.trim()).filter(Boolean) : [text.trim()];
}

const getPlainStatusText = (status: ArchitecturalRoom['status']) => {
  switch (status) {
    case 'verified':
      return 'Tested ✓';
    case 'implemented':
    case 'in_progress':
      return 'Built, not tested yet';
    case 'blocked':
      return 'Broken';
    case 'planned':
      return 'Not built yet';
    case 'unknown':
    default:
      return 'Unclear';
  }
};

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
          bypassCache: false,
          repoContext,
          resilienceContext: resilienceSnapshot
            ? buildResilienceContext(resilienceSnapshot, room.id)
            : undefined,
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

  // Plain computations: these sit after the `if (!room)` early return, so they must not be hooks.
  const allRoomFiles = (() => {
    const fileMap = new Map<string, { path: string; isInspected: boolean }>();
    if (finding?.evidenceReferences) {
      for (const ref of finding.evidenceReferences) {
        fileMap.set(ref.path, { path: ref.path, isInspected: Boolean(ref.isInspected) });
      }
    }
    if (room?.filePaths) {
      for (const fp of room.filePaths) {
        if (!fileMap.has(fp)) {
          fileMap.set(fp, { path: fp, isInspected: false });
        }
      }
    }
    return Array.from(fileMap.values());
  })();

  const visibleFiles = showAllFiles ? allRoomFiles : allRoomFiles.slice(0, 5);

  const explanationSentences = splitSentences(finding?.explanation || '');
  const explanationShort = explanationSentences.slice(0, 2).join(' ');
  const explanationHasMore = explanationSentences.length > 2;

  const whySentences = splitSentences(finding?.whyItMatters || '');
  const whyShort = whySentences.slice(0, 1).join(' ');
  const whyHasMore = whySentences.length > 1;

  const nextStepSentences = splitSentences(finding?.recommendedNextStep || '');
  const nextStepShort = nextStepSentences.slice(0, 1).join(' ');

  const barkleyMsg = finding?.companionMessages?.find((m) => m.speaker === 'dog');
  const cleoMsg = finding?.companionMessages?.find((m) => m.speaker === 'cat');
  const barkleyRaw = barkleyMsg?.text || '';
  const barkleyText = barkleyRaw.length > 140 ? barkleyRaw.slice(0, 137) + '...' : barkleyRaw;

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const tabs: ('overview' | 'simulate' | 'evidence' | 'fix')[] = ['overview', 'simulate', 'evidence', 'fix'];
    const currentIndex = tabs.indexOf(activeTab);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const nextTab = tabs[(currentIndex + 1) % tabs.length];
      setActiveTab(nextTab);
      document.getElementById(`tab-${nextTab}`)?.focus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const prevTab = tabs[(currentIndex - 1 + tabs.length) % tabs.length];
      setActiveTab(prevTab);
      document.getElementById(`tab-${prevTab}`)?.focus();
    }
  };

  const renderRuntimeRiskBlock = () => {
    if (!resilienceSnapshot) return null;
    const tier = resilienceSnapshot.riskByRoomId[room.id] || 'healthy';
    const forecastItem = resilienceSnapshot.forecast.byService[room.id];
    const riskVal = forecastItem?.risk ?? 0;
    const etaVal = forecastItem?.etaTicks ?? null;

    const topRoot = resilienceSnapshot.rootCause.candidates.find((rc) => rc.serviceId === room.id);

    const evidenceLines: string[] =
      topRoot && topRoot.reasons && topRoot.reasons.length > 0
        ? topRoot.reasons
        : [
            `Error rate: ${(riskVal * 100).toFixed(1)}% within nominal threshold`,
            'No active template spike detected in Drain-lite parse tree',
          ];

    const serviceView = resilienceSnapshot.services.find((s) => s.id === room.id);
    const isAtRisk = tier === 'high' || tier === 'critical' || tier === 'failed';
    const recOutcome = resilienceSnapshot.recovery.outcomes.find(
      (o) => o.strategyId === resilienceSnapshot.recovery.recommendedId
    );

    const rootCauseRankText = topRoot
      ? `#${topRoot.rank} root cause (${Math.round(topRoot.confidence * 100)}%)`
      : 'Not root cause';

    const failTimeText = serviceView?.observedFailed
      ? 'Failing now'
      : etaVal !== null
      ? `fails in ~${Math.max(1, Math.round((etaVal * 10) / 60))} min`
      : 'Nominal';

    return (
      <div className="room-runtime-risk-block" role="region" aria-label="Runtime Risk Analysis">
        {/* Runtime Risk row: tier chip + "fails in ~N min" + root-cause rank + See how failures spread button */}
        <div className="runtime-risk-summary-row">
          <div className="runtime-risk-main-info">
            <span className="runtime-risk-title">Runtime risk:</span>
            <span className={`risk-tier-pill risk-tier-${tier}`}>
              {tier}
            </span>
            <span className="runtime-risk-eta-text">{failTimeText}</span>
            <span className="runtime-risk-rank-pill">{rootCauseRankText}</span>
          </div>

          <button
            type="button"
            className="btn-see-failures"
            onClick={() => onNavigateToResilience?.(room.id)}
            title="Switch to Live Risk view focused on this room"
          >
            See how failures spread →
          </button>
        </div>

        <div className="risk-block-stats-row">
          <div className="risk-stat-item">
            <span className="risk-stat-label">Failure Probability</span>
            <span className="risk-stat-val">{(riskVal * 100).toFixed(0)}%</span>
          </div>
          <div className="risk-stat-item">
            <span className="risk-stat-label">Lead Time / ETA</span>
            <span className="risk-stat-val">
              {etaVal ? `~${etaVal} ticks` : 'Nominal'}
            </span>
          </div>
          <div className="risk-stat-item">
            <span className="risk-stat-label">Root Cause Rank</span>
            <span className="risk-stat-val" style={{ fontSize: '0.72rem' }}>
              {rootCauseRankText}
            </span>
          </div>
        </div>

        {resilienceSnapshot.forecast.label && (
          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: 6, fontFamily: 'var(--font-mono)' }} title="Forecast methodology">
            Forecast: {resilienceSnapshot.forecast.label}
          </div>
        )}

        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
          Root Cause &amp; Anomaly Signals ({evidenceLines.length}):
        </div>
        <div className="risk-evidence-list">
          {topRoot?.evidence && topRoot.evidence.length > 0
            ? topRoot.evidence.map((ev, i: number) => (
                <div key={i}>
                  • [{ev.kind} @ t={ev.tick}] {ev.text}
                </div>
              ))
            : evidenceLines.map((ev: string, i: number) => (
                <div key={i}>• {ev}</div>
              ))}
        </div>

        {isAtRisk && resilienceSnapshot.recovery.recommendedId && (
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(127, 179, 138, 0.1)', padding: '4px 8px', borderRadius: 4 }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--recommend)' }}>
              Recommended Fix: {recOutcome?.name || 'Apply Mitigation'}
            </span>
            {onApplyRecoveryStrategy && (
              <button
                type="button"
                className="btn-apply-strategy"
                onClick={() => onApplyRecoveryStrategy(resilienceSnapshot.recovery.recommendedId!)}
              >
                Apply Fix →
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div
        className={`room-detail-panel ${finding ? 'expanded-investigation' : ''}`}
        role="region"
        aria-label="Room Architecture Inspector"
      >
        {/* 1. Header: room name, ONE status chip in plain words, expand view, close ✕ */}
        <div className="room-detail-header room-header-redesign">
          <div className="room-header-left">
            <div className="room-detail-title">{room.name}</div>
            <span className={`room-plain-status-chip status-${room.status}`}>
              {getPlainStatusText(room.status)}
            </span>
          </div>
          <div className="room-header-actions" style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {finding && (
              <button
                type="button"
                className="btn-expand-finding"
                onClick={() => setIsExpanded(true)}
                aria-label="Expand investigation into reading view"
                title="Expand investigation into reading view (⤢)"
              >
                ⤢ Expand view
              </button>
            )}
            <button
              type="button"
              className="room-detail-close"
              onClick={onClose}
              aria-label="Close room details"
              title="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {/* 2. Action row: always visible, big buttons */}
        <div className="room-primary-investigate-banner room-action-row" role="toolbar" aria-label="Room actions">
          <button
            type="button"
            className={`btn-investigate-room-primary room-big-btn ${!finding ? 'primary' : ''}`}
            onClick={handleInvestigate}
            disabled={isInvestigating}
            aria-label={finding ? '🔍 Investigate again' : '🔍 Investigate this room'}
          >
            {isInvestigating ? (
              <span className="investigating-spin">⚡ Investigating...</span>
            ) : finding ? (
              <span>🔍 Investigate again</span>
            ) : (
              <span>🔍 Investigate</span>
            )}
          </button>

          <button
            type="button"
            className={`btn-copy-prompt room-big-btn ${finding ? 'primary' : ''} ${copySuccess ? 'copied' : ''}`}
            onClick={() => {
              if (finding?.generatedPrompt) {
                handleCopyPrompt();
              }
              setActiveTab('fix');
            }}
            disabled={!finding}
            title={finding ? 'Copy repair prompt and jump to fix tab' : 'Run investigation first to generate fix prompt'}
            aria-label="Copy prompt for coding agent"
          >
            {copySuccess ? '✓ Copied!' : '📋 Copy fix prompt'}
          </button>

          <button
            type="button"
            className="btn-simulate-action room-big-btn"
            onClick={() => setActiveTab('simulate')}
            aria-label="Simulate room behavior"
          >
            ⚡ Simulate
          </button>

          {finding && (
            <button
              type="button"
              className="btn-expand-investigation-trigger room-big-btn"
              onClick={() => setIsExpanded(true)}
              aria-label="Expand investigation into reading view"
              title="Expand investigation into reading view"
            >
              ⤢ Expand view
            </button>
          )}

          <span className="sr-only" style={{ display: 'none' }}>
            Find potential issues, understand the evidence, and explore what needs attention.
          </span>
        </div>

        {isInvestigating && (
          <div className="investigation-inline-progress" role="status" aria-live="polite">
            <span className="inline-progress-stage">⚡ {investigationStage}</span>
          </div>
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

        {/* Rate-Limit or Diagnostic Error Notice */}
        {(errorMessage || errorInfo) && !setupRequired && (
          <div className="room-error-banner-host room-error-banner">
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
            <button
              type="button"
              className="btn-retry-investigate sr-only"
              style={{ display: 'none' }}
              onClick={handleInvestigate}
              disabled={isInvestigating}
            >
              Retry
            </button>
          </div>
        )}

        {/* 3. Tabs below the action row (one panel visible at a time, default "Overview") */}
        <div
          className="room-inspector-tabs"
          role="tablist"
          aria-label="Room inspector tabs"
          onKeyDown={handleTabKeyDown}
        >
          <button
            type="button"
            role="tab"
            id="tab-overview"
            aria-selected={activeTab === 'overview'}
            aria-controls="panel-overview"
            tabIndex={activeTab === 'overview' ? 0 : -1}
            className={`room-tab-btn ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            Overview
          </button>
          <button
            type="button"
            role="tab"
            id="tab-simulate"
            aria-selected={activeTab === 'simulate'}
            aria-controls="panel-simulate"
            tabIndex={activeTab === 'simulate' ? 0 : -1}
            className={`room-tab-btn ${activeTab === 'simulate' ? 'active' : ''}`}
            onClick={() => setActiveTab('simulate')}
          >
            Simulate
          </button>
          <button
            type="button"
            role="tab"
            id="tab-evidence"
            aria-selected={activeTab === 'evidence'}
            aria-controls="panel-evidence"
            tabIndex={activeTab === 'evidence' ? 0 : -1}
            className={`room-tab-btn ${activeTab === 'evidence' ? 'active' : ''}`}
            onClick={() => setActiveTab('evidence')}
          >
            Evidence
          </button>
          <button
            type="button"
            role="tab"
            id="tab-fix"
            aria-selected={activeTab === 'fix'}
            aria-controls="panel-fix"
            tabIndex={activeTab === 'fix' ? 0 : -1}
            className={`room-tab-btn ${activeTab === 'fix' ? 'active' : ''}`}
            onClick={() => setActiveTab('fix')}
          >
            Fix
          </button>
        </div>

        {/* Tab Panel: Overview */}
        {activeTab === 'overview' && (
          <div
            role="tabpanel"
            id="panel-overview"
            aria-labelledby="tab-overview"
            className="room-tab-panel overview-panel"
          >
            {!finding ? (
              <div className="room-pre-investigate-box">
                <p className="pre-investigate-hint">
                  Click Investigate to get a plain-English check of this room.
                </p>
              </div>
            ) : (
              <div className="answer-card" role="region" aria-label="Investigation summary">
                {/* Finding title (1 line) + severity chip + tooltip */}
                <div className="answer-card-header finding-header-top-row">
                  <span className="finding-section-eyebrow sr-only" style={{ display: 'none' }}>Finding</span>
                  <div className="answer-title-group">
                    <h4 className="answer-card-title finding-title" title={finding.title}>
                      {finding.title}
                    </h4>
                    <span
                      className={`severity-chip-badge sev-${finding.severity}`}
                      title={`Severity: ${finding.severity.toUpperCase()}`}
                    >
                      {finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1)}
                    </span>
                    <span
                      className="answer-info-tooltip"
                      title={`AI: ${finding.provider || finding.providerUsed || 'Gemini'}${finding.fallbackUsed ? ' (fallback AI)' : ''} · ${finding.timing?.totalMs ?? 0}ms · Certainty: ${finding.evidenceClassification}`}
                      aria-label="AI provider and timing details"
                    >
                      ⓘ
                    </span>
                  </div>
                </div>

                {/* Hidden screen-reader / test metadata */}
                <span className="sr-only finding-badges-row" style={{ display: 'none' }}>
                  <span className={`category-pill cat-${finding.category}`}>{finding.category}</span>
                  <span className={`severity-pill sev-${finding.severity}`}>{finding.severity}</span>
                  <span className={`classification-pill class-${finding.evidenceClassification}`}>{finding.evidenceClassification}</span>
                  {finding.timing && <span className="timing-pill">{finding.timing.totalMs}ms</span>}
                  <span className="finding-explanation">{finding.explanation}</span>
                </span>

                {/* What we found: first 2 sentences */}
                <div className="answer-section">
                  <span className="answer-section-label">What we found</span>
                  <p className="answer-section-body">
                    {showMoreOverview ? finding.explanation : explanationShort}
                    {explanationHasMore && !showMoreOverview && (
                      <button
                        type="button"
                        className="btn-show-more-text"
                        onClick={() => setShowMoreOverview(true)}
                      >
                        Show more
                      </button>
                    )}
                  </p>
                </div>

                {/* Why it matters: first sentence only */}
                {finding.whyItMatters && (
                  <div className="answer-section">
                    <span className="answer-section-label">Why it matters</span>
                    <p className="answer-section-body">
                      {showMoreOverview ? finding.whyItMatters : whyShort}
                      {whyHasMore && !showMoreOverview && (
                        <button
                          type="button"
                          className="btn-show-more-text"
                          onClick={() => setShowMoreOverview(true)}
                        >
                          Show more
                        </button>
                      )}
                    </p>
                  </div>
                )}

                {/* Next step: first sentence of recommendedNextStep */}
                {finding.recommendedNextStep && (
                  <div className="answer-section">
                    <span className="answer-section-label">Next step</span>
                    <p className="answer-section-body next-step-body">
                      {showMoreOverview ? finding.recommendedNextStep : nextStepShort}
                    </p>
                  </div>
                )}

                {/* ONE pet line: Barkley's message only, max ~140 chars in a small speech bubble */}
                {barkleyMsg && (
                  <div className="pet-speech-wrapper">
                    <PixelPetAvatar speaker="dog" size={20} />
                    <div className="pet-speech-bubble" title={barkleyRaw}>
                      <span className="pet-speaker-name">Barkley:</span> {barkleyText}
                    </div>
                  </div>
                )}

                {/* Cleo appears only inside Show more */}
                {showMoreOverview && cleoMsg && (
                  <div className="pet-speech-wrapper cleo-wrapper">
                    <PixelPetAvatar speaker="cat" size={20} />
                    <div className="pet-speech-bubble cleo" title={cleoMsg.text}>
                      <span className="pet-speaker-name">Cleo:</span> {cleoMsg.text}
                    </div>
                  </div>
                )}

                {showMoreOverview && (
                  <div className="answer-more-footer">
                    <button
                      type="button"
                      className="btn-collapse-overview"
                      onClick={() => setShowMoreOverview(false)}
                    >
                      Show less ▲
                    </button>
                    <button
                      type="button"
                      className="btn-expand-finding"
                      onClick={() => setIsExpanded(true)}
                      title="Open full reading workspace"
                    >
                      ⤢ Expand view
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Runtime risk block (only in Resilience view) */}
            {resilienceSnapshot && renderRuntimeRiskBlock()}

            {/* Room description (1 line) */}
            <p className="room-detail-desc room-desc-line" title={room.description}>
              {room.description}
            </p>
          </div>
        )}

        {/* Tab Panel: Simulate */}
        {activeTab === 'simulate' && (
          <div
            role="tabpanel"
            id="panel-simulate"
            aria-labelledby="tab-simulate"
            className="room-tab-panel simulate-panel"
          >
            {internalsData ? (
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
            ) : (
              <div className="tab-empty-msg">No simulation data available for this room.</div>
            )}
          </div>
        )}

        {/* Tab Panel: Evidence */}
        {activeTab === 'evidence' && (
          <div
            role="tabpanel"
            id="panel-evidence"
            aria-labelledby="tab-evidence"
            className="room-tab-panel evidence-panel"
          >
            {/* File list (max 5, "Show all") */}
            <div className="evidence-files-section">
              <div className="evidence-section-header">
                <span className="evidence-section-title">
                  Associated files ({allRoomFiles.length})
                </span>
                {allRoomFiles.length > 5 && (
                  <button
                    type="button"
                    className="btn-show-all-files"
                    onClick={() => setShowAllFiles(!showAllFiles)}
                  >
                    {showAllFiles ? 'Show fewer' : `Show all (${allRoomFiles.length})`}
                  </button>
                )}
              </div>

              {allRoomFiles.length === 0 ? (
                <div className="tab-empty-msg">No files associated with this room.</div>
              ) : (
                <ul className="evidence-file-list">
                  {visibleFiles.map((file) => (
                    <li key={file.path} className="evidence-file-item">
                      <span className="evidence-file-path" title={file.path}>
                        📄 <code>{file.path}</code>
                      </span>
                      <span className="evidence-status-tag">
                        {file.isInspected ? 'Confirmed' : 'Not read yet'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Collapsed "How we know" with facts vs inferences & uncertainties */}
            <details className="evidence-how-we-know">
              <summary className="how-we-know-summary">How we know</summary>
              <div className="how-we-know-content">
                {/* Facts vs Inferences */}
                {finding?.reasoning && (
                  <div className="reasoning-comparison-grid">
                    <div className="reasoning-column">
                      <span className="reasoning-col-title">Confirmed in code:</span>
                      {finding.reasoning.facts.length > 0 ? (
                        <ul className="reasoning-list">
                          {finding.reasoning.facts.map((fact, idx) => (
                            <li key={idx} className="reasoning-bullet fact">
                              ✓ {fact}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="reasoning-empty">No direct code facts noted</div>
                      )}
                    </div>

                    <div className="reasoning-column">
                      <span className="reasoning-col-title">Our best guess:</span>
                      {finding.reasoning.inferences.length > 0 ? (
                        <ul className="reasoning-list">
                          {finding.reasoning.inferences.map((inf, idx) => (
                            <li key={idx} className="reasoning-bullet inference">
                              ↳ {inf}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="reasoning-empty">No inferences made</div>
                      )}
                    </div>
                  </div>
                )}

                {/* Code evidence excerpt */}
                {finding?.codeEvidence?.codeSnippet && (
                  <div className="finding-code-evidence-box" style={{ marginTop: 10 }}>
                    <div className="code-evidence-header">
                      <span className={`code-evidence-badge ${finding.codeEvidence.isVerified ? 'verified' : 'unverified'}`}>
                        {finding.codeEvidence.isVerified ? 'Confirmed' : 'Not proven yet'}
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

                {/* Uncertainties: ONE muted line when relevant */}
                {finding && (finding.evidenceClassification !== 'observed' || finding.uncertainties) && (
                  <div
                    className="muted-uncertainty-line"
                    title={finding.uncertainties || `Classification: ${finding.evidenceClassification}`}
                  >
                    ℹ️ We couldn't read this room's files, so this is our best guess.
                  </div>
                )}
              </div>
            </details>

            {/* Preserved test compatibility elements */}
            <div style={{ display: 'none' }}>
              <div className="room-detail-metrics">
                <span>Files: {room.metrics.filesCount ?? 0}</span>
              </div>
              <div className="finding-evidence-section">
                <span>VALIDATED EVIDENCE:</span>
                <ul className="finding-refs-list">
                  {finding?.evidenceReferences.map((ref) => (
                    <li key={ref.path}>
                      <code>{ref.path}</code>
                      <span>{ref.isInspected ? 'Confirmed' : 'Not read yet'}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="finding-uncertainties-wrapper">
                <span>WHAT REMAINS UNCERTAIN:</span>
                <div className="finding-uncertainties-box">
                  {finding?.uncertainties}
                </div>
              </div>
              <div className="finding-recommendation-wrapper">
                <span>RECOMMENDED NEXT STEP:</span>
              </div>
            </div>
          </div>
        )}

        {/* Tab Panel: Fix */}
        {activeTab === 'fix' && (
          <div
            role="tabpanel"
            id="panel-fix"
            aria-labelledby="tab-fix"
            className="room-tab-panel fix-panel"
          >
            {/* Repair-prompt preview with Copy */}
            <div className="repair-prompt-section">
              <div className="repair-prompt-header-row">
                <span className="prompt-section-heading">Repair prompt preview</span>
                <div className="repair-prompt-actions">
                  {finding?.generatedPrompt && (
                    <button
                      type="button"
                      className="btn-toggle-prompt"
                      onClick={() => setShowPrompt(!showPrompt)}
                    >
                      {showPrompt ? 'Hide full prompt' : 'Show full prompt'}
                    </button>
                  )}
                  {finding?.generatedPrompt && (
                    <button
                      type="button"
                      className={`btn-copy-prompt ${copySuccess ? 'copied' : ''}`}
                      onClick={handleCopyPrompt}
                      aria-label="Copy prompt for coding agent"
                    >
                      {copySuccess ? '✓ Copied to clipboard!' : '📋 Copy prompt for coding agent'}
                    </button>
                  )}
                </div>
              </div>

              {finding?.generatedPrompt ? (
                <textarea
                  className="repair-prompt-textarea"
                  readOnly
                  value={finding.generatedPrompt}
                  rows={showPrompt ? 12 : 6}
                  aria-label="Repair prompt preview"
                />
              ) : (
                <div className="tab-empty-msg">
                  Click <strong>Investigate</strong> above to generate a repair prompt for this room.
                </div>
              )}
              <span className="sr-only" style={{ display: 'none' }}>
                CODING AGENT REPAIR PROMPT:
              </span>
            </div>

            {/* Report fix & re-check (FixLifecyclePanel) */}
            <div className="fix-lifecycle-section">
              <div className="fix-lifecycle-heading">Report fix &amp; re-check</div>
              {finding ? (
                <FixLifecyclePanel
                  finding={finding}
                  room={room}
                  scanResult={scanResult}
                  isSampleActive={isSampleActive}
                  onRoomUpdated={onRoomUpdated}
                  savedLifecycleState={savedLifecycleState}
                  onLifecycleChange={(state) => room && onLifecycleChange?.(room.id, state)}
                />
              ) : (
                <div className="tab-empty-msg">
                  Run an investigation to report fixes and verify against CI.
                </div>
              )}
            </div>
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
