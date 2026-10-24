# The Living Blueprint — VS Code Extension (v0.2.0)

> **Visual software-architecture house and deterministic evidence engine directly in VS Code.**  
> Know what AI coding agents have actually built, what remains unverified, and inspect real code evidence in your workspace.

---

## Installation

### Option 1: Install via VS Code Command Line (Recommended)

After downloading or building `living-blueprint-vscode-0.2.0.vsix`:

```bash
code --install-extension living-blueprint-vscode-0.2.0.vsix
```

### Option 2: Install from VS Code GUI

1. Open VS Code.
2. Open the **Extensions** view (`Ctrl+Shift+X` or `Cmd+Shift+X`).
3. Click the **Views and More Actions** (`...`) menu at the top of the Extensions view.
4. Select **Install from VSIX...**
5. Select `living-blueprint-vscode-0.2.0.vsix`.

### Option 3: Download from The Living Blueprint Web App

When running the web application, download the packaged VSIX directly from `/api/download/extension` or the toolbar download button, then install as above.

---

## Core Extension Features

- **Automatic Architecture Discovery**: Automatically scans opened workspace folders with bounded inspection, ignoring `.git`, `node_modules`, build artifacts, and vendor files.
- **Deterministic Status Engine**: Evaluates module and requirement readiness based strictly on observed source files and verified test execution records. Unverified tests remain truthfully labeled as *Implemented*, never claiming *Verified*.
- **Multi-Lens Architecture Visualizations**:
  - **Overview Lens**: Topological modules, layer hierarchy, and status summaries.
  - **Flow Lens**: Traces call chains and request journeys across functions and services.
  - **Components Lens**: Detailed breakdown of components, exported symbols, and schemas.
  - **Status Lens**: Strict requirement-by-requirement verification status breakdown.
- **Evidence-Backed Investigation**:
  - Deep room-level inspection with 7-level grounded findings.
  - Transparent separation of observed code facts (`✓`) from architectural inferences (`↳`).
  - Clickable line ranges (e.g. `L12-L18`) that instantly jump to exact source lines in VS Code.
- **Repair Prompt Handoff**: Generates self-contained, copy-ready repair prompts tailored for autonomous coding agents with exact line references, reproduction steps, and verifiable acceptance criteria.
- **Local Re-Inspection Engine**:
  - Dedicated **Re-inspect** action to verify code changes against original evidence.
  - Compares diffs, checks git commit SHAs, and verifies passing test records.
- **Dual-Persona AI Companions (Barkley & Cleo)**:
  - **Barkley (Dog)**: Friendly, helpful architectural walkthroughs and analogies.
  - **Cleo (Cat)**: Skeptical auditor probing unverified assumptions and missing tests.
- **Secure SecretStorage & Per-Folder Consent**:
  - Per-folder AI consent policy defaults to OFF. External AI calls require explicit user authorization per folder.
  - API keys (Gemini, Groq, Cloudflare) are stored in native VS Code `SecretStorage` and never logged, exposed to webviews, or leaked.
- **100% Offline by Default**: Discovery, architecture mapping, lenses, and deterministic status evaluation operate completely offline without external network calls.

---

## Development & Building

The extension uses pinned dependencies and builds reproducibly via esbuild:

```bash
# Install dependencies
npm install

# Compile development bundle (with sourcemap)
npm run compile

# Compile production-minified bundle (no sourcemaps, <400 KiB)
npm run compile:prod

# Typecheck TypeScript sources
npm run typecheck

# Run unit tests (182 tests)
npm test

# Run opt-in Extension Development Host tests
npm run test:host

# Package production VSIX
npm run package
```
