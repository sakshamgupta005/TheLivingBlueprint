import type {
  MappedTest,
  MappedTestAssertion,
  TestMappingType,
} from './types.ts';
import type { GitHubCheckRun } from '../lifecycle/types.ts';

export interface TestMapperInputFile {
  path: string;
  content: string;
  category?: string;
}

export interface ImplementationTarget {
  filePath: string;
  symbolName?: string;
  symbolKind?: string;
  line?: number;
}

/**
 * Normalizes relative paths to match repository root.
 */
function normalizeRelativePath(currentFilePath: string, relativePath: string): string {
  const dirParts = currentFilePath.replace(/\\/g, '/').split('/').slice(0, -1);
  const specParts = relativePath.replace(/\\/g, '/').split('/');

  for (const part of specParts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (dirParts.length > 0) dirParts.pop();
    } else {
      dirParts.push(part);
    }
  }

  let resolved = dirParts.join('/');
  // Strip extensions for agnostic matching
  resolved = resolved.replace(/\.(ts|js|tsx|jsx|mjs|cjs)$/, '');
  return resolved;
}

function getBasename(filePath: string): string {
  const name = filePath.replace(/\\/g, '/').split('/').pop() || '';
  return name.replace(/\.(test|spec)\.(ts|js|tsx|jsx|mjs|cjs)$/, '').replace(/\.(ts|js|tsx|jsx|mjs|cjs)$/, '');
}

/**
 * Extracts test cases (it / test blocks) with line numbers from source text.
 */
function extractTestCases(content: string): Array<{ name: string; startLine: number; endLine: number; body: string }> {
  const testCases: Array<{ name: string; startLine: number; endLine: number; body: string }> = [];
  const lines = content.split('\n');

  // Match: it('name', ...), it("name", ...), test('name', ...)
  const testRegex = /(?:it|test)\s*\(\s*(['"`])(.*?)\1\s*,/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match: RegExpExecArray | null;
    testRegex.lastIndex = 0;
    while ((match = testRegex.exec(line)) !== null) {
      const name = match[2];
      const startLine = i + 1;
      // Approximate test body by scanning next 25 lines or until next it/describe
      const bodyLines = lines.slice(i, Math.min(lines.length, i + 35));
      testCases.push({
        name,
        startLine,
        endLine: Math.min(lines.length, i + 35),
        body: bodyLines.join('\n'),
      });
    }
  }

  return testCases;
}

/**
 * Extracts assertions from text lines.
 */
function extractAssertions(content: string, startLine = 1): MappedTestAssertion[] {
  const assertions: MappedTestAssertion[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i].trim();
    const lineNum = startLine + i;

    if (lineText.includes('assert.throws')) {
      assertions.push({
        expression: lineText,
        line: lineNum,
        kind: 'assert_throws',
      });
    } else if (lineText.includes('assert.strictEqual') || lineText.includes('assert.equal') || lineText.includes('assert.deepStrictEqual')) {
      assertions.push({
        expression: lineText,
        line: lineNum,
        kind: 'assert_equal',
      });
    } else if (lineText.includes('assert.ok') || lineText.includes('assert.notStrictEqual')) {
      assertions.push({
        expression: lineText,
        line: lineNum,
        kind: 'generic',
      });
    } else if (lineText.includes('expect(')) {
      assertions.push({
        expression: lineText,
        line: lineNum,
        kind: 'expect',
      });
    }
  }

  return assertions;
}

/**
 * Extracts imported symbols and specifiers from JavaScript/TypeScript code.
 */
function extractImports(
  sourcePath: string,
  content: string
): Array<{ specifier: string; resolvedBase: string; symbols: string[]; line: number }> {
  const imports: Array<{ specifier: string; resolvedBase: string; symbols: string[]; line: number }> = [];
  const lines = content.split('\n');

  // ESM: import { a, b } from '../path'
  const esmNamed = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  // ESM: import Foo from '../path'
  const esmDefault = /import\s+([A-Za-z0-9_$]+)\s+from\s+['"]([^'"]+)['"]/g;
  // CJS: const { a, b } = require('../path')
  const cjsNamed = /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  // CJS: const Foo = require('../path')
  const cjsDefault = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    let m: RegExpExecArray | null;

    esmNamed.lastIndex = 0;
    while ((m = esmNamed.exec(line)) !== null) {
      const symbols = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      const spec = m[2];
      imports.push({
        specifier: spec,
        resolvedBase: normalizeRelativePath(sourcePath, spec),
        symbols,
        line: lineNum,
      });
    }

    esmDefault.lastIndex = 0;
    while ((m = esmDefault.exec(line)) !== null) {
      const sym = m[1].trim();
      const spec = m[2];
      if (sym !== '{') {
        imports.push({
          specifier: spec,
          resolvedBase: normalizeRelativePath(sourcePath, spec),
          symbols: [sym],
          line: lineNum,
        });
      }
    }

    cjsNamed.lastIndex = 0;
    while ((m = cjsNamed.exec(line)) !== null) {
      const symbols = m[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean);
      const spec = m[2];
      imports.push({
        specifier: spec,
        resolvedBase: normalizeRelativePath(sourcePath, spec),
        symbols,
        line: lineNum,
      });
    }

    cjsDefault.lastIndex = 0;
    while ((m = cjsDefault.exec(line)) !== null) {
      const sym = m[1].trim();
      const spec = m[2];
      if (sym !== '{') {
        imports.push({
          specifier: spec,
          resolvedBase: normalizeRelativePath(sourcePath, spec),
          symbols: [sym],
          line: lineNum,
        });
      }
    }
  }

  return imports;
}

