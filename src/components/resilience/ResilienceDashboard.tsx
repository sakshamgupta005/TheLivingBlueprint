import React, { useReducer, useEffect, useRef } from 'react';
import type { RecoveryStrategyId, ResilienceSnapshot, RiskTier } from '../../domain/resilience/types.ts';
import type { ArchitecturalRoom } from '../../types.ts';
import {
  runResilienceStep,
  createPlayback,
  playbackReducer,
  relatedServiceIds,
  BUILTIN_SCENARIOS,
  createScannedRepoScenario,
} from '../../domain/resilience/index.ts';
import { ControlBar } from './ControlBar.tsx';
import { IncidentBrief } from './IncidentBrief.tsx';
import { GuidedDemoBanner, useGuidedDemo } from './GuidedDemo.tsx';
import { LogAnalyzer } from './LogAnalyzer.tsx';
import { HowItWorks } from './HowItWorks.tsx';
import { CascadeGraph } from './CascadeGraph.tsx';
import { StrategyComparison } from './StrategyComparison.tsx';
import { SignalTimeline } from './SignalTimeline.tsx';
import { LogStream } from './LogStream.tsx';

interface ResilienceDashboardProps {
  allRooms: ArchitecturalRoom[];
  selectedRoom: ArchitecturalRoom | null;
  onSelectRoom: (room: ArchitecturalRoom | null) => void;
  hasScanResult: boolean;
  projectName?: string;
  onRiskChange?: (riskMap: Record<string, RiskTier>) => void;
  onSnapshotChange?: (snapshot: ResilienceSnapshot) => void;
  onRegisterApplyStrategy?: (fn: (strategyId: string) => void) => void;
  /** Sends a question to Barkley & Cleo with the engine findings for the focused service. */
  onAskAi?: (question: string, focusId: string | null) => void;
}

