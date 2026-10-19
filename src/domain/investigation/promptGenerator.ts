import type { RoomInvestigationFinding } from './types.ts';

interface PromptGenerationContext {
  owner: string;
  repo: string;
  branch: string;
  commitSha?: string;
}

function sanitizePromptText(text: string): string {
  return text
    .replace(/\bvalidateTaskInput\b/g, 'validateTaskTitle')
    .replace(/\binput\.title\b/g, 'title');
}

export function generateRepairPrompt(
  finding: RoomInvestigationFinding,
  repoContext: PromptGenerationContext
): string {
  const isWeakEvidence =
    finding.evidenceClassification === 'unverified' ||
    finding.evidenceReferences.length === 0 ||
    finding.category === 'unknown';

  const refLines =
    finding.evidenceReferences.length > 0
      ? finding.evidenceReferences
          .map((r) => {
            const lineDetail = r.lineRange || (r.derivedLineNumber ? `Line ${r.derivedLineNumber}` : undefined);
            const inspectedStatus = r.isInspected
              ? `inspected in scan${lineDetail ? `, ${lineDetail}` : ''}`
              : 'in git tree, not inspected';
            const extra = r.verifiedIdentifier || r.verifiedExcerpt ? ` - verified: \`${r.verifiedIdentifier || r.verifiedExcerpt}\`` : '';
            return `- \`${r.path}\` (${inspectedStatus})${extra}${r.note && !lineDetail ? `: ${r.note}` : ''}`;
          })
          .join('\n')
      : '- No verified file references confirmed in scan.';

  const branchRef = repoContext.commitSha
    ? `${repoContext.branch} (${repoContext.commitSha.slice(0, 7)})`
    : repoContext.branch;

  const sanitizedExplanation = sanitizePromptText(finding.explanation);
  const sanitizedWhyItMatters = finding.whyItMatters ? sanitizePromptText(finding.whyItMatters) : undefined;
  const sanitizedNextStep = sanitizePromptText(finding.recommendedNextStep);

  // Reasoning block
  let reasoningBlock = '';
  if (finding.reasoning) {
    const factsList = finding.reasoning.facts.map((f) => `  - [Fact] ${f}`).join('\n');
    const inferencesList = finding.reasoning.inferences.map((i) => `  - [Inference] ${i}`).join('\n');
    reasoningBlock = `\n## Grounded Reasoning
- **Direct Observed Facts**:
${factsList || '  - Direct facts established from inspected files.'}
- **Architectural Inferences**:
${inferencesList || '  - Inferred from repository structure and observed patterns.'}
`;
  }

  // Verified code evidence block if present
  let codeEvidenceBlock = '';
  if (finding.codeEvidence?.isVerified) {
    const ce = finding.codeEvidence;
    const lineLabel = ce.lineRange || (ce.derivedLineNumber ? `Line ${ce.derivedLineNumber}` : undefined);
    codeEvidenceBlock = `\n## Verified Code Evidence
- **Source File**: \`${ce.filePath}\`${lineLabel ? ` (${lineLabel})` : ''}
${ce.targetIdentifier ? `- **Verified Identifier**: \`${ce.targetIdentifier}\`` : ''}
${ce.codeSnippet ? `- **Observed Code Statement**: \`${ce.codeSnippet}\`` : ''}
${ce.explanation ? `- **Evidence Assessment**: ${ce.explanation}` : ''}
`;
  }

  // Domain-specific prompt enhancement for whitespace title validation
  const isWhitespaceTitleIssue =
    finding.roomId === 'room-validation' ||
    sanitizedExplanation.toLowerCase().includes('whitespace') ||
    finding.title.toLowerCase().includes('whitespace') ||
    finding.codeEvidence?.targetIdentifier === 'validateTaskTitle';

  let targetedGuidanceBlock = '';
  if (isWhitespaceTitleIssue) {
    targetedGuidanceBlock = `\n## Target Diagnosis & Implementation Grounding
- **Primary Source File**: \`src/tasks/validation.js\`
- **Target Function**: \`validateTaskTitle(title)\`
- **Observed Baseline Logic**: Currently evaluates \`title.length === 0\`, checking raw string length instead of trimmed length and erroneously accepting whitespace-only titles.
- **Relevant Test Suite**: \`test/createTask.test.js\` (asserts rejection of whitespace-only titles with \`TaskValidationError\`).
- **Correction Directive**: Validate trimmed title before accepting, but inspect the current implementation first to confirm the exact function signature and error handling. Do not reference unverified or fabricated identifiers.
`;
  }

  const whyItMattersSection = sanitizedWhyItMatters
    ? `\n## Why It Matters (System & User Consequence)\n${sanitizedWhyItMatters}\n`
    : '';

  if (isWeakEvidence) {
    // Investigation-First Prompt when evidence is weak or unverified
    return `# Investigation & Diagnostic Task: ${finding.roomName}

## Repository Context
- **Repository**: \`${repoContext.owner}/${repoContext.repo}\`
- **Target Branch**: \`${branchRef}\`
- **Architectural Room / Module**: \`${finding.roomName}\` (\`${finding.roomId}\`)
- **Suspected Issue**: ${finding.title}
- **Evidence Classification**: **UNVERIFIED / INSUFFICIENT EVIDENCE** (Category: \`${finding.category}\`, Severity: \`${finding.severity}\`)

## Diagnostic Assessment
${sanitizedExplanation}
${whyItMattersSection}${reasoningBlock}
## Known Uncertainties & Caveats
${finding.uncertainties}

## Supporting References
${refLines}
${codeEvidenceBlock}
---

## Instructions for Coding Agent (Investigation First)

> [!IMPORTANT]
> The suspected issue is currently **unverified**. Do NOT assume this issue exists or make speculative code modifications. You must investigate and verify first.

1. **Investigate Before Editing**:
   - Inspect the codebase to determine whether the suspected issue (\`${finding.title}\`) actually exists or is a false positive.
   - If relevant files were skipped in the initial bounded scan, locate the actual implementation files for \`${finding.roomName}\`.
2. **Determine Root Cause**:
   - If an issue or test gap exists, identify the precise files, functions, or configurations responsible.
   - If the implementation is already sound, report that finding and do not make unnecessary changes.
3. **Targeted Implementation Goals (if verified)**:
   - Resolve the confirmed gap: ${sanitizedNextStep}
   - Avoid refactoring unrelated subsystems or dependencies.
4. **Acceptance Criteria**:
   - The diagnosis is grounded in actual inspected code.
   - Any added or updated logic has corresponding automated tests.
   - \`npm test\` (or the repository's test command) and build pass cleanly.
5. **Reporting & Honesty Policy**:
   - List every file touched, command executed, and test run.
   - **Never claim a test passed unless it was actually executed and returned exit code 0.**
   - Clearly state what was checked, what was skipped, and any remaining risks.
`;
  }

  // Targeted Repair Prompt when evidence is observed or inferred with supporting files
  return `# Task: Address ${finding.title} in ${finding.roomName}

## Repository Context
- **Repository**: \`${repoContext.owner}/${repoContext.repo}\`
- **Target Branch**: \`${branchRef}\`
- **Architectural Room / Module**: \`${finding.roomName}\` (\`${finding.roomId}\`)
- **Issue Category**: \`${finding.category}\`
- **Assessed Severity**: \`${finding.severity.toUpperCase()}\`
- **Evidence Classification**: \`${finding.evidenceClassification.toUpperCase()}\`

## Observed Issue Description
${sanitizedExplanation}
${whyItMattersSection}
## Supporting Evidence & Relevant Files
${refLines}
${codeEvidenceBlock}${targetedGuidanceBlock}${reasoningBlock}
## Known Uncertainties
${finding.uncertainties}

## Recommended Resolution
${sanitizedNextStep}

---

## Instructions for Coding Agent

1. **Verify the Diagnosis**:
   - Inspect the files referenced above before making any edits.
   - Confirm the failure mode or test gap in your local environment.
   - Do NOT assume the fix has already been applied.
   - Ground all edits in the actual code: use verified identifiers (\`validateTaskTitle\`, \`title\`), not unverified or fabricated names.
2. **Scope of Changes**:
   - Focus strictly on addressing \`${finding.title}\`.
   - Preserve existing architectural patterns and avoid unrelated redesigns or refactoring.
3. **Verification Steps**:
   - Run the relevant unit or integration tests for \`${finding.roomName}\` (\`npm test\`).
   - If tests are missing or failing, inspect test assertions in \`test/createTask.test.js\`.
4. **Acceptance Criteria**:
   - Implementation satisfies: ${sanitizedNextStep}
   - Existing and new tests pass without regressions.
   - Project build and type-checking succeed.
5. **Reporting & Honesty Policy**:
   - Explicitly report: files changed, commands run, test outcomes, and remaining issues.
   - **Never claim tests passed or builds succeeded unless they actually ran with passing results.**
`;
}
