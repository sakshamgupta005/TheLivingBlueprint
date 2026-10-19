import React, { useState, useMemo } from 'react';
import type { ArchitecturalRoom } from '../types.ts';
import type { GitHubScanResult } from '../domain/github/types.ts';
import type { EvidenceRecord } from '../domain/types.ts';
import {
  buildEvidenceChain,
  type EvidenceChainSummary,
  type LinkedEvidenceChain,
} from '../domain/evidenceChain/index.ts';

interface EvidenceChainViewProps {
  room: ArchitecturalRoom;
  scanResult?: GitHubScanResult | null;
  isSampleActive?: boolean;
  onSelectRoom?: (roomId: string) => void;
  className?: string;
}

export const EvidenceChainView: React.FC<EvidenceChainViewProps> = ({
  room,
  scanResult = null,
  isSampleActive = false,
  onSelectRoom: _onSelectRoom,
  className = '',
}) => {
  const [filterMode, setFilterMode] = useState<'all' | 'verified' | 'failing' | 'missing'>('all');
  const [selectedChainId, setSelectedChainId] = useState<string | null>(null);
  const [showRawFailure, setShowRawFailure] = useState<Record<string, boolean>>({});

  // Deterministically compute evidence chain summary
  const summary: EvidenceChainSummary = useMemo(() => {
    return buildEvidenceChain({
      room,
      scanResult,
      isSampleActive,
    });
  }, [room, scanResult, isSampleActive]);

  const chains = summary.chains;
  const filteredChains = useMemo(() => {
    if (filterMode === 'verified') {
      return chains.filter((c) => c.chainStatus === 'complete_verified');
    }
    if (filterMode === 'failing') {
      return chains.filter((c) => c.chainStatus === 'complete_failing' || c.ciCheck?.honestStateLabel === 'failed');
    }
    if (filterMode === 'missing') {
      return chains.filter((c) => !c.test || c.chainStatus === 'missing_test');
    }
    return chains;
  }, [chains, filterMode]);

  const toggleRawOutput = (chainId: string) => {
    setShowRawFailure((prev) => ({
      ...prev,
      [chainId]: !prev[chainId],
    }));
  };

  const getStatusBadgeClass = (status: LinkedEvidenceChain['chainStatus']) => {
    switch (status) {
      case 'complete_verified':
        return 'badge-verified';
      case 'complete_failing':
        return 'badge-failing';
      case 'pending_ci':
        return 'badge-pending';
      case 'stale_evidence':
        return 'badge-stale';
      case 'ci_inaccessible':
        return 'badge-inaccessible';
      default:
        return 'badge-unverified';
    }
  };

  const getStatusLabel = (status: LinkedEvidenceChain['chainStatus']) => {
    switch (status) {
      case 'complete_verified':
        return 'CHAIN VERIFIED';
      case 'complete_failing':
        return 'CHAIN FAILING';
      case 'pending_ci':
        return 'PENDING CI';
      case 'stale_evidence':
        return 'STALE EVIDENCE (SHA MISMATCH)';
      case 'ci_inaccessible':
        return 'CI INACCESSIBLE';
      case 'missing_test':
        return 'MISSING TEST';
      default:
        return 'UNVERIFIED IMPLEMENTATION';
    }
  };

  return (
    <div
      className={`evidence-chain-view ${className}`}
      role="region"
      aria-label="Code, Tests and CI Evidence Relationship Chain"
    >
      {/* 1. Header & Summary Bar */}
      <div className="chain-header">
        <div className="chain-header-title-row">
          <div className="chain-main-title">
            <span className="chain-title-icon">🔗</span>
            <strong>Source Code, Tests & Real CI Evidence</strong>
          </div>
          <div className="chain-commit-badge" title="Scanned Commit Reference">
            Exact SHA: <code>{summary.repositorySha.slice(0, 7)}</code>
            {summary.isExactCommit ? (
              <span className="exact-match-tag">✓ Exact</span>
            ) : (
              <span className="stale-mismatch-tag">⚠️ Stale SHA</span>
            )}
          </div>
        </div>

        {/* 2. Distinct Claims Separation Bar (Requirement 5) */}
        <div className="claims-separation-bar" aria-label="Evidence claim distinctions">
          <div className="claim-card">
            <span className="claim-count">{summary.claimsSeparation.filesDetectedCount}</span>
            <span className="claim-label">1. Test File Detected</span>
            <span className="claim-hint">File exists in tree</span>
          </div>
          <div className="claim-arrow">→</div>
          <div className="claim-card">
            <span className="claim-count">{summary.claimsSeparation.referencingTestsCount}</span>
            <span className="claim-label">2. References Code</span>
            <span className="claim-hint">Imports/symbols mapped</span>
          </div>
          <div className="claim-arrow">→</div>
          <div className="claim-card">
            <span className="claim-count">{summary.claimsSeparation.executedTestsCount}</span>
            <span className="claim-label">3. Test Executed</span>
            <span className="claim-hint">Ran in exact CI check</span>
          </div>
          <div className="claim-arrow">→</div>
          <div className="claim-card">
            <span className="claim-count">{summary.claimsSeparation.passedCheckCount}</span>
            <span className="claim-label">4. Test Passed</span>
            <span className="claim-hint">Green check on commit</span>
          </div>
        </div>

        {/* Truth Policy Note */}
        <div className="truth-policy-note">
          ⚖️ <strong>Truthful Status Policy:</strong> Detecting a test file does not prove it references this code. A referencing test is not proof it was run in CI. An executed check is not proof it passed.
        </div>

        {/* Stale Commit Warning if applicable */}
        {summary.staleShaWarnings.length > 0 && (
          <div className="stale-sha-banner" role="alert">
            {summary.staleShaWarnings.map((w, i) => (
              <div key={i}>⚠️ {w}</div>
            ))}
          </div>
        )}

        {/* Filters */}
        <div className="chain-filters-row">
          <div className="chain-filter-group" role="tablist">
            <button
              type="button"
              className={`btn-chain-filter ${filterMode === 'all' ? 'active' : ''}`}
              onClick={() => setFilterMode('all')}
            >
              All Chains ({chains.length})
            </button>
            <button
              type="button"
              className={`btn-chain-filter ${filterMode === 'verified' ? 'active' : ''}`}
              onClick={() => setFilterMode('verified')}
            >
              Verified ({summary.verifiedChainsCount})
            </button>
            <button
              type="button"
              className={`btn-chain-filter ${filterMode === 'failing' ? 'active' : ''}`}
              onClick={() => setFilterMode('failing')}
            >
              Failing ({summary.failingChainsCount})
            </button>
            <button
              type="button"
              className={`btn-chain-filter ${filterMode === 'missing' ? 'active' : ''}`}
              onClick={() => setFilterMode('missing')}
            >
              Missing Tests ({summary.missingTestsCount})
            </button>
          </div>
        </div>
      </div>

      {/* 3. Chains List */}
      <div className="chains-content-area">
        {filteredChains.length === 0 ? (
          <div className="chains-empty-notice">
            No evidence chains match the current filter "{filterMode}".
          </div>
        ) : (
          filteredChains.map((chain) => {
            const isFailing =
              chain.chainStatus === 'complete_failing' || chain.ciCheck?.honestStateLabel === 'failed';
            const isExpanded = selectedChainId === chain.id;

            return (
              <div
                key={chain.id}
                className={`chain-card ${getStatusBadgeClass(chain.chainStatus)} ${
                  isExpanded ? 'selected-chain' : ''
                }`}
                onClick={() => setSelectedChainId(chain.id)}
              >
                {/* Chain Status Header */}
                <div className="chain-card-header">
                  <span className={`chain-status-pill ${getStatusBadgeClass(chain.chainStatus)}`}>
                    {getStatusLabel(chain.chainStatus)}
                  </span>
                  <span className="chain-id-label">{chain.requirement.title}</span>
                </div>

                {/* The 4-Step Navigable Chain */}
                <div className="chain-steps-flow">
                  {/* Step 1: Requirement / Behavior */}
                  <div className="chain-step-node step-requirement">
                    <div className="step-tag">1. REQUIREMENT</div>
                    <div className="step-title">{chain.requirement.title}</div>
                    {chain.requirement.description && (
                      <div className="step-subtext">{chain.requirement.description}</div>
                    )}
                  </div>

                  <div className="step-connector">➔</div>

                  {/* Step 2: Implementation */}
                  <div className="chain-step-node step-implementation">
                    <div className="step-tag">2. IMPLEMENTATION</div>
                    <div className="step-path" title={chain.implementation.filePath}>
                      📄 <code>{chain.implementation.filePath}</code>
                    </div>
                    {chain.implementation.symbolName && (
                      <div className="step-symbol">
                        Symbol: <strong>{chain.implementation.symbolName}</strong>
                      </div>
                    )}
                    {chain.implementation.excerpt && (
                      <pre className="step-code-excerpt">
                        {chain.implementation.excerpt.slice(0, 160)}...
                      </pre>
                    )}
                  </div>

                  <div className="step-connector">➔</div>

                  {/* Step 3: Relevant Test */}
                  <div
                    className={`chain-step-node step-test ${
                      chain.test ? (chain.test.mappingType === 'syntax' ? 'syntax' : 'heuristic') : 'missing'
                    }`}
                  >
                    <div className="step-tag">3. RELEVANT TEST</div>
                    {chain.test ? (
                      <>
                        <div className="step-path" title={chain.test.testFilePath}>
                          🧪 <code>{chain.test.testFilePath}</code>
                        </div>
                        {chain.test.testCaseName && (
                          <div className="step-testcase">
                            Case: <em>"{chain.test.testCaseName}"</em>
                          </div>
                        )}
                        <div className="step-mapping-type">
                          {chain.test.mappingType === 'syntax' ? (
                            <span className="mapping-badge syntax" title="Direct import or explicit symbol call">
                              ✓ Syntax Confirmed
                            </span>
                          ) : (
                            <span className="mapping-badge heuristic" title="Associated by filename or heuristic match">
                              ℹ Heuristic Association
                            </span>
                          )}
                          {chain.test.assertions.length > 0 && (
                            <span className="assertion-count-badge">
                              {chain.test.assertions.length} assertion(s)
                            </span>
                          )}
                        </div>
                        <div className="step-evidence-note">{chain.test.evidence}</div>
                      </>
                    ) : (
                      <div className="step-missing-test">
                        ⚠️ No test suite references this implementation.
                      </div>
                    )}
                  </div>

                  <div className="step-connector">➔</div>

                  {/* Step 4: Exact CI Check */}
                  <div
                    className={`chain-step-node step-ci ${
                      chain.ciCheck?.honestStateLabel || 'missing'
                    }`}
                  >
                    <div className="step-tag">4. EXACT CI CHECK</div>
                    {chain.ciCheck ? (
                      <>
                        <div className="step-check-name">
                          ⚙️ <strong>{chain.ciCheck.checkName}</strong>
                        </div>
                        <div className="step-ci-meta">
                          SHA: <code>{chain.ciCheck.commitSha.slice(0, 7)}</code>
                          {chain.ciCheck.isExactScannedCommit ? (
                            <span className="ci-exact-tag">Exact</span>
                          ) : (
                            <span className="ci-mismatch-tag">Mismatch</span>
                          )}
                        </div>
                        <div className="step-ci-status">
                          Result:{' '}
                          <span className={`ci-result-pill ${chain.ciCheck.honestStateLabel}`}>
                            {chain.ciCheck.honestStateLabel.toUpperCase()}
                          </span>
                        </div>
                        {chain.ciCheck.htmlUrl && (
                          <a
                            href={chain.ciCheck.htmlUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ci-external-link"
                          >
                            Open CI Run ↗
                          </a>
                        )}
                      </>
                    ) : (
                      <div className="step-missing-ci">
                        No CI checks available for this commit.
                      </div>
                    )}
                  </div>
                </div>

                {/* Explanation text */}
                <div className="chain-explanation-bar">{chain.explanation}</div>

                {/* 4. Failure Connection: Connect failed test to related file and failure explanation */}
                {isFailing && chain.failureConnection && (
                  <div className="chain-failure-connection-box" role="alert">
                    <div className="failure-connection-header">
                      <strong>💥 Failed Test Diagnostic Connection</strong>
                    </div>
                    <div className="failure-connection-body">
                      <div className="failure-field">
                        <span className="field-label">Failed Test Case:</span>{' '}
                        <code>{chain.failureConnection.failedTestName || 'Test suite failure'}</code> in{' '}
                        <code>{chain.failureConnection.failingFile}</code>
                      </div>
                      {chain.failureConnection.relevantSourceFile && (
                        <div className="failure-field">
                          <span className="field-label">Target Source Location:</span>{' '}
                          <code>{chain.failureConnection.relevantSourceFile}</code>
                          {chain.failureConnection.relevantSourceLine && (
                            <span> (line {chain.failureConnection.relevantSourceLine})</span>
                          )}
                          {chain.failureConnection.relevantSourceSymbol && (
                            <span> in <code>{chain.failureConnection.relevantSourceSymbol}</code></span>
                          )}
                        </div>
                      )}
                      <div className="failure-field explanation">
                        <span className="field-label">Failure Explanation:</span>{' '}
                        <span>{chain.failureConnection.explanation}</span>
                      </div>

                      {chain.failureConnection.failureOutputExcerpt && (
                        <div className="failure-raw-section">
                          <button
                            type="button"
                            className="btn-toggle-raw-failure"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleRawOutput(chain.id);
                            }}
                          >
                            {showRawFailure[chain.id] ? 'Hide Failure Output' : 'View Failure Output Excerpt'}
                          </button>
                          {showRawFailure[chain.id] && (
                            <pre className="raw-failure-excerpt">
                              {chain.failureConnection.failureOutputExcerpt}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* 5. Existing Evidence History & Supersession Display (Requirement 7) */}
      {room.evidenceHistory && room.evidenceHistory.length > 0 && (
        <div className="chain-evidence-history-section">
          <div className="history-header">
            <strong>ROOM EVIDENCE HISTORY & SUPERSESSION ({room.evidenceHistory.length})</strong>
          </div>
          <div className="history-list">
            {room.evidenceHistory.map((ev: EvidenceRecord) => (
              <div
                key={ev.id}
                className={`history-item ${ev.isSuperseded ? 'superseded' : 'active-evidence'}`}
              >
                <div className="history-item-top">
                  <span className={`evidence-type-badge ${ev.sourceType}`}>
                    {ev.sourceType.replace('_', ' ').toUpperCase()}
                  </span>
                  {ev.isSuperseded ? (
                    <span className="superseded-badge">
                      SUPERSEDED {ev.supersededBy ? `by ${ev.supersededBy}` : ''}
                    </span>
                  ) : (
                    <span className="active-badge">ACTIVE</span>
                  )}
                  <span className="history-time">
                    {new Date(ev.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <div className="history-desc">{ev.description}</div>
                {ev.verificationResult && (
                  <div className={`history-result ${ev.verificationResult.status}`}>
                    Result: {ev.verificationResult.status.toUpperCase()} (
                    {ev.verificationResult.testName || 'Test suite'})
                    {ev.verificationResult.details && (
                      <span className="history-details"> — {ev.verificationResult.details}</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