export const ResilienceDashboard: React.FC<ResilienceDashboardProps> = ({
  allRooms,
  selectedRoom,
  onSelectRoom,
  hasScanResult,
  projectName,
  onRiskChange,
  onSnapshotChange,
  onRegisterApplyStrategy,
  onAskAi,
}) => {
  const [pb, dispatch] = useReducer(playbackReducer, undefined, () => createPlayback());
  // A scanned repo gets its own scenario built from its rooms (weak, text-matched dependency links).
  const scannedScenario = React.useMemo(
    () =>
      hasScanResult
        ? createScannedRepoScenario(allRooms.map((r) => ({ id: r.id, name: r.name, layer: r.layer, dependencies: r.dependencies })))
        : null,
    [hasScanResult, allRooms]
  );
  const liveSnapshot = React.useMemo(
    () => runResilienceStep(pb, pb.scenarioId === 'scanned-repo' && scannedScenario ? scannedScenario : undefined),
    [pb, scannedScenario]
  );
  // Pasted logs shown on the dashboard replace the simulation until "Back to simulation".
  const [logSnapshot, setLogSnapshot] = React.useState<ResilienceSnapshot | null>(null);
  const snapshot = logSnapshot ?? liveSnapshot;
  const demo = useGuidedDemo(snapshot, dispatch);
  const [showAnalyzer, setShowAnalyzer] = React.useState(false);
  const [showHow, setShowHow] = React.useState(false);

  // After a scan, start on the user's own repo rather than the demo.
  useEffect(() => {
    if (hasScanResult) {
      dispatch({ type: 'selectScenario', scenarioId: 'scanned-repo' });
      dispatch({ type: 'play' });
    }
    else if (pb.scenarioId === 'scanned-repo') dispatch({ type: 'selectScenario', scenarioId: BUILTIN_SCENARIOS[0].id });
  }, [hasScanResult]);

  // Compute related room IDs for filtering when a room is focused
  const focusedRelatedIds = React.useMemo(
    () => (selectedRoom ? relatedServiceIds(snapshot, selectedRoom.id) : null),
    [snapshot, selectedRoom]
  );

  const [previewStrategyId, setPreviewStrategyId] = React.useState<string | null>(null);
  const [toastMessage, setToastMessage] = React.useState<string | null>(null);
  const strategyComparisonRef = useRef<HTMLDivElement | null>(null);

  // Register external strategy application dispatcher (e.g. from RoomInspector)
  useEffect(() => {
    if (onRegisterApplyStrategy) {
      onRegisterApplyStrategy((strategyId: string) => {
        // Use the outcome's own target (rate-limit targets the entry service, not the root cause).
        const outcome = snapshot.recovery.outcomes.find((o) => o.strategyId === strategyId);
        if (!outcome) return;
        dispatch({ type: 'applyStrategy', strategyId: strategyId as RecoveryStrategyId, targetServiceId: outcome.targetServiceId });
        dispatch({ type: 'play' });
      });
    }
  }, [snapshot.recovery.outcomes, onRegisterApplyStrategy]);

  // Pass risk tiers and snapshot up to parent for IsometricHouse overlay & RoomInspector
  useEffect(() => {
    if (onRiskChange && snapshot.riskByRoomId) {
      onRiskChange(snapshot.riskByRoomId);
    }
    if (onSnapshotChange) {
      onSnapshotChange(snapshot);
    }
  }, [snapshot, onRiskChange, onSnapshotChange]);

  // Start playing on open so the view is alive; skipped for reduced-motion users.
  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!reduced) dispatch({ type: 'play' });
  }, []);

  // Interval: while pb.playing, dispatch({type:'step'}) every 1000/pb.speed ms
  useEffect(() => {
    if (!pb.playing) return;

    const intervalMs = Math.max(100, 1000 / pb.speed);
    const intervalId = window.setInterval(() => {
      // Hidden (Blueprint view): don't advance the incident or re-render the app every tick.
      if (shellRef.current && shellRef.current.offsetParent === null) return;
      dispatch({ type: 'step' });
    }, intervalMs);

    return () => clearInterval(intervalId);
  }, [pb.playing, pb.speed]);

  // Pause once when the first failure happens. Without the ref, pressing play (or Apply) on that
  // same tick would pause again immediately and the dashboard looked frozen.
  const autoPausedAt = useRef<string | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const lastTick = useRef(0);
  useEffect(() => {
    // Going backwards (reset, undo, switching fix, new scenario) re-arms the pause and clears the toast.
    if (snapshot.tick < lastTick.current) {
      autoPausedAt.current = null;
      setToastMessage(null);
    }
    lastTick.current = snapshot.tick;
    const key = `${pb.scenarioId}@${snapshot.tick}`;
    if (snapshot.shouldAutoPause && pb.playing && autoPausedAt.current !== key) {
      autoPausedAt.current = key;
      dispatch({ type: 'pause' });
      setToastMessage('First failure reached. The brief above shows the recommended fix.');
    }
  }, [snapshot.shouldAutoPause, snapshot.tick, pb.playing, pb.scenarioId]);

  // Keyboard controls: Space for play/pause, Right arrow for step, R for reset
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!shellRef.current || shellRef.current.offsetParent === null) return;
      const activeTag = document.activeElement?.tagName?.toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        dispatch(pb.playing ? { type: 'pause' } : { type: 'play' });
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        dispatch({ type: 'step' });
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        dispatch({ type: 'reset' });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pb.playing]);

  // In Live Risk, clicking a service focuses the brief; the room panel opens only on request.
  const [focusId, setFocusId] = React.useState<string | null>(null);
  const handleSelectRoomById = (roomId: string) => setFocusId(roomId);
  const focusRoom = focusId ? allRooms.find((r) => r.id === focusId) : undefined;

  const handleFocusStrategies = () => {
    strategyComparisonRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div ref={shellRef} className="resilience-dashboard-shell" role="region" aria-label="Resilience Dashboard">
      {/* Toast Banner for Cascade Intervention */}
      {toastMessage && (
        <div
          style={{
            background: 'rgba(217, 115, 63, 0.95)',
            color: '#fff',
            padding: '8px 14px',
            borderRadius: 6,
            fontSize: '0.8rem',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
          }}
          role="alert"
        >
          <span>{toastMessage}</span>
          <button
            type="button"
            onClick={() => setToastMessage(null)}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#fff',
              fontSize: '1rem',
              cursor: 'pointer',
            }}
            aria-label="Dismiss alert"
          >
            ✕
          </button>
        </div>
      )}

      {/* Top Incident Context Bar */}
      <div className="resilience-context-bar" role="region" aria-label="Incident Context Bar">
        <div className="context-bar-left">
          {selectedRoom ? (
            <span className="context-focused-chip" title="Filtering KPIs, timeline, and logs to this room and its dependencies">
              Focused on: <strong>{selectedRoom.name}</strong>
              <button
                type="button"
                className="btn-clear-focus"
                onClick={() => onSelectRoom(null)}
                aria-label="Clear focus and return to whole project"
                title="Return to whole project view"
              >
                ✕
              </button>
            </span>
          ) : (
            <span className="context-whole-project">
              Whole project · <strong>{projectName || (hasScanResult ? 'Scanned Repo' : 'BookNook')}</strong>
            </span>
          )}

          <div className="context-scenario-picker">
            <label htmlFor="context-scenario-select" className="context-scenario-label">
              Demo incident:
            </label>
            <select
              id="context-scenario-select"
              className="resilience-select"
              value={pb.scenarioId}
              onChange={(e) => dispatch({ type: 'selectScenario', scenarioId: e.target.value })}
              aria-label="Select demo incident scenario"
            >
              {BUILTIN_SCENARIOS.map((sc) => (
                <option key={sc.id} value={sc.id}>
                  {sc.name}
                </option>
              ))}
              {hasScanResult && (
                <option value="scanned-repo">
                  Scanned repo (inferred topology)
                </option>
              )}
            </select>
          </div>
        </div>

        <div className="context-bar-right">
          <button
            type="button"
            className="gd-start"
            onClick={() => {
              setLogSnapshot(null);
              demo.start(pb.scenarioId === 'scanned-repo' ? BUILTIN_SCENARIOS[0].id : pb.scenarioId);
            }}
            disabled={demo.active && !demo.finished}
          >
            ▶ Guided demo
          </button>
          <button type="button" className="cg-btn" aria-expanded={showAnalyzer} onClick={() => setShowAnalyzer((v) => !v)}>
            Analyze your logs
          </button>
          <button type="button" className="cg-btn" aria-expanded={showHow} onClick={() => setShowHow((v) => !v)}>
            How it works
          </button>
          <span
            className="simulated-incident-badge"
            title={snapshot.forecast.label}
          >
            Simulated incident · engine-computed, not live telemetry
          </span>
        </div>
      </div>

      {/* Top Playback & Control Bar */}
      <ControlBar
        snapshot={snapshot}
        isPlaying={pb.playing}
        speed={pb.speed}
        onPlay={() => dispatch({ type: 'play' })}
        onPause={() => dispatch({ type: 'pause' })}
        onStep={() => dispatch({ type: 'step' })}
        onReset={() => dispatch({ type: 'reset' })}
        onSetSpeed={(speed) => dispatch({ type: 'setSpeed', speed: speed as 1 | 2 | 4 })}
        onInjectFault={(fault) => dispatch({ type: 'inject', serviceId: fault.serviceId, faultType: fault.faultType })}
        isStrategyApplied={Boolean(pb.applied)}
      />

      {/* 4 Hero KPI Tiles */}

      {/* Primary Split: Cascade Graph (House visual default) + Strategy Comparison */}
      <GuidedDemoBanner demo={demo} />

      {logSnapshot && (
        <div className="gd" role="status">
          <span className="gd__step">Your logs</span>
          <span className="gd__caption">
            Showing your pasted logs: {logSnapshot.services.length} services, {logSnapshot.scenario.totalTicks} time windows. Playback and fix comparison
            are off because there is no model of your system to replay.
          </span>
          <button type="button" className="ib__link" onClick={() => setLogSnapshot(null)}>
            Back to simulation
          </button>
        </div>
      )}

      {showHow && <HowItWorks snapshot={snapshot} onClose={() => setShowHow(false)} />}

      {showAnalyzer && (
        <LogAnalyzer
          scenarioId={pb.scenarioId === 'scanned-repo' ? BUILTIN_SCENARIOS[0].id : pb.scenarioId}
          tick={snapshot.tick}
          onClose={() => setShowAnalyzer(false)}
          onShowOnMap={(s) => {
            dispatch({ type: 'pause' });
            setFocusId(null);
            setLogSnapshot(s);
          }}
        />
      )}

      <IncidentBrief
        snapshot={snapshot}
        isPlaying={pb.playing}
        onPlay={() => dispatch({ type: 'play' })}
        focusId={focusId}
        onClearFocus={() => setFocusId(null)}
        onApply={(strategyId, targetServiceId) => {
          dispatch({ type: 'applyStrategy', strategyId, targetServiceId });
          dispatch({ type: 'play' });
        }}
        onCompare={handleFocusStrategies}
        onAsk={onAskAi ? (q) => onAskAi(q, focusId) : undefined}
        onUndo={() => {
          dispatch({ type: 'clearStrategy' });
          dispatch({ type: 'play' });
        }}
        onOpenRoom={focusRoom ? () => selectedRoom?.id !== focusRoom.id && onSelectRoom(focusRoom) : undefined}
      />

      <div className="resilience-main-grid">
        <CascadeGraph
          snapshot={snapshot}
          allRooms={allRooms}
          selectedRoomId={focusId}
          onSelectRoom={handleSelectRoomById}
          previewStrategyId={previewStrategyId}
        />

        <div ref={strategyComparisonRef} style={{ display: 'flex' }}>
          <StrategyComparison
            strategies={snapshot.recovery.outcomes}
            baseline={snapshot.recovery.baseline}
            recommendedStrategyId={snapshot.recovery.recommendedId}
            recommendedReason={snapshot.recovery.recommendedReason}
            weights={snapshot.recovery.weights}
            onApplyStrategy={(strategyId, targetServiceId) => {
              dispatch({ type: 'applyStrategy', strategyId, targetServiceId });
              dispatch({ type: 'play' });
            }}
            onPreviewStrategy={setPreviewStrategyId}
            appliedStrategyId={pb.applied?.strategyId ?? null}
            applied={snapshot.applied}
            onClearStrategy={() => {
              dispatch({ type: 'clearStrategy' });
              dispatch({ type: 'play' });
            }}
          />
        </div>
      </div>

      {/* Secondary Split: Telemetry Signal Timeline + Log Stream */}

      <div className="resilience-sub-grid">
        <SignalTimeline
          snapshot={snapshot}
          selectedRoomId={focusId}
          onSelectRoom={handleSelectRoomById}
          focusedRelatedIds={focusedRelatedIds}
        />

        <LogStream
          logs={snapshot.logs}
          templates={snapshot.templates}
          selectedRoomId={focusId}
          selectedRoomName={snapshot.services.find((v) => v.id === focusId)?.name ?? null}
          focusedRelatedIds={focusedRelatedIds}
        />
      </div>
    </div>
  );
};
