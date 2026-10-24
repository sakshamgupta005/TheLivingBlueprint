// Runs inside the Extension Development Host. Dependency-free (no mocha).
// Uses the extension's read-only __test hook; makes no AI or network calls.
const assert = require('node:assert');
const vscode = require('vscode');

const EXTENSION_ID = 'the-living-blueprint.living-blueprint-vscode';
const EXPECT = process.env.LB_EXPECT || 'rooms';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, label, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

exports.run = async function run() {
  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });

  let api;
  const posted = [];
  const nextPosted = (type, timeoutMs = 10000) => {
    const startIdx = posted.length;
    return waitFor(() => posted.slice(startIdx).find((m) => m && m.type === type), `host message '${type}'`, timeoutMs);
  };
  const settled = () =>
    waitFor(() => {
      const s = api.getScanState();
      return ['idle', 'empty', 'truncated', 'error'].includes(s.status) && s;
    }, 'scan to settle');

  test('extension activates and exposes the read-only test hook', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'extension is installed in the development host');
    const exported = await ext.activate();
    api = exported && exported.__test;
    assert.ok(api, '__test hook exported');
    api.tap((m) => posted.push(m));
  });

  test('all commands are registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'livingBlueprint.focus',
      'livingBlueprint.refresh',
      'livingBlueprint.openEditor',
      'livingBlueprint.setApiKey',
      'livingBlueprint.previewAiPayload',
      'livingBlueprint.runProjectTests',
    ]) {
      assert.ok(commands.includes(id), `command ${id}`);
    }
  });

  if (EXPECT === 'empty') {
    test('empty workspace shows an honest empty state with zero rooms', async () => {
      const state = await settled();
      assert.strictEqual(state.status, 'empty');
      assert.deepStrictEqual(api.getRoomIds(), []);
    });

    test('architecture lens on an empty workspace explains instead of drawing', async () => {
      const reply = nextPosted('architectureLens');
      await api.dispatch({ command: 'selectArchitectureLens', lensId: 'modules' });
      const msg = await reply;
      assert.strictEqual(msg.graph, null);
      assert.strictEqual(msg.sufficientEvidence, false);
      assert.ok(msg.message);
    });
  } else {
    test('scans the fixture workspace into rooms', async () => {
      const state = await settled();
      assert.ok(['idle', 'truncated'].includes(state.status), `status ${state.status}`);
      assert.ok(api.getRoomIds().length > 0, 'rooms mapped');
      assert.match(api.getFingerprint() || '', /^[0-9a-f]{64}$/);
    });

    test('refresh command rescans', async () => {
      const before = api.getScanState().timestamp;
      await vscode.commands.executeCommand('livingBlueprint.refresh');
      await waitFor(() => {
        const s = api.getScanState();
        return s.timestamp !== before && ['idle', 'truncated'].includes(s.status);
      }, 'refresh to complete');
    });

    test('openFile opens a snapshot file at the requested line', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await api.dispatch({ command: 'openFile', path: 'src/server.js', line: 2 });
      const editor = await waitFor(() => vscode.window.activeTextEditor, 'editor to open');
      assert.ok(editor.document.uri.fsPath.replace(/\\/g, '/').endsWith('src/server.js'));
      assert.strictEqual(editor.selection.active.line, 1, '1-based line 2 → 0-based 1');
    });

    test('openFile rejects traversal, absolute, URL and unknown paths', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      for (const bad of ['../../etc/passwd', 'C:/Windows/win.ini', '/etc/hosts', 'file:///etc/hosts', 'src/ghost.js', '..\\..\\x']) {
        await api.dispatch({ command: 'openFile', path: bad, line: 1 });
      }
      await sleep(500);
      assert.strictEqual(vscode.window.activeTextEditor, undefined, 'no editor opened');
    });

    test('unknown command and stale room ids are rejected without side effects', async () => {
      const start = posted.length;
      await api.dispatch({ command: 'deleteEverything' });
      await api.dispatch({ command: 'investigateRoom', roomId: 'room-ghost' });
      await sleep(300);
      const after = posted.slice(start);
      assert.ok(!after.some((m) => m && String(m.type).startsWith('investigation')));
      const rejected = after.filter((m) => m && m.type === 'requestRejected');
      assert.deepStrictEqual(rejected.map((m) => m.command), ['deleteEverything', 'investigateRoom'], 'UI is told about rejections');
    });

    test('architecture lens and evidence chain: real graph, execution "not_run"', async () => {
      const lens = nextPosted('architectureLens');
      await api.dispatch({ command: 'selectArchitectureLens', lensId: 'modules' });
      const lensMsg = await lens;
      assert.strictEqual(lensMsg.sufficientEvidence, true);
      assert.ok(lensMsg.graph && lensMsg.graph.nodes.length > 0);

      const roomId = api.getRoomIds()[0];
      const chain = nextPosted('evidenceChain');
      await api.dispatch({ command: 'requestEvidenceChain', roomId });
      const chainMsg = await chain;
      assert.strictEqual(chainMsg.roomId, roomId);
      for (const item of chainMsg.items) {
        assert.strictEqual(item.claims.testExecuted, 'not_run');
        assert.strictEqual(item.claims.testPassed, 'not_run');
      }
    });

    test('companion answers offline (consent defaults off) and says no AI call was made', async () => {
      const reply = nextPosted('companionReplies');
      await api.dispatch({ command: 'askCompanion', question: 'Explain how the rooms connect', explanationLevel: 'technical' });
      const msg = await reply;
      assert.strictEqual(msg.meta.mode, 'offline');
      assert.ok(msg.messages.length > 0);
      for (const m of msg.messages) assert.ok(m.text.startsWith('Offline (no AI call made)'), m.text);
    });

    test('investigation is unavailable without consent; no finding is invented', async () => {
      const roomId = api.getRoomIds()[0];
      const reply = nextPosted('investigationUnavailable');
      await api.dispatch({ command: 'investigateRoom', roomId });
      const msg = await reply;
      assert.strictEqual(msg.roomId, roomId);
      assert.ok(['offline', 'needsKey', 'disabled'].includes(msg.state), msg.state);
    });

    test('handoff and re-inspection refuse honestly when no finding exists', async () => {
      const roomId = api.getRoomIds()[0];
      const handoff = nextPosted('handoffResult');
      await api.dispatch({ command: 'handoffRepairPrompt', roomId, action: 'copy' });
      const h = await handoff;
      assert.strictEqual(h.ok, false);
      assert.strictEqual(h.reason, 'invalid_finding');

      const re = nextPosted('reinspectionResult', 20000);
      await api.dispatch({ command: 'reinspectFinding', roomId });
      const r = await re;
      assert.strictEqual(r.classification, 'not_comparable');
      assert.strictEqual(r.testsPassedForCurrentSnapshot, false);
    });
  }

  let failures = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✔ ${t.name}`);
    } catch (err) {
      failures++;
      console.error(`  ✖ ${t.name}\n    ${err && err.stack ? err.stack : err}`);
    }
  }
  if (api) api.tap(undefined);
  console.log(`\n[host smoke:${EXPECT}] ${tests.length - failures}/${tests.length} passed`);
  if (failures > 0) throw new Error(`${failures} host smoke test(s) failed`);
};
