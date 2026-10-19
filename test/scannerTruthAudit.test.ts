import { describe, it } from 'node:test';
import assert from 'node:assert';
import { scanGitHubRepository } from '../src/domain/github/scanner.ts';
import { mapScanResultToHouse } from '../src/domain/github/architectureMapper.ts';
import {
  allBenchmarkFixtures,
  createFixtureScannerFetch,
  docHeavyFixture,
  jsApiFixture,
  monorepoFixture,
  pyBackendFixture,
  tsFrontendFixture,
  unsupportedFixture,
} from './fixtures/index.ts';

describe('T22: Scanner Truth Audit and Benchmark Fixtures', () => {
  describe('1. Small JavaScript API Fixture (Express + SQLite + Auth)', () => {
    it('discovers facts, maps to sensible rooms, and cites correct paths', async () => {
      const mockFetch = createFixtureScannerFetch(jsApiFixture);
      const result = await scanGitHubRepository(
        `https://github.com/${jsApiFixture.owner}/${jsApiFixture.repo}`,
        { fetchFn: mockFetch }
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.owner, jsApiFixture.owner);
      assert.strictEqual(result.repo, jsApiFixture.repo);

      // Verify discovered vs inspected separation
      assert.strictEqual(result.totalFilesDiscovered, Object.keys(jsApiFixture.files).length);
      assert.ok(result.inspectedFiles.length > 0);
      assert.ok(result.inspectedFiles.length <= result.totalFilesDiscovered);

      // Verify technologies detected
      assert.ok(result.detectedTechnologies.includes('JavaScript'));
      assert.ok(result.detectedTechnologies.includes('GitHub Actions'));

      // Map to House Architecture
      const house = mapScanResultToHouse(result);
      const roomIds = house.rooms.map((r) => r.id);

      // Known facts: expected rooms
      assert.ok(roomIds.includes('room-server'), 'Must create HTTP Server & API Routing room');
      assert.ok(roomIds.includes('room-database'), 'Must create Data Persistence & Storage room');
      assert.ok(roomIds.includes('room-auth'), 'Must create Authentication & Access Control room');
      assert.ok(roomIds.includes('room-tests'), 'Must create Automated Tests & Quality room');

      // Verify file citations
      const serverRoom = house.rooms.find((r) => r.id === 'room-server')!;
      assert.ok(serverRoom.filePaths.some((p) => p.includes('server.js') || p.includes('routes/tasks.js')));

      const dbRoom = house.rooms.find((r) => r.id === 'room-database')!;
      assert.ok(dbRoom.filePaths.includes('src/db/database.js'));

      const authRoom = house.rooms.find((r) => r.id === 'room-auth')!;
      assert.ok(authRoom.filePaths.includes('src/middleware/auth.js'));

      const testRoom = house.rooms.find((r) => r.id === 'room-tests')!;
      assert.ok(testRoom.filePaths.includes('test/tasks.test.js'));

      // Verified status because CI check run passed for commit
      assert.strictEqual(testRoom.status, 'verified');
      assert.strictEqual(testRoom.metrics.ciStatus, 'passing');

      // Inter-module relationships
      assert.ok(serverRoom.dependencies.includes('Data Persistence & Storage') || serverRoom.dependencies.includes('room-database'));
      assert.ok(serverRoom.dependencies.includes('Authentication & Access Control') || serverRoom.dependencies.includes('room-auth'));
    });
  });

  describe('2. TypeScript Frontend Fixture (React + Vite + Vitest)', () => {
    it('discovers frontend structure, maps to UI and test rooms, and cites components', async () => {
      const mockFetch = createFixtureScannerFetch(tsFrontendFixture);
      const result = await scanGitHubRepository(
        `https://github.com/${tsFrontendFixture.owner}/${tsFrontendFixture.repo}`,
        { fetchFn: mockFetch }
      );

      assert.strictEqual(result.success, true);
      assert.ok(result.detectedTechnologies.includes('TypeScript'));
      assert.ok(result.detectedTechnologies.includes('React'));
      assert.ok(result.detectedTechnologies.includes('Vite'));
      assert.ok(result.detectedTechnologies.includes('Vitest'));

      const house = mapScanResultToHouse(result);
      const roomIds = house.rooms.map((r) => r.id);

      assert.ok(roomIds.includes('room-ui'), 'Must map UI components to room-ui');
      assert.ok(roomIds.includes('room-tests'), 'Must map vitest test to room-tests');

      const uiRoom = house.rooms.find((r) => r.id === 'room-ui')!;
      assert.ok(uiRoom.filePaths.some((p) => p.includes('App.tsx') || p.includes('Header.tsx')));

      // Test room cites test/App.test.tsx
      const testRoom = house.rooms.find((r) => r.id === 'room-tests')!;
      assert.ok(testRoom.filePaths.includes('test/App.test.tsx'));
      assert.strictEqual(testRoom.status, 'verified');

      // UI room should not falsely claim to be a server
      assert.strictEqual(uiRoom.layer, 'service');
    });
  });

  describe('3. Python Backend Fixture (FastAPI + Pydantic + SQLAlchemy)', () => {
    it('discovers Python frameworks, validation schemas, and database layer', async () => {
      const mockFetch = createFixtureScannerFetch(pyBackendFixture);
      const result = await scanGitHubRepository(
        `https://github.com/${pyBackendFixture.owner}/${pyBackendFixture.repo}`,
        { fetchFn: mockFetch }
      );

      assert.strictEqual(result.success, true);
      assert.ok(result.detectedTechnologies.includes('Python'));
      assert.ok(result.detectedTechnologies.includes('FastAPI'));
      assert.ok(result.detectedTechnologies.includes('Pytest'));
      assert.ok(result.detectedTechnologies.includes('PostgreSQL / SQL'));

      const house = mapScanResultToHouse(result);
      const roomIds = house.rooms.map((r) => r.id);

      assert.ok(roomIds.includes('room-server'), 'Must create server room for FastAPI endpoints');
      assert.ok(roomIds.includes('room-validation'), 'Must create validation room for Pydantic schemas');
      assert.ok(roomIds.includes('room-database'), 'Must create database room for SQLAlchemy');
      assert.ok(roomIds.includes('room-tests'), 'Must create tests room for pytest suite');

      const serverRoom = house.rooms.find((r) => r.id === 'room-server')!;
      assert.ok(serverRoom.filePaths.some((p) => p.includes('app/main.py') || p.includes('app/api/endpoints.py')));

      const valRoom = house.rooms.find((r) => r.id === 'room-validation')!;
      assert.ok(valRoom.filePaths.includes('app/models/schemas.py'));

      const dbRoom = house.rooms.find((r) => r.id === 'room-database')!;
      assert.ok(dbRoom.filePaths.includes('app/database.py'));

      const testRoom = house.rooms.find((r) => r.id === 'room-tests')!;
      assert.ok(testRoom.filePaths.includes('tests/test_api.py'));
    });
  });

  describe('4. Monorepo Fixture (Multi-Package Workspaces)', () => {
    it('discovers all workspace manifests and prevents lump-package room collapse', async () => {
      const mockFetch = createFixtureScannerFetch(monorepoFixture);
      const result = await scanGitHubRepository(
        `https://github.com/${monorepoFixture.owner}/${monorepoFixture.repo}`,
        { fetchFn: mockFetch }
      );

      assert.strictEqual(result.success, true);

      // Verify all package manifests discovered across git tree
      assert.ok(result.detectedManifests.includes('package.json'));
      assert.ok(result.detectedManifests.includes('packages/api/package.json'));
      assert.ok(result.detectedManifests.includes('packages/web/package.json'));
      assert.ok(result.detectedManifests.includes('packages/shared/package.json'));

      const house = mapScanResultToHouse(result);
      const roomIds = house.rooms.map((r) => r.id);

      assert.ok(roomIds.includes('room-server'));
      assert.ok(roomIds.includes('room-ui'));
      assert.ok(roomIds.includes('room-tests'));

      // Ensure domain folders extract package domains rather than generic 'packages'
      assert.ok(!roomIds.includes('room-packages'), 'Should not collapse all packages into room-packages');

      const testRoom = house.rooms.find((r) => r.id === 'room-tests')!;
      assert.ok(
        testRoom.filePaths.includes('packages/api/test/users.test.ts') ||
          testRoom.filePaths.includes('packages/web/test/App.test.tsx')
      );
    });
  });

  describe('5. Documentation & Generated-Heavy Fixture', () => {
    it('skips build artifacts, falls back cleanly to room-core, and reports accurate paths', async () => {
      const mockFetch = createFixtureScannerFetch(docHeavyFixture);
      const result = await scanGitHubRepository(
        `https://github.com/${docHeavyFixture.owner}/${docHeavyFixture.repo}`,
        { fetchFn: mockFetch }
      );

      assert.strictEqual(result.success, true);

      // Verify ignored files: dist, coverage, package-lock
      assert.ok(result.skippedFiles.some((s) => s.path.includes('dist/') && s.reason === 'ignored_directory'));
      assert.ok(result.skippedFiles.some((s) => s.path.includes('coverage/') && s.reason === 'ignored_directory'));
      assert.ok(result.skippedFiles.some((s) => s.path === 'package-lock.json' && s.reason === 'lockfile'));

      const house = mapScanResultToHouse(result);

      // Gracefully defaults to application core without inventing fake servers or databases
      assert.strictEqual(house.rooms.length, 1);
      assert.strictEqual(house.rooms[0].id, 'room-core');
      assert.strictEqual(house.rooms[0].name, 'Application Core');
      assert.ok(house.rooms[0].filePaths.length > 0, 'Must cite the discovered entry file in filePaths');
      assert.strictEqual(house.rooms[0].metrics.filesCount, house.rooms[0].filePaths.length);
      assert.strictEqual(house.rooms[0].status, 'implemented');
    });
  });

  describe('6. Partially Unsupported Project Fixture (Fortran + Malformed Manifest)', () => {
    it('records parse failures, skips binary assets, and marks partial status honestly', async () => {
      const mockFetch = createFixtureScannerFetch(unsupportedFixture);
      const result = await scanGitHubRepository(
        `https://github.com/${unsupportedFixture.owner}/${unsupportedFixture.repo}`,
        { fetchFn: mockFetch }
      );

      assert.strictEqual(result.success, true);
      // Status must be partial due to parse failure
      assert.strictEqual(result.status, 'partial');

      // Verify binary asset skipped
      assert.ok(result.skippedFiles.some((s) => s.path === 'assets/data.bin' && s.reason === 'binary_asset'));

      // Verify parse failures recorded separately
      assert.ok(result.parseFailures && result.parseFailures.length > 0);
      assert.strictEqual(result.parseFailures[0].path, 'package.json');
      assert.ok(result.warnings.some((w) => /Manifest parse failure/i.test(w)));

      const house = mapScanResultToHouse(result);
      assert.ok(house.rooms.length > 0);
      assert.strictEqual(house.rooms[0].id, 'room-core');
    });
  });

  describe('7. Truth Audit: Discovered vs Inspected vs Skipped Separation', () => {
    it('never reports discovered files as inspected across any benchmark fixture', async () => {
      for (const fixture of allBenchmarkFixtures) {
        const mockFetch = createFixtureScannerFetch(fixture);
        const result = await scanGitHubRepository(
          `https://github.com/${fixture.owner}/${fixture.repo}`,
          { fetchFn: mockFetch }
        );

        // 1. Separate accounting
        assert.ok(typeof result.totalFilesDiscovered === 'number', `${fixture.name}: discovered files must be number`);
        assert.ok(Array.isArray(result.discoveredFilePaths), `${fixture.name}: discoveredFilePaths must be array`);
        assert.ok(Array.isArray(result.inspectedFiles), `${fixture.name}: inspectedFiles must be array`);
        assert.ok(Array.isArray(result.skippedFiles), `${fixture.name}: skippedFiles must be array`);
        assert.ok(typeof result.durationMs === 'number' && result.durationMs >= 0, `${fixture.name}: durationMs must be non-negative`);
        assert.ok(Array.isArray(result.parseFailures), `${fixture.name}: parseFailures must be array`);
        assert.ok(result.evidenceCoverage, `${fixture.name}: evidenceCoverage must be defined`);

        // 2. Coverage calculation integrity
        assert.strictEqual(result.evidenceCoverage!.discoveredCount, result.totalFilesDiscovered);
        assert.strictEqual(result.evidenceCoverage!.inspectedCount, result.inspectedFiles.length);
        assert.strictEqual(result.evidenceCoverage!.skippedCount, result.skippedFiles.length);

        // 3. Strict truth: No inspected file can be absent from inspectedFiles array
        const inspectedPaths = new Set(result.inspectedFiles.map((f) => f.path));

        const house = mapScanResultToHouse(result);
        for (const room of house.rooms) {
          // Room filePaths must ONLY contain files that were actually inspected
          for (const fp of room.filePaths) {
            assert.ok(
              inspectedPaths.has(fp),
              `${fixture.name} Room ${room.id} cited "${fp}" which was NEVER inspected!`
            );
          }

          // Room metrics filesCount must equal the room's actual filePaths.length
          assert.strictEqual(
            room.metrics.filesCount,
            room.filePaths.length,
            `${fixture.name} Room ${room.id} claimed filesCount ${room.metrics.filesCount} but has ${room.filePaths.length} filePaths!`
          );
        }
      }
    });

    it('clearly reports facts it cannot establish without fabricating claims', async () => {
      const mockFetch = createFixtureScannerFetch(jsApiFixture);
      const result = await scanGitHubRepository(
        `https://github.com/${jsApiFixture.owner}/${jsApiFixture.repo}`,
        { fetchFn: mockFetch }
      );
      const house = mapScanResultToHouse(result);

      // Verify that rooms without verification evidence are never claimed as verified
      const serverRoom = house.rooms.find((r) => r.id === 'room-server')!;
      assert.strictEqual(serverRoom.status, 'implemented');
      assert.notStrictEqual(serverRoom.status, 'verified');

      const dbRoom = house.rooms.find((r) => r.id === 'room-database')!;
      assert.strictEqual(dbRoom.status, 'implemented');
      assert.notStrictEqual(dbRoom.status, 'verified');

      const authRoom = house.rooms.find((r) => r.id === 'room-auth')!;
      assert.strictEqual(authRoom.status, 'implemented');
      assert.notStrictEqual(authRoom.status, 'verified');
    });
  });
});
