import React, { useState } from 'react';
import { analyzeLogText, exportScenarioLogs, type LogAnalysis } from '../../domain/resilience/index.ts';
import type { ResilienceSnapshot } from '../../domain/resilience/types.ts';
import './LogAnalyzer.css';

interface LogAnalyzerProps {
  /** Built-in scenario whose simulated logs can be loaded as a sample. */
  scenarioId: string;
  tick: number;
  onClose: () => void;
  onShowOnMap?: (snapshot: ResilienceSnapshot) => void;
}

const MAX_CHARS = 2_000_000;

/** Paste or load real logs and run the same engine on them. Runs fully in the browser; nothing is uploaded. */
export const LogAnalyzer: React.FC<LogAnalyzerProps> = ({ scenarioId, tick, onClose, onShowOnMap }) => {
  const [text, setText] = useState('');
  const [result, setResult] = useState<LogAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (input = text) => {
    setError(null);
    if (!input.trim()) {
      setError('Paste some log lines first.');
      return;
    }
    setResult(analyzeLogText(input.slice(0, MAX_CHARS)));
  };

  const loadSample = () => {
    const sample = exportScenarioLogs(scenarioId, Math.max(tick, 50));
    setText(sample);
    run(sample);
  };

  const loadFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? '');
      setText(content.slice(0, MAX_CHARS));
      run(content);
      if (content.length > MAX_CHARS) setError('Large file: only the first 2 MB were analyzed.');
    };
    reader.onerror = () => setError('Could not read that file.');
    reader.readAsText(file);
  };

  const top = result?.rootCause.candidates.slice(0, 3) ?? [];
  const onsets = result
    ? Object.values(result.anomalies)
        .filter((a) => a.onsetTick !== null || a.observedFailed)
        .sort((a, b) => (a.onsetTick ?? a.firstObservedFailureTick ?? 0) - (b.onsetTick ?? b.firstObservedFailureTick ?? 0))
    : [];
  const problems = result?.templates.filter((t) => t.level !== 'INFO').sort((a, b) => a.firstSeenTick - b.firstSeenTick).slice(0, 5) ?? [];
  const unit = result?.timeUnit === 'tick' ? (result.windowSize === 1 ? ' tick' : ' ticks') : 's';

  return (
    <section className="la" aria-label="Analyze your own logs">
      <header className="la__head">
        <div>
          <h3 className="la__title">Analyze your own logs</h3>
          <p className="la__sub">
            Paste server logs or load a file. The same engine groups similar lines, infers which services call each other, finds drift and ranks the root
            cause. Everything runs in your browser; nothing is uploaded.
          </p>
        </div>
        <button type="button" className="ib__link" onClick={onClose} aria-label="Close log analyzer">
          ✕
        </button>
      </header>

      <textarea
        className="la__input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        placeholder={'One entry per line, for example:\n2024-05-01T10:00:00Z checkout ERROR upstream call to payment timed out after 3000ms\nt=42 payment WARN connection pool wait 812ms active=48/50\n{"timestamp":"2024-05-01T10:00:02Z","service":"cart","level":"warn","message":"cache miss storm"}'}
        aria-label="Log lines to analyze"
      />

      <div className="la__actions">
        <button type="button" className="ib__apply" onClick={() => run()}>
          Analyze
        </button>
        <label className="la__file">
          Load file
          <input type="file" accept=".log,.txt,.json,.jsonl,text/plain" onChange={(e) => loadFile(e.target.files?.[0])} />
        </label>
        <button type="button" className="ib__link" onClick={loadSample}>
          Use this simulation's logs as a sample
        </button>
        {text && (
          <button
            type="button"
            className="ib__link"
            onClick={() => {
              setText('');
              setResult(null);
              setError(null);
            }}
          >
            Clear
          </button>
        )}
      </div>
      {error && <p className="la__error">{error}</p>}

      {result && (
        <div className="la__result">
          <p className="la__summary">
            Read {result.parsedCount} of {result.lineCount} lines from {result.services.length} services, in {result.windowCount} time windows of{' '}
            {result.windowSize}
            {unit}. Found {result.templates.length} log patterns and {result.edges.length} links between services.
          </p>
          {result.snapshot && onShowOnMap && (
            <button type="button" className="ib__apply la__show" onClick={() => onShowOnMap(result.snapshot!)}>
              Show on the live map →
            </button>
          )}
          {result.notes.map((n) => (
            <p key={n} className="la__note">
              {n}
            </p>
          ))}

          <div className="la__cols">
            <div>
              <span className="ib__label">Likely root cause</span>
              {top.length === 0 ? (
                <p className="ib__text">No clear anomaly in these logs.</p>
              ) : (
                <ol className="la__list">
                  {top.map((c) => (
                    <li key={c.serviceId}>
                      <strong>{c.serviceId}</strong> <span className="ib__muted">({Math.round(c.confidence * 100)}% of evidence)</span>
                      <ul className="ib__reasons">
                        {c.reasons.slice(0, 2).map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div>
              <span className="ib__label">What went wrong first</span>
              {onsets.length === 0 ? (
                <p className="ib__text">No service drifted from its baseline.</p>
              ) : (
                <ul className="la__plain">
                  {onsets.slice(0, 6).map((a) => (
                    <li key={a.serviceId}>
                      <span className="la__mono">t={a.onsetTick ?? a.firstObservedFailureTick}</span> {a.serviceId}{' '}
                      {a.observedFailed ? <span className="la__bad">failing</span> : <span className="ib__muted">drifting</span>}
                    </li>
                  ))}
                </ul>
              )}
              <span className="ib__label la__gap">Who calls whom (from messages)</span>
              {result.edges.length === 0 ? (
                <p className="ib__text">No links found.</p>
              ) : (
                <ul className="la__plain">
                  {result.edges.slice(0, 8).map((e) => (
                    <li key={e.id} className="la__mono">
                      {e.source} → {e.target}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <span className="ib__label">First problem patterns</span>
              {problems.length === 0 ? (
                <p className="ib__text">No warning or error patterns.</p>
              ) : (
                <ul className="la__plain">
                  {problems.map((t) => (
                    <li key={t.id}>
                      <code className="ib__evidence" title={t.template}>
                        {t.template}
                      </code>
                      <span className="ib__muted">
                        {' '}
                        ×{t.count} · {t.serviceIds.join(', ')} · first at t={t.firstSeenTick}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
