import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildCodeIndex,
  detectCircularDependencies,
  normalizeRepoPath,
  resolveRelativeImport,
  resolveAliasImport,
  parseTsConfigPaths,
  TypeScriptJavaScriptAdapter,
  PythonLanguageAdapter,
  FallbackLanguageAdapter,
} from '../src/domain/codeIndex/index.ts';

describe('T24: Real Code Structure and Deterministic Dependency Index', () => {
  describe('1. Relative Imports Resolution', () => {
    it('resolves relative imports across directories with omitted extensions and index files', () => {
      const files: Record<string, string> = {
        'src/controllers/taskController.ts': `
          import { createTask, getTasks } from '../services/taskService';
          import { TaskStore } from '../store';
          export function handleCreate(body: any) {
            return createTask(body);
          }
        `,
        'src/services/taskService.ts': `
          import { Task } from '../models/task';
          export function createTask(t: Task) { return t; }
          export function getTasks() { return []; }
        `,
        'src/models/task.ts': `
          export interface Task { id: string; title: string; }
        `,
        'src/store/index.ts': `
          export class TaskStore {}
        `,
      };

      const index = buildCodeIndex({
        repositorySha: 'commit-test-1',
        files,
      });

      assert.strictEqual(index.repositorySha, 'commit-test-1');
      assert.strictEqual(index.stats.filesIndexed, 4);

      // Verify taskController imports taskService
      const serviceRel = index.relationships.find(
        (r) =>
          r.source.path === 'src/controllers/taskController.ts' &&
          r.target.path === 'src/services/taskService.ts' &&
          r.type === 'imports'
      );
      assert.ok(serviceRel, 'Must establish confirmed import relationship from controller to service');
      assert.strictEqual(serviceRel.provenance, 'syntax');
      assert.strictEqual(serviceRel.confidence, 'confirmed');

      // Verify taskController imports store via index.ts directory import
      const storeRel = index.relationships.find(
        (r) =>
          r.source.path === 'src/controllers/taskController.ts' &&
          r.target.path === 'src/store/index.ts' &&
          r.type === 'imports'
      );
      assert.ok(storeRel, 'Must resolve "../store" to "src/store/index.ts"');
      assert.strictEqual(storeRel.confidence, 'confirmed');

      // Direct syntactic call from handleCreate to createTask
      const callRel = index.relationships.find(
        (r) =>
          r.source.path === 'src/controllers/taskController.ts' &&
          r.source.symbol === 'src/controllers/taskController.ts#handleCreate' &&
          r.target.symbol === 'src/services/taskService.ts#createTask' &&
          r.type === 'calls'
      );
      assert.ok(callRel, 'Must record direct syntactic call to imported createTask function');
      assert.strictEqual(callRel.provenance, 'syntax');
      assert.strictEqual(callRel.confidence, 'confirmed');
    });
  });

  describe('2. Re-Exports and Barrel Files', () => {
    it('accurately resolves named and wildcard re-exports with target provenance', () => {
      const files: Record<string, string> = {
        'src/index.ts': `
          export { add, multiply as mult } from './math/operations';
          export * from './types';
        `,
        'src/math/operations.ts': `
          export function add(a: number, b: number) { return a + b; }
          export function multiply(a: number, b: number) { return a * b; }
        `,
        'src/types.ts': `
          export interface CalculationResult { value: number; }
        `,
      };

      const index = buildCodeIndex({ files });

      // Check re-export records
      const reExports = index.exports.filter((e) => e.isReExport);
      assert.strictEqual(reExports.length, 3);

      const addReExport = reExports.find((e) => e.exportedName === 'add');
      assert.ok(addReExport);
      assert.strictEqual(addReExport.resolvedReExportPath, 'src/math/operations.ts');

      const multReExport = reExports.find((e) => e.exportedName === 'mult');
      assert.ok(multReExport);
      assert.strictEqual(multReExport.localName, 'multiply');
      assert.strictEqual(multReExport.resolvedReExportPath, 'src/math/operations.ts');

      // Re-export relationships
      const reExportRels = index.relationships.filter((r) => r.type === 're_exports');
      assert.ok(reExportRels.some((r) => r.source.path === 'src/index.ts' && r.target.path === 'src/math/operations.ts'));
      assert.ok(reExportRels.some((r) => r.source.path === 'src/index.ts' && r.target.path === 'src/types.ts'));
    });
  });

  describe('3. Circular Dependencies Detection', () => {
    it('detects and canonicalizes circular import cycles without false alarms on DAGs', () => {
      // 1. Cyclic structure: A -> B -> C -> A
      const cyclicFiles: Record<string, string> = {
        'src/a.ts': `import { b } from './b'; export const a = 1;`,
        'src/b.ts': `import { c } from './c'; export const b = 2;`,
        'src/c.ts': `import { a } from './a'; export const c = 3;`,
      };

      const cyclicIndex = buildCodeIndex({ files: cyclicFiles });
      assert.strictEqual(cyclicIndex.circularDependencies.length, 1);
      const cycle = cyclicIndex.circularDependencies[0];
      assert.deepStrictEqual(cycle, ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/a.ts']);
      assert.strictEqual(cyclicIndex.stats.circularDependencyCount, 1);

      // 2. Acyclic DAG structure: X -> Y, X -> Z, Y -> Z (diamond, no cycles)
      const dagFiles: Record<string, string> = {
        'src/x.ts': `import { y } from './y'; import { z } from './z';`,
        'src/y.ts': `import { z } from './z'; export const y = 1;`,
        'src/z.ts': `export const z = 1;`,
      };

      const dagIndex = buildCodeIndex({ files: dagFiles });
      assert.strictEqual(dagIndex.circularDependencies.length, 0);
      assert.strictEqual(dagIndex.stats.circularDependencyCount, 0);
    });
  });

  describe('4. Aliased Imports Resolution (tsconfig / jsconfig)', () => {
    it('resolves tsconfig compilerOptions.paths aliases and reports unresolvable aliases explicitly', () => {
      const tsconfigContent = JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@/*': ['src/*'],
            '@components/*': ['src/components/*'],
          },
        },
      });

      const files: Record<string, string> = {
        'tsconfig.json': tsconfigContent,
        'src/views/Dashboard.tsx': `
          import { Button } from '@components/Button';
          import { formatDate } from '@/utils/date';
          import { GhostWidget } from '@/nonexistent/ghost';
          export function Dashboard() { return null; }
        `,
        'src/components/Button.tsx': `
          export function Button() { return null; }
        `,
        'src/utils/date.ts': `
          export function formatDate(d: Date) { return d.toISOString(); }
        `,
      };

      const index = buildCodeIndex({
        files,
        configFiles: { 'tsconfig.json': tsconfigContent },
      });

      // 1. @components/Button resolves to src/components/Button.tsx
      const btnImport = index.imports.find((i) => i.rawSpecifier === '@components/Button');
      assert.ok(btnImport);
      assert.strictEqual(btnImport.isResolved, true);
      assert.strictEqual(btnImport.resolvedPath, 'src/components/Button.tsx');

      // 2. @/utils/date resolves to src/utils/date.ts
      const dateImport = index.imports.find((i) => i.rawSpecifier === '@/utils/date');
      assert.ok(dateImport);
      assert.strictEqual(dateImport.isResolved, true);
      assert.strictEqual(dateImport.resolvedPath, 'src/utils/date.ts');

      // 3. @/nonexistent/ghost cannot be resolved
      const ghostImport = index.imports.find((i) => i.rawSpecifier === '@/nonexistent/ghost');
      assert.ok(ghostImport);
      assert.strictEqual(ghostImport.isResolved, false);
      assert.strictEqual(ghostImport.isAlias, true);
      assert.strictEqual(ghostImport.unresolvedReason, 'unresolvable_alias');

      // Explicitly recorded in unresolvedImports
      const ghostUnresolved = index.unresolvedImports.find((u) => u.specifier === '@/nonexistent/ghost');
      assert.ok(ghostUnresolved);
      assert.strictEqual(ghostUnresolved.reason, 'unresolvable_alias');
      assert.match(ghostUnresolved.detail, /Configured alias.*did not match/i);
    });
  });

  describe('5. Syntax Errors and Robust Diagnostic Reporting', () => {
    it('captures TypeScript syntax errors with line numbers without crashing the indexer', () => {
      const files: Record<string, string> = {
        'src/broken.ts': `
          export function broken( {
            const x = ;
        `,
        'src/valid.ts': `
          export function valid() { return 42; }
        `,
      };

      const index = buildCodeIndex({ files });

      assert.strictEqual(index.stats.filesIndexed, 2);
      assert.ok(index.stats.syntaxErrorsCount > 0);

      // Verify diagnostics
      const brokenDiags = index.diagnostics.filter((d) => d.path === 'src/broken.ts');
      assert.ok(brokenDiags.length > 0);
      assert.ok(brokenDiags.some((d) => d.severity === 'error'));
      assert.ok(brokenDiags[0].line >= 1);

      // Valid file was still indexed cleanly
      const validSymbol = index.symbols.find((s) => s.path === 'src/valid.ts' && s.name === 'valid');
      assert.ok(validSymbol);
    });
  });

  describe('6. Duplicate Symbol Names and Scoping', () => {
    it('distinguishes duplicate symbol names across different files using distinct scoped IDs', () => {
      const files: Record<string, string> = {
        'src/auth/handler.ts': `
          export function handleRequest() { return 'auth'; }
        `,
        'src/tasks/handler.ts': `
          export function handleRequest() { return 'tasks'; }
        `,
        'src/server.ts': `
          import { handleRequest as handleAuth } from './auth/handler';
          import { handleRequest as handleTasks } from './tasks/handler';
          export function startServer() {
            handleAuth();
            handleTasks();
          }
        `,
      };

      const index = buildCodeIndex({ files });

      // Two symbols with identical name 'handleRequest'
      const handlers = index.symbols.filter((s) => s.name === 'handleRequest');
      assert.strictEqual(handlers.length, 2);

      const authHandler = handlers.find((h) => h.path === 'src/auth/handler.ts');
      const taskHandler = handlers.find((h) => h.path === 'src/tasks/handler.ts');
      assert.ok(authHandler);
      assert.ok(taskHandler);
      assert.notStrictEqual(authHandler.id, taskHandler.id);
      assert.strictEqual(authHandler.id, 'src/auth/handler.ts#handleRequest');
      assert.strictEqual(taskHandler.id, 'src/tasks/handler.ts#handleRequest');

      // Calls in server.ts must link to the respective distinct symbol IDs
      const authCall = index.relationships.find(
        (r) =>
          r.source.path === 'src/server.ts' &&
          r.target.symbol === 'src/auth/handler.ts#handleRequest' &&
          r.type === 'calls'
      );
      assert.ok(authCall, 'Must link handleAuth() call to src/auth/handler.ts#handleRequest');

      const taskCall = index.relationships.find(
        (r) =>
          r.source.path === 'src/server.ts' &&
          r.target.symbol === 'src/tasks/handler.ts#handleRequest' &&
          r.type === 'calls'
      );
      assert.ok(taskCall, 'Must link handleTasks() call to src/tasks/handler.ts#handleRequest');
    });
  });

  describe('7. Unresolved Calls & No Heuristic Fabrication', () => {
    it('never invents confirmed relationships between files merely sharing similar names', () => {
      const files: Record<string, string> = {
        // Files with similar names but NO syntactic imports or calls between them
        'src/billing/userBilling.ts': `
          export function processBilling() {
            doInternalMath();
          }
          function doInternalMath() {}
        `,
        'src/services/userService.ts': `
          export function fetchUser() {
            return { id: 1 };
          }
        `,
      };

      const index = buildCodeIndex({ files });

      // Assert NO relationship exists between userBilling.ts and userService.ts
      const fakeRel = index.relationships.find(
        (r) =>
          (r.source.path === 'src/billing/userBilling.ts' && r.target.path === 'src/services/userService.ts') ||
          (r.source.path === 'src/services/userService.ts' && r.target.path === 'src/billing/userBilling.ts')
      );
      assert.strictEqual(fakeRel, undefined, 'Must NEVER fabricate relationship between similarly named files');

      // Local call within userBilling is confirmed
      const localCall = index.relationships.find(
        (r) =>
          r.source.symbol === 'src/billing/userBilling.ts#processBilling' &&
          r.target.symbol === 'src/billing/userBilling.ts#doInternalMath' &&
          r.type === 'calls'
      );
      assert.ok(localCall, 'Local function call is confirmed');
      assert.strictEqual(localCall.provenance, 'syntax');
    });
  });

  describe('8. Multi-Language Adapters & Route Extraction', () => {
    it('honestly reports analysisQuality and extracts routes and imports for Python', () => {
      const files: Record<string, string> = {
        'api/main.py': `
          from fastapi import FastAPI
          from .services.item_service import get_item, create_item

          app = FastAPI()

          @app.get("/items/{item_id}")
          def read_item(item_id: int):
              return get_item(item_id)

          @app.post("/items")
          def add_item(item: dict):
              return create_item(item)
        `,
        'api/services/item_service.py': `
          def get_item(id: int):
              return {"id": id}

          def create_item(data: dict):
              return data
        `,
        'engine/core.go': `
          package engine
          import "fmt"
          func StartEngine() {
              fmt.Println("engine started")
          }
        `,
      };

      const index = buildCodeIndex({ files });

      // Python file analysis quality
      const pySummary = index.files['api/main.py'];
      assert.ok(pySummary);
      assert.strictEqual(pySummary.analysisQuality, 'pattern_ast');
      assert.strictEqual(pySummary.language, 'Python');

      // Go file analysis quality
      const goSummary = index.files['engine/core.go'];
      assert.ok(goSummary);
      assert.strictEqual(goSummary.analysisQuality, 'shallow');
      assert.strictEqual(goSummary.language, 'Go');

      // Python routes extracted
      assert.strictEqual(index.routes.length, 2);
      const getRoute = index.routes.find((r) => r.method === 'GET' && r.routePath === '/items/{item_id}');
      assert.ok(getRoute);
      assert.strictEqual(getRoute.handlerSymbol, 'api/main.py#read_item');
      assert.strictEqual(getRoute.framework, 'fastapi');

      // Python relative import resolved
      const pyRelativeImport = index.imports.find((i) => i.sourcePath === 'api/main.py' && i.isRelative);
      assert.ok(pyRelativeImport);
      assert.strictEqual(pyRelativeImport.isResolved, true);
      assert.strictEqual(pyRelativeImport.resolvedPath, 'api/services/item_service.py');

      // Python external import recognized as external
      const pyExtImport = index.imports.find((i) => i.sourcePath === 'api/main.py' && i.rawSpecifier === 'fastapi');
      assert.ok(pyExtImport);
      assert.strictEqual(pyExtImport.isExternal, true);
      assert.strictEqual(pyExtImport.isResolved, false);
    });
  });
});
