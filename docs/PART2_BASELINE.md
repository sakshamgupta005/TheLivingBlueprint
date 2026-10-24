# Part 2 Baseline — Reproducible Baseline and Build Truth (P2-01)

Documented on: 2026-10-23
Milestone: P2-01 (`docs/PART2_IMPLEMENTATION_PLAN.md`)
Branch: `main`

---

## 1. Environment & Setup Truth

- **Operating System:** Windows 11 (win32 x64)
- **Node.js Version:** `v24.16.0`
- **npm Version:** `12.0.1`
- **Shell:** PowerShell

### Initial Repository Status
- Git working tree was clean prior to milestone execution (except untracked plan and pre-existing `.gitignore` exception for test fixtures).
- Pre-existing `.gitignore` change preserving fixture `.env` files for future secret exclusion testing (`!vscode-extension/test/fixtures/**/.env`) was preserved.

---

## 2. Root Project Baseline

### Installation: `npm ci`
- **Command:** `npm ci`
- **Exit Code:** `0`
- **Output Summary:** Added 148 packages, audited 149 packages in 19s.
- **Audit Findings:** 2 vulnerabilities (1 moderate, 1 high) from upstream dependencies.
- **Script Policy Notice:** Blocked install script for `esbuild@0.21.5` per npm allowScripts configuration (non-blocking for builds).

### Build: `npm run build`
- **Command:** `npm run build` (`tsc && vite build`)
- **Exit Code:** `0`
- **Build Duration:** 18.46s
- **Artifacts:**
  - `dist/index.html`: 0.70 kB (gzip: 0.40 kB)
  - `dist/assets/index-DozkC6qr.css`: 122.92 kB (gzip: 22.40 kB)
  - `dist/assets/vendor-react-D-QwIqES.js`: 0.04 kB (gzip: 0.06 kB)
  - `dist/assets/vendor-d3-DDYJLobC.js`: 19.65 kB (gzip: 7.33 kB)
  - `dist/assets/vendor-flow-cVqZWe3X.js`: 291.22 kB (gzip: 94.40 kB)
  - `dist/assets/index-W2J0FI_d.js`: 4,063.24 kB (gzip: 1,165.22 kB)
- **Build Warnings:** Vite warning regarding single chunk size > 500 kB (`dist/assets/index-W2J0FI_d.js`).

### Test Suite: `npm test`
- **Command:** `npm test` (`node --experimental-strip-types --test "test/*.test.ts"`)
- **Exit Code:** `0`
- **Duration:** 3,790 ms
- **Exact Counts:**
  - **Suites:** 167
  - **Tests:** 436
  - **Pass:** 436
  - **Fail:** 0
  - **Cancelled:** 0
  - **Skipped:** 0
  - **Todo:** 0
- **Comparison to Historical Claims:**
  - Earlier milestone records in `docs/CONTEXT.md` and `README.md` claimed 375 and 376 tests.
  - Actual current count is **436 tests across 167 suites**, with 100% passing. (Historical documentation remains untouched per constraint).
- **Console Output Notes:**
  - Expected `SyntaxError: Expected property name or '}' in JSON` logged during `test/workspacePersistence.test.ts` as part of intentional malformed JSON resilience checks.

---

## 3. VS Code Extension Baseline & Decoupling

### Problem Identified Prior to P2-01
1. **Hidden Build Dependency:** `vscode-extension/build.js` executed `require('esbuild')`, but `esbuild` was not listed in `vscode-extension/package.json`. It previously relied on hoisting from root's `vite` dependency tree.
2. **Packaging Dependency on `npx`:** `package` script invoked `npx @vscode/vsce package --no-dependencies`, incurring network latency, potential version drift, and unpinned downloads.
3. **Restricted Test Discovery:** `test` script hard-coded specific test files (`test/scanner.test.ts test/companion.test.ts`) rather than globbing `test/*.test.ts`.
4. **Relaxed TypeScript Configuration:** `vscode-extension/tsconfig.json` only enabled `strictNullChecks: true`, lacking full `strict` mode.
5. **Engine Compatibility Floor:** `engines.vscode` was set to `^1.80.0`. VS Code 1.80 and 1.81 were based on Electron 22 with Node.js 16.17.1, which lacked stable global `fetch` and `AbortController`. The extension runtime targets `node18` and relies on global `fetch`.

### Changes Applied in P2-01

