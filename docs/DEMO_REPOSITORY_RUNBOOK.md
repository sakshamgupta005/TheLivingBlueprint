# Demonstration Repository Runbook

This runbook guides engineers and presenters through setting up and demonstrating the end-to-end repair and verification workflow of **The Living Blueprint** using the standalone **Patchboard Tasks API** (`demo-repository/`).

---

## 1. Overview & Demonstration Goal

The Living Blueprint proves how developer tools and coding agents can close the loop from defect detection to independently verified resolution:

```
Publish baseline repository (with failing regression test in CI)
       │
       ▼
Scan public GitHub repository in The Living Blueprint
       │
       ▼
Inspect architecture house & trigger room investigation
       │
       ▼
Generate copy-ready, evidence-backed repair prompt
       │
       ▼
Apply the fix in an external coding agent (e.g. Antigravity or Claude Code)
       │
       ▼
Push repair commit to GitHub (CI turns green)
       │
       ▼
Report fix in The Living Blueprint & re-inspect live commit
       │
       ▼
Deterministic status engine transitions room from blocked to verified!
```

---

## 2. Publishing the Standalone Repository to GitHub

> [!IMPORTANT]
> **Do not initialize a nested Git repository directly inside `demo-repository/` in the main workspace.**
> Always copy or export the folder outside the parent repository before initializing Git, to avoid submodule or tracking conflicts.

### Step-by-Step Publishing Guide

1. **Copy the demo repository to a separate clean folder**:
   ```bash
   # From your terminal, copy demo-repository outside the Living Blueprint repo
   # For example (Windows PowerShell):
   Copy-Item -Recurse -Path "demo-repository" -Destination "$HOME/patchboard-tasks-api"
   ```

2. **Initialize Git and create the initial commit in the clean folder**:
   ```bash
   cd "$HOME/patchboard-tasks-api"
   git init -b main
   git add .
   git commit -m "feat: Initial commit of Patchboard Tasks API"
   ```

3. **Create a new public repository on GitHub**:
   - Go to [GitHub > New Repository](https://github.com/new).
   - Name: `patchboard-tasks-api` (or similar).
   - Visibility: **Public** (required so The Living Blueprint can scan it via public API).
   - Do NOT add a README, license, or .gitignore from GitHub (the project already contains them).

4. **Link and push the baseline commit**:
   ```bash
   git remote add origin https://github.com/<your-username>/patchboard-tasks-api.git
   git push -u origin main
   ```

5. **Observe Baseline CI Failure**:
   - Navigate to the GitHub Actions tab in your new repository:
     `https://github.com/<your-username>/patchboard-tasks-api/actions`
   - Observe that the **CI Test Suite** workflow runs and fails on the seeded regression test:
     `✖ rejects whitespace-only task titles`.
   - This baseline failure provides the initial real-world evidence for the demonstration.

---

## 3. Running the Live Demonstration

### Stage 1: Repository Ingestion
1. Open The Living Blueprint website (`http://localhost:3000` or your Vercel deployment URL).
2. Paste the public GitHub URL into the repository input bar:
   `https://github.com/<your-username>/patchboard-tasks-api`
3. Click **Scan Repository**.
4. Observe the interactive architecture house mapping:
   - Identifies API routes (`src/server.js`), task domain logic (`src/tasks/`), and test suites (`test/`).
   - The room status shows failing or blocked verification due to missing proof or unresolved test coverage.

### Stage 2: Room Investigation & Prompt Generation
1. Click on the relevant room module (e.g. **Business Services & API Routes** or **Test Verification & Gateway**).
2. In the Room Inspector panel, click **🔍 Investigate this room**.
3. Observe the structured finding:
   - Identifies the issue and references real scanned files (`src/tasks/validation.js`).
   - Barkley and Cleo introduce the finding in natural dialogue.
4. Click **⚡ Generate coding-agent repair prompt**.
5. Click **📋 Copy prompt for coding agent**.

### Stage 3: External Repair in Coding Agent
1. Open your coding agent (Antigravity or Claude Code) in the separate working copy (`$HOME/patchboard-tasks-api`).
2. Paste the generated repair prompt directly into the agent.
3. The prompt instructs the agent to fix `src/tasks/validation.js`:
   ```javascript
   // Change:
   if (title.length === 0) { ... }
   // To:
   if (title.trim().length === 0) { ... }
   ```
4. Run `npm test` locally in the demo repo — observe that **all 10 tests now pass**:
   ```
   ℹ tests 10
   ℹ suites 2
   ℹ pass 10
   ℹ fail 0
   ```
5. Commit and push the fix:
   ```bash
   git commit -am "fix(validation): reject whitespace-only task titles"
   git push origin main
   ```

### Stage 4: CI Verification & Evidence-Backed Status Update
1. On GitHub, verify that the Actions workflow turns green (`✓ Run Unit and Integration Tests`).
2. Return to The Living Blueprint room inspector.
3. In the **Fix Reporting & Verification Lifecycle** section, click **🛠️ Report fix & re-inspect repository**.
4. Enter a summary (e.g. `Fixed title validation to check trimmed length; all 10 tests passing`) and optionally paste the new commit SHA or URL.
5. Click **🔍 Inspect Updated Repository & Verify**.
6. The Living Blueprint re-inspects the commit:
   - Confirms the updated revision (`isNewRevision: true`).
   - Fetches real GitHub CI check runs and recognizes the completed passing test check (`automated-tests`).
   - Deterministically marks the prior failing evidence as superseded.
   - Updates the room status from **blocked** to **✓ Verified by Evidence** on the software architecture house!
