/**
 * Question intent classifier for question-aware repository retrieval.
 */

import type { QuestionCategory, QuestionIntent } from './types.ts';

const TEAM_PROJECT_PATTERNS = [
  /\bteam\b/i,
  /\bmembers?\b/i,
  /\bwho\s+(?:made|built|worked|created|wrote|leads?|maintains?|is\s+on|are)\b/i,
  /\bauthor\b/i,
  /\bcreator\b/i,
  /\bcontributor\b/i,
  /\bowner\b/i,
  /\bfounder\b/i,
  /\bmaintainer\b/i,
  /\babout\s+(?:this|the)\s+project\b/i,
  /\bwhat\s+is\s+(?:this|velocity|the\s+project)\b/i,
  /\bwho\s+are\s+the\s+team\b/i,
];

const DOCS_PATTERNS = [
  /\breadme\b/i,
  /\bdocs?\b/i,
  /\bdocumentation\b/i,
  /\bguide\b/i,
  /\bmanual\b/i,
  /\binstructions\b/i,
  /\bhow\s+to\s+use\b/i,
  /\bfeatures?\b/i,
  /\boverview\b/i,
  /\bgetting\s+started\b/i,
];

const TECH_STACK_PATTERNS = [
  /\btechnolog(?:y|ies)\b/i,
  /\btech\s+stack\b/i,
  /\bframeworks?\b/i,
  /\blibrar(?:y|ies)\b/i,
  /\bpackages?\b/i,
  /\bdependencies\b/i,
  /\bwhat\s+is\s+used\b/i,
  /\bwhat\s+does\s+(?:this|it)\s+use\b/i,
  /\bdatabase\b/i,
  /\btools\b/i,
];

const ARCHITECTURE_PATTERNS = [
  /\barchitect(?:ure)?\b/i,
  /\bstructure\b/i,
  /\bfolders?\b/i,
  /\bdirector(?:y|ies)\b/i,
  /\bhow\s+is\s+(?:it|the\s+code|the\s+project)\s+(?:organized|structured)\b/i,
  /\blayout\b/i,
  /\blayers?\b/i,
  /\bwhat\s+folders\s+exist\b/i,
  /\btree\b/i,
];

const CODE_DEBUGGING_PATTERNS = [
  /\b(?:bug|broken|error|failing|failed|failure|issue|defect)\b/i,
  /\bwhy\s+is\b/i,
  /\bwhere\s+is\b/i,
  /\bhow\s+does\s+.*work\b/i,
  /\bimplement(?:ed|ation)?\b/i,
  /\bauth(?:entication)?\b/i,
  /\bjwt\b/i,
  /\btoken\b/i,
  /\bpayment\b/i,
  /\bcart\b/i,
  /\bstripe\b/i,
  /\bapi\b/i,
  /\broute\b/i,
  /\bhandler\b/i,
  /\bfunction\b/i,
  /\bendpoint\b/i,
];

/**
 * Extracts possible file path or filename mentions from user query (e.g. "README.md", "auth.ts", "package.json").
 */
function extractFileHints(query: string): string[] {
  const hints: string[] = [];
  const fileRegex = /\b([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]{1,5})\b/g;
  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(query)) !== null) {
    hints.push(match[1].toLowerCase());
  }
  if (/\breadme\b/i.test(query) && !hints.some((h) => h.includes('readme'))) {
    hints.push('readme');
  }
  return hints;
}

/**
 * Classifies a user query into an actionable QuestionIntent.
 */
export function classifyQuestion(rawQuery: string): QuestionIntent {
  const clean = (rawQuery || '').trim();
  const lower = clean.toLowerCase();

  const fileHints = extractFileHints(clean);

  // Extract non-stopword query keywords
  const keywords = lower
    .replace(/[^a-z0-9_\-\.\/]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !['what', 'when', 'where', 'which', 'who', 'this', 'that', 'from', 'with', 'about', 'does'].includes(w));

  let category: QuestionCategory = 'general';

  // 1. Team or project info (High priority classification)
  if (TEAM_PROJECT_PATTERNS.some((p) => p.test(clean))) {
    category = 'team_or_project';
  } else if (DOCS_PATTERNS.some((p) => p.test(clean))) {
    category = 'documentation';
  } else if (TECH_STACK_PATTERNS.some((p) => p.test(clean))) {
    category = 'technology_stack';
  } else if (ARCHITECTURE_PATTERNS.some((p) => p.test(clean))) {
    category = 'architecture';
  } else if (CODE_DEBUGGING_PATTERNS.some((p) => p.test(clean))) {
    category = 'code_debugging';
  }

  return {
    category,
    rawQuery: clean,
    keywords,
    targetFileHints: fileHints,
  };
}
