# The Living Blueprint — VS Code Extension

Discovered architecture, component status, and deterministic evidence for your workspace.

## Features

- **Automatic Architecture Discovery**: Automatically scans opened workspace files with bounded inspection, ignoring `.git`, `node_modules`, build artifacts, and vendor files.
- **Deterministic Status Engine**: Evaluates module and requirement readiness based strictly on observed source and verified test records. Test files discovered in source code without execution records are truthfully reported as *Implemented*, never falsely claiming *Verified*.
- **Interactive Architecture Graph**: Renders a topological dependency canvas derived from `layoutEngine.js` with pan/zoom and direct navigation to source files.
- **AI Companions (Barkley & Cleo)**:
  - **Barkley (Dog)**: Friendly architectural explanations, relatable analogies, and guided walkthroughs.
  - **Cleo (Cat)**: Sharp, skeptical reviews highlighting genuine evidence gaps and unverified tests.
- **Clickable Evidence Navigation**: Click any file reference or node in the architecture graph to open the file and jump directly to that line in VS Code.
- **Secure SecretStorage**: API credentials for Gemini, Groq, or Cloudflare are securely stored in VS Code's SecretStorage, never exposed to webviews, logs, or committed files.
- **Safe Local Grounding**: By default, operates 100% offline without sending workspace code to external services unless explicit user consent is granted.

## Quick Start

1. Open a workspace in VS Code.
2. Click the **Living Blueprint** icon on the Activity Bar.
3. Explore the Overview and Architecture Graph views.
