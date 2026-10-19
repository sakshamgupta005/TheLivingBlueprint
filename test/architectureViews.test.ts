import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  analyzeStateTransitions,
  analyzeDataSchemas,
  analyzeConfigWiring,
  analyzeModuleHierarchy,
  analyzeErrorPaths,
  buildArchitectureLensGraph,
} from '../src/domain/architectureViews/index.ts';
import { buildCodeIndex } from '../src/domain/codeIndex/index.ts';

describe('T31: Architecture Views Supported by Source Code Evidence', () => {
  describe('1. State-Transition View', () => {
    it('detects explicit enums and code-supported transitions', () => {
      const files: Record<string, string> = {
        'src/models/status.ts': `
          export enum TaskStatus {
            TODO = 'todo',
            IN_PROGRESS = 'in_progress',
            DONE = 'done',
            CANCELLED = 'cancelled'
          }
        `,
        'src/services/taskService.ts': `
          import { TaskStatus } from '../models/status';
          export function startTask(task: any) {
            task.status = TaskStatus.IN_PROGRESS;
          }
          export function completeTask(task: any) {
            task.status = TaskStatus.DONE;
          }
        `,
      };

      const result = analyzeStateTransitions({ files });

      assert.strictEqual(result.hasSufficientEvidence, true);
      assert.strictEqual(result.model?.machines.length, 1);
      assert.strictEqual(result.model?.machines[0].name, 'TaskStatus');
      assert.strictEqual(result.model?.machines[0].states.length, 4);
      assert.ok(result.model!.totalTransitions >= 1, 'Must find code-supported transitions');

      // Verify CanvasGraph generation
      const canvas = buildArchitectureLensGraph('state_transitions', { files });
      assert.ok(canvas);
      assert.strictEqual(canvas.viewMode, 'state_transitions');
      assert.strictEqual(canvas.nodes.length, 4);
      assert.ok(canvas.edges.length >= 1);
      assert.strictEqual(canvas.nodes[0].classification, 'observed');
    });

    it('detects state constants and explicit transition maps without fabricating transitions', () => {
      const files: Record<string, string> = {
        'src/workflow/orderState.js': `
          const OrderState = {
            DRAFT: 'draft',
            SUBMITTED: 'submitted',
            APPROVED: 'approved',
            REJECTED: 'rejected'
          };
          const transitions = {
            draft: ['submitted'],
            submitted: ['approved', 'rejected']
          };
        `,
      };

      const result = analyzeStateTransitions({ files });

      assert.strictEqual(result.hasSufficientEvidence, true);
      assert.strictEqual(result.model?.totalStates, 4);
      assert.strictEqual(result.model?.totalTransitions, 3);
      const submittedToApproved = result.model?.machines[0].transitions.find(
        (t) => t.from === 'submitted' && t.to === 'approved'
      );
      assert.ok(submittedToApproved, 'Must find submitted -> approved transition');
    });

    it('reports insufficient evidence when no enums or state patterns exist', () => {
      const files: Record<string, string> = {
        'src/utils/math.ts': `
          export function add(a: number, b: number) { return a + b; }
        `,
      };

      const result = analyzeStateTransitions({ files });

      assert.strictEqual(result.hasSufficientEvidence, false);
      assert.ok(result.reasonIfUnsupported?.includes('No explicit enums'));
      assert.strictEqual(result.model, null);

      const canvas = buildArchitectureLensGraph('state_transitions', { files });
      assert.ok(canvas);
      assert.strictEqual(canvas.nodes.length, 0);
      assert.ok(canvas.explanation?.includes('No explicit enums'));
    });
  });

  describe('2. Data / Schema View', () => {
    it('detects SQL table schemas, primary keys, and foreign key relationships', () => {
      const files: Record<string, string> = {
        'schema.sql': `
          CREATE TABLE users (
            id INT PRIMARY KEY,
            username VARCHAR(50) NOT NULL
          );

          CREATE TABLE tasks (
            id INT PRIMARY KEY,
            title VARCHAR(100) NOT NULL,
            user_id INT REFERENCES users(id)
          );
        `,
      };

      const result = analyzeDataSchemas({ files });

      assert.strictEqual(result.hasSufficientEvidence, true);
      assert.strictEqual(result.model?.models.length, 2);
      const tasksModel = result.model?.models.find((m) => m.name === 'tasks');
      assert.ok(tasksModel);
      assert.strictEqual(tasksModel.kind, 'sql_table');

      const fkRel = result.model?.relationships.find(
        (r) => r.sourceModel === 'tasks' && r.targetModel === 'users'
      );
      assert.ok(fkRel, 'Must establish foreign key relationship between tasks and users');
      assert.strictEqual(fkRel.kind, 'foreign_key');
    });

    it('detects TypeScript data interfaces and inferred ID relationships', () => {
      const files: Record<string, string> = {
        'src/types/models.ts': `
          export interface User {
            id: string;
            name: string;
          }

          export interface Task {
            id: string;
            title: string;
            userId: string;
            completed: boolean;
          }
        `,
      };

      const result = analyzeDataSchemas({ files });

      assert.strictEqual(result.hasSufficientEvidence, true);
      assert.strictEqual(result.model?.models.length, 2);
      const rel = result.model?.relationships.find(
        (r) => r.sourceModel === 'Task' && r.targetModel === 'User'
      );
      assert.ok(rel, 'Must detect userId field reference to User model');
    });

    it('handles malformed schemas gracefully without throwing errors', () => {
      const files: Record<string, string> = {
        'broken.sql': `
          CREATE TABLE broken (
            id INT PRIMARY KEY,
            unclosed syntax...
        `,
      };

      // Must not crash
      const result = analyzeDataSchemas({ files });
      assert.ok(result);
    });

    it('reports unsupported when no database or entity schemas exist', () => {
      const files: Record<string, string> = {
        'src/plain.js': 'console.log("hello world");',
      };

      const result = analyzeDataSchemas({ files });
      assert.strictEqual(result.hasSufficientEvidence, false);
      assert.ok(result.reasonIfUnsupported?.includes('No SQL tables'));
    });
  });

  describe('3. Configuration Wiring View & Secret Redaction', () => {
    it('connects environment variable reads to consumer modules and defaults', () => {
      const files: Record<string, string> = {
        '.env.example': `
          PORT=3000
          DATABASE_URL=postgres://localhost:5432/db
          GEMINI_API_KEY=your_key_here
        `,
        'src/server.ts': `
          const port = process.env.PORT || 3000;
          const dbUrl = process.env.DATABASE_URL;
        `,
        'src/ai.ts': `
          const apiKey = process.env['GEMINI_API_KEY'];
        `,
      };

      const result = analyzeConfigWiring({ files });

      assert.strictEqual(result.hasSufficientEvidence, true);
      assert.strictEqual(result.model?.totalKeys, 3);

      const portConfig = result.model?.configs.find((c) => c.key === 'PORT');
      assert.ok(portConfig);
      assert.strictEqual(portConfig.isSecret, false);
      assert.strictEqual(portConfig.defaultValue, '3000');
      assert.strictEqual(portConfig.consumers.length, 1);
      assert.strictEqual(portConfig.consumers[0].filePath, 'src/server.ts');
    });

    it('STRICTLY redacts secret values and never exposes sensitive credentials', () => {
      const files: Record<string, string> = {
        '.env': `
          PORT=8080
          SUPER_SECRET_TOKEN=super_secret_value_12345
          DATABASE_PASSWORD=production_root_password!
          API_KEY=live_live_secret_key_abcdef
        `,
        'src/app.ts': `
          const token = process.env.SUPER_SECRET_TOKEN;
          const pass = process.env.DATABASE_PASSWORD;
          const key = process.env.API_KEY;
        `,
      };

      const result = analyzeConfigWiring({ files });

      assert.strictEqual(result.hasSufficientEvidence, true);
      assert.strictEqual(result.model?.secretKeysCount, 3);

      for (const key of ['SUPER_SECRET_TOKEN', 'DATABASE_PASSWORD', 'API_KEY']) {
        const item = result.model?.configs.find((c) => c.key === key);
        assert.ok(item, `Must detect secret config: ${key}`);
        assert.strictEqual(item.isSecret, true);
        assert.strictEqual(item.defaultValue, undefined, 'Secret value must be redacted/undefined');
      }

      // Check CanvasGraph node labels to ensure zero leakage
      const canvas = buildArchitectureLensGraph('config_wiring', { files });
      assert.ok(canvas);
      for (const node of canvas.nodes) {
        assert.ok(!node.label.includes('super_secret_value_12345'));
        assert.ok(!node.label.includes('production_root_password!'));
        assert.ok(!node.label.includes('live_live_secret_key_abcdef'));
        if (node.codeSnippet?.code) {
          assert.ok(!node.codeSnippet.code.includes('super_secret_value_12345'));
        }
      }
    });

    it('reports unsupported when no environment reads or config files exist', () => {
      const files: Record<string, string> = {
        'src/pure.ts': 'export const x = 42;',
      };

      const result = analyzeConfigWiring({ files });
      assert.strictEqual(result.hasSufficientEvidence, false);
      assert.ok(result.reasonIfUnsupported?.includes('No environment variable accesses'));
    });
  });

  describe('4. Module Hierarchy View & Circular Dependencies', () => {
    it('groups modules by directory cluster and highlights circular dependencies', () => {
      const files: Record<string, string> = {
        'src/controllers/userController.ts': `
          import { getUserService } from '../services/userService';
          export function getUser() {}
        `,
        'src/services/userService.ts': `
          import { getUserController } from '../controllers/userController';
          export function getUserService() {}
        `,
        'src/utils/helpers.ts': `
          export function formatDate() {}
        `,
      };

      const codeIndex = buildCodeIndex({
        repositorySha: 'commit-test',
        files,
      });

      const result = analyzeModuleHierarchy({ codeIndex });

      assert.strictEqual(result.hasSufficientEvidence, true);
      assert.strictEqual(result.model?.totalModules, 3);
      assert.ok(result.model!.totalClusters >= 2);

      // Verify circular dependency detection
      assert.ok(result.model!.circularModulesCount >= 2, 'Must detect userController <-> userService cycle');

      const canvas = buildArchitectureLensGraph('module_hierarchy', { codeIndex });
      assert.ok(canvas);
      assert.strictEqual(canvas.viewMode, 'module_hierarchy');

      const circularEdge = canvas.edges.find((e) => e.label?.includes('CIRCULAR'));
      assert.ok(circularEdge, 'Must highlight circular dependency edge');
      assert.strictEqual(circularEdge.style, 'dashed');
    });

    it('reports unsupported when fewer than 2 modules exist', () => {
      const files: Record<string, string> = {
        'single.ts': 'export const one = 1;',
      };

      const codeIndex = buildCodeIndex({
        repositorySha: 'commit-test',
        files,
      });

      const result = analyzeModuleHierarchy({ codeIndex });
      assert.strictEqual(result.hasSufficientEvidence, false);
      assert.ok(result.reasonIfUnsupported?.includes('Insufficient modules'));
    });
  });

  describe('5. Error-Path View', () => {
    it('detects custom error classes, throw sites, catch handlers, and status failure branches', () => {
      const files: Record<string, string> = {
        'src/tasks/createTask.js': `
          import { validateTaskTitle } from './validation.js';

          export class TaskValidationError extends Error {
            constructor(msg) { super(msg); }
          }

          export function createTask(rawTitle) {
            const validation = validateTaskTitle(rawTitle);
            if (!validation.valid) {
              throw new TaskValidationError(validation.error);
            }
            return { id: 'task-1', title: validation.sanitizedTitle };
          }
        `,
        'src/server.js': `
          import { createTask, TaskValidationError } from './tasks/createTask.js';

          export function handleCreate(req, res) {
            try {
              const task = createTask(req.body.title);
              res.status(201).json(task);
            } catch (err) {
              if (err instanceof TaskValidationError) {
                res.status(400).json({ error: err.message });
              } else {
                res.status(500).json({ error: 'Server error' });
              }
            }
          }
        `,
      };

      const result = analyzeErrorPaths({ files });

      assert.strictEqual(result.hasSufficientEvidence, true);
      assert.strictEqual(result.model?.errorClasses.length, 1);
      assert.strictEqual(result.model?.errorClasses[0].name, 'TaskValidationError');

      assert.strictEqual(result.model?.throwSites.length, 1);
      assert.strictEqual(result.model?.throwSites[0].errorType, 'TaskValidationError');
      assert.strictEqual(result.model?.throwSites[0].enclosingFunction, 'createTask');

      assert.ok(result.model!.handlers.length >= 1, 'Must detect catch handler');
      assert.ok(result.model!.errorPaths.length >= 1, 'Must connect throw site to error path');

      const canvas = buildArchitectureLensGraph('error_paths', { files });
      assert.ok(canvas);
      assert.strictEqual(canvas.viewMode, 'error_paths');
      const throwNode = canvas.nodes.find((n) => n.kind === 'throw');
      assert.ok(throwNode);
      assert.strictEqual(throwNode.filePath, 'src/tasks/createTask.js');
    });

    it('reports unsupported when no error handling or throw logic exists', () => {
      const files: Record<string, string> = {
        'src/simple.js': 'export function greet() { return "hello"; }',
      };

      const result = analyzeErrorPaths({ files });
      assert.strictEqual(result.hasSufficientEvidence, false);
      assert.ok(result.reasonIfUnsupported?.includes('No custom Error classes'));
    });
  });
});
