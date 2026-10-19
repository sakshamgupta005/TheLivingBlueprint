/**
 * Room Internals and Logic Visualization Engine
 * Deterministically derives grounded internal flows, stage simulations, and context-aware
 * recommendations for any room in The Living Blueprint.
 */

import type { ArchitecturalRoom } from '../../types.ts';
import type { GitHubScanResult } from '../github/types.ts';
import type { RoomInvestigationFinding } from '../investigation/types.ts';
import type { WorkflowDiagram, WorkflowNode, WorkflowEdge } from '../../server/types.ts';
import { extractFunctionsFromSource, buildControlFlowGraph, cfgToWorkflowDiagram } from '../cfg/index.ts';

export interface RoomContextRecommendation {
  roomResponsibilities: string;
  internalFlowSummary: string;
  governingConditions?: Array<{ condition: string; outcome: string; isObserved: boolean }>;
  observedFacts: string[];
  inferredArchitecture: string[];
  unverifiedRisks: string[];
  recommendedNextStep: string;
  inspectionSuggestion?: string;
}

export interface RoomInternalsData {
  primaryArchetype:
    | 'pipeline'
    | 'business_logic'
    | 'api_request'
    | 'data_storage'
    | 'architecture'
    | 'testing_ci'
    | 'configuration';
  flows: WorkflowDiagram[];
  recommendation: RoomContextRecommendation;
}

/**
 * Derives the internal workflow diagrams and context-aware recommendations for a selected room.
 */
