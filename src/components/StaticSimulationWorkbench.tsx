import React, { useState, useEffect, useRef, useMemo } from 'react';
import type { ControlFlowGraph } from '../domain/cfg/types.ts';
import type { DataFlowGraph } from '../domain/dataFlow/types.ts';
import type {
  SimulationScenario,
  SimulationStep,
  SimulationResult,
} from '../domain/simulation/types.ts';
import { runStaticSimulation, deriveScenarios } from '../domain/simulation/interpreter.ts';
import { ExpandedVisualizationShell } from './ExpandedVisualizationShell.tsx';

export interface StaticSimulationWorkbenchProps {
  cfg?: ControlFlowGraph | null;
  availableCfgs?: ControlFlowGraph[];
  onSelectCfg?: (cfg: ControlFlowGraph) => void;
  lineage?: DataFlowGraph | null;
  knownTests?: Array<{ testName: string; filePath: string; line?: number; passing?: boolean; status?: string }>;
  onFocusRoom?: (roomId: string) => void;
  onOpenSource?: (filePath: string, line?: number) => void;
  className?: string;
  isParentExpanded?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

export const StaticSimulationWorkbench: React.FC<StaticSimulationWorkbenchProps> = ({
  cfg,
  availableCfgs = [],
  onSelectCfg,
  lineage,
  knownTests = [],
  onFocusRoom,
  onOpenSource,
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
  const getCfgKey = (c: ControlFlowGraph) => `${c.sourcePath}:${c.functionName}`;

  // 1. Available CFGs selection
  const activeCfg = cfg || availableCfgs[0] || null;

  // 2. Scenario derivation from parameters and tests (T29 Req 5)
  const scenarios = useMemo(() => {
    if (!activeCfg) return [];
    return deriveScenarios(activeCfg);
  }, [activeCfg]);

  const [selectedScenarioId, setSelectedScenarioId] = useState<string>('');

  // Sync selected scenario when scenarios change
  useEffect(() => {
    if (scenarios.length > 0 && (!selectedScenarioId || !scenarios.some((s) => s.id === selectedScenarioId))) {
      setSelectedScenarioId(scenarios[0].id);
    }
  }, [scenarios, selectedScenarioId]);

  const activeScenario: SimulationScenario | undefined =
    scenarios.find((s) => s.id === selectedScenarioId) || scenarios[0];

  // 3. Run deterministic bounded static simulation (T29 Req 3 & 4)
  const simulationResult: SimulationResult | null = useMemo(() => {
    if (!activeCfg || !activeScenario) return null;
    return runStaticSimulation({
      cfg: activeCfg,
      scenario: activeScenario,
      relevantTests: knownTests.map((t) => t.testName),
      maxSteps: 50,
      maxLoopIterations: 5,
    });
  }, [activeCfg, activeScenario, knownTests]);

  const steps = simulationResult?.steps || [];

  // 4. Playback and stepping controls (T29 Req 2)
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<0.5 | 1 | 2>(1);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Reset step index when scenario or CFG changes
  useEffect(() => {
    setCurrentStepIndex(0);
    setIsPlaying(false);
  }, [activeCfg ? getCfgKey(activeCfg) : null, activeScenario?.id]);

  // Auto-play loop with configurable speed
  useEffect(() => {
    if (isPlaying && steps.length > 0) {
      const intervalMs = Math.round(1600 / playbackSpeed);
      timerRef.current = setTimeout(() => {
        setCurrentStepIndex((prev) => {
          if (prev >= steps.length - 1) {
            setIsPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, intervalMs);
    } else if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isPlaying, playbackSpeed, currentStepIndex, steps.length]);

  const handlePlayPause = () => {
    if (isPlaying) {
      setIsPlaying(false);
    } else {
      if (currentStepIndex >= steps.length - 1) {
        setCurrentStepIndex(0);
      }
      setIsPlaying(true);
    }
  };

  const handleStepForward = () => {
    setIsPlaying(false);
    setCurrentStepIndex((prev) => Math.min(steps.length - 1, prev + 1));
  };

  const handleStepBack = () => {
    setIsPlaying(false);
    setCurrentStepIndex((prev) => Math.max(0, prev - 1));
  };

  const handleRestart = () => {
    setIsPlaying(false);
    setCurrentStepIndex(0);
  };

  const currentStep: SimulationStep | undefined = steps[currentStepIndex];

  if (!activeCfg) {
    return (
      <div className={`static-simulation-workbench empty-state ${className}`}>
        <div className="empty-workbench-card">
          <span className="empty-icon">🔀</span>
          <h4>No Control-Flow Graph Selected</h4>
          <p>Select a function or component to inspect its static control-flow simulation.</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`static-simulation-workbench ${className}`}
      role="region"
      aria-label="Static Code Simulation Workbench"
    >
      {/* 1. Header & Explicit Static Labeling (Req 7) */}
      <div className="sim-workbench-header">
        <div className="header-title-block">
          <div className="title-row">
            <span className="sim-icon">🔬</span>
            <h3 className="sim-main-title">Static Code Simulation Workbench</h3>
            <span className="sim-badge-static" title="Requirement 7: Deterministic AST interpreter, not runtime execution">
              STATIC CODE SIMULATION
            </span>
            {!isParentExpanded && (
              <button
                ref={expandButtonRef}
                type="button"
                className="btn-sim-expand"
                onClick={() => setIsExpanded(true)}
                title="Expand static simulation workbench to full-screen view (95vw × 92vh)"
                aria-label="Expand static simulation workbench to full-screen view"
              >
                ⛶ Expand
              </button>
            )}
          </div>
          <p className="sim-subtitle">
            Source-grounded walkthrough of modeled statements and branches. Every computed value is evaluated by a bounded, deterministic AST interpreter—never executing repository code or installing dependencies.
          </p>
        </div>

        {/* Function & Scenario Selectors */}
        <div className="sim-selectors-row">
          {/* Function Selector (if multiple CFGs) */}
          {availableCfgs.length > 1 && (
            <div className="selector-group">
              <label htmlFor="sim-fn-select" className="selector-label">Function:</label>
              <select
                id="sim-fn-select"
                className="sim-dropdown fn-select"
                value={getCfgKey(activeCfg)}
                onChange={(e) => {
                  const target = availableCfgs.find((c) => getCfgKey(c) === e.target.value);
                  if (target && onSelectCfg) onSelectCfg(target);
                }}
              >
                {availableCfgs.map((c) => (
                  <option key={getCfgKey(c)} value={getCfgKey(c)}>
                    {c.functionName}() ({c.sourcePath.split('/').pop()})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Scenario Selector (Req 2 & 5) */}
          <div className="selector-group scenario-group">
            <label htmlFor="sim-scenario-select" className="selector-label">Scenario:</label>
            <select
              id="sim-scenario-select"
              className="sim-dropdown scenario-select"
              value={selectedScenarioId}
              onChange={(e) => {
                setSelectedScenarioId(e.target.value);
                setIsPlaying(false);
              }}
            >
              {scenarios.map((sc) => (
                <option key={sc.id} value={sc.id}>
                  [{sc.category.toUpperCase()}] {sc.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Scenario Description Banner */}
      {activeScenario && (
        <div className="sim-scenario-banner">
          <div className="scenario-meta">
            <span className={`category-tag category-${activeScenario.category}`}>
              {activeScenario.category.replace('_', ' ')}
            </span>
            <span className="scenario-desc">{activeScenario.description}</span>
          </div>
          <div className="scenario-params">
            <span className="params-label">Modeled Parameters:</span>
            <code>{JSON.stringify(activeScenario.parameters)}</code>
          </div>
        </div>
      )}

      {/* 2. Playback Toolbar (Req 2) */}
      <div className="sim-playback-toolbar" role="toolbar" aria-label="Simulation playback controls">
        <div className="playback-buttons">
          <button
            type="button"
            className={`btn-play-pause ${isPlaying ? 'playing' : ''}`}
            onClick={handlePlayPause}
            title={isPlaying ? 'Pause simulation (Space)' : 'Play simulation'}
          >
            {isPlaying ? '⏸ Pause' : '▶ Play'}
          </button>

          <button
            type="button"
            className="btn-playback-step"
            onClick={handleStepBack}
            disabled={currentStepIndex <= 0}
            title="Step backward to previous statement"
          >
            ◀ Back
          </button>

          <button
            type="button"
            className="btn-playback-step"
            onClick={handleStepForward}
            disabled={currentStepIndex >= steps.length - 1}
            title="Step forward to next statement"
          >
            Step ▶
          </button>

          <button
            type="button"
            className="btn-playback-restart"
            onClick={handleRestart}
            title="Reset simulation to beginning"
          >
            ↺ Restart
          </button>
        </div>

        {/* Speed Controls */}
        <div className="speed-control-group" role="group" aria-label="Playback speed">
          <span className="speed-label">Speed:</span>
          {([0.5, 1, 2] as const).map((spd) => (
            <button
              key={spd}
              type="button"
              className={`btn-speed-pill ${playbackSpeed === spd ? 'active' : ''}`}
              onClick={() => setPlaybackSpeed(spd)}
            >
              {spd}x
            </button>
          ))}
        </div>

        {/* Progress Counter & Status */}
        <div className="sim-status-counter">
          <span className="step-counter">
            Step <strong>{steps.length > 0 ? currentStepIndex + 1 : 0}</strong> of <strong>{steps.length}</strong>
          </span>
          {simulationResult?.terminatedEarly && (
            <span className="termination-pill" title={simulationResult.terminationReason}>
              ⚠️ Bounded Terminated
            </span>
          )}
          {simulationResult?.returnValue !== undefined && (
            <span className="return-pill">
              Result: <code>{JSON.stringify(simulationResult.returnValue)}</code>
            </span>
          )}
        </div>
      </div>

      {/* 3. Visible Path Summary Progression Ribbon (Req 2) */}
      {steps.length > 0 && (
        <div className="sim-path-summary-container" aria-label="Modeled Execution Path Ribbon">
          <div className="path-summary-label">PATH SUMMARY:</div>
          <div className="path-summary-scroll">
            {steps.map((st, idx) => {
              const isCurrent = idx === currentStepIndex;
              const isPassed = idx < currentStepIndex;
              const hasUnknown = st.hasUnknownExpressions;
              const isBranch = !!st.conditionResult;

              return (
                <div
                  key={st.stepIndex}
                  className={`path-chip ${isCurrent ? 'current' : ''} ${isPassed ? 'passed' : ''} ${
                    isBranch ? 'branch-chip' : ''
                  }`}
                  onClick={() => {
                    setIsPlaying(false);
                    setCurrentStepIndex(idx);
                  }}
                  title={`Step ${idx + 1}: ${st.nodeLabel} (Line ${st.lineRange.startLine})`}
                >
                  <span className="chip-index">{idx + 1}</span>
                  <span className="chip-label">{st.nodeLabel}</span>
                  {hasUnknown && <span className="chip-unknown-flag" title="Contains unknown expression">?</span>}
                  {idx < steps.length - 1 && <span className="chip-arrow">→</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 4. Main Two-Column Workbench Layout */}
      {currentStep && (
        <div className="sim-workbench-grid">
          {/* Left Column: Current Statement, Lineage, Rationale & Alternatives */}
          <div className="workbench-col col-statement">
            {/* Current Step Card */}
            <div className="sim-card current-statement-card">
              <div className="card-header-row">
                <div className="header-left">
                  <span className="step-badge">STEP {currentStep.stepIndex + 1}</span>
                  <span className={`kind-badge kind-${currentStep.nodeKind}`}>{currentStep.nodeKind}</span>
                </div>
                <div className="header-right">
                  {currentStep.filePath && (
                    <span
                      className="source-file-link"
                      onClick={() => onOpenSource?.(currentStep.filePath!, currentStep.lineRange.startLine)}
                      title="Click to view in source context"
                    >
                      📄 {currentStep.filePath.split('/').pop()}:L{currentStep.lineRange.startLine}
                    </span>
                  )}
                </div>
              </div>

              <div className="statement-label">{currentStep.nodeLabel}</div>

              {/* Source Excerpt */}
              {currentStep.codeExcerpt && (
                <div className="sim-source-excerpt">
                  <div className="excerpt-header">
                    <span>Source Excerpt (Line {currentStep.lineRange.startLine}):</span>
                  </div>
                  <pre className="excerpt-pre">
                    <code>{currentStep.codeExcerpt}</code>
                  </pre>
                </div>
              )}

              {/* Step Explanation / Branch Rationale (Req 4) */}
              <div className="step-explanation-box">
                <span className="explanation-title">Decision / Operation Rationale:</span>
                <p className="explanation-text">{currentStep.explanation}</p>
              </div>

              {/* Condition Result Details (if applicable) (Req 4) */}
              {currentStep.conditionResult && (
                <div className="condition-decision-card">
                  <div className="condition-header">
                    <span className="cond-title">Branch Condition Evaluation:</span>
                    <span
                      className={`cond-result-badge ${
                        currentStep.conditionResult.result === true
                          ? 'true'
                          : currentStep.conditionResult.result === false
                          ? 'false'
                          : 'unknown'
                      }`}
                    >
                      {String(currentStep.conditionResult.result).toUpperCase()}
                    </span>
                  </div>
                  <div className="condition-formula">
                    <code>{currentStep.conditionResult.expression}</code>
                  </div>
                  <div className="condition-vars-eval">
                    <span className="vars-eval-label">Evaluated Inputs:</span>
                    <div className="vars-eval-chips">
                      {Object.entries(currentStep.conditionResult.evaluatedVariables).map(([k, v]) => (
                        <span key={k} className="eval-var-chip">
                          <code>{k}</code> = <code>{JSON.stringify(v)}</code>
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="branch-selected-note">
                    Selected Path: <strong>{currentStep.chosenBranchLabel || 'Default'}</strong>
                  </div>
                </div>
              )}

              {/* Alternative Branches Not Taken (Req 6) */}
              {currentStep.alternativeBranches && currentStep.alternativeBranches.length > 0 && (
                <div className="alternative-branches-card">
                  <div className="alt-title">Alternative Branches (Not Taken):</div>
                  <div className="alt-list">
                    {currentStep.alternativeBranches.map((alt, aIdx) => (
                      <div key={aIdx} className="alt-branch-item">
                        <div className="alt-branch-header">
                          <span className="alt-label">Branch: {alt.label}</span>
                          <span className="alt-target">→ {alt.targetNodeLabel}</span>
                        </div>
                        <div className="alt-reason">{alt.reasonNotTaken}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Relevant Test Links (Req 6) */}
              {simulationResult?.relevantTests && simulationResult.relevantTests.length > 0 && (
                <div className="sim-relevant-tests-card">
                  <div className="tests-header">
                    <span className="tests-icon">🧪</span>
                    <span className="tests-label">Relevant Grounding Tests ({simulationResult.relevantTests.length}):</span>
                  </div>
                  <div className="tests-list">
                    {simulationResult.relevantTests.map((tName, tIdx) => (
                      <span key={tIdx} className="test-chip" title="Test verifying this logic">
                        {tName}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Modeled Variables Scope & Lineage */}
          <div className="workbench-col col-variables">
            {/* Modeled Variables Scope Inspector (Req 3 & 4) */}
            <div className="sim-card variables-scope-card">
              <div className="card-header-row">
                <h4 className="card-title">Modeled Variables Scope</h4>
                <span className="var-count-badge">
                  {Object.keys(currentStep.variables || {}).length} Tracked
                </span>
              </div>
              <p className="variables-hint">
                Modeled strictly by deterministic expression evaluation. Unsupported or dynamic values are flagged as <code>UNKNOWN</code>.
              </p>

              {Object.keys(currentStep.variables || {}).length === 0 ? (
                <div className="empty-variables-notice">No variables currently defined in this scope.</div>
              ) : (
                <div className="variables-table-container">
                  <table className="variables-table">
                    <thead>
                      <tr>
                        <th>Variable</th>
                        <th>Modeled Value</th>
                        <th>Type / Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(currentStep.variables).map(([name, val]) => {
                        const isUnknown = val === 'UNKNOWN' || (typeof val === 'string' && val.includes('UNKNOWN'));
                        const isUpdatedThisStep = currentStep.variableUpdates && name in currentStep.variableUpdates;

                        return (
                          <tr key={name} className={`${isUpdatedThisStep ? 'updated-this-step' : ''} ${isUnknown ? 'row-unknown' : ''}`}>
                            <td className="var-name-cell">
                              <code>{name}</code>
                              {isUpdatedThisStep && <span className="updated-tag" title="Updated in this step">UPDATED</span>}
                            </td>
                            <td className="var-value-cell">
                              {isUnknown ? (
                                <span className="val-unknown-pill" title="Cannot be computed statically; marked UNKNOWN rather than guessing">
                                  UNKNOWN
                                </span>
                              ) : (
                                <code className="val-literal">{JSON.stringify(val)}</code>
                              )}
                            </td>
                            <td className="var-type-cell">
                              <span className={`type-tag type-${isUnknown ? 'unknown' : typeof val}`}>
                                {isUnknown ? 'unknown' : typeof val}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Value Lineage Insight (Req 1) */}
              {lineage && (
                <div className="sim-lineage-callout">
                  <span className="lineage-callout-icon">💧</span>
                  <div className="lineage-callout-content">
                    <div className="lineage-title">Static Value Lineage Connection:</div>
                    <p className="lineage-text">
                      Parameters travel into local variables and are validated before returning state or calling next services.
                    </p>
                    {onFocusRoom && (
                      <button
                        type="button"
                        className="btn-crosslink-room"
                        onClick={() => onFocusRoom('business_logic')}
                        style={{ marginTop: '4px', fontSize: '11px', cursor: 'pointer' }}
                      >
                        Focus Logic Room in House ↗
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Simulation Statistics & Bounds Verification */}
            {simulationResult && (
              <div className="sim-card stats-summary-card">
                <h4 className="card-title">Simulation Bounds & Metrics</h4>
                <div className="stats-grid">
                  <div className="stat-box">
                    <span className="stat-label">Total Steps:</span>
                    <span className="stat-value">{simulationResult.stats.totalSteps}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-label">Branches Evaluated:</span>
                    <span className="stat-value">{simulationResult.stats.branchesEvaluated}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-label">Variables Tracked:</span>
                    <span className="stat-value">{simulationResult.stats.variablesTracked}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-label">Unknown Exprs:</span>
                    <span className={`stat-value ${simulationResult.stats.unknownExpressionsCount > 0 ? 'highlight-unknown' : ''}`}>
                      {simulationResult.stats.unknownExpressionsCount}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 5. Static Simulation Integrity Footer (Req 7) */}
      <div className="sim-workbench-footer">
        <span>
          ℹ️ <strong>Static Simulation Guarantees:</strong> AST-based bounded evaluation only. Scanned code dependencies and runtime APIs are never invoked.
        </span>
      </div>

      {isExpanded && !isParentExpanded && (
        <ExpandedVisualizationShell
          isOpen={isExpanded}
          onClose={() => setIsExpanded(false)}
          triggerRef={expandButtonRef}
          title={`Static Simulation: ${activeCfg.functionName}()`}
          subtitle={`${activeCfg.sourcePath} • Bounded deterministic AST interpreter`}
          badge="EXPANDED SIMULATION"
        >
          <div className="expanded-simulation-wrapper">
            <StaticSimulationWorkbench
              cfg={activeCfg}
              availableCfgs={availableCfgs}
              onSelectCfg={onSelectCfg}
              lineage={lineage}
              knownTests={knownTests}
              onFocusRoom={onFocusRoom}
              onOpenSource={onOpenSource}
              isParentExpanded={true}
            />
          </div>
        </ExpandedVisualizationShell>
      )}
    </div>
  );
};
