import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';

const candidateSrcPaths = [
  path.resolve(process.cwd(), 'src'),
  path.resolve(process.cwd(), 'vscode-extension', 'src'),
];
const srcDir = candidateSrcPaths.find((p) => fs.existsSync(p)) || candidateSrcPaths[0];

const candidateExtPaths = [
  path.resolve(process.cwd()),
  path.resolve(process.cwd(), 'vscode-extension'),
];
const extDir = candidateExtPaths.find((p) => fs.existsSync(path.join(p, 'build.js'))) || candidateExtPaths[0];

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

const APPROVED_ROOT_PATTERNS = [
  /^src\/domain\/github\//,
  /^src\/domain\/graph\//,
  /^src\/domain\/investigation\//,
  /^src\/domain\/statusEngine(?:\/|\.ts$)/,
  /^src\/domain\/types(?:\/|\.ts$)/,
  /^src\/domain\/architectureViews\//,
  /^src\/domain\/evidenceChain\//,
  /^src\/domain\/lifecycle\//,
  /^src\/server\//,
  /^src\/types(?:\/|\.ts$)/,
];

const FORBIDDEN_PACKAGES = [
  /^react(?:-dom)?$/,
  /^d3(?:-.*)?$/,
  /^(?:@xyflow\/react|reactflow)$/,
  /^typescript$/,
];

const FORBIDDEN_ROOT_PATTERNS = [
  /^src\/domain\/codeIndex(?:\/|\.ts$)/,
  /^src\/components(?:\/|$)/,
];

describe('VS Code Extension - Import Boundaries & Transitive Bundle Guards (P2-06)', () => {
  it('1. Extension source files only import from approved root domains and never forbidden packages', () => {
    const tsFiles = getAllTsFiles(srcDir);
    assert.ok(tsFiles.length > 0, 'Must find extension TypeScript source files');

    const importRegex = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g;

    for (const filePath of tsFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      let match: RegExpExecArray | null;

      while ((match = importRegex.exec(content)) !== null) {
        const importSpecifier = match[1];

        // 1a. Assert not importing forbidden npm packages
        for (const forbiddenPkg of FORBIDDEN_PACKAGES) {
          assert.strictEqual(
            forbiddenPkg.test(importSpecifier),
            false,
            `File ${path.relative(srcDir, filePath)} imports forbidden package: ${importSpecifier}`
          );
        }

        // 1b. Assert not importing from components or other forbidden root modules
        for (const forbiddenPattern of FORBIDDEN_ROOT_PATTERNS) {
          assert.strictEqual(
            forbiddenPattern.test(importSpecifier),
            false,
            `File ${path.relative(srcDir, filePath)} imports forbidden root pattern: ${importSpecifier}`
          );
        }

        // 1c. If importing from root repo, verify approved domain area
        if (importSpecifier.includes('/src/')) {
          const resolvedPath = path.resolve(path.dirname(filePath), importSpecifier);
          const repoRoot = path.resolve(srcDir, '..', '..');
          const relToRepo = path.relative(repoRoot, resolvedPath).replace(/\\/g, '/');

          for (const forbiddenPattern of FORBIDDEN_ROOT_PATTERNS) {
            assert.strictEqual(
              forbiddenPattern.test(relToRepo),
              false,
              `File ${path.relative(srcDir, filePath)} imports forbidden root area: ${relToRepo}`
            );
          }

          const isApproved = APPROVED_ROOT_PATTERNS.some((pat) => pat.test(relToRepo));
          assert.ok(
            isApproved,
            `Unapproved root import in ${path.relative(srcDir, filePath)}: ${importSpecifier} -> ${relToRepo}`
          );
        }
      }
    }
  });

  it('2. Pure core adapter layer (src/core/*) has ZERO vscode imports', () => {
    const coreDir = path.join(srcDir, 'core');
    assert.ok(fs.existsSync(coreDir), 'src/core/ directory must exist');

    const coreFiles = getAllTsFiles(coreDir);
    assert.ok(coreFiles.length >= 4, 'src/core/ must contain adapter files');

    const importRegex = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g;

    for (const filePath of coreFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      let match: RegExpExecArray | null;

      while ((match = importRegex.exec(content)) !== null) {
        const importSpecifier = match[1];
        assert.notStrictEqual(
          importSpecifier,
          'vscode',
          `Core adapter file ${path.relative(coreDir, filePath)} must not import 'vscode'`
        );
      }
    }
  });

  it('3. Transitive compiled bundle (out/extension.js) strictly excludes forbidden libraries and TypeScript compiler', () => {
    const outJsPath = path.join(extDir, 'out', 'extension.js');
    assert.ok(fs.existsSync(outJsPath), 'Compiled bundle out/extension.js must exist');

    // Stale bundle detection: fail if out/extension.js is older than any file in src/
    const bundleStat = fs.statSync(outJsPath);
    const tsFiles = getAllTsFiles(srcDir);
    for (const srcFile of tsFiles) {
      const srcStat = fs.statSync(srcFile);
      if (bundleStat.mtimeMs < srcStat.mtimeMs) {
        assert.fail(
          `Compiled bundle out/extension.js is older than source file: ${path.relative(extDir, srcFile)}. Run npm run compile before running tests.`
        );
      }
    }

    const bundleContent = fs.readFileSync(outJsPath, 'utf8');
    const bundleSizeBytes = bundleStat.size;

    // TypeScript compiler package markers
    assert.strictEqual(
      bundleContent.includes('ts.createProgram') || bundleContent.includes('ts.version ='),
      false,
      'Compiled bundle must not bundle the TypeScript compiler'
    );

    // React library markers
    assert.strictEqual(
      bundleContent.includes('__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED'),
      false,
      'Compiled bundle must not bundle React'
    );

    // React Flow markers
    assert.strictEqual(
      bundleContent.includes('applyNodeChanges') || bundleContent.includes('applyEdgeChanges'),
      false,
      'Compiled bundle must not bundle React Flow'
    );

    // React component markers
    assert.strictEqual(
      bundleContent.includes('ExpandedVisualizationShell'),
      false,
      'Compiled bundle must not bundle ExpandedVisualizationShell'
    );

    // Bundle size sanity: TypeScript compiler is ~7MB+; our bundle is under 400KB
    assert.ok(
      bundleSizeBytes < 400 * 1024,
      `Bundle size (${bundleSizeBytes} bytes) indicates no heavy compiler was bundled`
    );
  });
});
