import assert from 'node:assert';
import { describe, it } from 'node:test';
import { scanGitHubRepository } from '../src/domain/github/scanner.ts';
import { mapScanResultToHouse } from '../src/domain/github/architectureMapper.ts';
import { buildCodeIndex } from '../src/domain/codeIndex/index.ts';
import { buildControlFlowGraph } from '../src/domain/cfg/cfgBuilder.ts';
import { traceRequestJourney } from '../src/domain/journey/index.ts';
import { runStaticSimulation } from '../src/domain/simulation/index.ts';
import { buildEvidenceChain } from '../src/domain/evidenceChain/evidenceChainBuilder.ts';
import {
  analyzeStateTransitions,
  analyzeDataSchemas,
  analyzeModuleHierarchy,
} from '../src/domain/architectureViews/index.ts';
import { executeAiChat } from '../src/server/aiProvider.ts';
import { validateInvestigationFinding } from '../src/domain/investigation/validator.ts';
import { generateRepairPrompt } from '../src/domain/investigation/promptGenerator.ts';

function toFilesRecord(scanResult: { inspectedFiles: Array<{ path: string; contentExcerpt?: string }> }): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const f of scanResult.inspectedFiles) {
    rec[f.path] = f.contentExcerpt || '';
  }
  return rec;
}

