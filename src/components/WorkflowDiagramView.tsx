import React, { useState, useRef } from 'react';
import type { WorkflowDiagram, WorkflowNode } from '../server/types.ts';
import type { ArchitecturalRoom } from '../types.ts';
import type { CodeIndex } from '../domain/codeIndex/types.ts';
import type { ControlFlowGraph } from '../domain/cfg/types.ts';
import { InteractiveGraphCanvas } from './InteractiveGraphCanvas.tsx';
import { ExpandedVisualizationShell } from './ExpandedVisualizationShell.tsx';

interface WorkflowDiagramViewProps {
  diagram: WorkflowDiagram;
  rooms?: ArchitecturalRoom[];
  codeIndex?: CodeIndex;
  cfg?: ControlFlowGraph;
  fileContents?: Record<string, string>;
  onSelectRoom?: (roomId: string) => void;
}

export const WorkflowDiagramView: React.FC<WorkflowDiagramViewProps> = ({
  diagram,
  rooms,
  codeIndex,
  cfg,
  fileContents,
  onSelectRoom,
}) => {
  const [displayMode, setDisplayMode] = useState<'canvas' | 'flowchart'>('canvas');
  const [activeStep, setActiveStep] = useState(0);
  const [isExpanded, setIsExpanded] = useState(false);
  const expandButtonRef = useRef<HTMLButtonElement | null>(null);

  // Gracefully handle missing, empty, or malformed diagrams
  if (!diagram || typeof diagram !== 'object' || !Array.isArray(diagram.nodes) || diagram.nodes.length === 0) {
    return (
      <div className="workflow-diagram-card fallback-mode">
        <div className="diagram-header-bar">
          <span className="diagram-icon">📊</span>
          <h4 className="diagram-title">{diagram?.title || 'Workflow Diagram'}</h4>
        </div>
        <p className="diagram-overview-text">
          {diagram?.explanation || 'Diagram data is incomplete or currently unavailable.'}
        </p>
      </div>
    );
  }

  const nodes = diagram.nodes || [];
  const edges = diagram.edges || [];
  const currentStep = Math.min(Math.max(0, activeStep), Math.max(0, nodes.length - 1));
  const activeNode: WorkflowNode | undefined = nodes[currentStep];

  const handlePrev = () => setActiveStep((prev) => Math.max(0, prev - 1));
  const handleNext = () => setActiveStep((prev) => Math.min(nodes.length - 1, prev + 1));
  const handleRestart = () => setActiveStep(0);

  const handleFocusRoom = (roomId?: string) => {
    if (roomId && onSelectRoom) {
      onSelectRoom(roomId);
    }
  };

  const getNodeTypeIcon = (type?: string) => {
    switch (type) {
      case 'decision':
        return '◇';
      case 'storage':
        return '🗄';
      case 'external':
        return '🌐';
      default:
        return '⚙';
    }
  };

  const renderContent = (isModal = false) => (
    <div className={`workflow-diagram-card ${isModal ? 'modal-mode' : ''}`}>
      {/* Header Bar */}
      <div className="diagram-header-bar">
        <div className="diagram-title-group">
          <span className="diagram-icon">📊</span>
          <h4 className="diagram-title">{diagram.title}</h4>
          <span className="diagram-simulation-badge" title="Statically derived from inspected source code, not runtime execution">
            Static Flow Simulation
          </span>
        </div>
        <div className="diagram-header-actions">
          <div className="diagram-display-mode-toggle" role="group" aria-label="Diagram display style">
            <button
              type="button"
              className={`btn-toggle-view ${displayMode === 'canvas' ? 'active' : ''}`}
              onClick={() => setDisplayMode('canvas')}
              title="Interactive zoomable graph canvas view"
            >
              📈 Canvas
            </button>
            <button
              type="button"
              className={`btn-toggle-view ${displayMode === 'flowchart' ? 'active' : ''}`}
              onClick={() => setDisplayMode('flowchart')}
              title="Step-by-step sequential flowchart walkthrough"
            >
              ☰ Flowchart
            </button>
          </div>
          <button
            ref={expandButtonRef}
            type="button"
            className="btn-diagram-expand"
            onClick={() => setIsExpanded(!isExpanded)}
            title={isExpanded ? 'Close enlarged view' : 'Enlarge diagram'}
            aria-label={isExpanded ? 'Close enlarged diagram view' : 'Enlarge diagram view'}
          >
            {isExpanded ? '✕ Close' : '⛶ Expand'}
          </button>
        </div>
      </div>

      <p className="diagram-overview-text">{diagram.explanation}</p>

      {displayMode === 'canvas' ? (
        <InteractiveGraphCanvas
          diagram={diagram}
          rooms={rooms}
          codeIndex={codeIndex}
          cfg={cfg}
          fileContents={fileContents}
          onSelectRoom={onSelectRoom}
          isParentExpanded={isModal}
        />
      ) : (
        <>
          {/* Visual Legend */}
          <div className="diagram-legend-bar" aria-label="Diagram legend">
        <span className="legend-item">
          <span className="legend-swatch swatch-observed" /> Observed in code
        </span>
        <span className="legend-item">
          <span className="legend-swatch swatch-inferred" /> Inferred flow
        </span>
        <span className="legend-divider">|</span>
        <span className="legend-item">⚙ Component</span>
        <span className="legend-item">◇ Decision</span>
        <span className="legend-item">🗄 Storage</span>
        <span className="legend-item">🌐 External</span>
      </div>

      {/* Visual Sequence of Nodes & Directed Edges */}
      <div className="diagram-visual-viewport">
        <div className="diagram-nodes-sequence" role="list" aria-label="Workflow diagram steps">
          {nodes.map((node, idx) => {
            const isActive = idx === currentStep;
            const isObserved = node.classification === 'observed';
            const nodeType = node.nodeType || 'component';

            // Find edge connecting this node to the next
            const nextNode = nodes[idx + 1];
            const connectingEdge = nextNode
              ? edges.find((e) => e.from === node.id && e.to === nextNode.id)
              : undefined;

            return (
              <React.Fragment key={node.id}>
                <div
                  role="listitem"
                  className={`diagram-node-box node-type-${nodeType} ${isActive ? 'active-step' : ''} ${
                    isObserved ? 'observed-node' : 'inferred-node'
                  }`}
                  onClick={() => setActiveStep(idx)}
                  title={`Step ${idx + 1}: ${node.label} (${nodeType}, ${node.classification}). Click to inspect.`}
                >
                  <div className="node-box-header">
                    <span className="node-step-number">{idx + 1}</span>
                    <span className="node-type-indicator">{getNodeTypeIcon(node.nodeType)}</span>
                    <span
                      className={`node-class-tag ${isObserved ? 'tag-observed' : 'tag-inferred'}`}
                    >
                      {isObserved ? 'Observed' : 'Inferred'}
                    </span>
                  </div>
                  <div className="node-box-label">{node.label}</div>
                  {node.role && <div className="node-box-role">{node.role}</div>}
                </div>

                {/* Directed Connector Arrow between steps */}
                {idx < nodes.length - 1 && (
                  <div
                    className={`diagram-edge-arrow ${
                      idx === currentStep || idx === currentStep - 1 ? 'edge-active' : ''
                    }`}
                    title={
                      connectingEdge?.branchLabel
                        ? `Branch: ${connectingEdge.branchLabel}`
                        : connectingEdge?.label
                        ? `Connection: ${connectingEdge.label}`
                        : 'Flow step'
                    }
                  >
                    <svg
                      className="arrow-svg"
                      width="44"
                      height="20"
                      viewBox="0 0 44 20"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <line
                        x1="2"
                        y1="10"
                        x2="36"
                        y2="10"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeDasharray={
                          connectingEdge?.classification === 'inferred' ? '3 3' : undefined
                        }
                      />
                      <polygon points="34,6 42,10 34,14" fill="currentColor" />
                    </svg>
                    {(connectingEdge?.branchLabel || connectingEdge?.label) && (
                      <span className={`edge-label-pill ${connectingEdge?.branchLabel ? 'branch-pill' : ''}`}>
                        {connectingEdge?.branchLabel || connectingEdge?.label}
                      </span>
                    )}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Interactive Step-by-Step Walkthrough Card */}
      {activeNode && (
        <div className="diagram-walkthrough-panel">
          <div className="walkthrough-nav-row">
            <span className="walkthrough-step-indicator">
              Step <strong>{currentStep + 1}</strong> of <strong>{nodes.length}</strong>:{' '}
              <span className="walkthrough-active-title">
                {getNodeTypeIcon(activeNode.nodeType)} {activeNode.label}
              </span>
            </span>

            <div className="walkthrough-nav-buttons">
              <button
                type="button"
                className="btn-step-nav"
                onClick={handlePrev}
                disabled={currentStep === 0}
                title="Go to previous step"
              >
                ◀ Prev
              </button>
              <button
                type="button"
                className="btn-step-nav"
                onClick={handleNext}
                disabled={currentStep === nodes.length - 1}
                title="Go to next step"
              >
                Next ▶
              </button>
              <button
                type="button"
                className="btn-step-restart"
                onClick={handleRestart}
                title="Restart walkthrough from step 1"
              >
                ↺ Restart
              </button>
            </div>
          </div>

          <div className="walkthrough-details-grid">
            <div className="walkthrough-detail-row">
              <span className="detail-label">Enters:</span>
              <span className="detail-value">
                {activeNode.inputs || 'Initial request payload / input arguments'}
              </span>
            </div>

            <div className="walkthrough-detail-row">
              <span className="detail-label">Operation:</span>
              <span className="detail-value">{activeNode.description}</span>
            </div>

            <div className="walkthrough-detail-row">
              <span className="detail-label">Leaves:</span>
              <span className="detail-value">
                {activeNode.outputs || 'Processed data / forwarded return value'}
              </span>
            </div>

            {activeNode.filePath && (
              <div className="walkthrough-detail-row">
                <span className="detail-label">Source File:</span>
                <span className="detail-value code-path">
                  <code>{activeNode.filePath}</code>
                  <span className="file-status-hint">
                    ({activeNode.classification === 'observed' ? 'Inspected source excerpt' : 'Discovered in tree'})
                  </span>
                </span>
              </div>
            )}
          </div>

          <div className="walkthrough-footer-row">
            <span className="walkthrough-static-note">
              ℹ Code-derived static walkthrough based on inspected repository files.
            </span>
            {activeNode.roomId && (
              <button
                type="button"
                className="btn-focus-house-room"
                onClick={() => handleFocusRoom(activeNode.roomId)}
                title={`Focus room "${activeNode.roomId}" in the architectural house`}
              >
                Focus {activeNode.label} in House ↗
              </button>
            )}
          </div>
        </div>
      )}
      </>
      )}

      {/* Disclosed Gaps / Uncertainties */}
      {diagram.uncertainties && (
        <div className="diagram-uncertainties-notice">
          <strong>ℹ Missing code / Static simulation limits:</strong> {diagram.uncertainties}
        </div>
      )}
    </div>
  );

  return (
    <>
      {renderContent(false)}

      <ExpandedVisualizationShell
        isOpen={isExpanded}
        onClose={() => setIsExpanded(false)}
        title={diagram.title}
        subtitle={diagram.explanation}
        eyebrow="EXPANDED WORKFLOW WALKTHROUGH"
        triggerRef={expandButtonRef}
        badges={
          <>
            <span className="diagram-simulation-badge">Static Flow Simulation</span>
            <span className="expanded-status-badge">
              {nodes.filter((n) => n.classification === 'observed').length} / {nodes.length} Observed
            </span>
          </>
        }
        actions={
          <div className="diagram-display-mode-toggle" role="group" aria-label="Diagram display style">
            <button
              type="button"
              className={`btn-toggle-view ${displayMode === 'canvas' ? 'active' : ''}`}
              onClick={() => setDisplayMode('canvas')}
              title="Interactive zoomable graph canvas view"
            >
              📈 Canvas
            </button>
            <button
              type="button"
              className={`btn-toggle-view ${displayMode === 'flowchart' ? 'active' : ''}`}
              onClick={() => setDisplayMode('flowchart')}
              title="Step-by-step sequential flowchart walkthrough"
            >
              ☰ Flowchart
            </button>
          </div>
        }
      >
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          {renderContent(true)}
        </div>
      </ExpandedVisualizationShell>
    </>
  );
};