1. **Pinned Dependencies Added to `vscode-extension/package.json`:**
   - `"esbuild": "0.21.5"` (pinned exact version matching root bundler runtime)
   - `"@vscode/vsce": "3.2.1"` (pinned exact version; avoids native keytar build issues on Node 20+)
   - `"@types/vscode": "^1.82.0"` (aligned with minimum VS Code engine)

2. **Packaging Script Updated:**
   - Changed from: `node build.js && npx @vscode/vsce package --no-dependencies`
   - Changed to: `node build.js && vsce package --no-dependencies`
   - Now uses the locally installed `@vscode/vsce` binary via npm scripts.
   - *Note:* Committed artifact `living-blueprint-vscode-0.1.0.vsix` was preserved untouched.

3. **Test Script Globbing:**
   - Changed from: `node --no-warnings --experimental-strip-types --test test/scanner.test.ts test/companion.test.ts`
   - Changed to: `node --no-warnings --experimental-strip-types --test "test/*.test.ts"`

4. **Stricter TypeScript Settings Assessed and Configured:**
   - Enabled in `vscode-extension/tsconfig.json`:
     - `"strict": true`
     - `"noFallthroughCasesInSwitch": true`
     - `"noUnusedParameters": true`
   - Result: All files compiled with **0 errors**.
   - **`noUnusedLocals` Assessment:** Tested with `tsc --noEmit`. Identified 3 compiler errors in `src/blueprintViewProvider.ts`:
     - `error TS6133: '_isScanning' is declared but its value is never read.`
     - `error TS6133: '_hasApiKey' is declared but its value is never read.`
     - `error TS6133: '_aiConsent' is declared but its value is never read.`
     These private fields represent pending state required for upcoming milestones (P2-02/P2-05). Per strict instructions not to modify extension runtime behavior or jump ahead to future milestones, `noUnusedLocals` was deferred until those fields are connected.

5. **Minimum Supported VS Code Engine Determination:**
   - Set to `"engines": { "vscode": "^1.82.0" }`.
   - **Verification Rationale:**
     - VS Code 1.81 (July 2023) shipped on Electron 22.3.18 / Node.js 16.17.1.
     - VS Code 1.82 (August 2023) upgraded to Electron 25.8.0 / Node.js 18.15.0.
     - Node.js 18 introduced native global `fetch`, `AbortController`, `Headers`, `Request`, and `Response`.
     - The extension code targets `node18` in `build.js` and requires global `fetch` without polyfills.
     - Therefore, VS Code 1.82.0 is the exact verified minimum version.

---

## 4. Extension Verification Results (Independent Directory)

Executed from `c:\Users\rspma\Downloads\Velocity\vscode-extension`:

### 1. `npm ci`
- **Exit Code:** `0`
- **Summary:** Added 201 packages in 25s, audited 202 packages. 0 compile errors.

### 2. `npm run typecheck`
- **Command:** `tsc --noEmit`
- **Exit Code:** `0`
- **Output:** Clean compilation under `strict: true`.

### 3. `npm run compile`
- **Command:** `node build.js`
- **Exit Code:** `0`
- **Output:**
  - `out/extension.js`: 231.8 kB
  - `out/extension.js.map`: 440.7 kB
  - Completed in 29ms using local pinned `esbuild`.

### 4. `npm test`
- **Command:** `node --no-warnings --experimental-strip-types --test "test/*.test.ts"`
- **Exit Code:** `0`
- **Duration:** 423 ms
- **Exact Counts:**
  - **Suites:** 2 (`companion.test.ts`, `scanner.test.ts`)
  - **Tests:** 8
  - **Pass:** 8
  - **Fail:** 0
  - **Cancelled:** 0
  - **Skipped:** 0
  - **Todo:** 0

---

## 5. Unresolved Issues and Items Still Unverified

1. **Extension Development Host (F5) Launch:**
   - Smoke testing the extension inside an actual running VS Code host window is unverified (scheduled for manual execution in milestone P2-02).
2. **`_isScanning`, `_hasApiKey`, `_aiConsent` Unused Fields:**
   - These fields exist in `src/blueprintViewProvider.ts` without active readers, blocking `"noUnusedLocals": true`.
3. **Large Bundle Warning in Root Web App:**
   - Vite flags `dist/assets/index-W2J0FI_d.js` (> 4 MB) as exceeding standard 500 kB chunk threshold.
4. **Committed VSIX Artifact:**
   - `living-blueprint-vscode-0.1.0.vsix` was preserved without regeneration per milestone constraints.
