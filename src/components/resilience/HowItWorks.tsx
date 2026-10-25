import React from 'react';
import type { ResilienceSnapshot } from '../../domain/resilience/types.ts';
import { ANALYSIS_CONFIG } from '../../domain/resilience/analysis.ts';

/** The pipeline in plain words, with the live numbers from the current snapshot. */
export const HowItWorks: React.FC<{ snapshot: ResilienceSnapshot; onClose: () => void }> = ({ snapshot, onClose }) => {
  const s = snapshot;
  const w = s.rootCause.weights;
  const rw = s.recovery.weights;
  const problemPatterns = s.templates.filter((t) => t.level !== 'INFO').length;
  const drifting = s.services.filter((v) => v.onsetTick !== null).length;
  const steps: Array<[string, string]> = [
    [
      'Logs and metrics',
      `Every tick (${s.scenario.tickSeconds}s of simulated time) each of the ${s.services.length} services emits log lines plus error rate and p95 latency. So far: ${s.tick + 1} ticks.`,
    ],
    [
      'Log patterns',
      `Similar lines are grouped Drain-style: IDs, numbers and timings are masked, then lines are clustered by shape. ${s.templates.length} patterns so far, ${problemPatterns} of them warnings or errors.`,
    ],
    [
      'Drift detection',
      `The first ${ANALYSIS_CONFIG.baselineTicks} ticks teach each service its normal range (median and spread, robust to outliers). A service is flagged when its smoothed deviation stays above ${ANALYSIS_CONFIG.onsetZ} for ${ANALYSIS_CONFIG.persistTicks} ticks. ${drifting} service(s) flagged.`,
    ],
    [
      'Root cause ranking',
      `Each flagged service is scored on: who drifted first (${w.temporal}), whether its own dependencies were already sick (${w.dependency}), its own errors vs. "upstream timeout" errors in logs (${w.logEvidence}), severity (${w.severity}) and how many other flagged services it would explain (${w.upstreamImpact}).`,
    ],
    [
      'Forecast',
      `Error-rate speed and acceleration project when a service crosses ${ANALYSIS_CONFIG.failErrorRate * 100}% errors (up to ${ANALYSIS_CONFIG.horizonTicks} ticks ahead). Callers on strong links (≥ ${ANALYSIS_CONFIG.strongEdgeWeight}) inherit the forecast one tick later. Smoothed so it does not flicker.`,
    ],
    [
      'Spread',
      `Walk the dependency map backwards from the root cause through every service projected to fail: ${s.cascade.affectedCount} of ${s.cascade.totalServices} right now.`,
    ],
    [
      'Recovery comparison',
      `Each of the 6 fixes is replayed on the simulated system for ${s.recovery.horizonTicks} ticks against the top-ranked root cause (not the known answer). Score = ${rw.blast} × fewer services down + ${rw.residual} × less leftover damage + ${rw.recovery} × faster recovery + ${rw.sideEffect} × fewer side effects.`,
    ],
    [
      'AI explanation',
      'Barkley and Cleo receive these findings and explain them in plain English. They never change a number, a ranking or the recommended fix.',
    ],
  ];

  return (
    <section className="hiw" aria-label="How it works">
      <header className="la__head">
        <h3 className="la__title">How it works</h3>
        <button type="button" className="ib__link" onClick={onClose} aria-label="Close how it works">
          ✕
        </button>
      </header>
      <ol className="hiw__steps">
        {steps.map(([title, text]) => (
          <li key={title}>
            <strong>{title}.</strong> {text}
          </li>
        ))}
      </ol>
    </section>
  );
};
