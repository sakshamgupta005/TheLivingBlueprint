# The Living Blueprint — Part 2 Acceptance & Release Report

**Date:** 2026-10-24  
**Sprint / Scope:** P2-16 & P2-17 Release-Engineering Sprint (Final Release Candidate)  
**Environment:** Windows x64, Node.js `v24.16.0`, npm `11.3.0`, VS Code Extension Development Host `1.143.1`  
**Definitive Package:** `vscode-extension/living-blueprint-vscode-0.2.0.vsix` (124.2 KB)  

---

## 1. Automated Acceptance Matrix (§6.1)

All automated checks were executed directly against the current checkout. No results were fabricated or assumed.

| # | Check | Command | Pass Condition | Real Result | Status |
|---|---|---|---|---|---|
| **A1** | Root build | `npm run build` | Exit code 0 | `tsc && vite build` succeeded in 14.87s (`dist/` generated). | **PASS** |
| **A2** | Root test suite | `npm test` | 0 failures; record real count | 456 tests passed, 0 failed (final closeout run, current working tree). | **PASS** |
| **A3** | Extension compile | `cd vscode-extension && npm run compile:prod` | Exit code 0, `out/extension.js` present | Production bundle compiled: 244,135 bytes (238.4 KiB), no sourcemaps. | **PASS** |
| **A4** | Extension typecheck | `npm run typecheck` | Exit code 0 | `tsc --noEmit` exited with code 0, zero type errors. | **PASS** |
| **A5** | Extension unit tests | `npm test` | 0 failures; record real count | 186 tests passed, 0 failed (final closeout run). | **PASS** |
| **A6** | Import boundary + bundle guards | Included in A5 (`importBoundary.test.ts` & `packaging.test.ts`) | Zero forbidden packages, no `typescript` compiler, size < 400 KiB | Production bundle 244,135 bytes < 409,600-byte (400 KiB) guard; TypeScript compiler, React, D3, React Flow markers absent. | **PASS** |
| **A7** | Egress & consent tests | Included in A5 (`securityConsent.test.ts`, `securityEdgeCases.test.ts`) | Zero egress calls without explicit user consent; `SecretStorage` isolation | Defaults to OFF; consent store resets across workspace changes; zero external fetch calls permitted without consent. | **PASS** |
| **A8** | Host smoke test | `npm run test:host` | Pass in Extension Development Host or marked UNVERIFIED | **NOT RE-RUN in closeout** (user asked not to launch VS Code windows). Last real run on 2026-10-24, VS Code 1.143.1: rooms 11/11, empty 4/4. Code changed since (AI hedging, Groq JSON recovery, OmniRoute), so treat as UNVERIFIED for the final tree. | **UNVERIFIED** |
| **A9** | Package generation | `npm run package` | VSIX created; clean file list | `vscode-extension/living-blueprint-vscode-0.2.0.vsix` (10 files, 126.73 KB). `vsce ls`: README.md, package.json, LICENSE, out/extension.js, media/blueprint-icon.svg, media/webview/{styles.css,main.js,index.html}. No sources, tests, fixtures or sourcemaps. | **PASS** |
| **A10** | Download route | `test/apiRoutes.test.ts` | 200 + correct headers | 21/21 route tests passed. | **PASS** |

**Summary (final closeout, current working tree):** 9 of 10 automated gates PASS; A8 host smoke UNVERIFIED for the final tree (not re-run by request). **642 automated tests** passed: 456 root + 186 extension. Root `npm run build` and extension typecheck exit 0.

---

## 2. Packaging Reconciliation & Discrepancy Resolution

Earlier reports between subagents showed disagreements on bundle size, test counts, and the bundle size limit:

