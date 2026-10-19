# The Living Blueprint — Demonstration Runbook

This runbook provides step-by-step instructions for presenters, evaluators, and engineers to verify, demonstrate, and test **The Living Blueprint** locally and in demonstration environments.

---

## 1. Local Startup and Environment Prerequisites

### Prerequisites
- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher
- **Modern Web Browser**: Chrome, Edge, Firefox, or Safari with JavaScript enabled

### Quickstart Commands
```bash
# 1. Install dependencies
npm install

# 2. Run automated test suite
npm test

# 3. Compile production build (TypeScript + Vite)
npm run build

# 4. Start local development server with AI middleware
npm run dev
```
The application will be accessible at: `http://localhost:3000`

---

## 2. Server-Side AI Configuration & Verification (Gemini Primary + Groq Secondary + Cloudflare Tertiary)

All LLM operations are strictly server-side. Secret API keys are never bundled or exposed to client browsers.

### Environment Setup
Create or update `.env` in the project root (never commit real credentials to source control):
```env
# Primary Provider (Google Gemini)
GEMINI_API_KEY="your-gemini-api-key-here"
AI_MODEL="gemini-3.8-flash"

# Automatic Secondary Fallback Provider (Groq)
# Note: Groq free tier is subject to bounded RPM/TPM rate limits (not unlimited).
GROQ_API_KEY="your-groq-api-key-here"
GROQ_MODEL="qwen/qwen3.8-27b"

# Automatic Tertiary Fallback Provider (Cloudflare Workers AI - Optional)
# Attempted only after Gemini and Groq fail with retryable provider errors (rate limits, timeouts, 5xx).
CLOUDFLARE_ACCOUNT_ID="your-cloudflare-account-id-here"
CLOUDFLARE_API_TOKEN="your-cloudflare-api-token-here"
CLOUDFLARE_AI_MODEL="@cf/meta/llama-3.3-70b-instruct-fp8-fast"
```
> [!NOTE]
> The default Groq fallback model is `qwen/qwen3.8-27b`. The default Cloudflare Workers AI model is `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.

### Verifying Configuration Safely (Zero Key Exposure)
To verify whether the server detects the configured API keys without printing or logging secret values:
```bash
curl -s http://localhost:3000/api/health
```
**Expected Response:**
```json
{
  "status": "ok",
  "service": "The Living Blueprint API",
  "timestamp": "2026-10-19T...",
  "aiConfigured": true,
  "model": "gemini-3.8-flash",
  "geminiConfigured": true,
  "groqConfigured": true,
  "cloudflareConfigured": true,
  "fallbackModel": "qwen/qwen3.8-27b",
  "tertiaryModel": "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
}
```
> [!IMPORTANT]
> A response of `"aiConfigured": true` verifies that at least one AI provider is configured in the server runtime. It does **not** guarantee network connectivity or quota availability with upstream APIs until an actual request executes.

If no provider is configured, repository scanning, house generation, and deterministic verification will still function normally; chat and room investigation will gracefully show setup guidance.

---

## 3. Public Demo Repository

- **Repository URL**: `https://github.com/sakshamgupta005/patchboard-tasks-api`
- **Default Branch**: `main`
- **Baseline Commit SHA**: `4ddfe585adbccd57794efba49ca1102ff654382f`

> [!WARNING]
> **Expected Baseline CI Failure**:
> The baseline commit intentionally contains a failing GitHub Actions CI test run (`✖ rejects whitespace-only task titles` in `test/createTask.test.js`).
> **Do not describe this repository as a repaired or fully passing project.** Its deliberate failure serves as the real-world baseline evidence for defect detection and room blocking.

---

## 4. Identifying Data States (Real vs. Saved vs. Sample)

The Living Blueprint distinguishes data origins clearly in the user interface:

| Data State | Visual Indicator | Source & Characteristics |
| :--- | :--- | :--- |
| **Real Scanned Data** | `Scanned via GitHub API` in Telemetry; active commit SHA shown in header. | Fetched live via GitHub REST API. Real Git tree, actual file contents, live CI check runs. |
| **Saved Workspace** | `Saved Workspace` badge in connection bar; `(Saved)` label beside commit SHA. | Restored from `localStorage` upon page reload. Preserves prior scan, architecture, and chat history. |
| **Partial Scan** | Amber `Partial Scan` badge in connection bar and Telemetry Drawer. | Scan completed with missing file contents, truncated Git tree, or rate-limited check runs. Limitation notice explains missing evidence. |
| **Sample Blueprint** | Gold banner: `Sample Data (Pre-canned Blueprint)` at top of screen. | Synthetic demonstration dataset (BookNook). Explicitly labeled to prevent confusing mock data with verified repositories. |

