import type { WorkspaceBlueprintData } from './workspaceScanner.ts';
import { executeAiWithFallback, type AiExecutionRequest } from '../../src/server/aiProviderRunner.ts';
import { parseAndValidateChatResponse } from '../../src/server/aiProvider.ts';
import { buildSystemPrompt } from '../../src/server/contextBuilder.ts';

export interface EvidenceRef {
  file: string;
  line?: number;
  label?: string;
}

export interface CompanionMessage {
  id: string;
  speaker: 'dog' | 'cat';
  speakerName: string;
  tagline: string;
  text: string;
  evidenceRefs: EvidenceRef[];
  timestamp: string;
  isAiGenerated?: boolean;
}

export interface CompanionAnalysisResult {
  timestamp: string;
  messages: CompanionMessage[];
  suggestedQuestions: string[];
}

/**
 * Extracts file:line or file paths mentioned in text and returns structured references.
 */
export function extractEvidenceRefs(text: string, knownFiles: string[] = []): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  const seen = new Set<string>();

  // Match file.ext:line patterns
  const fileLineRegex = /([a-zA-Z0-9_.\-\/\\]+\.[a-zA-Z0-9]+):(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = fileLineRegex.exec(text)) !== null) {
    const rawPath = match[1].replace(/\\/g, '/');
    const line = parseInt(match[2], 10);
    const key = `${rawPath}:${line}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ file: rawPath, line, label: `${pathBasename(rawPath)}:${line}` });
    }
  }

  // Match known file paths without line numbers
  for (const kf of knownFiles) {
    const normalized = kf.replace(/\\/g, '/');
    if (text.includes(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      refs.push({ file: normalized, line: 1, label: pathBasename(normalized) });
    }
  }

  return refs;
}

function pathBasename(p: string): string {
  return p.split('/').pop() || p;
}

/**
 * Generates automatic workspace analysis grounded strictly in discovered architecture and evidence.
 * Barkley explains the architecture in friendly plain English;
 * Cleo challenges assumptions and calls out genuine evidence gaps (silent if none).
 */
export function generateAutomaticCompanionAnalysis(
  data: WorkspaceBlueprintData
): CompanionAnalysisResult {
  const timestamp = new Date().toISOString();
  const messages: CompanionMessage[] = [];

  const rooms = data.rooms || [];
  const roomNames = rooms.map((r) => r.name).join(', ');
  const totalDiscovered = data.discoveredFilesCount;
  const totalInspected = data.inspectedFilesCount;
  const statusSummary = data.statusSummary || {};

  // 1. Identify primary entry point / manifest from inspected files
  const manifestFile = data.inspectedFiles.find((f) => f.category === 'manifest');
  const entryFile = data.inspectedFiles.find(
    (f) =>
      f.path.includes('App.') ||
      f.path.includes('main.') ||
      f.path.includes('index.') ||
      f.path.includes('server.')
  );
  const testFiles = data.inspectedFiles.filter((f) => f.category === 'test');

  const barkleyRefs: EvidenceRef[] = [];
  if (manifestFile) barkleyRefs.push({ file: manifestFile.path, line: 1, label: manifestFile.path });
  if (entryFile) barkleyRefs.push({ file: entryFile.path, line: 1, label: entryFile.path });

  // 2. Barkley: Plain-English Architectural Explanation
  const manifestName = manifestFile ? pathBasename(manifestFile.path) : 'workspace';
  const entryDesc = entryFile ? ` The primary application entry point is at ${entryFile.path}:1.` : '';

  const barkleyText =
    `Hello! I've mapped out ${data.workspaceName} across ${rooms.length} architecture rooms (${roomNames || 'modules'}). ` +
    `We discovered ${totalDiscovered} total files in the workspace, with bounded in-depth inspection on ${totalInspected} high-importance files.` +
    `${entryDesc} Think of this architecture like a well-organized house: routing and UI modules welcome the requests, core domain logic processes them, and our deterministic status engine continuously audits the evidence!`;

  messages.push({
    id: `msg-barkley-auto-${Date.now()}`,
    speaker: 'dog',
    speakerName: 'Barkley',
    tagline: 'Friendly · Architectural Teacher',
    text: barkleyText,
    evidenceRefs: barkleyRefs,
    timestamp,
    isAiGenerated: false,
  });

  // 3. Cleo: Skeptical Reviewer - ONLY speaks if genuine evidence gaps exist
  const cleoRefs: EvidenceRef[] = [];
  const gaps: string[] = [];

  // Gap 1: Test suites discovered in source, but zero live execution evidence
  const testRoom = rooms.find((r) => r.id === 'room-tests' || r.layer === 'gateway');
  if (testRoom && testRoom.status === 'implemented') {
    const sampleTest = testFiles[0]?.path || 'test/statusEngine.test.ts';
    gaps.push(
      `Test suite files exist (e.g. ${sampleTest}:1), but 0 live test execution records were verified. Code in ${testRoom.name} remains IMPLEMENTED rather than VERIFIED.`
    );
    cleoRefs.push({ file: sampleTest, line: 1, label: sampleTest });
  }

  // Gap 2: Missing or unconfigured infrastructure pillars
  const missingPillars = (data.pillars || []).filter((p) => p.status === 'missing');
  if (missingPillars.length > 0) {
    const pNames = missingPillars.map((p) => p.name).join(', ');
    gaps.push(`Infrastructure pillars are unconfigured or missing: ${pNames}.`);
  }

  // Gap 3: Bounded inspection coverage gap
  if (totalDiscovered > totalInspected) {
    gaps.push(
      `Inspection budget capped at ${totalInspected} files out of ${totalDiscovered} discovered files. ${totalDiscovered - totalInspected} files remain uninspected.`
    );
  }

  // Cleo only outputs if there are concrete objections/gaps
  if (gaps.length > 0) {
    const cleoText =
      `Don't celebrate prematurely, Barkley. Look at the evidence gaps: ` +
      gaps.join(' ') +
      ` The Living Blueprint deterministic status engine strictly rejects claims of completion without verified test runs.`;

    messages.push({
      id: `msg-cleo-auto-${Date.now()}`,
      speaker: 'cat',
      speakerName: 'Cleo',
      tagline: 'Sassy · Skeptical Reviewer',
      text: cleoText,
      evidenceRefs: cleoRefs,
      timestamp,
      isAiGenerated: false,
    });
  }

  return {
    timestamp,
    messages,
    suggestedQuestions: [
      'Explain how the rooms connect',
      'What tests are missing verification?',
      'How does the status engine evaluate evidence?',
    ],
  };
}