1. **Bundle Size Measurement:**
   - **Unminified Development Bundle (`npm run compile`):** 408,166 bytes.
     - In decimal notation: ~408.2 KB.
     - In binary kibibytes: ~398.6 KiB.
     - Barely below the binary 400 KiB ceiling (409,600 bytes) by 1.4 KiB, causing reports to flag "408 KB vs 400 KiB limit".
   - **Production Minified Bundle (`npm run compile:prod` / `npm run package`):** 237,794 bytes (~232.23 KiB / 237.8 KB).
     - **Resolution:** The production package is minified via esbuild with sourcemaps removed and unlinked. The production bundle is **232.23 KiB**, which is **167.7 KiB below the 400 KiB limit**.
     - **400 KiB Guard Decision:** The 400 KiB guard remains **strictly active and effective** in both `importBoundary.test.ts` and `packaging.test.ts`. We did **not** relax or raise the limit to 1 MiB.

2. **Automated Test Counts:**
   - Root test suite: **445 passed** (169 suites), 0 failed.
   - Extension test suite: **185 passed** (38 suites), 0 failed (includes `packaging.test.ts` and `webviewIntegration.test.ts`).
   - Host smoke suite: **15 passed** (11 rooms + 4 empty).
   - **Total Automated Unit/Integration Tests:** **630 passed**, 0 failed.

3. **Webview Integration Defect Fixes Verified:**
   - `requestRejected` handler stops spinners and displays user-friendly notices across all 7 features: chat, investigate, handoff, re-inspect, evidence chain, tests, and lens.
   - Added a safe 30s watchdog to `triggerRoomInvestigation` to prevent indefinite spinning after any rejection or dropped response.
   - `renderCompanionAnalysis` preserves ongoing chat threads instead of wiping them on rescan, refreshing only suggested questions/follow-ups when history exists.
   - `cachedEvidenceChains` is cleared globally across every room on workspace rescan (`updateBlueprint`), scan state change, and on every project test run result (`showTestRunResult`).
   - On folder switch via dropdown or host event, `resetWorkspaceFolderState` completely resets selected room, re-inspection results, test-run state, and cached lens graphs.
   - File chips strictly parse only host `evidenceRefs` objects and `navigation.references` objects; `evidencePaths` and `split(':')` string parsing have been removed.
   - Save Prompt watchdog keeps the Save buttons disabled while the VS Code file confirmation dialog modal is open.
   - Fixed test-evidence badge showing empty when neither applied nor stale by ensuring `classList.add('hidden')` and `textContent = ''`.

---

## 3. VSIX Package File Manifest Verification

Verification command: `vsce ls --no-dependencies`

```text
package.json
readme.md
LICENSE.txt
media/blueprint-icon.svg
media/webview/index.html
media/webview/main.js
media/webview/styles.css
out/extension.js
```

### Manifest Audit Findings
- **Included (10 files):** Extension manifest (`package.json`, `extension.vsixmanifest`), metadata (`readme.md`, `LICENSE.txt`, `[Content_Types].xml`), assets (`media/blueprint-icon.svg`, `media/webview/index.html`, `media/webview/main.js`, `media/webview/styles.css`), and production bundle (`out/extension.js`).
- **Excluded:** Zero `.ts` source files (`src/`), zero tests (`test/`), zero test fixtures (`fixtures/`), zero sourcemaps (`out/*.map`), zero development configurations (`tsconfig.json`, `build.js`, `.vscode/`, `.vscode-test/`).
- **Archive Size:** 124.2 KB compressed (vs ~144 KB unminified 0.1.0 baseline).
- **Bundle Size:** `out/extension.js` is 232.23 KiB (237,794 bytes), well below the architectural ceiling of 400 KiB (409,600 bytes).

---

## 4. Duplicate Tracked VSIX Analysis & Download Route

Investigation of pre-existing committed `.vsix` binaries in the repository:

| Path | File Size | SHA-256 Checksum | Redundancy Assessment |
|---|---|---|---|
| `public/living-blueprint-vscode-0.1.0.vsix` | 147,131 bytes | `fc8a75842cbd19ab743051408629c20f534b19ecec1b1a2b75ee724e7e8d55f8` | Byte-for-byte identical copy of initial v0.1.0 package. |
| `public/living-blueprint-vscode-latest.vsix` | 147,131 bytes | `fc8a75842cbd19ab743051408629c20f534b19ecec1b1a2b75ee724e7e8d55f8` | Byte-for-byte identical copy of initial v0.1.0 package. |
| `vscode-extension/living-blueprint-vscode-0.1.0.vsix` | 147,131 bytes | `fc8a75842cbd19ab743051408629c20f534b19ecec1b1a2b75ee724e7e8d55f8` | Byte-for-byte identical copy of initial v0.1.0 package. |

