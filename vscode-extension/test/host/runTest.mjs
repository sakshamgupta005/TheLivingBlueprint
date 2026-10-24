// Opt-in Extension Development Host smoke tests (P2-15).
// Downloads VS Code on first run (cached in .vscode-test/). Run after `npm run compile`:
//   node test/host/runTest.mjs
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(here, '../..');
const extensionTestsPath = path.resolve(here, 'suite/index.cjs');
const fixtures = path.resolve(here, '../fixtures');

const runs = [
  { fixture: 'small-express', expect: 'rooms' },
  { fixture: 'empty', expect: 'empty' },
];

let failed = false;
for (const run of runs) {
  console.log(`\n=== Host smoke: ${run.fixture} ===`);
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        path.join(fixtures, run.fixture),
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
      extensionTestsEnv: { LB_EXPECT: run.expect },
    });
  } catch (err) {
    failed = true;
    console.error(`Host smoke failed for ${run.fixture}:`, err instanceof Error ? err.message : err);
  }
}
process.exit(failed ? 1 : 0);