/**
 * Handles companion question answering:
 * If external AI is consented and configured, queries Gemini/Groq with persona prompt;
 * otherwise responds with grounded local deterministic answers.
 */
export async function answerCompanionQuery(
  question: string,
  data: WorkspaceBlueprintData,
  apiKeys: { geminiKey?: string; groqKey?: string; cloudflareToken?: string; cloudflareAccountId?: string },
  aiConsent: boolean
): Promise<CompanionMessage[]> {
  const timestamp = new Date().toISOString();
  const knownPaths = (data.inspectedFiles || []).map((f) => f.path);

  // If user granted consent and has at least one configured key, run live provider fallback
  const hasKey = Boolean(
    apiKeys.geminiKey || apiKeys.groqKey || (apiKeys.cloudflareToken && apiKeys.cloudflareAccountId)
  );

  if (aiConsent && hasKey) {
    try {
      const env: Record<string, string | undefined> = {
        GEMINI_API_KEY: apiKeys.geminiKey,
        GROQ_API_KEY: apiKeys.groqKey,
        CLOUDFLARE_API_TOKEN: apiKeys.cloudflareToken,
        CLOUDFLARE_ACCOUNT_ID: apiKeys.cloudflareAccountId,
      };

      const systemPrompt = buildSystemPrompt({
        messages: [{ role: 'user', content: question }],
        repoContext: {
          owner: 'local',
          repo: data.workspaceName,
          branch: 'main',
          totalFiles: data.discoveredFilesCount,
          inspectedFiles: data.inspectedFiles.map((f) => ({
            path: f.path,
            category: f.category,
            sizeBytes: f.sizeBytes,
            contentExcerpt: '',
            rawUrl: `file://${f.path}`,
            githubUrl: `file://${f.path}`,
          })),
          roomSummaries: data.rooms.map((r) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            evidence: r.evidence,
            filePaths: r.filePaths,
          })),
          detectedTechnologies: [],
        },
      });

      const execReq: AiExecutionRequest = {
        systemInstruction: systemPrompt,
        messages: [{ role: 'user', text: question }],
        temperature: 0.3,
        feature: 'chat',
        overallTimeoutMs: 12000,
      };

      const outcome = await executeAiWithFallback(execReq, env);
      if (outcome.success) {
        const validated = parseAndValidateChatResponse(outcome.rawText);
        return validated.replies.map((r, idx) => {
          const isDog = r.speaker === 'dog';
          const refs = extractEvidenceRefs(r.text, knownPaths);
          return {
            id: `msg-ai-${Date.now()}-${idx}`,
            speaker: r.speaker,
            speakerName: isDog ? 'Barkley' : 'Cleo',
            tagline: isDog ? 'Friendly · Architectural Teacher' : 'Sassy · Skeptical Reviewer',
            text: r.text,
            evidenceRefs: refs,
            timestamp,
            isAiGenerated: true,
          };
        });
      }
    } catch {
      // Fallback cleanly to local grounded answer if external call fails
    }
  }

  // Local Grounded Deterministic Answer
  return generateLocalGroundedAnswer(question, data, timestamp);
}

