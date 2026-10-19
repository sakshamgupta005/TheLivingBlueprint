import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  prepareSourceContext,
  buildSystemPrompt,
  scopeRepoContext,
  getFilePriorityScore,
} from '../src/server/contextBuilder.ts';
import { validateWorkflowDiagram } from '../src/domain/workflow/workflowValidator.ts';
import { validateInvestigationFinding } from '../src/domain/investigation/validator.ts';
import type { ChatApiRequest, InvestigateApiRequest } from '../src/server/types.ts';
import { jsApiFixture } from './fixtures/jsApiFixture.ts';

describe('S03 — Scoped Context Packing & Request Payload Reduction', () => {
  // Realistic multi-room repo context fixture
  const multiRoomRepoContext: NonNullable<ChatApiRequest['repoContext']> = {
    owner: 'test-org',
    repo: 'express-commerce',
    branch: 'main',
    commitSha: 'c0ffee1234567890abcdef1234567890abcdef12',
    totalFiles: 35,
    detectedTechnologies: ['TypeScript', 'Express', 'SQLite', 'Jest'],
    roomSummaries: [
      {
        id: 'room-auth',
        name: 'Authentication & Session Boundary',
        layer: 'security',
        status: 'implemented',
        evidence: 'JWT token signing in src/auth/jwt.ts, password hashing with bcrypt, and session middleware in src/auth/session.ts verified against security test suite.',
        filePaths: ['src/auth/jwt.ts', 'src/auth/session.ts'],
        ciStatus: 'passing',
      },
      {
        id: 'room-catalog',
        name: 'Catalog & Product Inventory',
        layer: 'domain',
        status: 'implemented',
        evidence: 'SQLite schema migrations in db/catalog.sql and product repository queries in src/catalog/products.ts with caching.',
        filePaths: ['src/catalog/products.ts', 'src/catalog/categories.ts'],
        ciStatus: 'passing',
      },
      {
        id: 'room-orders',
        name: 'Order Processing & Checkout Pipeline',
        layer: 'domain',
        status: 'blocked',
        evidence: 'Failing checkout transaction retry logic in src/orders/checkout.ts resulting in timeout in test/orders.test.ts.',
        filePaths: ['src/orders/checkout.ts', 'src/orders/payment.ts'],
        ciStatus: 'failing',
      },
      {
        id: 'room-planned-search',
        name: 'Search & Recommendation Engine',
        layer: 'domain',
        status: 'planned',
        evidence: 'Planned Elasticsearch query adapter not yet implemented in repository.',
        filePaths: [],
      },
    ],
    inspectedFiles: [
      {
        path: 'src/auth/jwt.ts',
        category: 'source',
        contentExcerpt: `import jwt from 'jsonwebtoken';\nexport function signAuthToken(payload: object): string {\n  return jwt.sign(payload, process.env.JWT_SECRET || 'dev-secret');\n}\nexport function verifyToken(token: string) {\n  return jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');\n}`,
        sizeBytes: 320,
      },
      {
        path: 'src/auth/session.ts',
        category: 'source',
        contentExcerpt: `export function sessionMiddleware(req: any, res: any, next: any) {\n  const token = req.headers.authorization?.replace('Bearer ', '');\n  if (!token) return res.status(401).json({ error: 'unauthorized' });\n  next();\n}`,
        sizeBytes: 280,
      },
      {
        path: 'test/auth.test.ts',
        category: 'test',
        contentExcerpt: `import { signAuthToken, verifyToken } from '../src/auth/jwt';\ndescribe('Auth Suite', () => {\n  it('verifies valid token', () => {\n    const token = signAuthToken({ sub: 'user_1' });\n    expect(verifyToken(token)).toBeTruthy();\n  });\n});`,
        sizeBytes: 310,
      },
      {
        path: 'src/catalog/products.ts',
        category: 'source',
        contentExcerpt: `export function listProducts() { return [{ id: 'p1', name: 'Book', price: 19.99 }]; }`,
        sizeBytes: 150,
      },
      {
        path: 'src/orders/checkout.ts',
        category: 'source',
        contentExcerpt: `export async function processCheckout(cart: any) { throw new Error('Transaction deadlock'); }`,
        sizeBytes: 180,
      },
      {
        path: 'package.json',
        category: 'manifest',
        contentExcerpt: `{"name":"express-commerce","version":"1.0.0","dependencies":{"express":"^4.18.2","jsonwebtoken":"^9.0.0"}}`,
        sizeBytes: 120,
      },
      {
        path: 'empty.ts',
        category: 'source',
        contentExcerpt: '   ',
        sizeBytes: 3,
      },
    ],
    discoveredFilePaths: [
      'src/auth/jwt.ts',
      'src/auth/session.ts',
      'test/auth.test.ts',
      'src/catalog/products.ts',
      'src/catalog/categories.ts',
      'src/orders/checkout.ts',
      'src/orders/payment.ts',
      'test/orders.test.ts',
      'package.json',
      'tsconfig.json',
      'README.md',
      'Dockerfile',
      '.github/workflows/ci.yml',
      'docs/architecture.md',
      'docs/api-spec.md',
      'scripts/seed.ts',
      'scripts/migrate.ts',
    ],
  };

  describe('1. Room-Focused Context Selection', () => {
    it('prioritizes inspected files and tests belonging to the selected room', () => {
      const prepared = prepareSourceContext({
        inspectedFiles: multiRoomRepoContext.inspectedFiles,
        discoveredFilePaths: multiRoomRepoContext.discoveredFilePaths,
        selectedRoomId: 'room-auth',
        selectedRoomFilePaths: ['src/auth/jwt.ts', 'src/auth/session.ts'],
        dependencies: ['package.json'],
        totalBudgetChars: 16000,
      });

      const paths = prepared.includedFiles.map((f) => f.path);
      assert.ok(paths.includes('src/auth/jwt.ts'), 'Should include room file src/auth/jwt.ts');
      assert.ok(paths.includes('src/auth/session.ts'), 'Should include room file src/auth/session.ts');
      assert.ok(paths.includes('test/auth.test.ts'), 'Should include relevant test/auth.test.ts');
      // Should NOT include unrelated room files
      assert.strictEqual(
        paths.includes('src/catalog/products.ts'),
        false,
        'Should not include unrelated room-catalog file'
      );
      assert.strictEqual(
        paths.includes('src/orders/checkout.ts'),
        false,
        'Should not include unrelated room-orders file'
      );
    });

    it('does not overfill remaining context budget with unrelated files merely to hit character limit', () => {
      const prepared = prepareSourceContext({
        inspectedFiles: multiRoomRepoContext.inspectedFiles,
        discoveredFilePaths: multiRoomRepoContext.discoveredFilePaths,
        selectedRoomId: 'room-auth',
        selectedRoomFilePaths: ['src/auth/jwt.ts', 'src/auth/session.ts'],
        totalBudgetChars: 24000, // Large budget
      });

      // Included files should ONLY be room-auth relevant files (jwt, session, auth.test)
      for (const file of prepared.includedFiles) {
        assert.ok(
          file.path.includes('auth'),
          `Included file ${file.path} should be relevant to room-auth`
        );
      }
    });

    it('gracefully handles planned rooms with zero source files without dumping unrelated code', () => {
      const prepared = prepareSourceContext({
        inspectedFiles: multiRoomRepoContext.inspectedFiles,
        discoveredFilePaths: multiRoomRepoContext.discoveredFilePaths,
        selectedRoomId: 'room-planned-search',
        selectedRoomFilePaths: [],
        totalBudgetChars: 16000,
      });

      // Planned room has no mapped files; falls back to at most 2 top foundation files
      assert.ok(prepared.includedFiles.length <= 2, 'Should bound fallback files to at most 2');
    });
  });

  describe('2. Repository-Wide Context Selection', () => {
    it('preserves multi-room cross-cutting files when no single room is selected', () => {
      const prepared = prepareSourceContext({
        inspectedFiles: multiRoomRepoContext.inspectedFiles,
        discoveredFilePaths: multiRoomRepoContext.discoveredFilePaths,
        totalBudgetChars: 16000,
      });

      const paths = prepared.includedFiles.map((f) => f.path);
      assert.ok(paths.includes('src/auth/jwt.ts'), 'Should include auth file');
      assert.ok(paths.includes('src/catalog/products.ts'), 'Should include catalog file');
      assert.ok(paths.includes('src/orders/checkout.ts'), 'Should include orders file');
    });

    it('buildSystemPrompt formats broad context without blindly filtering to a single room', () => {
      const prompt = buildSystemPrompt({
        message: 'How does this entire application handle data and requests?',
        explanationLevel: 'intermediate',
        repoContext: multiRoomRepoContext,
      });

      assert.ok(prompt.includes('ACTIVE REPOSITORY: test-org/express-commerce'));
      assert.ok(prompt.includes('Authentication & Session Boundary'));
      assert.ok(prompt.includes('Catalog & Product Inventory'));
      assert.ok(prompt.includes('Order Processing & Checkout Pipeline'));
      assert.ok(prompt.includes('src/auth/jwt.ts'));
      assert.ok(prompt.includes('src/catalog/products.ts'));
    });
  });

  describe('3. Concise Room Evidence Formatting', () => {
    it('keeps full evidence for selected room while keeping concise summaries for other rooms in prompt', () => {
      const prompt = buildSystemPrompt({
        message: 'Tell me about the authentication security boundary.',
        selectedRoomId: 'room-auth',
        repoContext: multiRoomRepoContext,
      });

      // Selected room keeps full evidence
      assert.ok(
        prompt.includes('JWT token signing in src/auth/jwt.ts, password hashing with bcrypt'),
        'Selected room should retain full evidence'
      );

      // Non-selected room evidence is shortened (to <= 60 chars)
      assert.ok(
        prompt.includes('Failing checkout transaction retry logic in src/orders/ch...'),
        'Non-selected room evidence should be concise'
      );
    });
  });

  describe('4. Client-to-Server Payload Scoping (scopeRepoContext)', () => {
    it('drops empty files and scopes inspectedFiles and discoveredFilePaths to room context', () => {
      const scoped = scopeRepoContext(multiRoomRepoContext, {
        selectedRoomId: 'room-auth',
        selectedRoomFilePaths: ['src/auth/jwt.ts', 'src/auth/session.ts'],
        dependencies: ['package.json'],
      });

      // 1. Empty file dropped
      assert.strictEqual(
        scoped.inspectedFiles.some((f) => f.path === 'empty.ts'),
        false,
        'Empty files should never be included as inspected'
      );

      // 2. Only room-relevant files retained in inspectedFiles
      const inspectedPaths = scoped.inspectedFiles.map((f) => f.path);
      assert.ok(inspectedPaths.includes('src/auth/jwt.ts'));
      assert.ok(inspectedPaths.includes('src/auth/session.ts'));
      assert.ok(inspectedPaths.includes('test/auth.test.ts'));
      assert.strictEqual(inspectedPaths.includes('src/catalog/products.ts'), false);
      assert.strictEqual(inspectedPaths.includes('src/orders/checkout.ts'), false);

      // 3. Room summaries retain concise evidence for non-focus rooms
      const catalogRoom = scoped.roomSummaries.find((r) => r.id === 'room-catalog');
      assert.ok(catalogRoom);
      assert.ok(catalogRoom.evidence.length <= 60, 'Non-focus room evidence must be concise');

      // 4. All room paths are preserved in discoveredFilePaths for evidence validation
      for (const r of scoped.roomSummaries) {
        for (const p of r.filePaths || []) {
          assert.ok(
            scoped.discoveredFilePaths.includes(p),
            `Room path ${p} must be preserved in discoveredFilePaths`
          );
        }
      }
    });

    it('measures serialized request-body payload reduction in bytes and characters', () => {
      // Simulate raw full client request payload
      const rawRequestBody = JSON.stringify({
        message: 'Explain authentication flow',
        selectedRoomId: 'room-auth',
        explanationLevel: 'intermediate',
        includeDiagram: true,
        repoContext: multiRoomRepoContext,
      });

      // Scoped client request payload
      const scopedRepo = scopeRepoContext(multiRoomRepoContext, {
        selectedRoomId: 'room-auth',
        selectedRoomFilePaths: ['src/auth/jwt.ts', 'src/auth/session.ts'],
        dependencies: ['package.json'],
      });
      const scopedRequestBody = JSON.stringify({
        message: 'Explain authentication flow',
        selectedRoomId: 'room-auth',
        explanationLevel: 'intermediate',
        includeDiagram: true,
        repoContext: scopedRepo,
      });

      const rawBytes = Buffer.byteLength(rawRequestBody, 'utf8');
      const scopedBytes = Buffer.byteLength(scopedRequestBody, 'utf8');
      const reductionBytes = rawBytes - scopedBytes;
      const reductionPct = ((reductionBytes / rawBytes) * 100).toFixed(1);

      assert.ok(
        scopedBytes < rawBytes,
        `Scoped payload (${scopedBytes} B) must be smaller than raw payload (${rawBytes} B)`
      );
      assert.ok(
        reductionBytes > 500,
        `Payload reduction should be substantial (actual reduction: ${reductionBytes} bytes, ${reductionPct}%)`
      );
    });

    it('measures realistic benchmark fixture payload reduction with jsApiFixture', () => {
      // Construct realistic scan context from jsApiFixture
      const files = Object.entries(jsApiFixture.files).map(([path, content]) => ({
        path,
        category: path.includes('test') ? 'test' : path.endsWith('.json') ? 'manifest' : 'source',
        contentExcerpt: content,
        sizeBytes: content.length,
      }));

      const fullFixtureContext: NonNullable<ChatApiRequest['repoContext']> = {
        owner: jsApiFixture.owner,
        repo: jsApiFixture.repo,
        branch: jsApiFixture.defaultBranch,
        commitSha: jsApiFixture.commitSha,
        totalFiles: files.length + 15,
        inspectedFiles: files,
        discoveredFilePaths: [
          ...files.map((f) => f.path),
          'docs/intro.md',
          'docs/tutorial.md',
          'scripts/build.sh',
          '.env.example',
          'LICENSE',
        ],
        detectedTechnologies: ['JavaScript', 'Express', 'SQLite'],
        roomSummaries: [
          {
            id: 'room-routes',
            name: 'API Routes & Middleware',
            status: 'implemented',
            evidence: 'Express routes in src/routes/tasks.js with auth middleware',
            filePaths: ['src/routes/tasks.js', 'src/middleware/auth.js'],
          },
          {
            id: 'room-db',
            name: 'Database Layer',
            status: 'implemented',
            evidence: 'SQLite memory database in src/db/database.js',
            filePaths: ['src/db/database.js'],
          },
        ],
      };

      const rawPayload = JSON.stringify({
        roomId: 'room-routes',
        roomName: 'API Routes & Middleware',
        repoContext: fullFixtureContext,
      });

      const scopedPayload = JSON.stringify({
        roomId: 'room-routes',
        roomName: 'API Routes & Middleware',
        repoContext: scopeRepoContext(fullFixtureContext, {
          selectedRoomId: 'room-routes',
          selectedRoomFilePaths: ['src/routes/tasks.js', 'src/middleware/auth.js'],
        }),
      });

      const rawBytes = Buffer.byteLength(rawPayload, 'utf8');
      const scopedBytes = Buffer.byteLength(scopedPayload, 'utf8');

      assert.ok(scopedBytes < rawBytes);
    });
  });

  describe('5. Grounding & Evidence Validation Integrity', () => {
    it('preserves validateWorkflowDiagram grounding for inspected room files', () => {
      const scopedRepo = scopeRepoContext(multiRoomRepoContext, {
        selectedRoomId: 'room-auth',
        selectedRoomFilePaths: ['src/auth/jwt.ts', 'src/auth/session.ts'],
      });

      const candidateDiagram = {
        title: 'Authentication Step',
        explanation: 'Tokens signed and verified in room-auth',
        nodes: [
          {
            id: 'node-client',
            label: 'Client HTTP Request',
            type: 'step',
            role: 'Client Request',
            roomId: 'room-auth',
            filePath: 'src/auth/session.ts',
          },
          {
            id: 'node-jwt',
            label: 'Sign JWT Token',
            type: 'component',
            role: 'Token Generator',
            roomId: 'room-auth',
            filePath: 'src/auth/jwt.ts',
          },
        ],
        edges: [
          {
            id: 'e1',
            from: 'node-client',
            to: 'node-jwt',
            label: 'passes credentials',
          },
        ],
      };

      const validated = validateWorkflowDiagram(candidateDiagram, scopedRepo);
      assert.ok(validated !== null);
      assert.strictEqual(validated.nodes.length, 2);
      assert.strictEqual(validated.nodes[0].filePath, 'src/auth/session.ts');
      assert.strictEqual(validated.nodes[1].filePath, 'src/auth/jwt.ts');
    });

    it('preserves validateInvestigationFinding with accurate inspected vs uninspected status', () => {
      const scopedRepo = scopeRepoContext(multiRoomRepoContext, {
        selectedRoomId: 'room-auth',
        selectedRoomFilePaths: ['src/auth/jwt.ts', 'src/auth/session.ts'],
      });

      const mockRequest: InvestigateApiRequest = {
        roomId: 'room-auth',
        roomName: 'Authentication & Session Boundary',
        roomStatus: 'implemented',
        roomEvidence: 'JWT token signing verified',
        roomFilePaths: ['src/auth/jwt.ts', 'src/auth/session.ts'],
        repoContext: scopedRepo,
      };

      const rawFinding = {
        title: 'Auth Verification',
        explanation: 'JWT token validation is implemented with test coverage.',
        category: 'security_risk',
        severity: 'low',
        evidenceClassification: 'observed',
        evidencePaths: ['src/auth/jwt.ts', 'src/catalog/products.ts'],
      };

      const validated = validateInvestigationFinding(rawFinding, mockRequest);
      assert.strictEqual(validated.evidenceReferences.length, 2);

      const jwtRef = validated.evidenceReferences.find((p) => p.path === 'src/auth/jwt.ts');
      assert.ok(jwtRef);
      assert.strictEqual(jwtRef.isInspected, true, 'Room file must be marked as inspected');

      const catalogRef = validated.evidenceReferences.find((p) => p.path === 'src/catalog/products.ts');
      assert.ok(catalogRef);
      // Catalog was not in scoped inspectedFiles, but in discoveredFilePaths
      assert.strictEqual(
        catalogRef.isInspected,
        false,
        'Non-room file must not be falsely claimed as inspected when omitted from payload'
      );
    });
  });

  describe('6. Safe Limits & Missing/Oversized Input Handling', () => {
    it('gracefully handles missing repoContext and undefined fields', () => {
      const scoped = scopeRepoContext(undefined as any);
      assert.strictEqual(scoped, undefined);

      const emptyScoped = scopeRepoContext({});
      assert.deepStrictEqual(emptyScoped.inspectedFiles, []);
      assert.deepStrictEqual(emptyScoped.discoveredFilePaths, []);

      const prompt = buildSystemPrompt({
        message: 'Hello',
        explanationLevel: 'beginner',
      });
      assert.ok(prompt.includes('ACTIVE REPOSITORY: None'));
    });

    it('gracefully handles oversized single files within budget limits', () => {
      const hugeFile = {
        path: 'src/huge.ts',
        category: 'source',
        contentExcerpt: 'export const data = [' + '"x",'.repeat(50000) + '];',
        sizeBytes: 250000,
      };

      const prepared = prepareSourceContext({
        inspectedFiles: [hugeFile],
        discoveredFilePaths: ['src/huge.ts'],
        totalBudgetChars: 4000,
        maxPerFileChars: 1500,
      });

      assert.strictEqual(prepared.includedFiles.length, 1);
      assert.ok(
        prepared.includedFiles[0].contentExcerpt.length <= 1500,
        'Oversized file must be capped at maxPerFileChars'
      );
      assert.ok(
        prepared.formattedPromptSection.includes('truncated for context budget'),
        'Must indicate truncation'
      );
    });
  });
});
