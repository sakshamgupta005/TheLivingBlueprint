/**
 * Built-in simulated scenarios. Topologies are shaped after the OpenTelemetry Demo
 * (Astronomy Shop) and a small auth-gated order system. Each one carries its ground truth.
 */

import type { DependencyEdge, EdgeKind, FaultType, ResilienceScenario, ServiceSpec } from './types.ts';

export const DEFAULT_RAMP_TICKS: Record<FaultType, number> = {
  connection_pool_exhaustion: 34,
  bad_deploy: 8,
  memory_leak: 50,
};

/** Text-matched scanner links are weak runtime evidence, whatever their `status` says. */
export const SCAN_HEURISTIC_EDGE_WEIGHT = 0.35;

function svc(
  id: string,
  layer: ServiceSpec['layer'],
  baseRps: number,
  baseP95Ms: number,
  baseErrorRate = 0.005
): ServiceSpec {
  return { id, name: id, layer, baseRps, baseP95Ms, baseErrorRate };
}

function edge(
  source: string,
  target: string,
  weight: number,
  opts: { kind?: EdgeKind; retries?: number; hasBreaker?: boolean } = {}
): DependencyEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    kind: opts.kind ?? 'sync',
    weight,
    provenance: 'scenario',
    retries: opts.retries ?? 0,
    hasBreaker: opts.hasBreaker ?? false,
  };
}

const SHOP_SERVICES: ServiceSpec[] = [
  svc('frontend', 'gateway', 120, 180),
  svc('checkout', 'service', 40, 220),
  svc('cart', 'service', 60, 60),
  svc('ad', 'service', 80, 40),
  svc('email', 'service', 10, 90),
  svc('product-catalog', 'core', 140, 50),
  svc('recommendation', 'core', 70, 110),
  svc('currency', 'core', 90, 20),
  svc('shipping', 'core', 30, 70),
  svc('payment', 'core', 35, 140),
  svc('cache', 'foundation', 300, 5),
  svc('payment-db', 'foundation', 50, 35),
];

const SHOP_EDGES: DependencyEdge[] = [
  edge('frontend', 'checkout', 0.95),
  edge('frontend', 'product-catalog', 0.9),
  edge('frontend', 'cart', 0.9),
  edge('frontend', 'recommendation', 0.4, { hasBreaker: true }),
  edge('frontend', 'ad', 0.3, { hasBreaker: true }),
  edge('checkout', 'cart', 0.8),
  edge('checkout', 'payment', 0.95, { retries: 3 }),
  edge('checkout', 'currency', 0.8),
  edge('checkout', 'shipping', 0.7),
  edge('checkout', 'email', 0.2, { kind: 'async' }),
  edge('recommendation', 'product-catalog', 0.9),
  edge('cart', 'cache', 0.9),
  edge('payment', 'payment-db', 0.97, { retries: 2 }),
];

const named = (s: ServiceSpec, name: string): ServiceSpec => ({ ...s, name });

