import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAndValidateChatResponse,
  executeAiChat,
} from '../src/server/aiProvider.ts';
import {
  validateWorkflowDiagram,
} from '../src/domain/workflow/workflowValidator.ts';
import {
  buildSystemPrompt,
  prepareSourceContext,
  clearSourceContextCache,
  getSourceContextCacheSize,
} from '../src/server/contextBuilder.ts';
import type {
  ChatApiRequest,
  WorkflowDiagram,
} from '../src/server/types.ts';

describe('T18: Educational Companions, Natural Explanations and Grounded Workflow Diagrams', () => {
  beforeEach(() => {
    clearSourceContextCache();
  });

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
        contentExcerpt: 'function validateTaskTitle(title) { if (title.length === 0) return false; return true; }',
      },
      {
        path: 'src/routes.js',
        category: 'source',
        contentExcerpt: 'router.post("/tasks", (req, res) => { const valid = validateTaskTitle(req.body.title); });',
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
      'src/db/connection.js', // Discovered but uninspected
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

  describe('1. Natural companion dialogue without forced alternation', () => {
    it('handles natural dog-only response without inventing or forcing cat reply', async () => {
      const mockFetch = async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        replies: [
                          {
                            speaker: 'dog',
                            text: 'In Express, a route handles incoming HTTP requests and dispatches them to middleware.',
                          },
                        ],
                      }),
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          }),
          { status: 200 }
        );

      const res = await executeAiChat(
        { message: 'What is a route?' },
        { GEMINI_API_KEY: 'test-key' },
        mockFetch as any
      );

      assert.equal(res.success, true);
      assert.equal(res.replies?.length, 1);
      assert.equal(res.replies?.[0].speaker, 'dog');
      assert.ok(!res.replies?.some((r) => r.speaker === 'cat'));
    });

    it('handles dog and selective skeptical cat reply without robotic alternation', async () => {
      const mockFetch = async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        replies: [
                          {
                            speaker: 'dog',
                            text: 'The validation function checks if title.length === 0.',
                            evidenceReference: 'src/tasks/validation.js',
                          },
                          {
                            speaker: 'cat',
                            text: 'It completely ignores strings with only spaces like "   ", which is why test/createTask.test.js fails.',
                            evidenceReference: 'test/createTask.test.js',
                          },
                        ],
                      }),
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          }),
          { status: 200 }
        );

      const res = await executeAiChat(
        { message: 'Why is validation failing?' },
        { GEMINI_API_KEY: 'test-key' },
        mockFetch as any
      );

      assert.equal(res.success, true);
      assert.equal(res.replies?.length, 2);
      assert.equal(res.replies?.[0].speaker, 'dog');
      assert.equal(res.replies?.[1].speaker, 'cat');
      assert.equal(res.replies?.[0].evidenceReference, 'src/tasks/validation.js');
      assert.equal(res.replies?.[1].evidenceReference, 'test/createTask.test.js');
    });
  });

  describe('2. Explanation levels: Beginner, Intermediate, and Technical', () => {
    it('defaults to beginner-friendly explanation mode when level is omitted', () => {
      const prompt = buildSystemPrompt({
        message: 'How does this work?',
        repoContext: mockRepoContext,
      });

      assert.ok(prompt.includes('EXPLANATION LEVEL: BEGINNER'));
      assert.ok(prompt.includes('Accessible language, relatable analogies and examples'));
    });

    it('adapts prompt instructions for intermediate explanation level', () => {
      const prompt = buildSystemPrompt({
        message: 'How does this work?',
        explanationLevel: 'intermediate',
        repoContext: mockRepoContext,
      });

      assert.ok(prompt.includes('EXPLANATION LEVEL: INTERMEDIATE'));
      assert.ok(prompt.includes('Practical implementation details, control flow, functions'));
    });

    it('adapts prompt instructions for technical explanation level', () => {
      const prompt = buildSystemPrompt({
        message: 'Explain validateTaskTitle behaviour',
        explanationLevel: 'technical',
        repoContext: mockRepoContext,
      });

      assert.ok(prompt.includes('EXPLANATION LEVEL: TECHNICAL'));
      assert.ok(prompt.includes('Precise function behaviour, exact source references'));
    });
  });

  describe('3. Optional diagram generation and cost efficiency', () => {
    it('keeps simple questions text-only with zero diagram overhead', () => {
      const rawJson = JSON.stringify({
        replies: [
          {
            speaker: 'dog',
            text: 'Express routes map HTTP methods and path patterns to request handler callbacks.',
          },
        ],
      });

      const parsed = parseAndValidateChatResponse(rawJson, mockRepoContext);
      assert.equal(parsed.replies.length, 1);
      assert.equal(parsed.workflowDiagram, undefined);
    });

    it('returns validated diagram and replies in a single unified model payload', () => {
      const rawJson = JSON.stringify({
        replies: [
          {
            speaker: 'dog',
            text: 'Here is the step-by-step path from incoming request to validation!',
          },
        ],
        workflowDiagram: {
          id: 'wf-task-create',
          title: 'Task Creation Request Flow',
          explanation: 'Traces the request through the gateway to schema checks',
          nodes: [
            {
              id: 'client',
              label: 'Client HTTP Request',
              role: 'External Caller',
              nodeType: 'external',
              classification: 'inferred',
              description: 'POST /tasks payload',
            },
            {
              id: 'router',
              label: 'Express Router',
              role: 'Routing',
              nodeType: 'component',
              roomId: 'room-routes',
              filePath: 'src/routes.js',
              classification: 'observed',
              description: 'Dispatches route handler',
            },
            {
              id: 'validator',
              label: 'Validation Logic',
              role: 'Input Validator',
              nodeType: 'decision',
              roomId: 'room-validation',
              filePath: 'src/tasks/validation.js',
              classification: 'observed',
              description: 'Checks title length',
            },
          ],
          edges: [
            {
              from: 'client',
              to: 'router',
              label: 'HTTP POST',
              classification: 'inferred',
            },
            {
              from: 'router',
              to: 'validator',
              label: 'validateTaskTitle(title)',
              branchLabel: 'on body parse',
              classification: 'observed',
              evidenceReference: 'src/routes.js',
            },
          ],
        },
      });

      const parsed = parseAndValidateChatResponse(rawJson, mockRepoContext);
      assert.equal(parsed.replies.length, 1);
      assert.ok(parsed.workflowDiagram);
      assert.equal(parsed.workflowDiagram.id, 'wf-task-create');
      assert.equal(parsed.workflowDiagram.nodes.length, 3);
      assert.equal(parsed.workflowDiagram.nodes[0].nodeType, 'external');
      assert.equal(parsed.workflowDiagram.nodes[2].nodeType, 'decision');
      assert.equal(parsed.workflowDiagram.edges[1].branchLabel, 'on body parse');
    });
  });

  describe('4. Diagram validation, size limits, and dangling edges', () => {
    it('supports practical bounds up to 12 nodes and 20 edges', () => {
      const twelveNodes = Array.from({ length: 12 }, (_, i) => ({
        id: `node-${i}`,
        label: `Step ${i}`,
        nodeType: i % 2 === 0 ? 'component' : 'decision',
        classification: 'inferred' as const,
        description: `Does step ${i}`,
      }));

      const edges = Array.from({ length: 11 }, (_, i) => ({
        from: `node-${i}`,
        to: `node-${i + 1}`,
        classification: 'inferred' as const,
      }));

      const diagram: WorkflowDiagram = {
        title: 'Twelve Step Flow',
        explanation: 'Deep workflow walkthrough',
        simulationType: 'code-derived workflow walkthrough',
        nodes: twelveNodes,
        edges,
      };

      const result = validateWorkflowDiagram(diagram, mockRepoContext, { maxNodes: 12, maxEdges: 20 });
      assert.ok(result);
      assert.equal(result.nodes.length, 12);
      assert.equal(result.edges.length, 11);
    });

    it('rejects dangling edges pointing to non-existent nodes', () => {
      const raw = {
        title: 'Dangling Edge Test',
        explanation: 'Tests dangling edge elimination',
        nodes: [
          { id: 'a', label: 'Node A', classification: 'inferred', description: 'Step A' },
          { id: 'b', label: 'Node B', classification: 'inferred', description: 'Step B' },
        ],
        edges: [
          { from: 'a', to: 'b', classification: 'inferred' },
          { from: 'b', to: 'nonexistent-node', classification: 'inferred' }, // Dangling!
          { from: 'ghost-node', to: 'a', classification: 'inferred' }, // Dangling!
        ],
      };

      const result = validateWorkflowDiagram(raw, mockRepoContext);
      assert.ok(result);
      assert.equal(result.nodes.length, 2);
      assert.equal(result.edges.length, 1);
      assert.equal(result.edges[0].from, 'a');
      assert.equal(result.edges[0].to, 'b');
    });

    it('rejects self loops and duplicate edges', () => {
      const raw = {
        title: 'Loop and Duplicate Test',
        explanation: 'Tests self loops and duplicate edges',
        nodes: [
          { id: 'a', label: 'Node A', classification: 'inferred', description: 'Step A' },
          { id: 'b', label: 'Node B', classification: 'inferred', description: 'Step B' },
        ],
        edges: [
          { from: 'a', to: 'a', classification: 'inferred' }, // Self loop!
          { from: 'a', to: 'b', classification: 'inferred' },
          { from: 'a', to: 'b', classification: 'inferred' }, // Duplicate!
        ],
      };

      const result = validateWorkflowDiagram(raw, mockRepoContext);
      assert.ok(result);
      assert.equal(result.edges.length, 1);
      assert.equal(result.edges[0].from, 'a');
      assert.equal(result.edges[0].to, 'b');
    });
  });

  describe('5. Grounding: Observed vs Inferred relationships and fabricated references', () => {
    it('strips fabricated file paths, fake room IDs, and demotes classification', () => {
      const raw = {
        title: 'Fabricated Data Test',
        explanation: 'Ensures invented items are stripped or demoted',
        nodes: [
          {
            id: 'n1',
            label: 'Fake Module',
            roomId: 'fake-room-xyz', // Fabricated room
            filePath: 'src/invented/ghost.py', // Fabricated path
            classification: 'observed',
            description: 'Invented step',
          },
          {
            id: 'n2',
            label: 'Real Module',
            roomId: 'room-routes', // Valid room
            filePath: 'src/routes.js', // Inspected file
            classification: 'observed',
            description: 'Real step',
          },
        ],
        edges: [
          {
            from: 'n1',
            to: 'n2',
            classification: 'observed',
            evidenceReference: 'src/fake/evidence.js',
          },
        ],
      };

      const result = validateWorkflowDiagram(raw, mockRepoContext);
      assert.ok(result);
      assert.equal(result.nodes[0].roomId, undefined);
      assert.equal(result.nodes[0].filePath, undefined);
      assert.equal(result.nodes[0].classification, 'inferred');
      assert.equal(result.nodes[1].roomId, 'room-routes');
      assert.equal(result.nodes[1].filePath, 'src/routes.js');
      assert.equal(result.nodes[1].classification, 'observed');
      // Edge must be demoted because n1 is inferred
      assert.equal(result.edges[0].classification, 'inferred');
      // Fake evidence reference must be stripped
      assert.equal(result.edges[0].evidenceReference, undefined);
    });

    it('demotes uninspected discovered files to inferred', () => {
      const raw = {
        title: 'Uninspected Discovered Test',
        explanation: 'File exists in git tree but content was not fetched',
        nodes: [
          {
            id: 'n1',
            label: 'Router',
            filePath: 'src/routes.js',
            classification: 'observed',
            description: 'Inspected file',
          },
          {
            id: 'n2',
            label: 'DB Connection',
            filePath: 'src/db/connection.js', // Discovered but uninspected
            classification: 'observed',
            description: 'Uninspected file',
          },
        ],
        edges: [
          { from: 'n1', to: 'n2', classification: 'observed' },
        ],
      };

      const result = validateWorkflowDiagram(raw, mockRepoContext);
      assert.ok(result);
      assert.equal(result.nodes[0].classification, 'observed');
      assert.equal(result.nodes[1].classification, 'inferred');
      assert.equal(result.edges[0].classification, 'inferred');
    });
  });

  describe('6. Repository/commit isolation and cache invalidation', () => {
    it('invalidates source context cache when repository commit changes', () => {
      const ctx1 = prepareSourceContext({
        inspectedFiles: mockRepoContext.inspectedFiles,
        selectedRoomId: 'room-routes',
      });
      assert.equal(getSourceContextCacheSize(), 1);

      // Same call uses cache
      const ctx2 = prepareSourceContext({
        inspectedFiles: mockRepoContext.inspectedFiles,
        selectedRoomId: 'room-routes',
      });
      assert.strictEqual(ctx1, ctx2);

      // Changed inspected files invalidates cache
      prepareSourceContext({
        inspectedFiles: [
          ...mockRepoContext.inspectedFiles,
          { path: 'src/new.js', category: 'source', contentExcerpt: 'export const a = 1;' },
        ],
        selectedRoomId: 'room-routes',
      });
      assert.equal(getSourceContextCacheSize(), 2);
    });
  });

  describe('7. Graceful degradation when evidence is insufficient', () => {
    it('drops diagram if fewer than 2 valid nodes remain without dropping companion text', () => {
      const rawJson = JSON.stringify({
        replies: [
          {
            speaker: 'dog',
            text: 'I could not find enough connected code in the inspected files to build a reliable diagram.',
          },
        ],
        workflowDiagram: {
          title: 'Insufficient Evidence Diagram',
          nodes: [
            { id: 'solo', label: 'Solo Node', classification: 'inferred', description: 'Single' },
          ],
          edges: [],
        },
      });

      const parsed = parseAndValidateChatResponse(rawJson, mockRepoContext);
      assert.equal(parsed.replies.length, 1);
      assert.equal(parsed.workflowDiagram, undefined);
      assert.ok(parsed.replies[0].text.includes('could not find enough connected code'));
    });
  });

  describe('8. Gemini failure handling preserves existing history', () => {
    it('handles rate limiting (429) cleanly with RATE_LIMITED code', async () => {
      const mockFetch = async () => new Response(JSON.stringify({ error: 'Quota exceeded' }), { status: 429 });

      const res = await executeAiChat(
        { message: 'Hello' },
        { GEMINI_API_KEY: 'test-key' },
        mockFetch as any
      );

      assert.equal(res.success, false);
      assert.equal(res.code, 'RATE_LIMITED');
      assert.ok(res.error?.includes('rate limit'));
    });

    it('returns CONFIG_REQUIRED when GEMINI_API_KEY is not configured', async () => {
      const res = await executeAiChat(
        { message: 'Hello' },
        {}, // No API key
        async () => new Response('')
      );

      assert.equal(res.success, false);
      assert.equal(res.code, 'CONFIG_REQUIRED');
    });
  });
});
