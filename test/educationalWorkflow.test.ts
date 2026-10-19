import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflowDiagram } from '../src/domain/workflow/workflowValidator.ts';
import { parseAndValidateChatResponse, parseAndValidateReplies } from '../src/server/aiProvider.ts';
import { buildSystemPrompt } from '../src/server/contextBuilder.ts';
import type { ChatApiRequest, WorkflowDiagram } from '../src/server/types.ts';

describe('Educational Simulation & Interactive Workflow Explanations', () => {
  const mockRepoContext: ChatApiRequest['repoContext'] = {
    owner: 'sakshamgupta005',
    repo: 'patchboard-tasks-api',
    branch: 'main',
    commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
    totalFiles: 18,
    detectedTechnologies: ['Node.js', 'Express', 'JavaScript'],
    inspectedFiles: [
      {
        path: 'src/tasks/validation.js',
        category: 'source',
        contentExcerpt: 'function validateTaskTitle(title) { if (title.length === 0) return false; }',
      },
      {
        path: 'src/routes.js',
        category: 'source',
        contentExcerpt: 'router.post("/tasks", (req, res) => { ... })',
      },
      {
        path: 'test/createTask.test.js',
        category: 'test',
        contentExcerpt: 'it("rejects whitespace-only task titles", () => { ... })',
      },
    ],
    discoveredFilePaths: [
      'src/tasks/validation.js',
      'src/routes.js',
      'test/createTask.test.js',
      'src/db/connection.js', // Discovered in tree, but NOT inspected
    ],
    roomSummaries: [
      {
        id: 'room-routes',
        name: 'API Routes & Gateway',
        layer: 'gateway',
        status: 'implemented',
        evidence: 'Discovered routes.js',
        filePaths: ['src/routes.js'],
      },
      {
        id: 'room-validation',
        name: 'Input Validation',
        layer: 'core',
        status: 'blocked',
        evidence: 'CI failure',
        filePaths: ['src/tasks/validation.js'],
      },
    ],
  };

  describe('1. Workflow Diagram Schema and Size Limits', () => {
    it('validates a bounded, properly grounded workflow diagram', () => {
      const raw = {
        title: 'Task Creation Flow',
        explanation: 'Traces client request through router to validation',
        nodes: [
          {
            id: 'client',
            label: 'Client HTTP Request',
            role: 'Client',
            classification: 'inferred',
            description: 'Sends POST /tasks with JSON payload',
            inputs: 'HTTP POST request',
            outputs: 'Raw JSON request body',
          },
          {
            id: 'router',
            label: 'Express Router',
            role: 'Router',
            roomId: 'room-routes',
            filePath: 'src/routes.js',
            classification: 'observed',
            description: 'Dispatches route handler',
            inputs: 'Express req',
            outputs: 'Calls validator',
          },
          {
            id: 'validator',
            label: 'Validation Logic',
            role: 'Schema check',
            roomId: 'room-validation',
            filePath: 'src/tasks/validation.js',
            classification: 'observed',
            description: 'Validates title length',
            inputs: 'Task title',
            outputs: 'Boolean or error',
          },
        ],
        edges: [
          {
            from: 'client',
            to: 'router',
            label: 'POST /tasks',
            classification: 'inferred',
          },
          {
            from: 'router',
            to: 'validator',
            label: 'validateTaskTitle(title)',
            classification: 'observed',
            evidenceReference: 'src/routes.js',
          },
        ],
        uncertainties: 'Database persistence layer src/db/connection.js was discovered but not inspected.',
      };

      const result = validateWorkflowDiagram(raw, mockRepoContext);
      assert.ok(result);
      assert.equal(result.title, 'Task Creation Flow');
      assert.equal(result.simulationType, 'code-derived workflow walkthrough');
      assert.equal(result.nodes.length, 3);
      assert.equal(result.edges.length, 2);
      assert.equal(result.nodes[1].classification, 'observed');
      assert.equal(result.nodes[1].roomId, 'room-routes');
      assert.equal(result.nodes[1].filePath, 'src/routes.js');
    });

    it('rejects diagrams with fewer than 2 nodes or no valid edges', () => {
      const singleNode = {
        title: 'Invalid Single Node',
        explanation: 'Only one node',
        nodes: [{ id: 'a', label: 'Only node', classification: 'inferred', description: 'desc' }],
        edges: [],
      };
      assert.equal(validateWorkflowDiagram(singleNode, mockRepoContext), null);

      const noEdges = {
        title: 'Disconnected Nodes',
        explanation: 'Two nodes without edges',
        nodes: [
          { id: 'a', label: 'Node A', classification: 'inferred', description: 'desc' },
          { id: 'b', label: 'Node B', classification: 'inferred', description: 'desc' },
        ],
        edges: [],
      };
      assert.equal(validateWorkflowDiagram(noEdges, mockRepoContext), null);
    });

    it('enforces maximum node bound (max 7 nodes) and edge bound (max 10 edges)', () => {
      const manyNodes = Array.from({ length: 12 }, (_, i) => ({
        id: `node-${i}`,
        label: `Node ${i}`,
        classification: 'inferred',
        description: `Description ${i}`,
      }));

      const manyEdges = Array.from({ length: 15 }, (_, i) => ({
        from: `node-${i}`,
        to: `node-${i + 1}`,
        classification: 'inferred',
      }));

      const raw = {
        title: 'Large Diagram',
        explanation: 'Too many nodes',
        nodes: manyNodes,
        edges: manyEdges,
      };

      const result = validateWorkflowDiagram(raw, mockRepoContext);
      assert.ok(result);
      assert.ok(result.nodes.length <= 7, `Expected <= 7 nodes, got ${result.nodes.length}`);
      assert.ok(result.edges.length <= 10, `Expected <= 10 edges, got ${result.edges.length}`);
    });
  });

  describe('2. Rejection of Fabricated Nodes and Grounding Guarantees', () => {
    it('strips non-existent file paths and invalid room IDs', () => {
      const raw = {
        title: 'Fabricated References Test',
        explanation: 'Checks stripping of fake paths and room IDs',
        nodes: [
          {
            id: 'n1',
            label: 'Node 1',
            roomId: 'fake-nonexistent-room',
            filePath: 'src/invented/fake_module.py',
            classification: 'observed', // Fabricated path cannot be observed!
            description: 'Fake code',
          },
          {
            id: 'n2',
            label: 'Node 2',
            roomId: 'room-routes', // Real room
            filePath: 'src/routes.js', // Real inspected file
            classification: 'observed',
            description: 'Real code',
          },
        ],
        edges: [
          {
            from: 'n1',
            to: 'n2',
            classification: 'observed',
            evidenceReference: 'nonexistent/file.js',
          },
        ],
      };

      const result = validateWorkflowDiagram(raw, mockRepoContext);
      assert.ok(result);
      // Fake room ID stripped
      assert.equal(result.nodes[0].roomId, undefined);
      // Fake file path stripped
      assert.equal(result.nodes[0].filePath, undefined);
      // Demoted from observed to inferred because file does not exist
      assert.equal(result.nodes[0].classification, 'inferred');
      // Edge demoted to inferred because source node is inferred
      assert.equal(result.edges[0].classification, 'inferred');
      // Fake evidence reference stripped
      assert.equal(result.edges[0].evidenceReference, undefined);

      // Real node preserved correctly
      assert.equal(result.nodes[1].roomId, 'room-routes');
      assert.equal(result.nodes[1].filePath, 'src/routes.js');
      assert.equal(result.nodes[1].classification, 'observed');
    });

    it('demotes uninspected discovered files to "inferred"', () => {
      const raw = {
        title: 'Discovered But Uninspected Test',
        explanation: 'File exists in git tree but content was not fetched',
        nodes: [
          {
            id: 'n1',
            label: 'Routes',
            filePath: 'src/routes.js',
            classification: 'observed',
            description: 'Inspected file',
          },
          {
            id: 'n2',
            label: 'Database connection',
            filePath: 'src/db/connection.js', // In discoveredFilePaths, but not in inspectedFiles
            classification: 'observed', // Should be demoted!
            description: 'Uninspected file',
          },
        ],
        edges: [
          {
            from: 'n1',
            to: 'n2',
            classification: 'observed',
          },
        ],
      };

      const result = validateWorkflowDiagram(raw, mockRepoContext);
      assert.ok(result);
      assert.equal(result.nodes[0].classification, 'observed');
      // Node 2 must be demoted to inferred because content was not inspected
      assert.equal(result.nodes[1].classification, 'inferred');
      assert.equal(result.edges[0].classification, 'inferred');
    });
  });

  describe('3. Chat Response Parsing & Diagram Optionality', () => {
    it('parses chat response containing both replies and workflowDiagram', () => {
      const rawJson = JSON.stringify({
        replies: [
          {
            speaker: 'dog',
            text: 'Here is how a request travels through the tasks API!',
          },
          {
            speaker: 'cat',
            text: 'Notice that whitespace is not trimmed in the validation step.',
          },
        ],
        workflowDiagram: {
          title: 'Request Lifecycle',
          explanation: 'From route to validation',
          nodes: [
            {
              id: 'a',
              label: 'Router',
              filePath: 'src/routes.js',
              classification: 'observed',
              description: 'Dispatches request',
            },
            {
              id: 'b',
              label: 'Validator',
              filePath: 'src/tasks/validation.js',
              classification: 'observed',
              description: 'Validates title',
            },
          ],
          edges: [
            {
              from: 'a',
              to: 'b',
              label: 'validate()',
              classification: 'observed',
            },
          ],
        },
      });

      const parsed = parseAndValidateChatResponse(rawJson, mockRepoContext);
      assert.equal(parsed.replies.length, 2);
      assert.equal(parsed.replies[0].speaker, 'dog');
      assert.equal(parsed.replies[1].speaker, 'cat');
      assert.ok(parsed.workflowDiagram);
      assert.equal(parsed.workflowDiagram.title, 'Request Lifecycle');
      // WorkflowDiagram is also attached to primary reply
      assert.ok(parsed.replies[0].workflowDiagram);
    });

    it('keeps diagram optional: standard array reply parses with zero error', () => {
      const rawJson = JSON.stringify([
        {
          speaker: 'dog',
          text: 'The architecture uses Node.js and Express.',
        },
      ]);

      const parsed = parseAndValidateChatResponse(rawJson, mockRepoContext);
      assert.equal(parsed.replies.length, 1);
      assert.equal(parsed.workflowDiagram, undefined);
      assert.equal(parsed.replies[0].workflowDiagram, undefined);

      const repliesOnly = parseAndValidateReplies(rawJson, mockRepoContext);
      assert.equal(repliesOnly.length, 1);
      assert.equal(repliesOnly[0].speaker, 'dog');
    });

    it('gracefully drops malformed diagram without discarding valid text replies', () => {
      const rawJson = JSON.stringify({
        replies: [
          {
            speaker: 'dog',
            text: 'Here is an explanation of the flow.',
          },
        ],
        workflowDiagram: {
          title: 'Broken diagram with no nodes',
          nodes: [], // Invalid!
          edges: [],
        },
      });

      const parsed = parseAndValidateChatResponse(rawJson, mockRepoContext);
      assert.equal(parsed.replies.length, 1);
      assert.equal(parsed.replies[0].text, 'Here is an explanation of the flow.');
      // Diagram dropped because it was malformed
      assert.equal(parsed.workflowDiagram, undefined);
    });
  });

  describe('4. Educational Prompts and Persona Instructions', () => {
    it('instructs Barkley as CS teacher and Cleo as skeptical reviewer in system prompt', () => {
      const req: ChatApiRequest = {
        message: 'Explain this project like I am a CS student',
        repoContext: mockRepoContext,
      };

      const prompt = buildSystemPrompt(req);
      assert.ok(prompt.includes('Primary Teacher') || prompt.includes('CS teacher'));
      assert.ok(prompt.includes('Selective Reviewer') || prompt.includes('discerning reviewer'));
      assert.ok(prompt.includes("Explain this project like I'm a CS student") || prompt.includes('CS student'));
      assert.ok(prompt.includes('code-derived workflow walkthrough') || prompt.includes('workflow diagram'));
      assert.ok(prompt.includes('What can you help me understand?'));
    });

    it('includes tool capabilities and limitation boundaries in system instructions', () => {
      const req: ChatApiRequest = {
        message: 'What can you help me understand?',
        repoContext: mockRepoContext,
      };

      const prompt = buildSystemPrompt(req);
      assert.ok(prompt.includes('The Living Blueprint\'s actual features'));
      assert.ok(prompt.includes('static code inspection only'));
      assert.ok(prompt.includes('bounded file scanning'));
      assert.ok(prompt.includes('read-only'));
    });
  });
});