describe('T35: Cross-Repository Acceptance and Visualization Quality Audit', () => {
  describe('1. TypeScript Frontend (Vite + React + Vitest)', () => {
    it('scans honestly, maps React components to house rooms, and builds architecture views', async () => {
      const scanResult = await scanGitHubRepository('https://github.com/benchmark-org/vite-react-dashboard', {
        maxFilesToInspect: 15,
      });

      assert.strictEqual(scanResult.success, true);
      assert.strictEqual(scanResult.owner, 'benchmark-org');
      assert.strictEqual(scanResult.repo, 'vite-react-dashboard');
      assert.strictEqual(scanResult.totalFilesDiscovered, 12);
      assert.strictEqual(scanResult.inspectedFiles.length, 12);
      assert.ok(scanResult.detectedTechnologies.includes('TypeScript'));
      assert.ok(scanResult.detectedTechnologies.includes('React'));

      const house = mapScanResultToHouse(scanResult);
      assert.ok(house.rooms.length > 0, 'House must derive rooms from React frontend');

      // Verify code index with files dictionary
      const filesRecord = toFilesRecord(scanResult);
      const index = buildCodeIndex({
        repositorySha: scanResult.commitSha,
        files: filesRecord,
      });
      assert.ok(index.symbols.length > 0, 'Code index must extract TypeScript symbols');

      // Check evidence chain for Vitest check runs
      const evidenceChain = buildEvidenceChain({
        room: house.rooms[0],
        scanResult,
      });
      assert.ok(evidenceChain.chains.length > 0, 'Must produce evidence chains from test checks');
    });
  });

  describe('2. Python API (FastAPI + Pydantic + SQLAlchemy)', () => {
    it('extracts Python routes, Pydantic schemas, and state transitions where supported', async () => {
      const scanResult = await scanGitHubRepository('https://github.com/benchmark-org/fastapi-inventory-api', {
        maxFilesToInspect: 10,
      });

      assert.strictEqual(scanResult.success, true);
      assert.ok(scanResult.detectedTechnologies.includes('Python'));
      assert.ok(scanResult.detectedTechnologies.includes('FastAPI'));

      const filesRecord = toFilesRecord(scanResult);
      const index = buildCodeIndex({
        repositorySha: scanResult.commitSha,
        files: filesRecord,
      });
      assert.ok(index.symbols.length > 0, 'Must extract Python functions and classes');

      // Schema view must detect Pydantic / SQLAlchemy models
      const schemaModel = analyzeDataSchemas({ files: filesRecord });
      assert.ok(schemaModel.hasSufficientEvidence, 'Python fixture must support data/schema view');
      assert.ok(schemaModel.model && schemaModel.model.models.length > 0, 'Must extract models');

      // Control flow & data flow: Python is not JS/TS, so CFG AST builder honestly reports unsupported or syntax diagnostics
      const pythonFile = scanResult.inspectedFiles.find((f) => f.path.endsWith('.py'));
      assert.ok(pythonFile, 'Python file must be inspected');
      const cfg = buildControlFlowGraph({
        sourcePath: pythonFile.path,
        content: pythonFile.contentExcerpt || '',
      });
      assert.ok(cfg === null || cfg.hasParseErrors === true || cfg.nodes.length === 0, 'Python CFG must honestly report unsupported or syntax limitations');
    });
  });

  describe('3. Monorepo (Multi-Package Workspaces)', () => {
    it('detects monorepo directory clusters and module hierarchy without crashing', async () => {
      const scanResult = await scanGitHubRepository('https://github.com/benchmark-org/saas-platform-monorepo', {
        maxFilesToInspect: 15,
      });

      assert.strictEqual(scanResult.success, true);
      const filesRecord = toFilesRecord(scanResult);
      const index = buildCodeIndex({
        repositorySha: scanResult.commitSha,
        files: filesRecord,
      });

      const moduleModel = analyzeModuleHierarchy({ codeIndex: index });
      assert.ok(moduleModel.hasSufficientEvidence, 'Monorepo must support module hierarchy');
      assert.ok(moduleModel.model && moduleModel.model.clusters.length > 0, 'Must identify multi-package clusters');
    });
  });

  describe('4. Small JavaScript API (Express + SQLite)', () => {
    it('traces request journeys and runs static simulation deterministically', async () => {
      const scanResult = await scanGitHubRepository('https://github.com/benchmark-org/express-task-service', {
        maxFilesToInspect: 10,
      });

      assert.strictEqual(scanResult.success, true);
      const filesRecord = toFilesRecord(scanResult);
      const index = buildCodeIndex({
        repositorySha: scanResult.commitSha,
        files: filesRecord,
      });

      const journey = traceRequestJourney({ codeIndex: index, fileContents: filesRecord });
      assert.ok(journey.steps.length > 0, 'Must trace Express route request journey steps');

      // Run static simulation on auth middleware
      const authFile = scanResult.inspectedFiles.find((f) => f.path.includes('auth.js'));
      assert.ok(authFile, 'auth.js must be inspected');
      const cfg = buildControlFlowGraph({
        sourcePath: authFile.path,
        content: authFile.contentExcerpt || '',
        functionName: 'authMiddleware',
      });
      assert.ok(cfg, 'CFG must be constructed');

      const simulation = runStaticSimulation({
        cfg,
        scenario: {
          id: 'unauthorized',
          name: 'Missing Auth Header',
          description: 'No authorization header provided',
          category: 'invalid',
          parameters: { 'req.headers': {} },
        },
      });
      assert.ok(simulation.steps.length > 0, 'Simulation must record steps');
      assert.strictEqual(simulation.isComplete, true, 'Simulation must complete deterministically');
    });
  });

  describe('5. Partially Unsupported / Malformed Manifest (Fortran + Broken JSON)', () => {
    it('honestly reports parse failures, skips non-text assets, and notes limitations', async () => {
      const scanResult = await scanGitHubRepository('https://github.com/benchmark-org/legacy-fortran-solver', {
        maxFilesToInspect: 10,
      });

      assert.strictEqual(scanResult.success, true);
      // package.json was malformed JSON
      assert.ok(scanResult.parseFailures.length > 0, 'Must honestly report JSON parse failure');
      assert.strictEqual(scanResult.parseFailures[0].path, 'package.json');

      const house = mapScanResultToHouse(scanResult);
      assert.ok(house.rooms.length > 0, 'Must derive fallback rooms for unparsed projects');

      // State view must declare insufficient evidence rather than inventing diagrams
      const filesRecord = toFilesRecord(scanResult);
      const stateModel = analyzeStateTransitions({ files: filesRecord });
      assert.strictEqual(stateModel.hasSufficientEvidence, false, 'Unsupported source must not fabricate state transitions');
    });
  });

  describe('6. Living Blueprint Self-Repository Target', () => {
    it('scans The Living Blueprint self-fixture, discovers architecture, and validates findings', async () => {
      const scanResult = await scanGitHubRepository('https://github.com/sakshamgupta005/velocity', {
        maxFilesToInspect: 10,
      });

      assert.strictEqual(scanResult.success, true);
      assert.strictEqual(scanResult.owner, 'sakshamgupta005');
      assert.strictEqual(scanResult.repo, 'velocity');

      const house = mapScanResultToHouse(scanResult);
      assert.ok(house.rooms.length > 0, 'Must map Living Blueprint architecture');

      // Validate finding with strict 7-level hierarchy
      const validatedFinding = validateInvestigationFinding(
        {
          title: 'Deterministic Status Logic Test',
          category: 'logic_error',
          severity: 'medium',
          evidenceClassification: 'observed',
          explanation: 'Validates status calculation based on observed evidence',
          whyItMatters: 'Status inaccuracies could mislead users about code health',
          codeEvidence: {
            filePath: 'src/domain/status/statusEngine.ts',
            targetIdentifier: 'deriveRoomStatus',
            codeSnippet: "  if (evidence.failingTests?.length > 0) return 'blocked';",
            isVerified: true,
          },
          evidencePaths: ['src/domain/status/statusEngine.ts'],
          reasoning: {
            facts: ['statusEngine.ts defines status derivation logic'],
            inferences: ['Status engine is core to truth reporting'],
          },
          uncertainties: 'Runtime test runner output is not observed in static scan',
          recommendedNextStep: 'Run test/statusEngine.test.ts to verify passing states',
          suggestedAgentPrompt: 'Test status derivation for passing tests',
        },
        {
          roomId: 'room-status',
          roomName: 'Domain Logic & Architecture',
          roomLayer: 'domain',
          roomStatus: 'implemented',
          roomEvidence: 'status derivation logic in src/domain/status/statusEngine.ts',
          roomFilePaths: ['src/domain/status/statusEngine.ts'],
          repoContext: {
            owner: scanResult.owner,
            repo: scanResult.repo,
            branch: 'main',
            commitSha: scanResult.commitSha,
            totalFiles: scanResult.totalFilesDiscovered,
            inspectedFiles: scanResult.inspectedFiles,
            discoveredFilePaths: scanResult.discoveredFilePaths,
            detectedTechnologies: scanResult.detectedTechnologies,
          },
        }
      );

      assert.strictEqual(validatedFinding.whyItMatters, 'Status inaccuracies could mislead users about code health');
      assert.strictEqual(validatedFinding.codeEvidence?.lineRange, 'L4');
      assert.strictEqual(validatedFinding.evidenceClassification, 'observed');

      // Generate repair prompt
      const prompt = generateRepairPrompt(validatedFinding, 'room-status', 'Domain Logic & Architecture');
      assert.ok(prompt.includes('## Why It Matters'), 'Prompt must include Why It Matters section');
      assert.ok(prompt.includes('## Grounded Reasoning'), 'Prompt must include Grounded Reasoning section');
    });
  });

  describe('7. Fallback Routing & AI Resilience', () => {
    it('handles primary provider rate-limit and falls back cleanly without crashing', async () => {
      let geminiCalled = 0;
      let groqCalled = 0;

      const mockFetch = async (url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes('googleapis.com')) {
          geminiCalled++;
          return new Response(
            JSON.stringify({
              error: {
                code: 429,
                message: 'Rate limit exceeded',
                status: 'RESOURCE_EXHAUSTED',
              },
            }),
            { status: 429, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (urlStr.includes('api.groq.com')) {
          groqCalled++;
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      replies: [
                        {
                          speaker: 'dog',
                          text: 'Barkley here via Groq backup!',
                        },
                      ],
                    }),
                  },
                  finish_reason: 'stop',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('Not found', { status: 404 });
      };

      const result = await executeAiChat(
        {
          message: 'Hello!',
          repoContext: {
            owner: 'sakshamgupta005',
            repo: 'patchboard-tasks-api',
            branch: 'main',
            commitSha: '4ddfe585adbccd57794efba49ca1102ff654382f',
          },
        },
        {
          GEMINI_API_KEY: 'mock-gemini-key',
          GROQ_API_KEY: 'mock-groq-key',
        },
        mockFetch as unknown as typeof fetch
      );

      assert.strictEqual(geminiCalled, 1, 'Gemini primary must be attempted first');
      assert.strictEqual(groqCalled, 1, 'Groq fallback must be called on 429');
      assert.strictEqual(result.fallbackUsed, true, 'Must flag fallbackUsed');
      assert.strictEqual(result.provider, 'groq');
    });
  });
});
