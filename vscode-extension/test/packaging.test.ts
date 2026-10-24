import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const candidateRoots = [
  path.resolve(process.cwd()),
  path.resolve(process.cwd(), 'vscode-extension'),
];
const EXTENSION_ROOT = candidateRoots.find((p) => fs.existsSync(path.join(p, 'build.js'))) || candidateRoots[0];
const MAX_BUNDLE_BYTES = 400 * 1024; // 409,600 bytes per architecture limit

describe('VS Code Extension Packaging & Production Build', () => {
  it('package.json specifies version 0.2.0, repository metadata, MIT license, and pinned dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(EXTENSION_ROOT, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.version, '0.2.0');
    assert.strictEqual(pkg.publisher, 'the-living-blueprint');
    assert.strictEqual(pkg.license, 'MIT');
    assert.ok(pkg.repository, 'package.json must contain repository metadata');
    assert.match(pkg.repository.url || pkg.repository, /sakshamgupta005\/Velocity/i);
    assert.strictEqual(pkg.devDependencies['@vscode/test-electron'], '2.4.1');
    assert.strictEqual(pkg.devDependencies['@vscode/vsce'], '3.2.1');
    assert.strictEqual(pkg.scripts['test:host'], 'node test/host/runTest.mjs');
  });

  it('LICENSE file exists and matches the MIT license declaration in package.json', () => {
    const licensePath = path.join(EXTENSION_ROOT, 'LICENSE');
    assert.ok(fs.existsSync(licensePath), 'LICENSE file must exist in extension root');
    const licenseText = fs.readFileSync(licensePath, 'utf8');
    assert.match(licenseText, /MIT License/i);
    assert.match(licenseText, /The Living Blueprint Contributors/i);
  });

  it('compiles production bundle without sourcemap and under the 400 KiB limit', () => {
    execSync('node build.js --production', { cwd: EXTENSION_ROOT, stdio: 'pipe' });

    const bundlePath = path.join(EXTENSION_ROOT, 'out', 'extension.js');
    assert.ok(fs.existsSync(bundlePath), 'out/extension.js must exist after compile:prod');

    const stat = fs.statSync(bundlePath);
    assert.ok(
      stat.size < MAX_BUNDLE_BYTES,
      `Production bundle size (${stat.size} bytes) exceeds limit of ${MAX_BUNDLE_BYTES} bytes`
    );

    const mapPath = path.join(EXTENSION_ROOT, 'out', 'extension.js.map');
    assert.strictEqual(
      fs.existsSync(mapPath),
      false,
      'out/extension.js.map must NOT exist in production build'
    );
  });

  it('packaged file manifest excludes source files, tests, fixtures, and sourcemaps', () => {
    const vsceBin = path.join(EXTENSION_ROOT, '..', 'node_modules', '.bin', 'vsce');
    const cmd = fs.existsSync(vsceBin)
      ? `"${vsceBin}" ls --no-dependencies`
      : 'npx @vscode/vsce ls --no-dependencies';

    const output = execSync(cmd, { cwd: EXTENSION_ROOT, encoding: 'utf8' });
    const lines = output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    // Must include required runtime artifacts
    assert.ok(lines.includes('package.json'), 'Must include package.json');
    assert.ok(lines.includes('out/extension.js') || lines.includes('out\\extension.js'), 'Must include out/extension.js');
    assert.ok(lines.includes('LICENSE'), 'Must include LICENSE');
    assert.ok(
      lines.some((l) => l.includes('media/webview/index.html') || l.includes('media\\webview\\index.html')),
      'Must include webview index.html'
    );
    assert.ok(
      lines.some((l) => l.includes('media/webview/main.js') || l.includes('media\\webview\\main.js')),
      'Must include webview main.js'
    );
    assert.ok(
      lines.some((l) => l.includes('media/webview/styles.css') || l.includes('media\\webview\\styles.css')),
      'Must include webview styles.css'
    );

    // Must exclude sources, tests, fixtures, and sourcemaps
    const forbidden = lines.filter((l) => {
      const normalized = l.replace(/\\/g, '/');
      return (
        normalized.startsWith('src/') ||
        normalized.startsWith('test/') ||
        normalized.startsWith('fixtures/') ||
        normalized.startsWith('.vscode-test/') ||
        normalized.endsWith('.map') ||
        normalized.endsWith('.vsix') ||
        normalized === 'tsconfig.json' ||
        normalized === 'build.js'
      );
    });

    assert.deepStrictEqual(
      forbidden,
      [],
      `VSIX package contains forbidden non-runtime files: ${forbidden.join(', ')}`
    );
  });
});
