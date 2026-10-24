import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
const candidatePaths = [
  path.resolve(process.cwd(), 'media', 'webview', 'main.js'),
  path.resolve(process.cwd(), 'vscode-extension', 'media', 'webview', 'main.js'),
];
const webviewMainJsPath = candidatePaths.find((p) => fs.existsSync(p)) || candidatePaths[0];

describe('Webview Integration Defect Audits (Release Engineering Sprint)', () => {
  const mainJsContent = fs.readFileSync(webviewMainJsPath, 'utf8');

  it('1. Handles requestRejected message to stop loading states and show useful messages across all 7 features', () => {
    assert.match(mainJsContent, /case\s+['"]requestRejected['"]:/, 'Must handle requestRejected message type');
    assert.match(mainJsContent, /setInvestigatingState\(false\)/, 'Must cancel investigation loading state on reject');
    assert.match(mainJsContent, /hideThinkingBubble\(\)/, 'Must hide thinking bubble on reject');
    assert.match(mainJsContent, /setHandoffButtonsState\(false\)/, 'Must reset handoff buttons on reject');
    assert.match(mainJsContent, /setReinspectingState\(false\)/, 'Must reset reinspecting state on reject');
    assert.match(mainJsContent, /renderEvidenceChain\(msg\.roomId/, 'Must reset evidence chain loading on reject');
    assert.match(mainJsContent, /isTestRunning\s*=\s*false[\s\S]*?updateTestRunButtonUi\(\)/, 'Must stop test running state on reject');
    assert.match(mainJsContent, /updateLensStatusPill\(currentSelectedLensId,\s*false\)/, 'Must update lens status pill on reject');
  });

  it('2. Features safe timeout/watchdog for Investigate action preventing indefinite spinners', () => {
    assert.match(mainJsContent, /activeInvestigationWatchdog/, 'Must maintain activeInvestigationWatchdog');
    assert.match(mainJsContent, /Investigation Timed Out/, 'Must report safe timeout error on unanswered investigation');
    assert.match(
      mainJsContent,
      /setTimeout\(\s*\(\)\s*=>\s*\{[\s\S]*?Investigation Timed Out[\s\S]*?\},\s*30000\)/,
      'Must configure 30s watchdog on room investigation'
    );
  });

  it('3. Preserves existing chat history when companionAnalysis message arrives and only refreshes suggestions', () => {
    assert.match(
      mainJsContent,
      /hasExistingConversation\s*=\s*Boolean\(\s*thread\.querySelector/,
      'Must check for existing conversation bubbles before clearing thread'
    );
    assert.match(
      mainJsContent,
      /if\s*\(hasExistingConversation\)\s*\{\s*return;\s*\}/,
      'Must return early when conversation exists, preserving history and refreshing only suggestions'
    );
  });

  it('4. Invalidates cached evidence-chain data for all rooms on workspace rescan and test results', () => {
    // In updateBlueprint
    assert.match(
      mainJsContent,
      /case\s+['"]updateBlueprint['"]:[\s\S]*?cachedEvidenceChains\s*=\s*\{\};/,
      'Must invalidate all cached evidence chains on updateBlueprint'
    );
    // In showTestRunResult
    assert.match(
      mainJsContent,
      /function\s+showTestRunResult\(msg\)\s*\{[\s\S]*?cachedEvidenceChains\s*=\s*\{\};/,
      'Must invalidate all cached evidence chains on showTestRunResult'
    );
  });

  it('5. Save Prompt watchdog keeps Save buttons disabled while host modal is open', () => {
    assert.match(
      mainJsContent,
      /action\s*===\s*['"]save['"]\s*\?\s*120000\s*:\s*\d+/,
      'Must use tolerant 120s timeout for file save confirmation dialog'
    );
    assert.match(
      mainJsContent,
      /if\s*\(action\s*===\s*['"]save['"]\)\s*\{[\s\S]*?Awaiting confirmation in VS Code dialog[\s\S]*?\}\s*else\s*\{\s*setHandoffButtonsState\(false\);/,
      'Must NOT re-enable buttons when action is save while awaiting modal'
    );
  });

  it('6. Resets selected room, re-inspection results, test-run state, and cached lens graphs on folder switch', () => {
    assert.match(mainJsContent, /function\s+resetWorkspaceFolderState\(\)/, 'Must have resetWorkspaceFolderState function');
    assert.match(
      mainJsContent,
      /folderSelect\.addEventListener\('change'[\s\S]*?resetWorkspaceFolderState\(\)/,
      'Must invoke resetWorkspaceFolderState on folder change'
    );
    assert.match(
      mainJsContent,
      /case\s+['"]workspaceFolders['"]:[\s\S]*?resetWorkspaceFolderState\(\)/,
      'Must invoke resetWorkspaceFolderState when activeFolderPath changes'
    );
  });

  it('7. Builds file chips only from host evidenceRefs objects and navigation.references (no split string parsing)', () => {
    // No evidencePaths in createCompanionBubble
    assert.doesNotMatch(
      mainJsContent,
      /msg\.evidencePaths/,
      'Must NOT reference msg.evidencePaths'
    );
    assert.doesNotMatch(
      mainJsContent,
      /parts\[0\][\s\S]*?parts\[1\]/,
      'Must NOT split string paths'
    );
    // Only object evidenceRefs
    assert.match(
      mainJsContent,
      /if\s*\(r\s*&&\s*typeof\s+r\s*===\s*['"]object['"]\s*&&\s*r\.file\)/,
      'Must only accept evidenceRefs objects'
    );
    // Only object navigation.references
    assert.match(
      mainJsContent,
      /record\.navigation\.references\.filter\(\(ref\)\s*=>\s*ref\s*&&\s*typeof\s+ref\s*===\s*['"]object['"]\s*&&\s*\(ref\.file\s*\|\|\s*ref\.path\)\)/,
      'Must strictly use navigation.references objects'
    );
  });

  it('8. Test evidence badge does not show empty when neither active nor stale', () => {
    assert.match(
      mainJsContent,
      /testRunIndicatorBadge\.classList\.add\(['"]hidden['"]\);\s*testRunIndicatorBadge\.textContent\s*=\s*['"]['"];/,
      'Must hide and empty badge when neither applied nor stale'
    );
  });
});
