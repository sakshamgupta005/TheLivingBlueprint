import type {
  EvidenceClassification,
  InvestigateApiRequest,
  IssueCategory,
  IssueSeverity,
  RoomInvestigationFinding,
  ValidatedCodeEvidence,
  ValidatedEvidenceRef,
} from './types.ts';
import type { CompanionReplyMessage } from '../../server/types.ts';

const VALID_CATEGORIES = new Set<IssueCategory>([
  'missing_proof',
  'possible_bug',
  'security_risk',
  'configuration_risk',
  'test_gap',
  'dependency_risk',
  'cascade_risk',
  'unknown',
]);

const VALID_SEVERITIES = new Set<IssueSeverity>(['info', 'low', 'medium', 'high']);
const VALID_CLASSIFICATIONS = new Set<EvidenceClassification>(['observed', 'inferred', 'unverified']);

export interface RawCodeEvidencePayload {
  filePath?: unknown;
  targetIdentifier?: unknown;
  codeSnippet?: unknown;
  explanation?: unknown;
}

export interface RawInvestigationPayload {
  title?: unknown;
  explanation?: unknown;
  whyItMatters?: unknown;
  category?: unknown;
  severity?: unknown;
  evidenceClassification?: unknown;
  evidencePaths?: unknown;
  codeEvidence?: RawCodeEvidencePayload;
  reasoning?: {
    facts?: unknown;
    inferences?: unknown;
  } | unknown;
  recommendedNextStep?: unknown;
  uncertainties?: unknown;
  companionMessages?: unknown;
}

