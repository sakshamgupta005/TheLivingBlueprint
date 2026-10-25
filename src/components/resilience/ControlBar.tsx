import React from 'react';
import type { ResilienceSnapshot, FaultInjection, FaultType } from '../../domain/resilience/types.ts';

const FAULT_TYPES: FaultType[] = ['connection_pool_exhaustion', 'bad_deploy', 'memory_leak'];

interface ControlBarProps {
  snapshot: ResilienceSnapshot;
  isPlaying: boolean;
  speed: number;
  onPlay: () => void;
  onPause: () => void;
  onStep: () => void;
  onReset: () => void;
  onSetSpeed: (speed: number) => void;
  onInjectFault: (fault: FaultInjection) => void;
  isStrategyApplied: boolean;
}

export const ControlBar: React.FC<ControlBarProps> = ({
  snapshot,
  isPlaying,
  speed,
  onPlay,
  onPause,
  onStep,
  onReset,
  onSetSpeed,
  onInjectFault,
  isStrategyApplied,
}) => {
  const clockString = `t=${String(snapshot.tick).padStart(3, '0')} · ${snapshot.simTimeLabel}`;

  return (
    <div
      className="resilience-control-bar"
      role="toolbar"
      aria-label="Simulation Playback and Fault Controls"
    >
      <div className="control-bar-group">

        {/* Play / Pause / Step / Reset Controls */}
        <button
          type="button"
          className={`resilience-btn-ctrl ${isPlaying ? 'active' : ''}`}
          onClick={isPlaying ? onPause : onPlay}
          aria-label={isPlaying ? 'Pause simulation (Space)' : 'Play simulation (Space)'}
          aria-pressed={isPlaying}
          title={isPlaying ? 'Pause simulation (Space)' : 'Play simulation (Space)'}
        >
          {isPlaying ? '❚❚ Pause' : '▶ Play'}
        </button>

        <button
          type="button"
          className="resilience-btn-ctrl"
          onClick={onStep}
          disabled={isPlaying}
          aria-label="Step forward 1 tick (→)"
          title="Step forward 1 tick (→)"
        >
          ⏭ Step
        </button>

        <button
          type="button"
          className="resilience-btn-ctrl"
          onClick={onReset}
          aria-label="Reset scenario to t=0 (R)"
          title="Reset scenario to t=0 (R)"
        >
          ⟲ Reset
        </button>

        {/* Speed Controls */}
        <div style={{ display: 'inline-flex', gap: 2 }}>
          {[1, 2, 4].map((s) => (
            <button
              key={s}
              type="button"
              className={`resilience-btn-ctrl ${speed === s ? 'active' : ''}`}
              onClick={() => onSetSpeed(s)}
              aria-label={`Playback speed ${s}x`}
              aria-pressed={speed === s}
            >
              {s}×
            </button>
          ))}
        </div>

        {/* Clock */}
        <div
          className="resilience-clock"
          title="Simulation Clock: 1 tick = 10 simulated seconds"
          aria-label={`Current tick ${snapshot.tick}`}
        >
          ⏱ {clockString}
        </div>
      </div>

      <div className="control-bar-group">
        {/* Inject Fault Menu */}
        <label htmlFor="fault-inject-select" style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
          Inject Fault:
        </label>
        <select
          id="fault-inject-select"
          className="resilience-select"
          disabled={isStrategyApplied}
          onChange={(e) => {
            const [serviceId, faultType] = e.target.value.split('|');
            if (serviceId && faultType) {
              onInjectFault({ serviceId, faultType: faultType as FaultType, startTick: snapshot.tick, rampTicks: 0 });
            }
            e.target.value = '';
          }}
          defaultValue=""
          aria-label="Inject fault into scenario"
          title={
            isStrategyApplied
              ? 'Fault injection locked during strategy containment'
              : 'Select fault to immediately trigger in simulation'
          }
        >
          <option value="" disabled>
            ⚡ Select fault to inject...
          </option>
          {snapshot.services.map((svc) => (
            <optgroup key={svc.id} label={svc.name}>
              {FAULT_TYPES.map((ft) => (
                <option key={ft} value={`${svc.id}|${ft}`}>
                  {svc.name}: {ft.replace(/_/g, ' ')}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

      </div>
    </div>
  );
};
