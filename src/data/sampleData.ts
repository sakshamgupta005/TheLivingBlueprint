import type { ArchitecturalRoom, ChatMessagePreview } from '../types.ts';

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

export const PREVIEW_CHAT_MESSAGES: ChatMessagePreview[] = [
  {
    id: 'msg-1',
    sender: 'dog',
    speakerName: 'Barkley',
    tagline: 'Friendly · Energetic · Helpful',
    content: "Hi there! I'm Barkley! I've laid out the foundation pillars and the BookNook catalog rooms. We've got 42 tests passing across Auth and Catalog! Ready whenever you want to dig into the next piece!",
    timestamp: 'Preview · Offline',
  },
  {
    id: 'msg-2',
    sender: 'cat',
    speakerName: 'Cleo',
    tagline: 'Sassy · Observant · Skeptical',
    content: "Hold your excitement, dog. Look at the Cart & Checkout room: 5 tests are red, Stripe webhooks are unhandled, and your 'AI Recommendations' is just an empty markdown file. Code isn't complete until the evidence backs it.",
    timestamp: 'Preview · Offline',
  },
];