export function validateInvestigationFinding(
  raw: RawInvestigationPayload,
  request: InvestigateApiRequest
): RoomInvestigationFinding {
  const { roomId, roomName, repoContext } = request;

  // 1. Title & Explanation
  const rawTitle =
    typeof raw.title === 'string' && raw.title.trim()
      ? raw.title.trim()
      : 'Architecture & Evidence Review';
  const rawExplanation =
    typeof raw.explanation === 'string' && raw.explanation.trim()
      ? raw.explanation.trim()
      : 'No specific issue identified from current evidence.';
  const rawWhyItMatters =
    typeof raw.whyItMatters === 'string' && raw.whyItMatters.trim()
      ? raw.whyItMatters.trim()
      : undefined;
  const rawNextStep =
    typeof raw.recommendedNextStep === 'string' && raw.recommendedNextStep.trim()
      ? raw.recommendedNextStep.trim()
      : 'Verify implementation files and add automated test coverage.';
  const rawUncertainties =
    typeof raw.uncertainties === 'string' && raw.uncertainties.trim()
      ? raw.uncertainties.trim()
      : 'Limited to inspected file sample. Full test execution unverified.';

  // 2. Category
  let category: IssueCategory = 'unknown';
  if (typeof raw.category === 'string' && VALID_CATEGORIES.has(raw.category as IssueCategory)) {
    category = raw.category as IssueCategory;
  }

  // 3. Severity
  let severity: IssueSeverity = 'info';
  if (typeof raw.severity === 'string' && VALID_SEVERITIES.has(raw.severity as IssueSeverity)) {
    severity = raw.severity as IssueSeverity;
  }

  // 4. Evidence Classification
  let classification: EvidenceClassification = 'inferred';
  if (
    typeof raw.evidenceClassification === 'string' &&
    VALID_CLASSIFICATIONS.has(raw.evidenceClassification as EvidenceClassification)
  ) {
    classification = raw.evidenceClassification as EvidenceClassification;
  }

  // 5. Build lookup maps from inspected files and git tree paths
  const inspectedFileMap = new Map<
    string,
    { path: string; category: string; contentExcerpt: string }
  >();
  for (const f of repoContext.inspectedFiles) {
    if (f && f.path) {
      inspectedFileMap.set(f.path.toLowerCase(), {
        path: f.path,
        category: f.category,
        contentExcerpt: f.contentExcerpt || '',
      });
    }
  }

  const discoveredPathSet = new Set(
    (repoContext.discoveredFilePaths || []).map((p) =>
      typeof p === 'string' ? p.toLowerCase() : ''
    )
  );

  const validatedRefs: ValidatedEvidenceRef[] = [];
  const rejectedPaths: string[] = [];
  const rawPaths = Array.isArray(raw.evidencePaths) ? raw.evidencePaths : [];

  for (const item of rawPaths) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const cleanPath = item.trim();
    const lower = cleanPath.toLowerCase();

    const inspected = inspectedFileMap.get(lower);
    const isDiscovered = discoveredPathSet.has(lower);

    if (inspected) {
      validatedRefs.push({
        path: inspected.path,
        isInspected: true,
        githubUrl: `https://github.com/${repoContext.owner}/${repoContext.repo}/blob/${repoContext.branch}/${inspected.path}`,
        note: inspected.contentExcerpt
          ? 'Code inspected in current scan'
          : 'File catalogued in scan, but content empty or uninspected',
      });
    } else if (isDiscovered) {
      validatedRefs.push({
        path: cleanPath,
        isInspected: false,
        githubUrl: `https://github.com/${repoContext.owner}/${repoContext.repo}/blob/${repoContext.branch}/${cleanPath}`,
        note: 'Discovered in git tree, but content not inspected in sample',
      });
    } else {
      // Fabricated / ungrounded path: rejected and explicitly tracked
      rejectedPaths.push(cleanPath);
    }
  }

  // 6. Validate Code Evidence (excerpt, identifier, line numbers)
  let validatedCodeEvidence: ValidatedCodeEvidence | undefined;
  let codeEvidenceVerified = false;
  const rejectedCodeItems: string[] = [];

  if (raw.codeEvidence && typeof raw.codeEvidence === 'object') {
    const rawCe = raw.codeEvidence;
    const rawFilePath = typeof rawCe.filePath === 'string' ? rawCe.filePath.trim() : '';
    const rawIdent =
      typeof rawCe.targetIdentifier === 'string' ? rawCe.targetIdentifier.trim() : undefined;
    const rawSnippet =
      typeof rawCe.codeSnippet === 'string' ? rawCe.codeSnippet.trim() : undefined;
    const rawCeExp =
      typeof rawCe.explanation === 'string' ? rawCe.explanation.trim() : undefined;

    if (rawFilePath) {
      const inspected = inspectedFileMap.get(rawFilePath.toLowerCase());
      if (!inspected || !inspected.contentExcerpt) {
        rejectedCodeItems.push(`codeEvidence file "${rawFilePath}" (content not inspected)`);
        validatedCodeEvidence = {
          filePath: rawFilePath,
          targetIdentifier: rawIdent,
          codeSnippet: rawSnippet,
          isVerified: false,
          explanation: rawCeExp,
        };
      } else {
        const fileContent = inspected.contentExcerpt;
        let snippetFound = true;
        let derivedLineNumber: number | undefined;

        if (rawSnippet) {
          const matchIdx = fileContent.indexOf(rawSnippet);
          if (matchIdx !== -1) {
            // Derive 1-indexed line number directly from inspected source content
            derivedLineNumber = fileContent.slice(0, matchIdx).split('\n').length;
            const lineCount = rawSnippet.split('\n').length;
            const endLine = derivedLineNumber + lineCount - 1;
            const lineRange = derivedLineNumber === endLine ? `L${derivedLineNumber}` : `L${derivedLineNumber}-L${endLine}`;
            (rawCe as any)._derivedLineRange = lineRange;
          } else {
            snippetFound = false;
            rejectedCodeItems.push(
              `codeEvidence snippet "${rawSnippet}" (not found in ${inspected.path})`
            );
          }
        }

        let identFound = true;
        if (rawIdent) {
          if (!fileContent.includes(rawIdent)) {
            identFound = false;
            rejectedCodeItems.push(
              `codeEvidence identifier "${rawIdent}" (not found in ${inspected.path})`
            );
          }
        }

        const derivedLineRange = (rawCe as any)._derivedLineRange as string | undefined;

        if (snippetFound && identFound && (rawSnippet || rawIdent)) {
          codeEvidenceVerified = true;
          validatedCodeEvidence = {
            filePath: inspected.path,
            targetIdentifier: rawIdent,
            codeSnippet: rawSnippet,
            derivedLineNumber,
            lineRange: derivedLineRange,
            isVerified: true,
            explanation: rawCeExp,
          };
        } else {
          validatedCodeEvidence = {
            filePath: inspected.path,
            targetIdentifier: rawIdent,
            codeSnippet: rawSnippet,
            isVerified: false,
            explanation: rawCeExp,
          };
        }
      }
    }
  }

  // 7. Check for Hallucinated Identifiers in Explanation, Next Step, or Reasoning
  const knownHallucinated = ['validateTaskInput', 'input.title'];
  for (const fab of knownHallucinated) {
    const inReasoning =
      raw.reasoning &&
      typeof raw.reasoning === 'object' &&
      Array.isArray((raw.reasoning as Record<string, unknown>).facts) &&
      ((raw.reasoning as Record<string, unknown>).facts as unknown[]).some(
        (item) => typeof item === 'string' && item.includes(fab)
      );
    const appearsInRaw =
      rawTitle.includes(fab) ||
      rawExplanation.includes(fab) ||
      (rawWhyItMatters && rawWhyItMatters.includes(fab)) ||
      rawNextStep.includes(fab) ||
      inReasoning;
    if (appearsInRaw) {
      let reallyExists = false;
      for (const f of inspectedFileMap.values()) {
        if (f.contentExcerpt.includes(fab)) {
          reallyExists = true;
          break;
        }
      }
      if (!reallyExists) {
        rejectedCodeItems.push(`${fab} (fabricated identifier)`);
      }
    }
  }

  // Enrich matching validatedRefs with verified code evidence
  if (validatedCodeEvidence?.isVerified) {
    for (const ref of validatedRefs) {
      if (ref.path.toLowerCase() === validatedCodeEvidence.filePath.toLowerCase()) {
        ref.verifiedExcerpt = validatedCodeEvidence.codeSnippet;
        ref.verifiedIdentifier = validatedCodeEvidence.targetIdentifier;
        ref.derivedLineNumber = validatedCodeEvidence.derivedLineNumber;
        ref.lineRange = validatedCodeEvidence.lineRange;
        if (ref.derivedLineNumber) {
          ref.note = `Code inspected (${ref.lineRange || `Line ${ref.derivedLineNumber}`})`;
        }
      }
    }
  }

  // Append explicit rejection notice to uncertainties
  let finalUncertainties = rawUncertainties;
  if (rejectedPaths.length > 0) {
    const rejectionNotice = `[REJECTED UNGROUNDED EVIDENCE: Excluded ${rejectedPaths.length} path(s) not found in scanned git tree: ${rejectedPaths.join(', ')}]`;
    finalUncertainties = finalUncertainties ? `${finalUncertainties} ${rejectionNotice}` : rejectionNotice;
  }
  if (rejectedCodeItems.length > 0) {
    const codeRejectionNotice = `[REJECTED CODE CLAIMS: Excluded ${rejectedCodeItems.length} unsupported code item(s): ${rejectedCodeItems.join(', ')}]`;
    finalUncertainties = finalUncertainties ? `${finalUncertainties} ${codeRejectionNotice}` : codeRejectionNotice;
  }

  // 8. Classification Grounding Rules:
  // An existing file path is NOT proof of code behavior.
  // To be 'observed':
  // - Must have at least one inspected file among validated references.
  // - Zero rejected paths or code items.
  // - If codeEvidence was provided, it must be verified.
  const hasInspectedRef = validatedRefs.some((r) => r.isInspected);
  if (classification === 'observed') {
    if (!hasInspectedRef || rejectedPaths.length > 0 || rejectedCodeItems.length > 0) {
      classification = validatedRefs.length > 0 ? 'inferred' : 'unverified';
    } else if (raw.codeEvidence && !codeEvidenceVerified) {
      classification = 'inferred';
    }
  }

  // If there are zero valid references, classify as unverified
  if (validatedRefs.length === 0 && classification === 'observed') {
    classification = 'unverified';
  }

  // Justify severity: unverified or unknown issues cannot be marked 'high'
  if ((classification === 'unverified' || category === 'unknown') && severity === 'high') {
    severity = 'medium';
  }

  // 9. Reasoning: Separate Direct Observed Facts from Inferences
  let reasoningFacts: string[] = [];
  let reasoningInferences: string[] = [];

  if (raw.reasoning && typeof raw.reasoning === 'object') {
    const rObj = raw.reasoning as Record<string, unknown>;
    if (Array.isArray(rObj.facts)) {
      reasoningFacts = rObj.facts
        .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
        .map((f) => f.trim().slice(0, 300));
    }
    if (Array.isArray(rObj.inferences)) {
      reasoningInferences = rObj.inferences
        .filter((i): i is string => typeof i === 'string' && i.trim().length > 0)
        .map((i) => i.trim().slice(0, 300));
    }
  }

  // If facts are empty, construct direct facts from real evidence
  if (reasoningFacts.length === 0) {
    if (validatedCodeEvidence?.isVerified && validatedCodeEvidence.codeSnippet) {
      reasoningFacts.push(
        `Inspected \`${validatedCodeEvidence.filePath}\`${validatedCodeEvidence.lineRange ? ` (${validatedCodeEvidence.lineRange})` : ''} contains statement: \`${validatedCodeEvidence.codeSnippet.replace(/\s+/g, ' ').slice(0, 90)}\``
      );
    }
    for (const ref of validatedRefs.slice(0, 3)) {
      if (ref.isInspected) {
        reasoningFacts.push(`Inspected file \`${ref.path}\` catalogued in scanned commit.`);
      }
    }
    if (repoContext.ciEvaluation?.failedChecks && repoContext.ciEvaluation.failedChecks.length > 0) {
      reasoningFacts.push(`CI check failed on scanned commit: ${repoContext.ciEvaluation.failedChecks.join(', ')}`);
    }
    if (reasoningFacts.length === 0) {
      reasoningFacts.push('No direct code facts established from inspected files.');
    }
  }

  // If inferences are empty, construct from explanation
  if (reasoningInferences.length === 0) {
    reasoningInferences.push(
      rawExplanation.length > 250 ? `${rawExplanation.slice(0, 247)}...` : rawExplanation
    );
    if (classification === 'inferred') {
      reasoningInferences.push('Concluded via architectural pattern analysis; runtime execution has not been verified.');
    }
  }

  // Filter out rejected items and fabricated identifiers from facts
  for (const fab of knownHallucinated) {
    reasoningFacts = reasoningFacts.filter((f) => !f.includes(fab));
  }
  if (rejectedCodeItems.length > 0) {
    reasoningFacts = reasoningFacts.filter(
      (f) => !rejectedCodeItems.some((rej) => f.includes(rej.split(' ')[0]))
    );
  }

  // 10. Companion Messages
  const companionMessages: CompanionReplyMessage[] = [];
  if (Array.isArray(raw.companionMessages)) {
    for (const msg of raw.companionMessages.slice(0, 2)) {
      if (
        msg &&
        typeof msg === 'object' &&
        (msg.speaker === 'dog' || msg.speaker === 'cat') &&
        typeof msg.text === 'string' &&
        msg.text.trim()
      ) {
        companionMessages.push({
          speaker: msg.speaker,
          text: msg.text.trim().slice(0, 300),
          evidenceReference:
            typeof msg.evidenceReference === 'string' ? msg.evidenceReference.slice(0, 100) : undefined,
        });
      }
    }
  }

  if (companionMessages.length === 0) {
    companionMessages.push({
      speaker: 'dog',
      text: `Barkley here! I investigated ${roomName}. Here is what the current evidence supports.`,
    });
  }

  const allRejected = [...rejectedPaths, ...rejectedCodeItems];

  // Synthesize whyItMatters if not explicitly provided
  const resolvedWhyItMatters =
    rawWhyItMatters ||
    (category === 'security_risk'
      ? 'Security risks can expose sensitive tokens, permit unauthorized operations, or bypass access control.'
      : category === 'possible_bug'
      ? 'Logic defects can cause unhandled exceptions, incorrect calculations, or degraded user transactions.'
      : category === 'test_gap' || category === 'missing_proof'
      ? 'Unverified implementation allows regressions to slip into production without detection by continuous integration.'
      : 'Architectural unverified scope introduces uncertainty and coupling risk across modules.');

  return {
    roomId,
    roomName,
    title: rawTitle.slice(0, 120),
    explanation: rawExplanation.slice(0, 800),
    whyItMatters: resolvedWhyItMatters.slice(0, 400),
    category,
    severity,
    evidenceClassification: classification,
    evidenceReferences: validatedRefs,
    rejectedReferences: allRejected.length > 0 ? allRejected : undefined,
    codeEvidence: validatedCodeEvidence,
    reasoning: {
      facts: reasoningFacts,
      inferences: reasoningInferences,
    },
    recommendedNextStep: rawNextStep.slice(0, 300),
    uncertainties: finalUncertainties.slice(0, 500),
    companionMessages,
  };
}