---

## 5. Safe Demonstration of Failure & Recovery

The Living Blueprint is built to remain honest, resilient, and non-destructive during operational failures:

### A. Demonstrating GitHub API Rate Limits
1. GitHub unauthenticated REST API requests are capped at 60 requests/hour per IP.
2. When the quota is exhausted (HTTP 403 `rate limit exceeded`), the app displays an honest inline status banner:
   - `GitHub rate limit reached — saved scan preserved. Quota resets at HH:MM AM (in ~X mins).`
3. **What is preserved**: The active repository scan, derived house rooms, and existing evidence are completely preserved.
4. **Action**: Automatic retry loops are disabled to prevent spamming GitHub. Wait until the indicated reset time, or continue interacting with the preserved saved workspace.

### B. Demonstrating Partial Scans
1. In the Telemetry Drawer (click **Scan Telemetry** in the bottom right), inspect the scan breakdown:
   - **Discovered Files**: Total paths found in the repository tree.
   - **Inspected Files**: Content successfully fetched and indexed.
   - **Skipped / Failed Reads**: Files omitted due to budget thresholds or network fetch failures.
2. If any content reads fail, the app flags the scan as **Partial**, preserves all validly scanned evidence, and warns the user that conclusions about skipped modules remain unverified.

### C. Demonstrating AI Failure Recovery & Automatic Provider Fallback
1. **Automatic Failover Hierarchy (Gemini → Groq → Cloudflare Workers AI)**:
   - If Gemini encounters daily quota exhaustion (HTTP 429), short-term rate limits, server overload (HTTP 503), or network timeouts, the server automatically re-routes the request to secondary fallback Groq (`qwen/qwen3.8-27b`).
   - If Groq also encounters retryable provider errors (HTTP 429, 5xx, or timeouts), the server automatically re-routes to optional tertiary fallback Cloudflare Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`).
   - The user interface displays a subtle backup indicator (`🛡️ Using backup AI (Groq)` or `🛡️ Using backup AI (Cloudflare)`) alongside response times.
2. **Graceful Handling When All Configured Providers Are Unavailable**:
   - **Chat**: If no provider is configured or all providers encounter quota/rate limits, the chat displays an honest inline recovery banner with a retry countdown when appropriate, preserving conversation history intact.
   - **Investigation**: Fails gracefully without producing fabricated diagnostic findings or empty success cards.
   - **Room Status Integrity**: The deterministic status engine never changes room states based on failed or ungrounded AI calls. Saved architecture and evidence remain safe.

### D. Repository Switching During In-Flight Requests
1. Start a scan or an AI investigation on one repository.
2. Quickly switch to another repository before the first operation completes.
3. The app tracks the active repository key and discards late-arriving asynchronous responses, preventing cross-workspace state corruption.

---

## 6. Pre-Demonstration Verification Checklist

Run through this checklist before presenting or recording a demonstration:

### Setup & Health
- [ ] Dependencies installed (`npm install`)
- [ ] Automated tests passing (`npm test` passes 135+ tests)
- [ ] Production build succeeds (`npm run build`)
- [ ] Dev server running (`npm run dev`)
- [ ] Health endpoint checked: `curl http://localhost:3000/api/health`

### Primary Demo Walkthrough
- [ ] **Scan Real Repository**: Enter `https://github.com/sakshamgupta005/patchboard-tasks-api` and click **Scan**.
- [ ] **Verify Real Commit**: Check that commit SHA `4ddfe585adbccd57794efba49ca1102ff654382f` is displayed.
- [ ] **Verify Live CI Failure**: Verify that the CI status reflects the actual failing GitHub Actions workflow.
- [ ] **Architecture House Interaction**: Click on various rooms (e.g. API Routes, Tasks Domain, Tests, Config); verify that the Room Inspector opens and displays actual repository files.
- [ ] **Telemetry Inspection**: Open **Scan Telemetry**; verify real counts of discovered and inspected files.
- [ ] **Companion Chat (if AI configured)**: Send a message in the chat panel; verify Barkley and Cleo respond with grounded context.
- [ ] **Room Investigation**: Open the failing room in the Inspector and click **🔍 Investigate this room**; verify evidence-grounded diagnosis.
- [ ] **Coding-Agent Repair Prompt**: Click **⚡ Generate coding-agent repair prompt**; verify prompt is generated and can be copied.
- [ ] **Workspace Persistence**: Refresh the browser (F5); verify workspace restores with `Saved Workspace` indicator.
- [ ] **Refresh Operation**: Click **Refresh Scan**; verify repository re-scans cleanly.
