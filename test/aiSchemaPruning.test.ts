import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildSystemPrompt,
  isDiagramIntentRequested,
} from '../src/server/contextBuilder.ts';
import {
  getChatResponseSchema,
  executeAiChat,
  parseAndValidateChatResponse,
} from '../src/server/aiProvider.ts';
import type { ChatApiRequest } from '../src/server/types.ts';

describe('S02 — Dynamic Intent-Gated AI Schema & Prompt Pruning', () => {
  const mockRepoContext: ChatApiRequest['repoContext'] = {
    owner: 'sakshamgupta005',
    repo: 'patchboard-tasks-api',
    branch: 'main',
    commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
    totalFiles: 12,
    inspectedFiles: [
      {
        path: 'src/tasks/validation.js',
        category: 'source',
        contentExcerpt: 'function validateTaskTitle(title) { if (title.length === 0) return false; return true; }',
      },
      {
        path: 'src/routes/tasks.js',
        category: 'source',
        contentExcerpt: 'router.post("/tasks", (req, res) => { res.json({ id: 1 }); });',
      },
      {
        path: 'test/createTask.test.js',
        category: 'test',
        contentExcerpt: 'it("rejects whitespace-only task titles", () => { ... });',
      },
    ],
    discoveredFilePaths: ['src/tasks/validation.js', 'src/routes/tasks.js', 'test/createTask.test.js'],
    detectedTechnologies: ['JavaScript', 'Node.js', 'Express'],
    roomSummaries: [
      {
        id: 'room-routes',
        name: 'API Routing & Gateways',
        status: 'implemented',
        evidence: '3 route handlers defined in src/routes/tasks.js',
        filePaths: ['src/routes/tasks.js'],
      },
      {
        id: 'room-validation',
        name: 'Input Validation & Schema',
        status: 'blocked',
        evidence: 'CI test failing in test/createTask.test.js',
        filePaths: ['src/tasks/validation.js'],
      },
    ],
  };

  describe('1. Intent Detection Accuracy', () => {
    it('detects ordinary conversation queries as not requiring a diagram', () => {
      const ordinaryQueries = [
        'Explain how this project works',
        'Why does this module depend on that one?',
        'Explain this function step by step',
        'What happens if this component fails?',
        'What can this application actually do?',
        'What can you help me understand?',
        'Hello, what is Barkley?',
        'Is there any test checking for whitespace titles?',
      ];

      for (const query of ordinaryQueries) {
        const req: ChatApiRequest = { message: query, repoContext: mockRepoContext };
        assert.strictEqual(
          isDiagramIntentRequested(req),
          false,
          `Expected "${query}" to NOT request a diagram`
        );
      }
    });

    it('detects explicit diagram requests accurately', () => {
      const diagramQueries = [
        'Show me a workflow diagram',
        'Show me a workflow diagram of API Routing & Gateways.',
        'Can you provide a flow diagram of this room?',
        'Draw an architecture diagram for the request flow',
        'Show me a flowchart of how tasks are handled',
      ];

      for (const query of diagramQueries) {
        const req: ChatApiRequest = { message: query, repoContext: mockRepoContext };
        assert.strictEqual(
          isDiagramIntentRequested(req),
          true,
          `Expected "${query}" to request a diagram`
        );
      }
    });

    it('detects flow-tracing and request-path requests accurately', () => {
      const flowQueries = [
        'What happens when a user sends a request? Trace the flow step by step from client to storage.',
        'Trace the path of an incoming POST request through the rooms',
        'Explain the execution flow of room Input Validation in detail.',
        'Can you visualize the flow between gateway and validation?',
        'Show a step-by-step flow walkthrough',
        'Explain the data flow from client to database',
      ];

      for (const query of flowQueries) {
        const req: ChatApiRequest = { message: query, repoContext: mockRepoContext };
        assert.strictEqual(
          isDiagramIntentRequested(req),
          true,
          `Expected "${query}" to request a diagram`
        );
      }
    });

    it('honors includeDiagram: true override even without explicit keywords', () => {
      const req: ChatApiRequest = {
        message: 'Explain room validation',
        includeDiagram: true,
        repoContext: mockRepoContext,
      };
      assert.strictEqual(isDiagramIntentRequested(req), true);
    });

    it('does not silently suppress explicit user requests if includeDiagram is false', () => {
      const req: ChatApiRequest = {
        message: 'Show me a workflow diagram of task creation',
        includeDiagram: false,
        repoContext: mockRepoContext,
      };
      assert.strictEqual(isDiagramIntentRequested(req), true);
    });
  });

  describe('2. Dynamic System Prompt Pruning', () => {
    it('omits interactive diagram schema and instructions on ordinary queries', () => {
      const ordinaryReq: ChatApiRequest = {
        message: 'Explain how task creation validation works',
        repoContext: mockRepoContext,
      };

      const prompt = buildSystemPrompt(ordinaryReq);

      // Must NOT include the heavy diagram schema instructions
      assert.strictEqual(prompt.includes('INTERACTIVE WORKFLOW DIAGRAMS:'), false);
      assert.strictEqual(prompt.includes('"workflowDiagram": {'), false);
      assert.strictEqual(prompt.includes('"simulationType": "code-derived workflow walkthrough"'), false);

      // Must still preserve core educational guidelines and grounding rules
      assert.strictEqual(prompt.includes('DOG ("Barkley") — Primary Teacher:'), true);
      assert.strictEqual(prompt.includes('CAT ("Cleo") — Selective Reviewer'), true);
      assert.strictEqual(prompt.includes('GROUNDING & STRICT TRUTH POLICY:'), true);
      assert.strictEqual(prompt.includes('validateTaskTitle(title)'), true);
    });

    it('retains full diagram instructions when a diagram is requested', () => {
      const diagramReq: ChatApiRequest = {
        message: 'Show me a workflow diagram of the main request path',
        repoContext: mockRepoContext,
      };

      const prompt = buildSystemPrompt(diagramReq);

      // Must include full diagram schema instructions
      assert.strictEqual(prompt.includes('INTERACTIVE WORKFLOW DIAGRAMS:'), true);
      assert.strictEqual(prompt.includes('"workflowDiagram": {'), true);
      assert.strictEqual(prompt.includes('"simulationType": "code-derived workflow walkthrough"'), true);
      assert.strictEqual(prompt.includes('GROUNDING & STRICT TRUTH POLICY:'), true);
    });

    it('measures significant prompt character savings between ordinary and diagram modes', () => {
      const ordinaryPrompt = buildSystemPrompt({
        message: 'How does validation work?',
        repoContext: mockRepoContext,
      });

      const diagramPrompt = buildSystemPrompt({
        message: 'Show me a workflow diagram of validation',
        repoContext: mockRepoContext,
      });

      const charDifference = diagramPrompt.length - ordinaryPrompt.length;
      // Diagram instructions are ~1,840 characters
      assert.ok(
        charDifference >= 1700,
        `Expected savings >= 1700 chars, got ${charDifference} (ordinary: ${ordinaryPrompt.length}, diagram: ${diagramPrompt.length})`
      );
    });
  });

  describe('3. Dynamic Response Schema Pruning', () => {
    it('returns minimal replies-only schema when diagram is not requested', () => {
      const schema = getChatResponseSchema(false) as {
        type: string;
        properties: Record<string, unknown>;
        required: string[];
      };

      assert.strictEqual(schema.type, 'OBJECT');
      assert.deepStrictEqual(schema.required, ['replies']);
      assert.strictEqual(Boolean(schema.properties.replies), true);
      assert.strictEqual(schema.properties.workflowDiagram, undefined);
    });

    it('returns full schema including workflowDiagram when diagram is requested', () => {
      const schema = getChatResponseSchema(true) as {
        type: string;
        properties: {
          replies: unknown;
          workflowDiagram: {
            type: string;
            required: string[];
            properties: Record<string, unknown>;
          };
        };
        required: string[];
      };

      assert.strictEqual(schema.type, 'OBJECT');
      assert.strictEqual(Boolean(schema.properties.workflowDiagram), true);
      assert.strictEqual(schema.properties.workflowDiagram.type, 'OBJECT');
      assert.deepStrictEqual(schema.properties.workflowDiagram.required, [
        'title',
        'explanation',
        'nodes',
        'edges',
      ]);
    });
  });

  describe('4. Output Parsing, Malformed Formats & Evidence Validation', () => {
    it('parses ordinary text-only replies cleanly without workflowDiagram', () => {
      const rawOutput = JSON.stringify({
        replies: [
          {
            speaker: 'dog',
            text: 'Validation checks whether the title is non-empty before storing.',
            evidenceReference: 'src/tasks/validation.js',
          },
        ],
      });

      const parsed = parseAndValidateChatResponse(rawOutput, mockRepoContext);
      assert.strictEqual(parsed.replies.length, 1);
      assert.strictEqual(parsed.replies[0].speaker, 'dog');
      assert.strictEqual(parsed.workflowDiagram, undefined);
    });

    it('parses and validates diagram when model outputs both replies and workflowDiagram', () => {
      const rawOutput = JSON.stringify({
        replies: [
          {
            speaker: 'dog',
            text: 'Here is the diagram of the request flow.',
          },
        ],
        workflowDiagram: {
          title: 'Request Validation Flow',
          explanation: 'Passes HTTP POST to validation helper',
          nodes: [
            {
              id: 'n1',
              label: 'Route Handler',
              role: 'Routing',
              classification: 'observed',
              filePath: 'src/routes/tasks.js',
              description: 'Receives POST /tasks',
            },
            {
              id: 'n2',
              label: 'Validator',
              role: 'Validation',
              classification: 'observed',
              filePath: 'src/tasks/validation.js',
              description: 'Validates title',
            },
          ],
          edges: [
            {
              from: 'n1',
              to: 'n2',
              label: 'invokes',
              classification: 'observed',
            },
          ],
        },
      });

      const parsed = parseAndValidateChatResponse(rawOutput, mockRepoContext);
      assert.strictEqual(parsed.replies.length, 1);
      assert.ok(parsed.workflowDiagram);
      assert.strictEqual(parsed.workflowDiagram.nodes.length, 2);
      assert.strictEqual(parsed.workflowDiagram.edges.length, 1);
    });

    it('rejects fabricated file paths in diagram nodes during validation', () => {
      const rawOutputWithFabrication = JSON.stringify({
        replies: [{ speaker: 'dog', text: 'Here is a fabricated flow.' }],
        workflowDiagram: {
          title: 'Fabricated Flow',
          explanation: 'Claims non-existent file exists',
          nodes: [
            {
              id: 'n1',
              label: 'Fake Component',
              role: 'Fabrication',
              classification: 'observed',
              filePath: 'src/secret/nonexistent/database.js', // Does NOT exist in repoContext
              description: 'Fake node',
            },
          ],
          edges: [],
        },
      });

      const parsed = parseAndValidateChatResponse(rawOutputWithFabrication, mockRepoContext);
      // Because 'src/secret/nonexistent/database.js' is fabricated, validateWorkflowDiagram either drops or adjusts classification or rejects invalid diagram
      if (parsed.workflowDiagram) {
        for (const node of parsed.workflowDiagram.nodes) {
          if (node.filePath === 'src/secret/nonexistent/database.js') {
            assert.notStrictEqual(
              node.classification,
              'observed',
              'Fabricated file path must not remain classified as observed'
            );
          }
        }
      }
    });

    it('handles malformed JSON gracefully', () => {
      assert.throws(() => {
        parseAndValidateChatResponse('{"replies": broken json...', mockRepoContext);
      }, /Malformed JSON/);
    });
  });

  describe('5. End-to-End Execution with Mock Provider', () => {
    it('uses pruned schema for ordinary conversation request', async () => {
      let capturedSchema: any = null;

      const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) || '{}');
        capturedSchema = body.generationConfig?.responseSchema;
        return new Response(
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
                            text: 'The repository separates routing from validation.',
                          },
                        ],
                      }),
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 1500,
              candidatesTokenCount: 60,
              totalTokenCount: 1560,
            },
          }),
          { status: 200 }
        );
      };

      const res = await executeAiChat(
        {
          message: 'How is the code organized?',
          repoContext: mockRepoContext,
        },
        { GEMINI_API_KEY: 'mock-key' },
        mockFetch as any
      );

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.replies?.length, 1);
      assert.strictEqual(res.workflowDiagram, undefined);
      // Captured schema must NOT have workflowDiagram
      assert.ok(capturedSchema);
      assert.strictEqual(capturedSchema.properties.workflowDiagram, undefined);
    });

    it('uses full schema when user explicitly asks for a workflow diagram', async () => {
      let capturedSchema: any = null;

      const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) || '{}');
        capturedSchema = body.generationConfig?.responseSchema;
        return new Response(
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
                            text: 'Here is the workflow diagram of request handling!',
                          },
                        ],
                        workflowDiagram: {
                          title: 'Request Flow',
                          explanation: 'Traces request to validation',
                          nodes: [
                            {
                              id: 'n1',
                              label: 'Router',
                              role: 'Gateway',
                              classification: 'observed',
                              filePath: 'src/routes/tasks.js',
                              description: 'Handles POST',
                            },
                            {
                              id: 'n2',
                              label: 'Validator',
                              role: 'Validation',
                              classification: 'observed',
                              filePath: 'src/tasks/validation.js',
                              description: 'Validates title',
                            },
                          ],
                          edges: [
                            {
                              from: 'n1',
                              to: 'n2',
                              label: 'calls',
                              classification: 'observed',
                            },
                          ],
                        },
                      }),
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 2200,
              candidatesTokenCount: 180,
              totalTokenCount: 2380,
            },
          }),
          { status: 200 }
        );
      };

      const res = await executeAiChat(
        {
          message: 'Show me a workflow diagram of task creation',
          repoContext: mockRepoContext,
        },
        { GEMINI_API_KEY: 'mock-key' },
        mockFetch as any
      );

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.replies?.length, 1);
      assert.ok(res.workflowDiagram);
      // Captured schema must have workflowDiagram
      assert.ok(capturedSchema);
      assert.ok(capturedSchema.properties.workflowDiagram);
    });
  });
});