function generateLocalGroundedAnswer(
  question: string,
  data: WorkspaceBlueprintData,
  timestamp: string
): CompanionMessage[] {
  const lowerQ = question.toLowerCase();
  const knownPaths = (data.inspectedFiles || []).map((f) => f.path);
  const rooms = data.rooms || [];

  if (lowerQ.includes('test') || lowerQ.includes('verif') || lowerQ.includes('pass')) {
    const testFiles = data.inspectedFiles.filter((f) => f.category === 'test');
    const firstTest = testFiles[0]?.path || 'test/statusEngine.test.ts';
    return [
      {
        id: `msg-barkley-ans-${Date.now()}`,
        speaker: 'dog',
        speakerName: 'Barkley',
        tagline: 'Friendly · Architectural Teacher',
        text: `We found test files like ${firstTest}:1 in the workspace, but static code scanning cannot run tests on its own. To achieve Verified status, tests must be actively executed by a test runner or verified through CI records!`,
        evidenceRefs: [{ file: firstTest, line: 1, label: firstTest }],
        timestamp,
        isAiGenerated: false,
      },
      {
        id: `msg-cleo-ans-${Date.now()}`,
        speaker: 'cat',
        speakerName: 'Cleo',
        tagline: 'Sassy · Skeptical Reviewer',
        text: `Exactly. Merely having test files in ${firstTest}:1 proves implementation, not verification. The deterministic status engine correctly classifies this as IMPLEMENTED until real execution evidence exists.`,
        evidenceRefs: [{ file: firstTest, line: 1, label: firstTest }],
        timestamp,
        isAiGenerated: false,
      },
    ];
  }

  if (lowerQ.includes('room') || lowerQ.includes('connect') || lowerQ.includes('architecture')) {
    const roomList = rooms.map((r) => `${r.name} (${r.status.toUpperCase()})`).join(', ');
    const entry = data.inspectedFiles[0]?.path || 'package.json';
    return [
      {
        id: `msg-barkley-ans-${Date.now()}`,
        speaker: 'dog',
        speakerName: 'Barkley',
        tagline: 'Friendly · Architectural Teacher',
        text: `Here is how the architecture connects: ${data.workspaceName} is organized into ${rooms.length} modules: ${roomList}. Discovered entry point: ${entry}:1. Requests flow through routing and service layers down to data persistence.`,
        evidenceRefs: [{ file: entry, line: 1, label: entry }],
        timestamp,
        isAiGenerated: false,
      },
    ];
  }

  // General grounded explanation
  const entry = data.inspectedFiles[0]?.path || 'package.json';
  const refs = extractEvidenceRefs(question, knownPaths);
  if (refs.length === 0 && entry) {
    refs.push({ file: entry, line: 1, label: entry });
  }

  return [
    {
      id: `msg-barkley-ans-${Date.now()}`,
      speaker: 'dog',
      speakerName: 'Barkley',
      tagline: 'Friendly · Architectural Teacher',
      text: `Regarding "${question}": In ${data.workspaceName}, we have ${data.discoveredFilesCount} files discovered across ${rooms.length} architectural modules. You can inspect the implementation in ${entry}:1 or any of the mapped room cards below!`,
      evidenceRefs: refs,
      timestamp,
      isAiGenerated: false,
    },
  ];
}
