import React, { useState, useMemo, useRef } from 'react';
import type { CodeIndex } from '../domain/codeIndex/types.ts';
import type { ArchitecturalRoom } from '../types.ts';
import type {
  RequestJourney,
} from '../domain/journey/types.ts';
import {
  detectEntryPoints,
  traceRequestJourney,
  exploreJourneyStep,
} from '../domain/journey/index.ts';
import { ExpandedVisualizationShell } from './ExpandedVisualizationShell.tsx';

interface CallSequenceViewProps {
  codeIndex?: CodeIndex;
  fileContents?: Record<string, string>;
  rooms?: ArchitecturalRoom[];
  initialRouteId?: string;
  initialSymbolId?: string;
  onNavigateToCfg?: (filePath: string, functionName?: string, line?: number) => void;
  onNavigateToDfg?: (filePath: string, functionName?: string, line?: number) => void;
  onSelectRoom?: (roomId: string) => void;
  className?: string;
  isParentExpanded?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

export const CallSequenceView: React.FC<CallSequenceViewProps> = ({
  codeIndex,
  fileContents = {},
  rooms = [],
  initialRouteId,
  initialSymbolId,
  onNavigateToCfg,
  onNavigateToDfg,
  onSelectRoom,
  className = '',
  isParentExpanded = false,
  isExpanded: externalIsExpanded,
  onToggleExpand,
}) => {
  const [internalIsExpanded, setInternalIsExpanded] = useState(false);
  const isExpanded = externalIsExpanded !== undefined ? externalIsExpanded : internalIsExpanded;
  const setIsExpanded = (val: boolean) => {
    setInternalIsExpanded(val);
    onToggleExpand?.();
  };
  const expandButtonRef = useRef<HTMLButtonElement | null>(null);
  // 1. Detect Entry Points
  const entryPoints = useMemo(() => {
    return codeIndex ? detectEntryPoints(codeIndex) : [];
  }, [codeIndex]);

  const [selectedRouteId, setSelectedRouteId] = useState<string>(
    initialRouteId || (entryPoints.length > 0 ? entryPoints[0].id : '')
  );

  // 2. Active Request Journey
  const journey: RequestJourney = useMemo(() => {
    if (!codeIndex) {
      return {
        id: 'empty',
        title: 'No Code Index',
        entryPoint: null,
        traceKind: 'statically_reconstructed',
        isComplete: false,
        unresolvedLinksCount: 0,
        participants: [],
        steps: [],
        explanation: 'Inspect a repository to generate code architecture and request journeys.',
        stats: {
          totalParticipants: 0,
          totalSteps: 0,
          callsCount: 0,
          returnsCount: 0,
          errorBranchesCount: 0,
          unresolvedCount: 0,
        },
        supportedExploration: { canStepForward: false, canStepBackward: false },
      };
    }

    return traceRequestJourney({
      entryPointId: selectedRouteId || undefined,
      startSymbolId: initialSymbolId,
      codeIndex,
      fileContents,
      rooms,
    });
  }, [codeIndex, selectedRouteId, initialSymbolId, fileContents, rooms]);

  // 3. Selection & Inspection State
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [selectedParticipantId, setSelectedParticipantId] = useState<string | null>(null);
  const [explorationFeedback, setExplorationFeedback] = useState<string | null>(null);

  const selectedStep = journey.steps.find((s) => s.id === selectedStepId);
  const selectedParticipant = journey.participants.find((p) => p.id === selectedParticipantId);

  // Participant Column Layout Measurements
  const COLUMN_WIDTH = 190;
  const COLUMN_GAP = 28;
  const STEP_ROW_HEIGHT = 56;
  const HEADER_HEIGHT = 90;

  const participantPositions = useMemo(() => {
    const map = new Map<string, { x: number; centerX: number }>();
    journey.participants.forEach((p, idx) => {
      const x = idx * (COLUMN_WIDTH + COLUMN_GAP) + 30;
      map.set(p.id, { x, centerX: x + COLUMN_WIDTH / 2 });
    });
    return map;
  }, [journey.participants]);

  const totalWidth = Math.max(760, journey.participants.length * (COLUMN_WIDTH + COLUMN_GAP) + 80);
  const totalHeight = HEADER_HEIGHT + journey.steps.length * STEP_ROW_HEIGHT + 100;

  // Participant Icon and Styling
  const getParticipantIcon = (kind: string) => {
    switch (kind) {
      case 'client':
        return '👤';
      case 'entry_route':
        return '🌐';
      case 'validator':
        return '🛡️';
      case 'service':
        return '⚙️';
      case 'storage':
        return '🗄️';
      case 'unresolved':
        return '⚠️';
      default:
        return '📦';
    }
  };

  // Exploration Handlers
  const handleExplore = (direction: 'forward' | 'backward', participantId: string) => {
    if (!codeIndex) return;
    const res = exploreJourneyStep(journey, {
      direction,
      participantId,
      codeIndex,
      fileContents,
    });
    setExplorationFeedback(res.explanation);
    setTimeout(() => setExplorationFeedback(null), 6000);
  };

  return (
    <div className={`call-sequence-view-container ${className}`} role="region" aria-label="Request Journey Diagram">
      {/* 1. Sequence Top Control Toolbar */}
      <div className="sequence-top-toolbar" role="toolbar" aria-label="Sequence controls">
        {/* Route Selector Dropdown */}
        <div className="sequence-route-selector-group">
          <label htmlFor="sequence-route-select" className="sequence-select-label">
            Route / Entry:
          </label>
          <select
            id="sequence-route-select"
            value={selectedRouteId}
            onChange={(e) => {
              setSelectedRouteId(e.target.value);
              setSelectedStepId(null);
              setSelectedParticipantId(null);
            }}
            className="sequence-route-select"
            aria-label="Select request entry point"
          >
            {entryPoints.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.method} {entry.routePath} ({entry.framework})
              </option>
            ))}
            {entryPoints.length === 0 && (
              <option value="">No Detectable HTTP Routes</option>
            )}
          </select>
        </div>

        {/* Stats Metrics Badges */}
        <div className="sequence-stats-bar">
          <span className="stat-pill">👥 Participants: <strong>{journey.stats.totalParticipants}</strong></span>
          <span className="stat-pill">▶ Steps: <strong>{journey.stats.totalSteps}</strong></span>
          <span className="stat-pill">📞 Calls: <strong>{journey.stats.callsCount}</strong></span>
          <span className="stat-pill">↵ Returns: <strong>{journey.stats.returnsCount}</strong></span>
          {journey.stats.errorBranchesCount > 0 && (
            <span className="stat-pill error-stat">⚠️ Error Branches: <strong>{journey.stats.errorBranchesCount}</strong></span>
          )}
          {journey.stats.unresolvedCount > 0 ? (
            <span className="stat-pill warning-stat" title="Calls to uninspected or external libraries">
              ⚠️ Unresolved: <strong>{journey.stats.unresolvedCount}</strong>
            </span>
          ) : (
            <span className="stat-pill success-stat" title="All observed links resolved">
              ✓ Fully Resolved
            </span>
          )}
        </div>

        {/* Honest Classification Notice */}
        <div className="sequence-trace-badge" title="T28 Requirement 5: Statically Reconstructed vs Observed Runtime Trace">
          <span className="badge-tag">ℹ Static Reconstructed Trace</span>
        </div>

        {!isParentExpanded && (
          <button
            ref={expandButtonRef}
            type="button"
            className="btn-seq-expand"
            onClick={() => setIsExpanded(true)}
            title="Expand request journey sequence to full-screen view (95vw × 92vh)"
            aria-label="Expand request journey sequence to full-screen view"
          >
            ⛶ Expand
          </button>
        )}
      </div>

      {/* Exploration Feedback Alert */}
      {explorationFeedback && (
        <div className="sequence-exploration-alert" role="status">
          <span>🔍 {explorationFeedback}</span>
          <button type="button" onClick={() => setExplorationFeedback(null)} className="btn-close-alert">✕</button>
        </div>
      )}

      {/* 2. Interactive Sequence Canvas Area */}
      <div className="sequence-diagram-viewport">
        <svg
          className="sequence-diagram-svg"
          width={totalWidth}
          height={totalHeight}
          viewBox={`0 0 ${totalWidth} ${totalHeight}`}
        >
          <defs>
            {/* Arrow Marker Definitions */}
            <marker
              id="seq-arrow-call"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" fill="#e5a963" />
            </marker>
            <marker
              id="seq-arrow-return"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" fill="#60a5fa" />
            </marker>
            <marker
              id="seq-arrow-error"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" fill="#ef4444" />
            </marker>
            <marker
              id="seq-arrow-unresolved"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" fill="#f59e0b" />
            </marker>
          </defs>

          {/* 1. Vertical Lifeline Cords */}
          {journey.participants.map((p) => {
            const pos = participantPositions.get(p.id);
            if (!pos) return null;
            return (
              <line
                key={`lifeline-${p.id}`}
                x1={pos.centerX}
                y1={HEADER_HEIGHT}
                x2={pos.centerX}
                y2={totalHeight - 30}
                stroke={p.kind === 'unresolved' ? '#855938' : '#4a3628'}
                strokeWidth={1.8}
                strokeDasharray={p.kind === 'unresolved' ? '4 4' : '6 4'}
              />
            );
          })}

          {/* 2. Horizontal Message Steps */}
          {journey.steps.map((step) => {
            const fromPos = participantPositions.get(step.fromParticipantId);
            const toPos = participantPositions.get(step.toParticipantId);
            if (!fromPos || !toPos) return null;

            const y = HEADER_HEIGHT + step.order * STEP_ROW_HEIGHT;
            const isSelected = selectedStepId === step.id;
            const isError = step.type === 'error_branch' || step.isError;
            const isReturn = step.type === 'return' || step.type === 'response_send';
            const isUnresolved = step.type === 'unresolved_call' || step.confidence === 'unresolved';

            const startX = fromPos.centerX;
            const endX = toPos.centerX;
            const isLeftward = endX < startX;

            const getStrokeColor = () => {
              if (isSelected) return '#38bdf8';
              if (isError) return '#ef4444';
              if (isUnresolved) return '#f59e0b';
              if (isReturn) return '#60a5fa';
              return '#e5a963';
            };

            const getMarker = () => {
              if (isError) return 'url(#seq-arrow-error)';
              if (isUnresolved) return 'url(#seq-arrow-unresolved)';
              if (isReturn) return 'url(#seq-arrow-return)';
              return 'url(#seq-arrow-call)';
            };

            const labelX = (startX + endX) / 2;
            const labelY = y - 7;

            return (
              <g
                key={step.id}
                className={`sequence-step-group ${isSelected ? 'step-selected' : ''}`}
                onClick={() => {
                  setSelectedStepId(step.id);
                  setSelectedParticipantId(null);
                }}
                style={{ cursor: 'pointer' }}
              >
                {/* Invisible hit-area */}
                <line
                  x1={startX}
                  y1={y}
                  x2={endX}
                  y2={y}
                  stroke="transparent"
                  strokeWidth={20}
                />

                {/* Visible Message Arrow */}
                <line
                  x1={startX}
                  y1={y}
                  x2={endX}
                  y2={y}
                  stroke={getStrokeColor()}
                  strokeWidth={isSelected ? 3.2 : 2.0}
                  strokeDasharray={isReturn ? '5 3' : isUnresolved ? '3 3' : undefined}
                  markerEnd={getMarker()}
                />

                {/* Step Order Badge */}
                <circle
                  cx={isLeftward ? startX - 14 : startX + 14}
                  cy={y}
                  r={9}
                  fill={isError ? '#ef4444' : isSelected ? '#38bdf8' : '#2d1e15'}
                  stroke={getStrokeColor()}
                  strokeWidth={1.5}
                />
                <text
                  x={isLeftward ? startX - 14 : startX + 14}
                  y={y + 3.5}
                  fill="#ffffff"
                  fontSize="9.5"
                  fontWeight="bold"
                  textAnchor="middle"
                >
                  {step.order}
                </text>

                {/* Step Label */}
                <text
                  x={labelX}
                  y={labelY}
                  fill={isError ? '#fca5a5' : isSelected ? '#38bdf8' : '#eed8c4'}
                  fontSize="11.5"
                  fontWeight={isSelected ? 'bold' : '600'}
                  textAnchor="middle"
                >
                  {step.label.length > 42 ? step.label.slice(0, 41) + '…' : step.label}
                </text>
              </g>
            );
          })}

          {/* 3. Top Participant Header Boxes */}
          {journey.participants.map((p) => {
            const pos = participantPositions.get(p.id);
            if (!pos) return null;
            const isSelected = selectedParticipantId === p.id;
            const icon = getParticipantIcon(p.kind);

            return (
              <g
                key={`box-${p.id}`}
                transform={`translate(${pos.x}, 12)`}
                onClick={() => {
                  setSelectedParticipantId(p.id);
                  setSelectedStepId(null);
                }}
                style={{ cursor: 'pointer' }}
                className={`sequence-participant-card ${isSelected ? 'selected' : ''}`}
              >
                {/* Box Background */}
                <rect
                  width={COLUMN_WIDTH}
                  height={64}
                  rx="8"
                  ry="8"
                  fill={isSelected ? '#312318' : '#221711'}
                  stroke={isSelected ? '#38bdf8' : p.kind === 'unresolved' ? '#b45309' : '#593e2c'}
                  strokeWidth={isSelected ? 2.4 : 1.4}
                  filter={isSelected ? 'drop-shadow(0 0 8px rgba(56, 189, 248, 0.4))' : undefined}
                />

                {/* Icon & Title */}
                <text x="12" y="26" fontSize="15">
                  {icon}
                </text>
                <text
                  x="34"
                  y="24"
                  fill="#f5eedc"
                  fontSize="12.5"
                  fontWeight="bold"
                  className="participant-label-text"
                >
                  {p.label.length > 17 ? p.label.slice(0, 16) + '…' : p.label}
                </text>

                {/* Kind Badge & Source Hint */}
                <text x="12" y="48" fill="#a88d75" fontSize="10" fontWeight="600">
                  {p.kind.toUpperCase()}
                  {p.filePath ? ` • ${p.filePath.split('/').pop()}` : ''}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* 3. Step Inspector Drawer */}
      {selectedStep && (
        <div className="sequence-inspector-drawer" role="complementary" aria-label="Step details">
          <div className="sequence-drawer-header">
            <div className="drawer-title-group">
              <span className={`drawer-kind-badge ${selectedStep.isError ? 'badge-error' : 'badge-step'}`}>
                STEP {selectedStep.order}: {selectedStep.type.toUpperCase()}
              </span>
              <h4 className="drawer-node-title">{selectedStep.label}</h4>
              <span className={`drawer-evidence-tag ${selectedStep.confidence === 'directly_observed' ? 'tag-observed' : selectedStep.confidence === 'statically_reconstructed' ? 'tag-inferred' : 'tag-unresolved'}`}>
                {selectedStep.confidence === 'directly_observed'
                  ? '✓ Directly Observed'
                  : selectedStep.confidence === 'statically_reconstructed'
                  ? 'ℹ Statically Reconstructed'
                  : '⚠ Unresolved Dispatch'}
              </span>
            </div>
            <button
              type="button"
              className="btn-close-drawer"
              onClick={() => setSelectedStepId(null)}
              aria-label="Close inspector drawer"
            >
              ✕
            </button>
          </div>

          <div className="sequence-drawer-body">
            {selectedStep.detail && (
              <p className="drawer-description">{selectedStep.detail}</p>
            )}

            {/* Error or Unresolved banner */}
            {selectedStep.isError && (
              <div className="drawer-issue-banner error" style={{ margin: '8px 0', padding: '10px', background: '#3b1818', border: '1px solid #ef4444', borderRadius: '6px' }}>
                <span className="issue-icon" style={{ fontSize: '16px', marginRight: '6px' }}>🚨</span>
                <div>
                  <strong style={{ color: '#fca5a5' }}>Error Branch / Exception Path:</strong>
                  <p style={{ color: '#fecaca', margin: '4px 0 0', fontSize: '12px' }}>
                    Triggered conditionally or inside exception handler; yields error response.
                  </p>
                </div>
              </div>
            )}

            {selectedStep.unresolvedReason && (
              <div className="drawer-issue-banner warning" style={{ margin: '8px 0', padding: '10px', background: '#352514', border: '1px solid #f59e0b', borderRadius: '6px' }}>
                <span className="issue-icon" style={{ fontSize: '16px', marginRight: '6px' }}>⚠️</span>
                <div>
                  <strong style={{ color: '#fde68a' }}>Unresolved Call:</strong>
                  <p style={{ color: '#fef3c7', margin: '4px 0 0', fontSize: '12px' }}>
                    Target is outside inspected repository source ({selectedStep.unresolvedReason}).
                  </p>
                </div>
              </div>
            )}

            {/* Supporting Evidence */}
            <div className="drawer-evidence-box" style={{ margin: '8px 0', padding: '10px', background: '#241a13', border: '1px solid #4a3628', borderRadius: '6px' }}>
              <span className="meta-label" style={{ color: '#d4a373', fontWeight: 'bold' }}>Supporting Evidence:</span>
              <p className="drawer-evidence-text" style={{ color: '#eed8c4', margin: '4px 0 0', fontSize: '12px', lineHeight: '1.4' }}>
                {selectedStep.evidence}
              </p>
            </div>

            <div className="drawer-meta-grid">
              <div className="drawer-meta-item">
                <span className="meta-label">Origin:</span>
                <span className="meta-val">
                  <strong>{journey.participants.find((p) => p.id === selectedStep.fromParticipantId)?.label || selectedStep.fromParticipantId}</strong>
                </span>
              </div>
              <div className="drawer-meta-item">
                <span className="meta-label">Destination:</span>
                <span className="meta-val">
                  <strong>{journey.participants.find((p) => p.id === selectedStep.toParticipantId)?.label || selectedStep.toParticipantId}</strong>
                </span>
              </div>
              {selectedStep.filePath && (
                <div className="drawer-meta-item" style={{ gridColumn: 'span 2' }}>
                  <span className="meta-label">Source File Location:</span>
                  <span className="meta-val code-path">
                    <code>{selectedStep.filePath}</code>
                    {selectedStep.lineRange && (
                      <span className="line-range-hint"> :L{selectedStep.lineRange.startLine}-{selectedStep.lineRange.endLine}</span>
                    )}
                  </span>
                </div>
              )}
            </div>

            {/* Code Excerpt Preview */}
            {selectedStep.codeExcerpt && (
              <div className="drawer-source-section">
                <span className="meta-label">Inspected Code Excerpt:</span>
                <pre className="drawer-code-block" style={{ marginTop: '6px', maxHeight: '140px', overflowY: 'auto' }}>
                  <code>{selectedStep.codeExcerpt}</code>
                </pre>
              </div>
            )}
          </div>

          <div className="sequence-drawer-footer">
            {selectedStep.filePath && onNavigateToCfg && (
              <button
                type="button"
                className="btn-view-cfg-drawer"
                onClick={() => onNavigateToCfg(selectedStep.filePath!, undefined, selectedStep.lineRange?.startLine)}
                title="View deterministic Control-Flow Graph for this step"
              >
                ⚡ View in CFG
              </button>
            )}
            {selectedStep.filePath && onNavigateToDfg && (
              <button
                type="button"
                className="btn-view-dfg-drawer"
                onClick={() => onNavigateToDfg(selectedStep.filePath!, undefined, selectedStep.lineRange?.startLine)}
                title="View Data-Flow Lineage for this step"
                style={{ background: '#1c2929', color: '#2dd4bf', border: '1px solid #2dd4bf', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '12px' }}
              >
                💧 View Data Flow
              </button>
            )}
          </div>
        </div>
      )}

      {/* 4. Participant Inspector Drawer with Forward/Backward Exploration */}
      {selectedParticipant && (
        <div className="sequence-inspector-drawer" role="complementary" aria-label="Participant details">
          <div className="sequence-drawer-header">
            <div className="drawer-title-group">
              <span className="drawer-kind-badge badge-step">
                PARTICIPANT: {selectedParticipant.kind.toUpperCase()}
              </span>
              <h4 className="drawer-node-title">{selectedParticipant.label}</h4>
            </div>
            <button
              type="button"
              className="btn-close-drawer"
              onClick={() => setSelectedParticipantId(null)}
              aria-label="Close participant drawer"
            >
              ✕
            </button>
          </div>

          <div className="sequence-drawer-body">
            <div className="drawer-meta-grid">
              <div className="drawer-meta-item">
                <span className="meta-label">Participant Type:</span>
                <span className="meta-val">{selectedParticipant.kind.toUpperCase()}</span>
              </div>
              <div className="drawer-meta-item">
                <span className="meta-label">Confidence:</span>
                <span className="meta-val">{selectedParticipant.confidence.replace('_', ' ')}</span>
              </div>
              {selectedParticipant.filePath && (
                <div className="drawer-meta-item" style={{ gridColumn: 'span 2' }}>
                  <span className="meta-label">File:</span>
                  <span className="meta-val code-path">
                    <code>{selectedParticipant.filePath}</code>
                  </span>
                </div>
              )}
            </div>

            {/* Exploration Options */}
            <div className="sequence-exploration-panel" style={{ marginTop: '16px', padding: '12px', background: '#241a13', border: '1px solid #4a3628', borderRadius: '6px' }}>
              <span className="meta-label" style={{ color: '#d4a373', fontWeight: 'bold' }}>Step Exploration (T28 Requirement 4):</span>
              <p style={{ color: '#eed8c4', fontSize: '12px', margin: '4px 0 10px' }}>
                Explore relationships forward (calls made by this participant) or backward (upstream callers).
              </p>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  className="btn-explore-backward"
                  onClick={() => handleExplore('backward', selectedParticipant.id)}
                  style={{ background: '#38281d', color: '#e5a963', border: '1px solid #785b46', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
                >
                  ◀ Explore Callers (Backward)
                </button>
                <button
                  type="button"
                  className="btn-explore-forward"
                  onClick={() => handleExplore('forward', selectedParticipant.id)}
                  style={{ background: '#38281d', color: '#e5a963', border: '1px solid #785b46', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
                >
                  ▶ Explore Calls (Forward)
                </button>
              </div>
            </div>
          </div>

          <div className="sequence-drawer-footer">
            {selectedParticipant.roomId && onSelectRoom && (
              <button
                type="button"
                className="btn-focus-house"
                onClick={() => onSelectRoom(selectedParticipant.roomId!)}
              >
                🏛 Focus Room in House ↗
              </button>
            )}
            {selectedParticipant.filePath && onNavigateToCfg && (
              <button
                type="button"
                className="btn-view-cfg-drawer"
                onClick={() => onNavigateToCfg(selectedParticipant.filePath!, selectedParticipant.label.replace(/\(\)$/, ''))}
              >
                ⚡ View CFG
              </button>
            )}
          </div>
        </div>
      )}

      {isExpanded && !isParentExpanded && (
        <ExpandedVisualizationShell
          isOpen={isExpanded}
          onClose={() => setIsExpanded(false)}
          triggerRef={expandButtonRef}
          title={`Request Journey: ${journey.title}`}
          subtitle={`${journey.stats.totalParticipants} participants, ${journey.stats.totalSteps} steps • Statically reconstructed trace`}
          badge="EXPANDED SEQUENCE VIEW"
        >
          <div className="expanded-sequence-wrapper">
            <CallSequenceView
              codeIndex={codeIndex}
              fileContents={fileContents}
              rooms={rooms}
              initialRouteId={selectedRouteId}
              initialSymbolId={initialSymbolId}
              onNavigateToCfg={onNavigateToCfg}
              onNavigateToDfg={onNavigateToDfg}
              onSelectRoom={onSelectRoom}
              isParentExpanded={true}
            />
          </div>
        </ExpandedVisualizationShell>
      )}
    </div>
  );
};
