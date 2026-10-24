import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  validateInboundMessage,
  getRejectedMessagesCount,
  resetRejectedMessagesCount,
  handleFolderSelection,
} from '../src/protocol.ts';
import {
  resolveWorkspaceFile,
} from '../src/pathResolver.ts';

const candidatePaths = [
  path.resolve(process.cwd(), 'test', 'fixtures'),
  path.resolve(process.cwd(), 'vscode-extension', 'test', 'fixtures'),
];
const fixturesDir = candidatePaths.find((p) => fs.existsSync(p)) || candidatePaths[0];
const expressFixture = path.join(fixturesDir, 'small-express');
const tsLibFixture = path.join(fixturesDir, 'ts-lib');

describe('VS Code Extension - Protocol, Secure File Resolution & CSP Audit (P2-05)', () => {
  beforeEach(() => {
    resetRejectedMessagesCount();
  });

  describe('1. Message Protocol & Validation', () => {
    it('accepts all valid inbound command payloads', () => {
      const validCases: Array<{ raw: unknown; expectedCmd: string }> = [
        { raw: { command: 'refresh' }, expectedCmd: 'refresh' },
        { raw: { command: 'openEditorPanel' }, expectedCmd: 'openEditorPanel' },
        { raw: { command: 'configureApiKey' }, expectedCmd: 'configureApiKey' },
        { raw: { command: 'toggleAiConsent', enabled: true }, expectedCmd: 'toggleAiConsent' },
        { raw: { command: 'toggleAiConsent', enabled: false }, expectedCmd: 'toggleAiConsent' },
        { raw: { command: 'selectFolder', folderPath: '/repo/root' }, expectedCmd: 'selectFolder' },
        { raw: { command: 'selectRoom', roomId: 'room-auth' }, expectedCmd: 'selectRoom' },
        { raw: { command: 'selectRoom', roomId: null }, expectedCmd: 'selectRoom' },
        { raw: { command: 'askCompanion', question: 'Explain this design.' }, expectedCmd: 'askCompanion' },
        { raw: { command: 'askCompanion', question: 'What is this?', roomId: 'room-auth' }, expectedCmd: 'askCompanion' },
        { raw: { command: 'openFile', path: 'src/server.js' }, expectedCmd: 'openFile' },
        { raw: { command: 'openFile', path: 'src/server.js', line: 42 }, expectedCmd: 'openFile' },
        { raw: { command: 'openFile', path: 'src/server.js', line: '42' }, expectedCmd: 'openFile' },
      ];

      for (const tc of validCases) {
        const res = validateInboundMessage(tc.raw);
        assert.strictEqual(res.valid, true, `Expected valid for ${tc.expectedCmd}`);
        if (res.valid) {
          assert.strictEqual(res.message.command, tc.expectedCmd);
        }
      }
      assert.strictEqual(getRejectedMessagesCount(), 0);
    });

    it('rejects unknown commands and safely counts rejections', () => {
      const unknowns = [
        { command: 'executeCommand' },
        { command: 'fetchSecret' },
        { command: 'eval' },
        { command: '__proto__' },
        { command: 123 },
      ];

      for (const u of unknowns) {
        const res = validateInboundMessage(u);
        assert.strictEqual(res.valid, false);
      }
      assert.strictEqual(getRejectedMessagesCount(), unknowns.length);
    });

    it('rejects malformed and non-object payloads', () => {
      const malformed = [null, undefined, 42, 'string', true, []];
      for (const m of malformed) {
        const res = validateInboundMessage(m);
        assert.strictEqual(res.valid, false);
      }
      assert.strictEqual(getRejectedMessagesCount(), malformed.length);
    });

    it('validates room IDs against active snapshot', () => {
      const validRoomIds = new Set(['room-core', 'room-auth']);

      // Valid room ID
      const ok = validateInboundMessage(
        { command: 'selectRoom', roomId: 'room-auth' },
        { validRoomIds }
      );
      assert.strictEqual(ok.valid, true);

      // Non-existent room ID
      const bad = validateInboundMessage(
        { command: 'selectRoom', roomId: 'room-malicious' },
        { validRoomIds }
      );
      assert.strictEqual(bad.valid, false);
      assert.match(bad.valid ? '' : bad.reason, /does not exist/i);

      // Null or empty room ID is accepted (unselecting room)
      const unselect = validateInboundMessage(
        { command: 'selectRoom', roomId: null },
        { validRoomIds }
      );
      assert.strictEqual(unselect.valid, true);
    });

    it('validates and clamps line numbers, rejecting negative, non-integer, and NaN values', () => {
      // Clamps oversized line to 1,000,000
      const oversized = validateInboundMessage({
        command: 'openFile',
        path: 'src/server.js',
        line: 5_000_000,
      });
      assert.strictEqual(oversized.valid, true);
      if (oversized.valid && oversized.message.command === 'openFile') {
        assert.strictEqual(oversized.message.line, 1_000_000);
      }

      // Rejects negative line
      const negative = validateInboundMessage({
        command: 'openFile',
        path: 'src/server.js',
        line: -10,
      });
      assert.strictEqual(negative.valid, false);

      // Rejects zero line
      const zero = validateInboundMessage({
        command: 'openFile',
        path: 'src/server.js',
        line: 0,
      });
      assert.strictEqual(zero.valid, false);

      // Rejects non-integer float
      const floatVal = validateInboundMessage({
        command: 'openFile',
        path: 'src/server.js',
        line: 12.34,
      });
      assert.strictEqual(floatVal.valid, false);

      // Rejects NaN string
      const nanVal = validateInboundMessage({
        command: 'openFile',
        path: 'src/server.js',
        line: 'not-a-number',
      });
      assert.strictEqual(nanVal.valid, false);
    });

    it('enforces string length bounds on path, question, and roomId', () => {
      const longPath = 'a'.repeat(1025);
      const resPath = validateInboundMessage({ command: 'openFile', path: longPath });
      assert.strictEqual(resPath.valid, false);

      const longQuestion = 'q'.repeat(4097);
      const resQ = validateInboundMessage({ command: 'askCompanion', question: longQuestion });
      assert.strictEqual(resQ.valid, false);

      const longRoom = 'r'.repeat(257);
      const resR = validateInboundMessage({ command: 'selectRoom', roomId: longRoom });
      assert.strictEqual(resR.valid, false);
    });
  });

  describe('2. Secure File Resolution (pathResolver.ts)', () => {
    it('resolves legitimate files within workspace fixture', () => {
      const result = resolveWorkspaceFile('src/server.js', {
        workspaceRoots: [expressFixture],
      });
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.relativePath, 'src/server.js');
        assert.strictEqual(result.workspaceRoot, expressFixture);
        assert.ok(fs.existsSync(result.resolvedPath));
      }
    });

    it('rejects directory traversal attempts (..)', () => {
      const traversals = [
        '../package.json',
        '../../etc/passwd',
        'src/../../package.json',
        'src/../../../windows/win.ini',
        '..',
      ];
      for (const t of traversals) {
        const res = resolveWorkspaceFile(t, { workspaceRoots: [expressFixture] });
        assert.strictEqual(res.success, false, `Traversal must be rejected: ${t}`);
        assert.strictEqual(res.error, 'TRAVERSAL_DISALLOWED');
      }
    });

    it('rejects absolute paths', () => {
      const absolutePaths = [
        '/etc/passwd',
        '/var/log/system.log',
        '\\Windows\\System32\\cmd.exe',
      ];
      for (const p of absolutePaths) {
        const res = resolveWorkspaceFile(p, { workspaceRoots: [expressFixture] });
        assert.strictEqual(res.success, false, `Absolute path must be rejected: ${p}`);
        assert.strictEqual(res.error, 'ABSOLUTE_PATH_DISALLOWED');
      }
    });

    it('rejects Windows drive-letter paths', () => {
      const drivePaths = ['C:\\Windows\\System32', 'D:/secrets.txt', 'c:autoexec.bat'];
      for (const dp of drivePaths) {
        const res = resolveWorkspaceFile(dp, { workspaceRoots: [expressFixture] });
        assert.strictEqual(res.success, false, `Drive path must be rejected: ${dp}`);
        assert.strictEqual(res.error, 'DRIVE_LETTER_DISALLOWED');
      }
    });

    it('rejects UNC paths', () => {
      const uncPaths = ['\\\\server\\share\\file.txt', '//192.168.1.1/shared/secret.key'];
      for (const u of uncPaths) {
        const res = resolveWorkspaceFile(u, { workspaceRoots: [expressFixture] });
        assert.strictEqual(res.success, false, `UNC path must be rejected: ${u}`);
        assert.strictEqual(res.error, 'UNC_PATH_DISALLOWED');
      }
    });

    it('rejects file:// URLs and NUL characters', () => {
      const urlRes = resolveWorkspaceFile('file:///etc/passwd', { workspaceRoots: [expressFixture] });
      assert.strictEqual(urlRes.success, false);
      assert.strictEqual(urlRes.error, 'URL_DISALLOWED');

      const nulRes = resolveWorkspaceFile('src/server.js\0.txt', { workspaceRoots: [expressFixture] });
      assert.strictEqual(nulRes.success, false);
      assert.strictEqual(nulRes.error, 'NUL_CHARACTER_DISALLOWED');
    });

    it('detects and rejects symlink escape attempts outside workspace root', () => {
      // Test realpath containment check with mock fsOverride
      const fakeEscapeRoot = 'c:/workspace/project';
      const fakeSymlinkTarget = 'c:/system/secret/passwords.txt';

      const res = resolveWorkspaceFile('symlink-to-secret.txt', {
        workspaceRoots: [fakeEscapeRoot],
        fsOverride: {
          existsSync: () => true,
          realpathSync: (p: string) => {
            if (p.includes('symlink-to-secret')) return fakeSymlinkTarget;
            return fakeEscapeRoot;
          },
          statSync: () => ({ isFile: () => true }),
        },
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.error, 'SYMLINK_ESCAPE');
      assert.strictEqual(res.message, 'Invalid or restricted file path');
    });

    it('supports multi-root workspaces and resolves file against matching root', () => {
      const resA = resolveWorkspaceFile('src/server.js', {
        workspaceRoots: [expressFixture, tsLibFixture],
      });
      assert.strictEqual(resA.success, true);
      if (resA.success) {
        assert.strictEqual(resA.workspaceRoot, expressFixture);
      }

      const resB = resolveWorkspaceFile('src/index.ts', {
        workspaceRoots: [expressFixture, tsLibFixture],
      });
      assert.strictEqual(resB.success, true);
      if (resB.success) {
        assert.strictEqual(resB.workspaceRoot, tsLibFixture);
      }
    });

    it('enforces discovered file snapshot membership when provided', () => {
      const discoveredFiles = new Set(['src/server.js', 'package.json']);

      // Allowed because in snapshot
      const ok = resolveWorkspaceFile('src/server.js', {
        workspaceRoots: [expressFixture],
        discoveredFiles,
      });
      assert.strictEqual(ok.success, true);

      // Denied because not in snapshot
      const denied = resolveWorkspaceFile('src/routes/tasks.js', {
        workspaceRoots: [expressFixture],
        discoveredFiles,
      });
      assert.strictEqual(denied.success, false);
      assert.strictEqual(denied.error, 'NOT_IN_SNAPSHOT');
    });

    it('ignores activeRoot outside workspaceRoots and prevents resolving against it (Blocker 3)', () => {
      // activeRoot is expressFixture, but workspaceRoots only contains tsLibFixture
      const res = resolveWorkspaceFile('src/server.js', {
        workspaceRoots: [tsLibFixture],
        activeRoot: expressFixture,
      });
      assert.strictEqual(res.success, false, 'Resolution against unapproved activeRoot must not succeed');
    });

    it('rejects path when snapshot is empty or no snapshot exists (Blocker 3)', () => {
      // 1. Snapshot provided but empty
      const emptySnapshotRes = resolveWorkspaceFile('src/server.js', {
        workspaceRoots: [expressFixture],
        discoveredFiles: [],
      });
      assert.strictEqual(emptySnapshotRes.success, false);
      assert.strictEqual(emptySnapshotRes.error, 'NOT_IN_SNAPSHOT');

      // 2. Explicitly null snapshot (no snapshot exists)
      const noSnapshotRes = resolveWorkspaceFile('src/server.js', {
        workspaceRoots: [expressFixture],
        discoveredFiles: null,
      });
      assert.strictEqual(noSnapshotRes.success, false);
      assert.strictEqual(noSnapshotRes.error, 'NOT_IN_SNAPSHOT');
    });

    it('refuses sensitive files that exist on disk (Blocker 3)', () => {
      // ts-lib/.env exists on disk
      const res = resolveWorkspaceFile('.env', {
        workspaceRoots: [tsLibFixture],
      });
      assert.strictEqual(res.success, false, 'Existing sensitive file on disk must be refused');
      assert.strictEqual(res.error, 'SENSITIVE_FILE_DISALLOWED');
    });

    it('leaves stored active folder unchanged when an unknown selectFolder path is passed (Blocker 3)', () => {
      const availableFolders = [
        { uri: { fsPath: expressFixture } },
        { uri: { fsPath: tsLibFixture } },
      ];

      // Unknown folder attempt
      const rejected = handleFolderSelection(
        '/unauthorized/outside/path',
        availableFolders,
        expressFixture
      );
      assert.strictEqual(rejected.accepted, false);
      assert.strictEqual(rejected.activeFolderPath, expressFixture, 'Active folder must stay unchanged');

      // Valid folder attempt
      const accepted = handleFolderSelection(
        tsLibFixture,
        availableFolders,
        expressFixture
      );
      assert.strictEqual(accepted.accepted, true);
      assert.strictEqual(accepted.activeFolderPath, tsLibFixture);
    });
  });

  describe('3. Webview CSP & Dynamic HTML Security Audit', () => {
    it('verifies that media/webview/index.html CSP contains no unsafe-inline', () => {
      const htmlPath = path.resolve(fixturesDir, '..', '..', 'media', 'webview', 'index.html');
      assert.ok(fs.existsSync(htmlPath), 'media/webview/index.html must exist');
      const html = fs.readFileSync(htmlPath, 'utf8');

      // CSP check
      assert.match(html, /Content-Security-Policy/i);
      assert.match(html, /default-src\s+'none'/);
      assert.strictEqual(
        html.includes("'unsafe-inline'"),
        false,
        "CSP must NOT contain 'unsafe-inline'"
      );

      // Verify no inline style attributes in HTML
      const inlineStyleMatches = html.match(/\bstyle\s*=/gi);
      assert.strictEqual(
        inlineStyleMatches,
        null,
        'index.html must contain zero inline style attributes'
      );
    });

    it('verifies that media/webview/main.js does not assign unescaped dynamic data to innerHTML', () => {
      const jsPath = path.resolve(fixturesDir, '..', '..', 'media', 'webview', 'main.js');
      assert.ok(fs.existsSync(jsPath), 'media/webview/main.js must exist');
      const js = fs.readFileSync(jsPath, 'utf8');

      // Remove comments before analyzing code assignments
      const codeOnly = js.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
      const innerHtmlMatches = codeOnly.match(/\.innerHTML\s*=/g);
      assert.strictEqual(
        innerHtmlMatches,
        null,
        'main.js must not assign dynamic data to innerHTML'
      );
    });

    it('verifies that webview resources exist and build succeeds without source-only paths', () => {
      const extDir = path.resolve(fixturesDir, '..', '..');
      const htmlPath = path.join(extDir, 'media', 'webview', 'index.html');
      const cssPath = path.join(extDir, 'media', 'webview', 'styles.css');
      const jsPath = path.join(extDir, 'media', 'webview', 'main.js');
      const outPath = path.join(extDir, 'out', 'extension.js');

      assert.ok(fs.existsSync(htmlPath), 'index.html must be emitted');
      assert.ok(fs.existsSync(cssPath), 'styles.css must be emitted');
      assert.ok(fs.existsSync(jsPath), 'main.js must be emitted');
      assert.ok(fs.existsSync(outPath), 'out/extension.js must be emitted');

      // Verify out/extension.js does not hardcode local user workspace paths
      const bundle = fs.readFileSync(outPath, 'utf8');
      assert.strictEqual(
        bundle.includes('c:\\Users\\rspma'),
        false,
        'Compiled extension bundle must not hardcode developer machine paths'
      );
    });
  });
});
