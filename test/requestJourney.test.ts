import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildCodeIndex } from '../src/domain/codeIndex/indexer.ts';
import {
  detectEntryPoints,
  traceRequestJourney,
  exploreJourneyStep,
} from '../src/domain/journey/index.ts';
import { jsApiFixture } from './fixtures/jsApiFixture.ts';
import { docHeavyFixture } from './fixtures/docHeavyFixture.ts';
import { pyBackendFixture } from './fixtures/pyBackendFixture.ts';

describe('T28: Request Journey and Call-Sequence Diagrams', () => {
  it('1. Detects recognizable entry points across Express, FastAPI, and Next.js', () => {
    // 1a. Express routes from jsApiFixture
    const jsIndex = buildCodeIndex({
      files: jsApiFixture.files,
      repositorySha: jsApiFixture.commitSha,
    });
    const expressEntries = detectEntryPoints(jsIndex);

    assert.ok(expressEntries.length >= 2, 'Should detect Express routes');
    assert.ok(
      expressEntries.some((e) => e.method === 'GET' && e.routePath.includes('health')),
      'Should detect GET /health'
    );
    assert.ok(
      expressEntries.some((e) => e.routePath.includes('/') || e.routePath.includes('tasks')),
      'Should detect task routes'
    );

    // 1b. FastAPI routes from pyBackendFixture
    const pyIndex = buildCodeIndex({
      files: pyBackendFixture.files,
      repositorySha: pyBackendFixture.commitSha,
    });
    const fastApiEntries = detectEntryPoints(pyIndex);

    assert.ok(fastApiEntries.length >= 1, 'Should detect FastAPI/Flask routes');
    assert.ok(
      fastApiEntries.some((e) => e.framework === 'fastapi' || e.framework === 'flask'),
      'Should tag framework as fastapi/flask'
    );

    // 1c. Next.js App Router route handlers
    const nextFiles = {
      'src/app/api/users/route.ts': `
        export async function GET(request: Request) {
          return Response.json({ users: [] });
        }
        export async function POST(request: Request) {
          const body = await request.json();
          return Response.json({ success: true });
        }
      `,
    };
    const nextIndex = buildCodeIndex({ files: nextFiles });
    const nextEntries = detectEntryPoints(nextIndex);

    assert.ok(nextEntries.length >= 2, 'Should detect Next.js GET and POST route handlers');
    assert.ok(
      nextEntries.some((e) => e.framework === 'nextjs' && e.method === 'GET'),
      'Should tag Next.js GET'
    );
    assert.ok(
      nextEntries.some((e) => e.framework === 'nextjs' && e.method === 'POST'),
      'Should tag Next.js POST'
    );
  });

  it('2. Traces a simple API request with participants, ordered calls, and response path', () => {
    const files = {
      'src/server.ts': `
        import express from 'express';
        const app = express();

        app.get('/api/health', (req, res) => {
          res.json({ status: 'ok', uptime: 100 });
        });
      `,
    };

    const codeIndex = buildCodeIndex({ files });
    const journey = traceRequestJourney({
      codeIndex,
      fileContents: files,
      startRoutePath: '/api/health',
    });

    assert.strictEqual(journey.traceKind, 'statically_reconstructed', 'Must be statically reconstructed');
    assert.strictEqual(journey.isComplete, true, 'Simple health route should be complete');
    assert.strictEqual(journey.unresolvedLinksCount, 0, 'No unresolved links');

    // Check participants: Client, Entry Route, Handler
    assert.ok(journey.participants.some((p) => p.kind === 'client'), 'Client participant');
    assert.ok(journey.participants.some((p) => p.kind === 'entry_route'), 'Entry route participant');
    assert.ok(journey.participants.some((p) => p.kind === 'handler'), 'Handler participant');

    // Ordered sequence
    assert.ok(journey.steps.length >= 3, 'Should have call and response steps');
    assert.strictEqual(journey.steps[0].type, 'call', 'First step is client HTTP call');
    assert.strictEqual(journey.steps[0].order, 1, 'First step has order 1');

    const responseStep = journey.steps.find((s) => s.type === 'response_send');
    assert.ok(responseStep, 'Should find response_send step');
    assert.strictEqual(responseStep?.confidence, 'directly_observed', 'Response call is directly observed in AST');
    assert.ok(responseStep?.filePath?.includes('server.ts'), 'Source link included');
  });

  it('3. Traces nested calls across handler, service, and storage with return paths', () => {
    const files = {
      'src/routes/tasks.ts': `
        import express from 'express';
        import { TaskService } from '../services/taskService';
        const router = express.Router();

        router.get('/tasks', async (req, res) => {
          const service = new TaskService();
          const items = await service.fetchAllTasks();
          res.json({ tasks: items });
        });
      `,
      'src/services/taskService.ts': `
        import { getDatabase } from '../db/database';

        export class TaskService {
          async fetchAllTasks() {
            const db = getDatabase();
            return db.query('SELECT * FROM tasks');
          }
        }
      `,
      'src/db/database.ts': `
        export function getDatabase() {
          return {
            query: (sql: string) => []
          };
        }
      `,
    };

    const codeIndex = buildCodeIndex({ files });
    const journey = traceRequestJourney({
      codeIndex,
      fileContents: files,
      startRoutePath: '/tasks',
    });

    assert.ok(journey.participants.length >= 3, 'Should have client, route/handler, service/db participants');
    assert.ok(journey.steps.some((s) => s.type === 'return'), 'Must include return paths');

    // Verify stats
    assert.ok(journey.stats.callsCount >= 1, 'Records calls');
    assert.ok(journey.stats.returnsCount >= 1, 'Records return paths');
    assert.strictEqual(journey.traceKind, 'statically_reconstructed');
  });

  it('4. Traces error handling and error branches (try/catch and guard conditions)', () => {
    const files = {
      'src/routes/order.ts': `
        import express from 'express';
        const router = express.Router();

        router.post('/orders', (req, res) => {
          try {
            const { itemId, amount } = req.body;
            if (!itemId) {
              return res.status(400).json({ error: 'itemId required' });
            }
            res.status(201).json({ id: 101, itemId, amount });
          } catch (err) {
            res.status(500).json({ error: 'internal_error' });
          }
        });
      `,
    };

    const codeIndex = buildCodeIndex({ files });
    const journey = traceRequestJourney({
      codeIndex,
      fileContents: files,
      startRoutePath: '/orders',
    });

    assert.ok(journey.stats.errorBranchesCount >= 1, 'Should record error branches');
    const errorSteps = journey.steps.filter((s) => s.type === 'error_branch' || s.isError);
    assert.ok(errorSteps.length >= 1, 'Must have at least one error branch step');
    assert.ok(
      errorSteps.some((s) => s.label.includes('400') || s.label.includes('Catch') || s.label.includes('Error')),
      'Labels error branch outcome accurately'
    );
  });

  it('5. Flags unresolved calls and renders partial trace with explicit unresolved reason', () => {
    const files = {
      'src/routes/payment.ts': `
        import express from 'express';
        // External third-party payment SDK not in repository
        import Stripe from 'stripe';
        const router = express.Router();

        router.post('/charge', async (req, res) => {
          const client = new Stripe('test_key');
          const result = await client.charges.create({ amount: 2000 });
          res.json(result);
        });
      `,
    };

    const codeIndex = buildCodeIndex({ files });
    const journey = traceRequestJourney({
      codeIndex,
      fileContents: files,
      startRoutePath: '/charge',
    });

    assert.strictEqual(journey.isComplete, false, 'Should be marked as incomplete due to external call');
    assert.ok(journey.unresolvedLinksCount > 0, 'Should record unresolved links');

    const unresolvedPart = journey.participants.find((p) => p.kind === 'unresolved');
    assert.ok(unresolvedPart, 'Should identify unresolved participant');
    assert.ok(unresolvedPart?.unresolvedReason, 'Should provide explicit unresolvedReason');

    const unresolvedStep = journey.steps.find((s) => s.type === 'unresolved_call');
    assert.ok(unresolvedStep, 'Should render unresolved_call step in sequence');
    assert.strictEqual(unresolvedStep?.confidence, 'unresolved', 'Confidence is marked unresolved');
  });

  it('6. Supports forward and backward exploration from a participant', () => {
    const files = {
      'src/routes/items.ts': `
        import express from 'express';
        import { computeDiscount } from '../services/pricing';
        const router = express.Router();

        router.get('/items', (req, res) => {
          const discount = computeDiscount(100);
          res.json({ discount });
        });
      `,
      'src/services/pricing.ts': `
        export function computeDiscount(price: number) {
          return price * 0.9;
        }
      `,
    };

    const codeIndex = buildCodeIndex({ files });
    const journey = traceRequestJourney({
      codeIndex,
      fileContents: files,
      startRoutePath: '/items',
    });

    // Find handler participant
    const handler = journey.participants.find((p) => p.kind === 'handler');
    assert.ok(handler, 'Handler exists');

    // Explore forward
    const forwardResult = exploreJourneyStep(journey, {
      direction: 'forward',
      participantId: handler.id,
      codeIndex,
      fileContents: files,
    });

    assert.strictEqual(forwardResult.success, true);
    assert.ok(forwardResult.discoveredSymbols.length > 0, 'Discovers computeDiscount call');

    // Explore backward on pricing service
    const servicePart = journey.participants.find((p) => p.label.includes('computeDiscount'));
    if (servicePart) {
      const backwardResult = exploreJourneyStep(journey, {
        direction: 'backward',
        participantId: servicePart.id,
        codeIndex,
        fileContents: files,
      });
      assert.strictEqual(backwardResult.success, true);
      assert.ok(backwardResult.discoveredSymbols.some((s) => s.direction === 'called_by'));
    }
  });

  it('7. Handles projects without detectable routes gracefully', () => {
    // docHeavyFixture has only documentation and build artifacts, no routes
    const docIndex = buildCodeIndex({
      files: docHeavyFixture.files,
      repositorySha: docHeavyFixture.commitSha,
    });

    const entries = detectEntryPoints(docIndex);
    assert.strictEqual(entries.length, 0, 'No routes in doc-heavy fixture');

    const journey = traceRequestJourney({
      codeIndex: docIndex,
      fileContents: docHeavyFixture.files,
    });

    assert.strictEqual(journey.isComplete, false);
    assert.strictEqual(journey.entryPoint, null);
    assert.ok(journey.explanation.includes('No recognizable HTTP route handlers'));
    assert.ok(journey.participants.length >= 1, 'Provides client participant at minimum');
  });

  it('8. Distinguishes statically reconstructed path from observed runtime trace (honest reporting)', () => {
    const jsIndex = buildCodeIndex({
      files: jsApiFixture.files,
      repositorySha: jsApiFixture.commitSha,
    });

    const journey = traceRequestJourney({
      codeIndex: jsIndex,
      fileContents: jsApiFixture.files,
    });

    assert.strictEqual(journey.traceKind, 'statically_reconstructed');
    assert.notStrictEqual(journey.traceKind, 'observed_runtime');

    for (const step of journey.steps) {
      assert.ok(
        ['directly_observed', 'statically_reconstructed', 'unresolved'].includes(step.confidence),
        'Each step must have an honest confidence label'
      );
      assert.ok(step.evidence.length > 0, 'Every step must include supporting evidence');
    }
  });
});
