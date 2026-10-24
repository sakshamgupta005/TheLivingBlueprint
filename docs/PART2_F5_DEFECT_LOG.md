# Part 2 — F5 / Extension Development Host Defect Log (P2-02)

Date: 2026-10-23
Milestone: P2-02 (`docs/PART2_IMPLEMENTATION_PLAN.md`)
Status: Fixtures created, test suite decoupled, awaiting manual F5 execution.

---

## 1. Manual Testing Instructions

1. Open `vscode-extension/` in Visual Studio Code.
2. Press **F5** to launch the Extension Development Host window.
3. In the Host window, test each fixture workspace:
   - `vscode-extension/test/fixtures/empty`
   - `vscode-extension/test/fixtures/small-express`
   - `vscode-extension/test/fixtures/ts-lib`
   - The root repository (`Velocity`)
4. Click the **Living Blueprint** icon on the Activity Bar.
5. Execute the interactions listed in the checklist below and record results.

---

## 2. F5 Smoke Test Checklist

| Interaction / Item | Expected Behavior | PASS / FAIL | Notes / Observations |
|---|---|:---:|---|
| **F5 Launch** | Extension Development Host window launches cleanly without fatal extension host crashes. | | |
| **Extension View Visibility** | Living Blueprint activity-bar icon appears; clicking it opens the sidebar overview view with rendered webview content. | | |
| **Empty-Folder Behavior** | Opening `test/fixtures/empty` handles the empty workspace gracefully without throwing uncaught exceptions. | | |
| **Fixture Scanning & Room Rendering** | Opening `small-express` or `ts-lib` discovers workspace files, detects architecture rooms (e.g. server, auth, tests), and renders them in the view. | | |
| **Clicking a Room** | Clicking a room highlights the room and filters/focuses the corresponding details or files. | | |
| **Opening a File Through a File Pill** | Clicking a file pill in evidence/details opens the target source file in the editor at the specified line. | | |
| **File-Edit Refresh** | Creating or editing a file in the workspace triggers an automatic architectural refresh. | | |
| **Manual Refresh** | Clicking the "Refresh" title action icon triggers a workspace re-scan and updates the view. | | |
| **Consent Toggle** | Toggling the AI consent option in the view updates internal state without crashing. | | |
| **“Configure AI Provider Credentials” Prompt** | Executing `livingBlueprint.setApiKey` opens the input prompt for API key configuration. | | |

---

## 3. Defect & Observation Log

*To be populated during manual F5 session:*

| ID | Fixture / Workspace | Observed Symptom | Suspected Root Cause | Severity |
|---|---|---|---|:---:|
| D-01 | | | | |
