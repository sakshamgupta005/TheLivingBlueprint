import React from 'react';
import type { ResilienceSnapshot } from '../../domain/resilience/types.ts';
import { summarizeSnapshot } from '../../domain/resilience/index.ts';

interface KpiStripProps {
  snapshot: ResilienceSnapshot;
  onSelectRoom?: (roomId: string) => void;
  onFocusStrategies?: () => void;
  focusedRoomId?: string | null;
  focusedRelatedIds?: string[] | null;
}

/** One compact line of incident facts. Every phrase comes from summarizeSnapshot, so nothing disagrees. */
export const KpiStrip: React.FC<KpiStripProps> = ({ snapshot, onSelectRoom, onFocusStrategies }) => {
  const s = summarizeSnapshot(snapshot);
  const next = snapshot.forecast.next;
  const top = snapshot.rootCause.candidates[0];
  const quiet = snapshot.rootCause.status !== 'ok';

  return (
    <div className="incident-summary" aria-live="polite">
      <p className="incident-summary__line">
        <span className="incident-summary__tick">t={snapshot.tick}</span>
        {quiet ? (
          <span>{s.nextFailure}</span>
        ) : (
          <>
            <button type="button" className="incident-summary__link" onClick={() => next && onSelectRoom?.(next.serviceId)}>
              {s.nextFailure}
            </button>
            <span aria-hidden="true">·</span>
            <span>{s.blastRadius}</span>
            <span aria-hidden="true">·</span>
            <button type="button" className="incident-summary__link" onClick={() => top && onSelectRoom?.(top.serviceId)}>
              {s.rootCause}
            </button>
            <span aria-hidden="true">·</span>
            <button type="button" className="incident-summary__link" onClick={onFocusStrategies}>
              {s.bestFix}
            </button>
          </>
        )}
        {s.leadTime && <span className="incident-summary__lead">{s.leadTime}</span>}
      </p>
      <p className="incident-summary__pet">
        <strong>Barkley:</strong> {s.petLine}
      </p>
    </div>
  );
};