export interface MapTestsOptions {
  testFiles: TestMapperInputFile[];
  targetImplementation: ImplementationTarget;
  scannedCommitSha?: string;
  checkRuns?: GitHubCheckRun[];
}

/**
 * Maps tests to an implementation symbol or file using imports, direct references, assertions,
 * and explicit source evidence. Labels heuristic associations separately.
 */
export function mapTestsToImplementation(options: MapTestsOptions): MappedTest[] {
  const { testFiles, targetImplementation, scannedCommitSha, checkRuns = [] } = options;
  const mapped: MappedTest[] = [];

  const targetPathNorm = targetImplementation.filePath.replace(/\\/g, '/');
  const targetBase = targetPathNorm.replace(/\.(ts|js|tsx|jsx|mjs|cjs)$/, '');
  const targetBasename = getBasename(targetPathNorm);
  const targetSymbolName = targetImplementation.symbolName;

  // Evaluate matching CI check runs for exact scanned commit
  const commitMatchingChecks = checkRuns.filter(
    (c) => !c.commitSha || !scannedCommitSha || c.commitSha === scannedCommitSha
  );
  const testChecks = commitMatchingChecks.filter((c) => c.isRelevantTestCheck);
  const testExecuted = testChecks.some((c) => c.status === 'completed');
  const testPassed = testChecks.length > 0 && testChecks.every((c) => c.conclusion === 'success');

  for (const testFile of testFiles) {
    const testPathNorm = testFile.path.replace(/\\/g, '/');
    const isTestFile =
      testFile.category === 'test' ||
      /\.(test|spec)\./i.test(testPathNorm) ||
      /^test[s]?\//i.test(testPathNorm);

    if (!isTestFile) continue;

    const imports = extractImports(testPathNorm, testFile.content);
    const testCases = extractTestCases(testFile.content);
    const allAssertions = extractAssertions(testFile.content);

    // 1. Check for Syntax-Level Import Match
    let syntaxMatchedImport = imports.find(
      (imp) =>
        imp.resolvedBase === targetBase ||
        targetBase.endsWith(imp.resolvedBase) ||
        imp.resolvedBase.endsWith(targetBase)
    );

    let hasSymbolSyntaxMatch = false;
    if (syntaxMatchedImport && targetSymbolName) {
      hasSymbolSyntaxMatch = syntaxMatchedImport.symbols.includes(targetSymbolName);
    }

    // Direct symbol call reference in the test file body
    const hasSymbolCall =
      Boolean(targetSymbolName) &&
      new RegExp(`\\b${targetSymbolName}\\s*\\(`, 'g').test(testFile.content);

    // If syntax match exists via import, explicit symbol matching, or direct symbol invocation
    if (syntaxMatchedImport || hasSymbolCall || hasSymbolSyntaxMatch) {
      const mappingType: TestMappingType = 'syntax';

      // Find specific test cases referencing this implementation or symbol
      const relevantCases = testCases.filter((tc) => {
        if (targetSymbolName && tc.body.includes(targetSymbolName)) return true;
        if (syntaxMatchedImport && syntaxMatchedImport.symbols.some((s) => tc.body.includes(s))) return true;
        return false;
      });

      if (relevantCases.length > 0) {
        for (const tc of relevantCases) {
          const caseAssertions = extractAssertions(tc.body, tc.startLine);
          mapped.push({
            id: `test-map-${testPathNorm}#${tc.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
            testFilePath: testPathNorm,
            testCaseName: tc.name,
            lineRange: { startLine: tc.startLine, endLine: tc.endLine },
            mappingType,
            targetSymbol: targetSymbolName
              ? {
                  name: targetSymbolName,
                  filePath: targetPathNorm,
                  line: targetImplementation.line,
                }
              : undefined,
            evidence: `Syntax-confirmed mapping: Test case "${tc.name}" imports and calls "${targetSymbolName || targetBasename}" (lines ${tc.startLine}-${tc.endLine})`,
            assertions: caseAssertions,
            claims: {
              testFileDetected: true,
              testReferencesCode: true,
              testExecuted,
              testPassed,
            },
          });
        }
      } else {
        // File-level syntax mapping
        mapped.push({
          id: `test-map-${testPathNorm}`,
          testFilePath: testPathNorm,
          mappingType,
          targetSymbol: targetSymbolName
            ? {
                name: targetSymbolName,
                filePath: targetPathNorm,
                line: targetImplementation.line,
              }
            : undefined,
          evidence: `Syntax-confirmed mapping: Test file "${testPathNorm}" explicitly imports "${syntaxMatchedImport?.symbols.join(', ') || targetSymbolName || targetBasename}" from "${targetPathNorm}"`,
          assertions: allAssertions,
          claims: {
            testFileDetected: true,
            testReferencesCode: true,
            testExecuted,
            testPassed,
          },
        });
      }
      continue;
    }

    // 2. Check for Heuristic Association (File naming convention or basename match)
    const testBasename = getBasename(testPathNorm);
    const isHeuristicMatch =
      testBasename === targetBasename ||
      testBasename.includes(targetBasename) ||
      targetBasename.includes(testBasename);

    if (isHeuristicMatch) {
      mapped.push({
        id: `test-map-heuristic-${testPathNorm}`,
        testFilePath: testPathNorm,
        mappingType: 'heuristic',
        targetSymbol: targetSymbolName
          ? {
              name: targetSymbolName,
              filePath: targetPathNorm,
              line: targetImplementation.line,
            }
          : undefined,
        evidence: `Heuristic association: Test file "${testPathNorm}" matches implementation file "${targetPathNorm}" by name convention, without explicit AST symbol import.`,
        assertions: allAssertions,
        claims: {
          testFileDetected: true,
          testReferencesCode: true,
          testExecuted,
          testPassed,
        },
      });
    }
  }

  return mapped;
}
