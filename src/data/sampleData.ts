import type { ArchitecturalRoom } from '../types.ts';

/**
 * Fallback demonstration dataset: BookNook bookstore application.
 * NOTE: This is pre-canned sample data for UI demonstration and layout validation only.
 * Live repository scanning is disconnected in this milestone.
 */
export const SAMPLE_PROJECT = {
  name: 'BookNook',
  repo: 'github.com/example/booknook-demo',
  isSampleData: true,
  statusLabel: 'Sample Demonstration Data — Live GitHub Scanning Disconnected',
  summary: 'Online independent bookstore architecture model with 4 core rooms.',
};

export const SAMPLE_ROOMS: ArchitecturalRoom[] = [
  {
    id: 'room-auth',
    name: 'Authentication & Session',
    layer: 'service',
    status: 'verified',
    description: 'User registration, JWT tokens, session cookies, and role access control.',
    evidence: 'Sample: 18/18 integration tests passed. Endpoints verified in test harness.',
    metrics: { testsPassed: 18, totalTests: 18, filesCount: 6 },
    coords: { isoX: -170, isoY: 10, width: 160, height: 80, depth: 120 },
  },
  {
    id: 'room-catalog',
    name: 'Book Catalog & Inventory',
    layer: 'core',
    status: 'verified',
    description: 'PostgreSQL schema, ISBN indexing, search cache, and stock tracking.',
    evidence: 'Sample: Schema migrations verified. 24 unit tests passing.',
    metrics: { testsPassed: 24, totalTests: 24, filesCount: 12 },
    coords: { isoX: -170, isoY: -130, width: 160, height: 80, depth: 120 },
  },
  {
    id: 'room-checkout',
    name: 'Cart & Stripe Checkout',
    layer: 'service',
    status: 'in_progress',
    description: 'Cart persistence, Stripe webhook handling, discount code calculations.',
    evidence: 'Sample: Stripe webhook signature check failing in mock environment. In-flight work.',
    metrics: { testsPassed: 7, totalTests: 12, filesCount: 8 },
    coords: { isoX: 10, isoY: 10, width: 160, height: 80, depth: 120 },
  },
  {
    id: 'room-recommendations',
    name: 'AI Recommendations',
    layer: 'gateway',
    status: 'planned',
    description: 'Vector embeddings and reader affinity clustering.',
    evidence: 'Sample: Architecture specification present in docs, but 0 implementation files exist.',
    metrics: { testsPassed: 0, totalTests: 0, filesCount: 0 },
    coords: { isoX: 10, isoY: -130, width: 160, height: 80, depth: 120 },
  },
];
