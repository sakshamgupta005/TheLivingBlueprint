import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mapScanResultToHouse } from '../src/domain/github/architectureMapper.ts';
import { SAMPLE_ROOMS, SAMPLE_PROJECT } from '../src/data/sampleData.ts';
import type { GitHubScanResult } from '../src/domain/github/types.ts';

describe('T10A: Repository-Derived Architecture & Interaction', () => {
  it('1. Patchboard produces rooms derived specifically from its source, tests, and CI', () => {
    const patchboardScan: GitHubScanResult = {
      success: true,
      owner: 'sakshamgupta005',
      repo: 'patchboard-tasks-api',
      scannedAt: '2026-10-19T01:00:00Z',
      commitSha: '69420abcdef1234567890',
      totalFilesDiscovered: 8,
      inspectedFiles: [
        {
          path: 'src/server.js',
          sizeBytes: 1200,
          category: 'source',
          contentExcerpt: "const http = require('http'); const { createTask } = require('./tasks/createTask');",
        },
        {
          path: 'src/tasks/createTask.js',
          sizeBytes: 850,
          category: 'source',
          contentExcerpt: "const { validateTask } = require('./validation'); const store = require('./store');",
        },
        {
          path: 'src/tasks/store.js',
          sizeBytes: 600,
          category: 'source',
          contentExcerpt: 'const tasks = []; module.exports = { tasks };',
        },
        {
          path: 'src/tasks/validation.js',
          sizeBytes: 700,
          category: 'source',
          contentExcerpt: 'function validateTask(payload) { if (!payload.title) return false; return true; }',
        },
        {
          path: 'test/createTask.test.js',
          sizeBytes: 950,
          category: 'test',
          contentExcerpt: "const test = require('node:test'); const assert = require('node:assert');",
        },
        {
          path: 'test/getTasks.test.js',
          sizeBytes: 900,
          category: 'test',
          contentExcerpt: "const test = require('node:test'); const assert = require('node:assert');",
        },
        {
          path: '.github/workflows/ci.yml',
          sizeBytes: 400,
          category: 'config',
          contentExcerpt: 'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest',
        },
        {
          path: 'package.json',
          sizeBytes: 300,
          category: 'manifest',
          contentExcerpt: '{"name": "patchboard-tasks-api", "version": "1.0.0"}',
        },
      ],
      discoveredFilePaths: [
        'src/server.js',
        'src/tasks/createTask.js',
        'src/tasks/store.js',
        'src/tasks/validation.js',
        'test/createTask.test.js',
        'test/getTasks.test.js',
        '.github/workflows/ci.yml',
        'package.json',
      ],
      detectedTechnologies: ['Node.js', 'JavaScript'],
      warnings: [],
      checkRuns: [
        {
          id: 39160329324,
          name: 'Run Unit and Integration Tests',
          status: 'completed',
          conclusion: 'failure',
          head_sha: '69420abcdef1234567890',
          completed_at: '2026-10-18T19:47:14Z',
          html_url: 'https://github.com/sakshamgupta005/patchboard-tasks-api/actions/runs/39160329324',
          isRelevantTestCheck: true,
          relevanceReason: 'matches test pattern',
        },
      ],
    };

    const house = mapScanResultToHouse(patchboardScan);
    assert.ok(house.rooms.length >= 3);

    const roomIds = house.rooms.map((r) => r.id);
    // Must contain specific modules derived from scan
    assert.ok(roomIds.includes('room-server'), 'Must contain server room');
    assert.ok(roomIds.includes('room-tasks'), 'Must contain tasks domain room');
    assert.ok(roomIds.includes('room-validation'), 'Must contain validation room');
    assert.ok(roomIds.includes('room-tests'), 'Must contain automated tests room');

    // Must NOT contain unevidenced rooms from generic templates
    assert.strictEqual(roomIds.includes('room-auth'), false, 'Must NOT contain auth room');
    assert.strictEqual(roomIds.includes('room-database'), false, 'Must NOT contain database room');
    assert.strictEqual(roomIds.includes('room-catalog'), false, 'Must NOT reuse BookNook catalog room');

    // Associated files must match actual scan
    const serverRoom = house.rooms.find((r) => r.id === 'room-server')!;
    assert.ok(serverRoom.filePaths?.includes('src/server.js'));

    const tasksRoom = house.rooms.find((r) => r.id === 'room-tasks')!;
    assert.ok(tasksRoom.filePaths?.includes('src/tasks/createTask.js'));
    assert.ok(tasksRoom.filePaths?.includes('src/tasks/store.js'));

    // Derived dependencies must be supported by real scan imports
    assert.ok(serverRoom.dependencies?.some((d) => /task/i.test(d)));

    // Status engine evaluation for test room with failing CI
    const testRoom = house.rooms.find((r) => r.id === 'room-tests')!;
    assert.strictEqual(testRoom.status, 'blocked');
    assert.strictEqual(testRoom.metrics.ciStatus, 'failing');
  });

  it('2. A structurally different repository produces a completely different room set', () => {
    const frontendScan: GitHubScanResult = {
      success: true,
      owner: 'acme-org',
      repo: 'web-dashboard-ui',
      scannedAt: '2026-10-19T01:00:00Z',
      commitSha: 'fedcba9876543210',
      totalFilesDiscovered: 4,
      inspectedFiles: [
        {
          path: 'src/components/Header.tsx',
          sizeBytes: 800,
          category: 'source',
          contentExcerpt: 'export const Header = () => <header>Dashboard</header>;',
        },
        {
          path: 'src/components/MetricCard.tsx',
          sizeBytes: 600,
          category: 'source',
          contentExcerpt: 'export const MetricCard = () => <div className="card" />;',
        },
        {
          path: 'src/views/AnalyticsView.tsx',
          sizeBytes: 950,
          category: 'source',
          contentExcerpt: 'export const AnalyticsView = () => <div />;',
        },
        {
          path: 'package.json',
          sizeBytes: 250,
          category: 'manifest',
          contentExcerpt: '{"name": "web-dashboard-ui", "dependencies": {"react": "^18.0.0"}}',
        },
      ],
      discoveredFilePaths: [
        'src/components/Header.tsx',
        'src/components/MetricCard.tsx',
        'src/views/AnalyticsView.tsx',
        'package.json',
      ],
      detectedTechnologies: ['React', 'TypeScript'],
      warnings: [],
    };

    const house = mapScanResultToHouse(frontendScan);
    const roomIds = house.rooms.map((r) => r.id);

    // Frontend repo must produce UI module
    assert.ok(roomIds.includes('room-ui'));
    assert.strictEqual(roomIds.includes('room-server'), false);
    assert.strictEqual(roomIds.includes('room-tasks'), false);
    assert.strictEqual(roomIds.includes('room-database'), false);
    assert.strictEqual(roomIds.includes('room-tests'), false); // No test files or CI
  });

  it('3. A repository without authentication code does not acquire a fabricated authentication room', () => {
    const cliScan: GitHubScanResult = {
      success: true,
      owner: 'toolsmith',
      repo: 'file-converter-cli',
      scannedAt: '2026-10-19T01:00:00Z',
      commitSha: '112233445566',
      totalFilesDiscovered: 2,
      inspectedFiles: [
        {
          path: 'src/converter.js',
          sizeBytes: 500,
          category: 'source',
          contentExcerpt: 'function convert(file) { return file.toUpperCase(); }',
        },
        {
          path: 'test/converter.test.js',
          sizeBytes: 300,
          category: 'test',
          contentExcerpt: 'test("converts", () => {});',
        },
      ],
      discoveredFilePaths: ['src/converter.js', 'test/converter.test.js'],
      detectedTechnologies: ['Node.js'],
      warnings: [],
    };

    const house = mapScanResultToHouse(cliScan);
    const roomIds = house.rooms.map((r) => r.id);

    assert.strictEqual(roomIds.includes('room-auth'), false, 'Must NOT invent an authentication room');
    assert.ok(roomIds.includes('room-tests'), 'Must have tests room');
  });

  it('4. Empty or minimal scan does not silently render BookNook sample architecture', () => {
    const emptyScan: GitHubScanResult = {
      success: true,
      owner: 'empty-user',
      repo: 'scratchpad',
      scannedAt: '2026-10-19T01:00:00Z',
      totalFilesDiscovered: 0,
      inspectedFiles: [],
      discoveredFilePaths: [],
      detectedTechnologies: [],
      warnings: ['No architectural source files found'],
    };

    const house = mapScanResultToHouse(emptyScan);
    const roomIds = house.rooms.map((r) => r.id);

    // Must NOT contain BookNook rooms
    assert.strictEqual(roomIds.includes('room-catalog'), false);
    assert.strictEqual(roomIds.includes('room-recommendations'), false);
    assert.strictEqual(roomIds.includes('room-checkout'), false);

    // Honest limited-coverage room
    assert.ok(roomIds.includes('room-core'));
    const coreRoom = house.rooms.find((r) => r.id === 'room-core')!;
    assert.strictEqual(coreRoom.status, 'planned');
  });

  it('5. Each rendered room has unique selectable coordinates without stacking collisions', () => {
    const multiScan: GitHubScanResult = {
      success: true,
      owner: 'fullstack',
      repo: 'ecommerce-api',
      scannedAt: '2026-10-19T01:00:00Z',
      totalFilesDiscovered: 6,
      inspectedFiles: [
        { path: 'src/server.ts', sizeBytes: 100, category: 'source', contentExcerpt: '' },
        { path: 'src/validation.ts', sizeBytes: 100, category: 'source', contentExcerpt: '' },
        { path: 'src/orders/process.ts', sizeBytes: 100, category: 'source', contentExcerpt: '' },
        { path: 'src/auth/jwt.ts', sizeBytes: 100, category: 'source', contentExcerpt: '' },
        { path: 'prisma/schema.prisma', sizeBytes: 100, category: 'source', contentExcerpt: '' },
        { path: 'tests/api.test.ts', sizeBytes: 100, category: 'test', contentExcerpt: '' },
      ],
      discoveredFilePaths: [
        'src/server.ts',
        'src/validation.ts',
        'src/orders/process.ts',
        'src/auth/jwt.ts',
        'prisma/schema.prisma',
        'tests/api.test.ts',
      ],
      detectedTechnologies: ['Node.js', 'TypeScript', 'Prisma'],
      warnings: [],
    };

    const house = mapScanResultToHouse(multiScan);
    assert.strictEqual(house.rooms.length, 6);

    const coordinateKeys = new Set<string>();
    for (const room of house.rooms) {
      assert.ok(room.coords, `Room ${room.id} must have coordinates`);
      const key = `${room.coords.isoX},${room.coords.isoY}`;
      assert.strictEqual(
        coordinateKeys.has(key),
        false,
        `Duplicate coordinates detected for room ${room.id} at ${key}`
      );
      coordinateKeys.add(key);
    }
  });

  it('6. BookNook fallback remains explicitly labelled and does not contaminate scans', () => {
    assert.strictEqual(SAMPLE_PROJECT.name, 'BookNook');
    assert.strictEqual(SAMPLE_ROOMS.length, 4);

    const sampleIds = SAMPLE_ROOMS.map((r) => r.id);
    assert.strictEqual(sampleIds.length, 4);
    assert.ok(sampleIds.includes('room-catalog'));
    assert.ok(sampleIds.includes('room-recommendations'));
    assert.ok(sampleIds.includes('room-auth'));
    assert.ok(sampleIds.includes('room-checkout'));

    // Sample rooms have distinct coordinates on foundation
    const sampleCoords = new Set(SAMPLE_ROOMS.map((r) => `${r.coords.isoX},${r.coords.isoY}`));
    assert.strictEqual(sampleCoords.size, 4);
  });
});
