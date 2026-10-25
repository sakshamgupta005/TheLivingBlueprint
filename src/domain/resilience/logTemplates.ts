/**
 * Drain-lite log template miner (after logpai/Drain3): mask variable fields, bucket by
 * level + token count + first token, then merge into the most similar cluster.
 */

import type { LogEvent, LogLevel, LogTemplate } from './types.ts';

const WILDCARD = '<*>';
const SIMILARITY_THRESHOLD = 0.5;

const MASKS: Array<[RegExp, string]> = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, WILDCARD],
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, WILDCARD],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, WILDCARD],
  [/\b(?=[0-9a-f]*\d)[0-9a-f]{6,}\b/gi, WILDCARD],
  [/\d+(?:\.\d+)?/g, WILDCARD],
];

export function maskLogLine(line: string): string {
  return MASKS.reduce((acc, [re, rep]) => acc.replace(re, rep), line);
}

interface Cluster {
  id: string;
  tokens: string[];
  level: LogLevel;
  count: number;
  firstSeenTick: number;
  lastSeenTick: number;
  serviceIds: Set<string>;
}

function similarity(template: string[], tokens: string[]): number {
  let same = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (template[i] === tokens[i] || template[i] === WILDCARD) same++;
  }
  return same / tokens.length;
}

export interface MinedLogs {
  logs: LogEvent[];
  templates: LogTemplate[];
}

/** `newSinceTick`: templates first seen after this tick and within the last 10 ticks are flagged new. */
export function mineTemplates(events: LogEvent[], currentTick: number, newSinceTick: number): MinedLogs {
  const buckets = new Map<string, Cluster[]>();
  const clusters: Cluster[] = [];
  const logs = events.map((e) => {
    const tokens = maskLogLine(e.message).split(/\s+/).filter(Boolean);
    const first = tokens[0] && !tokens[0].includes(WILDCARD) ? tokens[0] : WILDCARD;
    const key = `${e.level}|${tokens.length}|${first}`;
    const bucket = buckets.get(key) ?? [];
    buckets.set(key, bucket);

    let best: Cluster | null = null;
    let bestSim = 0;
    for (const c of bucket) {
      const sim = similarity(c.tokens, tokens);
      if (sim > bestSim) {
        best = c;
        bestSim = sim;
      }
    }
    if (best && bestSim >= SIMILARITY_THRESHOLD) {
      best.tokens = best.tokens.map((t, i) => (t === tokens[i] ? t : WILDCARD));
      best.count++;
      best.lastSeenTick = e.tick;
      best.serviceIds.add(e.serviceId);
    } else {
      best = {
        id: `T${clusters.length + 1}`,
        tokens,
        level: e.level,
        count: 1,
        firstSeenTick: e.tick,
        lastSeenTick: e.tick,
        serviceIds: new Set([e.serviceId]),
      };
      bucket.push(best);
      clusters.push(best);
    }
    return { ...e, templateId: best.id };
  });

  const templates: LogTemplate[] = clusters.map((c) => ({
    id: c.id,
    template: c.tokens.join(' '),
    count: c.count,
    level: c.level,
    firstSeenTick: c.firstSeenTick,
    lastSeenTick: c.lastSeenTick,
    serviceIds: [...c.serviceIds].sort(),
    isNew: c.firstSeenTick > newSinceTick && c.firstSeenTick > currentTick - 10,
  }));
  return { logs, templates };
}