export const BUILTIN_SCENARIOS: ResilienceScenario[] = [
  {
    // Uses the sample house's room ids (src/data/sampleData.ts) so risk lines up with the rooms on screen.
    id: 'booknook-catalog-pool',
    name: 'BookNook: catalog database pool exhaustion',
    description:
      "The Book Catalog room's database pool runs dry. Checkout and Recommendations call it on every request and go down with it, then the API Gateway follows.",
    seed: 5505,
    totalTicks: 80,
    tickSeconds: 10,
    services: [
      named(svc('room-checkout', 'service', 40, 220), 'Cart & Stripe Checkout'),
      named(svc('room-recommendations', 'gateway', 70, 160), 'AI Recommendations'),
      named(svc('room-auth', 'service', 120, 40), 'Authentication & Session'),
      named(svc('room-catalog', 'core', 140, 60), 'Book Catalog & Inventory'),
      named(svc('api-gateway', 'gateway', 260, 90), 'API Gateway'),
      named(svc('search-index', 'core', 90, 45), 'Search Index'),
      named(svc('stripe-api', 'foundation', 30, 180), 'Stripe API'),
      named(svc('session-cache', 'foundation', 300, 6), 'Session Cache'),
      named(svc('email-worker', 'service', 12, 120), 'Order Emails'),
      named(svc('reviews', 'service', 50, 70), 'Book Reviews'),
    ],
    edges: [
      edge('api-gateway', 'room-checkout', 0.95),
      edge('api-gateway', 'room-recommendations', 0.5, { hasBreaker: true }),
      edge('api-gateway', 'room-auth', 0.9),
      edge('api-gateway', 'reviews', 0.4, { hasBreaker: true }),
      edge('room-checkout', 'room-catalog', 0.95, { retries: 2 }),
      edge('room-checkout', 'room-auth', 0.9),
      edge('room-checkout', 'stripe-api', 0.7, { retries: 2 }),
      edge('room-checkout', 'email-worker', 0.2, { kind: 'async' }),
      edge('room-recommendations', 'room-catalog', 0.9),
      edge('room-recommendations', 'search-index', 0.6),
      edge('room-recommendations', 'room-auth', 0.4, { hasBreaker: true }),
      edge('reviews', 'room-catalog', 0.5, { hasBreaker: true }),
      edge('room-auth', 'session-cache', 0.9),
    ],
    faults: [{ serviceId: 'room-catalog', faultType: 'connection_pool_exhaustion', startTick: 16, rampTicks: 34 }],
    groundTruth: { rootServiceId: 'room-catalog', faultType: 'connection_pool_exhaustion', faultStartTick: 16 },
    isScannedRepo: false,
  },
  {
    id: 'shop-payment-db-pool',
    name: 'Payment DB connection-pool exhaustion',
    description:
      'Slow queries hold connections in payment-db until the pool runs dry. Payment, checkout and the frontend follow.',
    seed: 1101,
    totalTicks: 80,
    tickSeconds: 10,
    services: SHOP_SERVICES,
    edges: SHOP_EDGES,
    faults: [{ serviceId: 'payment-db', faultType: 'connection_pool_exhaustion', startTick: 18, rampTicks: 34 }],
    groundTruth: { rootServiceId: 'payment-db', faultType: 'connection_pool_exhaustion', faultStartTick: 18 },
    isScannedRepo: false,
  },
  {
    id: 'orders-auth-bad-deploy',
    name: 'Bad deploy in auth service',
    description:
      'A new auth build throws on token validation. Every request path that checks tokens starts failing within a minute.',
    seed: 2202,
    totalTicks: 60,
    tickSeconds: 10,
    services: [
      svc('gateway', 'gateway', 150, 120),
      svc('web-bff', 'service', 110, 160),
      svc('orders', 'service', 45, 200),
      svc('notifications', 'service', 20, 80),
      svc('auth', 'core', 160, 30),
      svc('inventory', 'core', 50, 60),
      svc('queue', 'foundation', 40, 10),
      svc('user-db', 'foundation', 90, 15),
      svc('inventory-db', 'foundation', 60, 25),
    ],
    edges: [
      edge('gateway', 'web-bff', 0.95),
      edge('gateway', 'auth', 0.9),
      edge('web-bff', 'orders', 0.9),
      edge('web-bff', 'auth', 0.95, { retries: 1 }),
      edge('orders', 'auth', 0.9),
      edge('orders', 'inventory', 0.85),
      edge('orders', 'notifications', 0.25, { kind: 'async' }),
      edge('notifications', 'queue', 0.6),
      edge('inventory', 'inventory-db', 0.95),
      edge('auth', 'user-db', 0.95),
    ],
    faults: [{ serviceId: 'auth', faultType: 'bad_deploy', startTick: 25, rampTicks: 8 }],
    groundTruth: { rootServiceId: 'auth', faultType: 'bad_deploy', faultStartTick: 25 },
    isScannedRepo: false,
  },
  {
    id: 'shop-recommendation-leak',
    name: 'Memory leak in recommendation (contained)',
    description:
      'recommendation leaks heap and eventually dies, but the frontend calls it behind a circuit breaker, so the cascade stops there.',
    seed: 3303,
    totalTicks: 80,
    tickSeconds: 10,
    services: SHOP_SERVICES,
    edges: SHOP_EDGES,
    faults: [{ serviceId: 'recommendation', faultType: 'memory_leak', startTick: 12, rampTicks: 50 }],
    groundTruth: { rootServiceId: 'recommendation', faultType: 'memory_leak', faultStartTick: 12 },
    isScannedRepo: false,
  },
];

export function getScenario(id: string): ResilienceScenario {
  return BUILTIN_SCENARIOS.find((s) => s.id === id) ?? BUILTIN_SCENARIOS[0];
}

export interface ScannedRoomLike {
  id: string;
  name: string;
  layer: ServiceSpec['layer'];
  dependencies?: string[];
}

/**
 * Builds a scenario from scanned rooms. Edges are scanner text matches, so they get
 * SCAN_HEURISTIC_EDGE_WEIGHT and provenance 'scan-heuristic'. A pool-exhaustion fault is
 * injected into the most database-like room; that injection is the ground truth.
 */
export function createScannedRepoScenario(rooms: ScannedRoomLike[]): ResilienceScenario {
  const ids = new Set(rooms.map((r) => r.id));
  const services = rooms.map((r) => ({ ...svc(r.id, r.layer, 50, 80), name: r.name }));
  const weak = (source: string, target: string) => ({ ...edge(source, target, SCAN_HEURISTIC_EDGE_WEIGHT), provenance: 'scan-heuristic' as const });
  let edges: DependencyEdge[] = rooms.flatMap((r) =>
    (r.dependencies ?? []).filter((target) => target !== r.id && ids.has(target)).map((target) => weak(r.id, target))
  );
  // No code references found: assume the usual layering (gateway -> service -> core -> foundation), still weak.
  if (edges.length === 0) {
    const order: ServiceSpec['layer'][] = ['gateway', 'service', 'core', 'foundation'];
    const byLayer = order.map((l) => rooms.filter((r) => r.layer === l));
    edges = byLayer.flatMap((upper, i) => {
      const lower = byLayer.slice(i + 1).find((g) => g.length > 0) ?? [];
      return upper.flatMap((u) => lower.map((d) => weak(u.id, d.id)));
    });
  }
  const root =
    rooms.find((r) => /db|database|store|persist/i.test(`${r.id} ${r.name}`)) ??
    rooms.find((r) => r.layer === 'foundation') ??
    rooms[0];
  const rootId = root?.id ?? 'unknown';
  return {
    id: 'scanned-repo',
    name: 'Scanned repo (inferred topology)',
    description: 'Synthetic logs on top of the scanned rooms. Topology is inferred from code references.',
    seed: 4404,
    totalTicks: 80,
    tickSeconds: 10,
    services,
    edges,
    faults: root ? [{ serviceId: rootId, faultType: 'connection_pool_exhaustion', startTick: 15, rampTicks: 30 }] : [],
    groundTruth: { rootServiceId: rootId, faultType: 'connection_pool_exhaustion', faultStartTick: 15 },
    isScannedRepo: true,
  };
}