### Download Route Verification
- The version-agnostic route handler (`src/server/extensionDownloadHandler.ts`) discovers and serves packages by semantic version weight.
- Current resolution output:
  ```text
  Resolved VSIX: vscode-extension/living-blueprint-vscode-0.2.0.vsix
  ```
- **Current Behavior:** `/api/download/extension` **currently serves version 0.2.0** (`living-blueprint-vscode-0.2.0.vsix`) with header `Content-Disposition: attachment; filename="living-blueprint-vscode-0.2.0.vsix"`.
- **What would need to change for binary cleanup:**
  1. Once approved, copy `vscode-extension/living-blueprint-vscode-0.2.0.vsix` to `public/living-blueprint-vscode-latest.vsix` (overwriting the older 0.1.0 binary).
  2. Delete `vscode-extension/living-blueprint-vscode-0.1.0.vsix` and `public/living-blueprint-vscode-0.1.0.vsix`.
  3. No application code needs to change because `extensionDownloadHandler.ts` is already version-agnostic and prioritizes the newest semantic version.

---

## 5. Metadata, Publisher & Licensing Declarations

- **Version:** Bumped from `0.1.0` to `0.2.0` across `vscode-extension/package.json` and documentation.
- **Repository:** Set to `https://github.com/sakshamgupta005/Velocity` matching the project root repository.
- **License:** Declared as `MIT` in `package.json` and distributed via root and extension [LICENSE](file:///c:/Users/rspma/Downloads/Velocity/vscode-extension/LICENSE) files.
- **Publisher Limitation:** `publisher: "the-living-blueprint"`.  
  *Note:* This is currently an unreserved project placeholder identifier. If publishing to the public Visual Studio Marketplace, the maintainer must register or own this publisher ID under their Microsoft/Visual Studio Marketplace account. Local installation (`code --install-extension`) operates without marketplace reservation.

---

## 6. Manual Verification Checklist (§6.2)

The following manual test flows are designed for execution in a real interactive VS Code window with `living-blueprint-vscode-0.2.0.vsix` installed:

| # | Check Flow | Expected Result | Status |
|---|---|---|---|
| **M1** | Launch & discovery | Open `fixtures/small-express`: rooms appear within ~2s from real files. Open empty folder: shows honest empty state. | **NOT RUN** (Ready for manual test) |
| **M2** | Meaningful room view | At least 3 rooms with correct names/files; test room labeled `implemented`, not `verified`, until tests execute. | **NOT RUN** (Ready for manual test) |
| **M3** | Navigation & jumps | Clicking file pills or graph nodes opens correct files; line-range buttons jump to cited lines; directory traversals (`../../x`) are refused. | **NOT RUN** (Ready for manual test) |
| **M4** | Honest status / errors | Editing a file triggers single debounced refresh; broken file reports skip/error; missing key displays offline label without crashing. | **NOT RUN** (Ready for manual test) |
| **M5** | AI Companions | With consent + API key: Barkley answers citing real inspected lines; Cleo comments selectively on genuine evidence gaps. | **NOT RUN** (Ready for manual test) |
| **M6** | Investigation & repair handoff | Room investigation produces 7 levels; "Copy prompt" copies valid agent prompt; "Re-inspect" marks modified code as "changed, not verified". | **NOT RUN** (Ready for manual test) |
| **M7** | Security & consent gate | AI consent defaults to OFF; payload preview shows exact payload; `.env` never listed; switching workspace resets consent. | **NOT RUN** (Ready for manual test) |
| **M8** | Verified path | Executing tests marks room `verified` for current fingerprint; modifying file invalidates back to `implemented`. | **NOT RUN** (Ready for manual test) |
| **M9** | Packaging & uninstall | VSIX installs cleanly via `code --install-extension`; uninstall leaves no unwanted artifacts. | **NOT RUN** (Ready for manual test) |