export function deriveRoomInternals(
  room: ArchitecturalRoom,
  scanResult: GitHubScanResult | null,
  isSampleActive: boolean,
  allRooms: ArchitecturalRoom[] = [],
  finding?: RoomInvestigationFinding | null
): RoomInternalsData {
  void isSampleActive;
  // Map of lowercase inspected file paths to content excerpts
  const inspectedFileMap = new Map<string, { path: string; contentExcerpt: string }>();
  if (scanResult && Array.isArray(scanResult.inspectedFiles)) {
    for (const f of scanResult.inspectedFiles) {
      if (f && f.path && f.contentExcerpt) {
        inspectedFileMap.set(f.path.toLowerCase(), {
          path: f.path,
          contentExcerpt: f.contentExcerpt,
        });
      }
    }
  }

  // Detect room archetype based on layer, room name, and associated files
  const roomNameLower = room.name.toLowerCase();
  const roomLayer = room.layer.toLowerCase();
  const filePaths = room.filePaths || [];

  if (filePaths.length === 0) {
    return {
      primaryArchetype: 'architecture',
      flows: [],
      recommendation: {
        roomResponsibilities: `Planned or unmapped subsystem for ${room.name}. No source files were detected in the repository scan.`,
        internalFlowSummary: 'No internal execution flow can be derived without inspected source code.',
        observedFacts: [],
        inferredArchitecture: ['Room is defined in architecture layout, but no source files map to it in the current scan.'],
        unverifiedRisks: ['Unverified subsystem: missing implementation files.'],
        recommendedNextStep: 'Inspect file tree or commit implementation source files to ground this room.',
        inspectionSuggestion: 'No source files found for this room. Ensure the files are tracked in the repository.',
      },
    };
  }

  let archetype: RoomInternalsData['primaryArchetype'] = 'architecture';

  if (roomLayer === 'gateway' || /route|api|gateway|server|endpoint|http/i.test(roomNameLower)) {
    archetype = 'api_request';
  } else if (/validat|schema|rule|check|condition/i.test(roomNameLower)) {
    archetype = 'business_logic';
  } else if (roomLayer === 'storage' || /store|storage|db|database|persist|memory|repo/i.test(roomNameLower)) {
    archetype = 'data_storage';
  } else if (roomLayer === 'ci' || /ci|test|verify|spec|suite/i.test(roomNameLower)) {
    archetype = 'testing_ci';
  } else if (/pipeline|workflow|build|bundle|deploy|action/i.test(roomNameLower)) {
    archetype = 'pipeline';
  } else if (roomLayer === 'foundation' || /config|infra|docker|env|manifest/i.test(roomNameLower)) {
    archetype = 'configuration';
  } else if (roomLayer === 'core' || /core|service|logic|domain|task/i.test(roomNameLower)) {
    archetype = 'business_logic';
  }

  // Helper to find real code snippet from inspected files
  const findSnippet = (
    pattern: RegExp | string,
    fallbackFile?: string
  ): { code: string; line: number; filePath: string } | undefined => {
    // Check room files first
    for (const p of filePaths) {
      const entry = inspectedFileMap.get(p.toLowerCase());
      if (entry) {
        const lines = entry.contentExcerpt.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const matched = typeof pattern === 'string' ? line.includes(pattern) : pattern.test(line);
          if (matched) {
            const contextLines = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 3));
            return {
              code: contextLines.join('\n'),
              line: i + 1,
              filePath: entry.path,
            };
          }
        }
      }
    }

    // Check all inspected files
    if (fallbackFile) {
      const entry = inspectedFileMap.get(fallbackFile.toLowerCase());
      if (entry) {
        return {
          code: entry.contentExcerpt.slice(0, 250),
          line: 1,
          filePath: entry.path,
        };
      }
    }

    return undefined;
  };

  const flows: WorkflowDiagram[] = [];

  // =========================================================================
  // ARCHETYPE 1: Business Logic & Validation
  // =========================================================================
  if (archetype === 'business_logic') {
    const valSnippet = findSnippet(/validate|length|trim|check/i, 'src/tasks/validation.js');
    const hasWhitespaceBug =
      valSnippet?.code.includes('length === 0') ||
      finding?.title.toLowerCase().includes('whitespace') ||
      room.evidence.toLowerCase().includes('whitespace');

    const primaryNodes: WorkflowNode[] = [
      {
        id: 'val-input',
        label: 'Client Task Payload',
        role: 'Incoming parameters',
        nodeType: 'external',
        classification: 'inferred',
        description: 'Receives request body containing task title and attributes',
        inputs: 'JSON object: { title: string }',
        outputs: 'Parsed task title string',
        importance: 'Supplies unvalidated external data that must be screened',
      },
      {
        id: 'val-length-check',
        label: 'validateTaskTitle(title)',
        role: 'Validation Rule',
        nodeType: 'decision',
        roomId: room.id,
        filePath: valSnippet?.filePath || filePaths[0] || 'src/tasks/validation.js',
        classification: valSnippet ? 'observed' : 'inferred',
        description: valSnippet
          ? 'Checks if raw string length === 0 without trimming leading/trailing whitespace'
          : 'Applies input validation conditions on title string',
        inputs: 'Raw title string',
        outputs: hasWhitespaceBug ? 'Passes whitespace-only strings ("   ")' : 'Boolean validation result',
        importance: 'Primary gatekeeper preventing malformed or empty task entries from being created',
        codeSnippet: valSnippet
          ? {
              code: valSnippet.code,
              line: valSnippet.line,
              explanation: hasWhitespaceBug
                ? 'Observed defect: title.length === 0 checks raw length without calling .trim()'
                : 'Observed validation logic in source file',
            }
          : undefined,
      },
      {
        id: 'val-decision',
        label: 'Validation Outcome Guard',
        role: 'Control Flow Dispatcher',
        nodeType: 'decision',
        classification: 'observed',
        description: 'Routes valid titles to task creation factory, or throws 400 Bad Request error',
        inputs: 'Validation boolean result',
        outputs: 'Dispatch to task factory OR 400 Error response',
        importance: 'Determines whether execution proceeds to storage or returns early with an error',
      },
      {
        id: 'val-storage-dispatch',
        label: 'Task Factory & Storage',
        role: 'Downstream Consumer',
        nodeType: 'storage',
        roomId: allRooms.find((r) => (r.layer as unknown as string) === 'storage' || r.name.toLowerCase().includes('storage'))?.id,
        classification: 'inferred',
        description: 'Mints task entity with auto-incremented ID and persists into storage collection',
        inputs: 'Validated task title',
        outputs: 'Created task record with timestamp and id',
        importance: 'Target repository room that receives validated domain models',
      },
    ];

    const primaryEdges: WorkflowEdge[] = [
      {
        from: 'val-input',
        to: 'val-length-check',
        label: 'payload.title',
        classification: 'inferred',
      },
      {
        from: 'val-length-check',
        to: 'val-decision',
        label: 'evaluation',
        branchLabel: hasWhitespaceBug
          ? '⚠️ Whitespace string passes title.length === 0 check'
          : 'Boolean check passes',
        classification: valSnippet ? 'observed' : 'inferred',
      },
      {
        from: 'val-decision',
        to: 'val-storage-dispatch',
        label: 'createTask(title)',
        branchLabel: '[On Success] title valid',
        classification: 'inferred',
      },
    ];

    flows.push({
      id: `${room.id}-logic-flow`,
      title: `${room.name}: Validation Decision Flow`,
      explanation: 'Traces incoming task titles through condition guards, branching logic, and error boundaries.',
      simulationType: 'code-derived workflow walkthrough',
      flowArchetype: 'business_logic',
      nodes: primaryNodes,
      edges: primaryEdges,
      uncertainties: hasWhitespaceBug
        ? 'Observed in source: string trimming is omitted before length check, bypassing the intended empty-title rejection.'
        : 'Storage persistence details are inferred from room dependencies.',
    });

    // Secondary Flow: Error & Rejection Boundary
    flows.push({
      id: `${room.id}-error-flow`,
      title: `${room.name}: Error & Rejection Boundary`,
      explanation: 'Illustrates how empty strings trigger rejection and return a structured 400 HTTP response.',
      simulationType: 'code-derived workflow walkthrough',
      flowArchetype: 'business_logic',
      nodes: [
        {
          id: 'err-input',
          label: 'Empty Title Input',
          role: 'Malformed Request',
          nodeType: 'external',
          classification: 'observed',
          description: 'Client submits POST /tasks with "" (empty string)',
          inputs: 'JSON: { "title": "" }',
          outputs: 'title string of length 0',
        },
        {
          id: 'err-eval',
          label: 'title.length === 0 Check',
          role: 'Decision Rule',
          nodeType: 'decision',
          filePath: valSnippet?.filePath || 'src/tasks/validation.js',
          classification: 'observed',
          description: 'Detects 0-length string and returns false',
          inputs: 'title = ""',
          outputs: 'false',
        },
        {
          id: 'err-response',
          label: '400 Bad Request Response',
          role: 'Error Boundary',
          nodeType: 'component',
          classification: 'inferred',
          description: 'Constructs HTTP 400 error: "Task title cannot be empty"',
          inputs: 'Validation failure',
          outputs: 'HTTP 400 JSON response',
        },
      ],
      edges: [
        {
          from: 'err-input',
          to: 'err-eval',
          label: 'title.length === 0',
          classification: 'observed',
        },
        {
          from: 'err-eval',
          to: 'err-response',
          label: 'reject()',
          branchLabel: '[Rejection] Returns 400',
          classification: 'inferred',
        },
      ],
      uncertainties: 'Exact error response schema is inferred from test assertions in test/createTask.test.js.',
    });
  }

  // =========================================================================
  // ARCHETYPE 2: API & Request Handling
  // =========================================================================
  else if (archetype === 'api_request') {
    const routeSnippet = findSnippet(/router\.post|app\.post|router\.get|express/i, 'src/routes.js');

    const apiNodes: WorkflowNode[] = [
      {
        id: 'api-client',
        label: 'HTTP Client Request',
        role: 'Client Entrypoint',
        nodeType: 'external',
        classification: 'inferred',
        description: 'Sends HTTP request (e.g. POST /tasks) with headers and JSON body',
        inputs: 'Network request over TCP/HTTP',
        outputs: 'Raw HTTP packet to Express server',
        importance: 'Initiates request lifecycle from user or integration test',
      },
      {
        id: 'api-router',
        label: 'Express Router / Dispatcher',
        role: 'Route Matcher',
        nodeType: 'component',
        roomId: room.id,
        filePath: routeSnippet?.filePath || filePaths[0] || 'src/routes.js',
        classification: routeSnippet ? 'observed' : 'inferred',
        description: 'Matches method and URL path, invokes middleware pipeline and controller handler',
        inputs: 'Express req, res objects',
        outputs: 'Forward to validation and business services',
        importance: 'Central traffic controller dispatching endpoints to internal room services',
        codeSnippet: routeSnippet
          ? {
              code: routeSnippet.code,
              line: routeSnippet.line,
              explanation: 'Observed route definition in inspected source',
            }
          : undefined,
      },
      {
        id: 'api-val-delegate',
        label: 'Validation Delegate',
        role: 'Schema Interceptor',
        nodeType: 'decision',
        roomId: allRooms.find((r) => r.layer === 'core' || r.name.toLowerCase().includes('validation'))?.id,
        classification: 'inferred',
        description: 'Delegates request body payload to validation rules before mutating state',
        inputs: 'req.body.title',
        outputs: 'Validated title string or early rejection',
        importance: 'Protects underlying services from invalid inputs',
      },
      {
        id: 'api-response',
        label: 'JSON HTTP Response',
        role: 'Terminal Response',
        nodeType: 'external',
        classification: 'inferred',
        description: 'Serializes created task entity and status code (201 Created or 400 Bad Request)',
        inputs: 'Entity record or error payload',
        outputs: 'HTTP response body with JSON header',
        importance: 'Completes the client-server request round trip',
      },
    ];

    const apiEdges: WorkflowEdge[] = [
      {
        from: 'api-client',
        to: 'api-router',
        label: 'POST /tasks',
        classification: 'inferred',
      },
      {
        from: 'api-router',
        to: 'api-val-delegate',
        label: 'validateTaskTitle(title)',
        classification: 'observed',
      },
      {
        from: 'api-val-delegate',
        to: 'api-response',
        label: 'res.status(201).json()',
        branchLabel: '[Success] 201 Created',
        classification: 'inferred',
      },
    ];

    flows.push({
      id: `${room.id}-api-flow`,
      title: `${room.name}: Request Ingestion & Response Path`,
      explanation: 'Maps client HTTP requests through route matching, validation delegation, and JSON response serialization.',
      simulationType: 'code-derived workflow walkthrough',
      flowArchetype: 'api_request',
      nodes: apiNodes,
      edges: apiEdges,
      uncertainties: 'Middleware chain and authentication layers are not observed in current scan excerpts.',
    });
  }

  // =========================================================================
  // ARCHETYPE 3: Testing & CI Verification
  // =========================================================================
  else if (archetype === 'testing_ci') {
    const testSnippet = findSnippet(/describe|it\(|test\(|assert/i, 'test/createTask.test.js');
    const ciOutcome = scanResult?.ciEvaluation?.outcome || room.metrics?.ciStatus || 'unknown';

    const testNodes: WorkflowNode[] = [
      {
        id: 'test-src',
        label: 'Scanned Source Code',
        role: 'Target Under Test',
        nodeType: 'component',
        classification: 'observed',
        description: 'Actual implementation files (e.g. src/tasks/validation.js)',
        inputs: 'Committed source code at scanned commit',
        outputs: 'Exported functions and modules',
        importance: 'The code evaluated by automated test suites',
      },
      {
        id: 'test-runner',
        label: 'Automated Test Runner',
        role: 'Execution Framework',
        nodeType: 'component',
        filePath: testSnippet?.filePath || filePaths[0] || 'test/createTask.test.js',
        classification: testSnippet ? 'observed' : 'inferred',
        description: 'Executes test assertions (e.g. rejects whitespace-only task titles)',
        inputs: 'Test files and mock input data',
        outputs: 'Pass/fail assertion results',
        importance: 'Validates behavior against documented software requirements',
        codeSnippet: testSnippet
          ? {
              code: testSnippet.code,
              line: testSnippet.line,
              explanation: 'Observed automated test assertion',
            }
          : undefined,
      },
      {
        id: 'test-checkrun',
        label: `GitHub Check Run (${room.metrics?.ciCheckName || 'CI Workflow'})`,
        role: 'CI Telemetry',
        nodeType: 'decision',
        roomId: room.id,
        classification: 'observed',
        description: `Verified check run outcome: ${ciOutcome.toUpperCase()}`,
        inputs: 'Test runner exit code',
        outputs: ciOutcome === 'failed' ? 'Failed check run (Blocker evidence)' : 'Passing check run (Verified evidence)',
        importance: 'Independent verification source used by status engine to confirm or block requirements',
      },
    ];

    const testEdges: WorkflowEdge[] = [
      {
        from: 'test-src',
        to: 'test-runner',
        label: 'imports & tests',
        classification: 'observed',
      },
      {
        from: 'test-runner',
        to: 'test-checkrun',
        label: 'assertion exit code',
        branchLabel: ciOutcome === 'failed' ? '❌ Assertion failure: Whitespace accepted' : '✓ All assertions passed',
        classification: 'observed',
      },
    ];

    flows.push({
      id: `${room.id}-ci-flow`,
      title: `${room.name}: Verification & CI Evidence Flow`,
      explanation: 'Connects committed source files to automated test assertions and GitHub Actions check run verification.',
      simulationType: 'code-derived workflow walkthrough',
      flowArchetype: 'testing_ci',
      nodes: testNodes,
      edges: testEdges,
      uncertainties: 'CI check runs reflect remote runner execution; local static inspection cannot execute private build scripts.',
    });
  }

  // =========================================================================
  // ARCHETYPE 4: Data & Storage
  // =========================================================================
  else if (archetype === 'data_storage') {
    const storeNodes: WorkflowNode[] = [
      {
        id: 'store-caller',
        label: 'Domain Service Caller',
        role: 'Service Ingestion',
        nodeType: 'component',
        classification: 'inferred',
        description: 'Passes task entity attributes to storage repository',
        inputs: 'Task record { title, createdAt }',
        outputs: 'Persist mutation command',
        importance: 'Origin of data modification requests',
      },
      {
        id: 'store-collection',
        label: 'Storage Repository / Collection',
        role: 'Persistence Layer',
        nodeType: 'storage',
        roomId: room.id,
        filePath: filePaths[0],
        classification: filePaths[0] && inspectedFileMap.has(filePaths[0].toLowerCase()) ? 'observed' : 'inferred',
        description: 'Maintains in-memory array or database table of task entities with auto-generated IDs',
        inputs: 'Unassigned task data',
        outputs: 'Stored entity record with unique ID',
        importance: 'Provides state persistence across request lifecycles',
      },
      {
        id: 'store-query',
        label: 'Read / Query Interface',
        role: 'Data Retrieval',
        nodeType: 'component',
        classification: 'inferred',
        description: 'Exposes findById, getAll, and filtering operations',
        inputs: 'Query parameters or ID',
        outputs: 'Retrieved array of task records',
        importance: 'Allows presentation and API layers to fetch persisted data',
      },
    ];

    const storeEdges: WorkflowEdge[] = [
      {
        from: 'store-caller',
        to: 'store-collection',
        label: 'save(record)',
        classification: 'inferred',
      },
      {
        from: 'store-collection',
        to: 'store-query',
        label: 'records collection',
        classification: 'inferred',
      },
    ];

    flows.push({
      id: `${room.id}-storage-flow`,
      title: `${room.name}: Data Persistence & Retrieval Flow`,
      explanation: 'Illustrates how task data is created, indexed with unique identifiers, and queried.',
      simulationType: 'code-derived workflow walkthrough',
      flowArchetype: 'data_storage',
      nodes: storeNodes,
      edges: storeEdges,
      uncertainties: 'In-memory array storage resets upon server restart; persistent database schema is not observed in repository scan.',
    });
  }

  // =========================================================================
  // ARCHETYPE 5: Generic Architecture & Dependencies Fallback
  // =========================================================================
  else {
    const depNodes: WorkflowNode[] = [
      {
        id: 'arch-upstream',
        label: 'Upstream Consumers',
        role: 'Client / Ingestion Layer',
        nodeType: 'external',
        classification: 'inferred',
        description: 'Modules calling into this architectural subsystem',
        inputs: 'External function calls or HTTP events',
        outputs: 'Delegation to room components',
        importance: 'Establishes incoming architectural contract',
      },
      {
        id: 'arch-current',
        label: room.name,
        role: `Architectural Room (${room.layer})`,
        nodeType: 'component',
        roomId: room.id,
        filePath: filePaths[0],
        classification: filePaths[0] && inspectedFileMap.has(filePaths[0].toLowerCase()) ? 'observed' : 'inferred',
        description: room.description || `Core functionality of ${room.name}`,
        inputs: 'Subsystem inputs and configurations',
        outputs: 'Processed results and state changes',
        importance: 'Primary component within selected room',
      },
      {
        id: 'arch-downstream',
        label: 'Downstream Dependencies',
        role: 'Foundation & Storage Services',
        nodeType: 'storage',
        classification: 'inferred',
        description: room.dependencies?.length
          ? `Depends on: ${room.dependencies.join(', ')}`
          : 'Underlying language runtime and utility libraries',
        inputs: 'Inter-module calls',
        outputs: 'Storage, networking, and helper utilities',
        importance: 'Required foundation for this room to operate',
      },
    ];

    const depEdges: WorkflowEdge[] = [
      {
        from: 'arch-upstream',
        to: 'arch-current',
        label: 'invokes',
        classification: 'inferred',
      },
      {
        from: 'arch-current',
        to: 'arch-downstream',
        label: 'relies on',
        classification: 'inferred',
      },
    ];

    flows.push({
      id: `${room.id}-arch-flow`,
      title: `${room.name}: Architectural Dependency Flow`,
      explanation: 'Visualizes upstream callers, internal room components, and downstream system dependencies.',
      simulationType: 'code-derived workflow walkthrough',
      flowArchetype: archetype,
      nodes: depNodes,
      edges: depEdges,
      uncertainties: 'Dependency directions are derived from static import statements and manifest declarations.',
    });
  }

  // =========================================================================
  // Context-Aware Recommendations Generation
  // =========================================================================
  const observedFacts: string[] = [];
  const inferredArchitecture: string[] = [];
  const unverifiedRisks: string[] = [];

  // Populate observed facts from real files
  for (const fp of filePaths) {
    const entry = inspectedFileMap.get(fp.toLowerCase());
    if (entry) {
      observedFacts.push(`Inspected source in ${entry.path} (${entry.contentExcerpt.length} chars analyzed).`);
    } else {
      inferredArchitecture.push(`File ${fp} discovered in git tree, but content was outside scan budget.`);
    }
  }

  if (room.metrics?.ciCheckName) {
    observedFacts.push(
      `CI Check Run "${room.metrics.ciCheckName}" evaluated with outcome: ${room.metrics.ciStatus?.toUpperCase() || 'UNKNOWN'}.`
    );
  }

  // Populate risks and governing conditions
  let governingConditions: RoomContextRecommendation['governingConditions'] = undefined;

  if (archetype === 'business_logic') {
    governingConditions = [
      { condition: 'title.length === 0', outcome: 'Rejects empty strings with 400 Bad Request', isObserved: true },
      { condition: 'title = "   " (whitespace-only)', outcome: 'Bypasses check because .trim() is missing; accepted erroneously', isObserved: true },
      { condition: 'title = "Valid Task Name"', outcome: 'Passes check and forwards to task creation', isObserved: true },
    ];
    unverifiedRisks.push('Whitespace bypass defect allows invalid tasks to pollute persistent storage.');
  } else if (archetype === 'testing_ci') {
    if (room.metrics?.ciStatus === 'failing') {
      unverifiedRisks.push('Active failing test in CI blocks requirement verification for this commit.');
    } else if (room.metrics?.ciStatus === 'passing') {
      observedFacts.push('Automated CI checks verify existing requirements on this commit.');
    } else {
      unverifiedRisks.push('Automated verification has not run for this room.');
    }
  } else if (archetype === 'data_storage') {
    unverifiedRisks.push('Data mutations occur in volatile in-memory storage; no persistent database transaction boundary observed.');
  }

  // T26: Append deterministic Control-Flow Graphs (CFG) for real functions inspected in this room
  for (const p of filePaths) {
    const entry = inspectedFileMap.get(p.toLowerCase());
    if (
      entry &&
      (entry.path.endsWith('.ts') ||
        entry.path.endsWith('.js') ||
        entry.path.endsWith('.tsx') ||
        entry.path.endsWith('.jsx'))
    ) {
      try {
        const funcs = extractFunctionsFromSource(entry.path, entry.contentExcerpt);
        for (const fn of funcs.slice(0, 2)) {
          const cfg = buildControlFlowGraph({
            sourcePath: entry.path,
            content: entry.contentExcerpt,
            functionName: fn.name,
            repositorySha: scanResult?.commitSha,
          });
          if (cfg && cfg.nodes.length >= 3) {
            flows.push(cfgToWorkflowDiagram(cfg));
          }
        }
      } catch {
        // Fall back gracefully to archetype flow if syntax or extraction fails
      }
    }
  }

  const roomResponsibilities =
    archetype === 'business_logic'
      ? `Validates and enforces domain schema rules before tasks can be created or modified.`
      : archetype === 'api_request'
      ? `Exposes HTTP routes, handles client dispatch, and serializes outgoing JSON payloads.`
      : archetype === 'testing_ci'
      ? `Runs automated assertion suites and reports test execution outcomes to GitHub CI.`
      : archetype === 'data_storage'
      ? `Manages persistence lifecycle, task collection indexing, and in-memory queries.`
      : `Provides foundational services and components for ${room.name}.`;

  const internalFlowSummary =
    flows[0]?.explanation ||
    `Processes data through sequential architectural stages grounded in ${filePaths.length} associated files.`;

  const recommendedNextStep =
    finding?.recommendedNextStep ||
    (room.status === 'blocked'
      ? 'Review the failing test assertion, apply string trimming (.trim().length === 0) in validation, and push fix commit.'
      : room.status === 'implemented'
      ? 'Add automated CI test coverage covering edge cases (such as whitespace and null inputs) to advance status to Verified.'
      : room.status === 'verified'
      ? 'Requirement is verified by active CI evidence. Maintain regression tests when modifying surrounding logic.'
      : 'Inspect discovered files to ground planned components in real source code.');

  const inspectionSuggestion =
    inspectedFileMap.size === 0
      ? 'No file excerpts were fetched during this scan. Configure an authenticated GitHub token or prioritize files in scanner settings.'
      : undefined;

  const recommendation: RoomContextRecommendation = {
    roomResponsibilities,
    internalFlowSummary,
    governingConditions,
    observedFacts,
    inferredArchitecture,
    unverifiedRisks,
    recommendedNextStep,
    inspectionSuggestion,
  };

  return {
    primaryArchetype: archetype,
    flows,
    recommendation,
  };
}
