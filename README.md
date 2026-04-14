## AI Bug Fix Agent

Production-grade Node.js AI agent that listens to Sentry production errors, analyzes them with an LLM, generates a patch, runs tests in a Docker sandbox, and opens a GitHub pull request with the fix.

Application code lives under **`src/`**: `src/agents/`, `src/services/`, `src/utils/`, `src/workers/`, and `src/sandbox/`. Entry points remain at the project root: `index.js`, `config.js`, `queue.js`.

---

### High-Level Architecture

- **Sentry webhook (`/sentry-webhook`)**
  - Sentry sends error events to the Express API.
  - The API validates and normalizes the payload, extracts `event_id`, `message`, and stacktrace, and enqueues a job into the **BullMQ** `bugFixQueue`.

- **BullMQ queue (`bugFixQueue`)**
  - Stores pending bug-fix jobs backed by **Redis**.
  - Each job carries the error message, stacktrace, top file+line, and raw payload.

- **Worker (`src/workers/fixWorker.js`)**
  - Consumes `bugFixQueue` jobs and runs the `processBug()` pipeline:
    1. Clone GitHub repository (using `simple-git`).
    2. Checkout production branch.
    3. Create a new fix branch (`ai-fix/sentry-{eventId}`).
    4. **Build code context** (`src/services/contextService.js`): read the stacktrace file, extract a 20-line-above/below snippet, parse `require`/ES imports, resolve in-repo paths, and load up to **5 related files** (max **20k characters** total).
    5. **Generate reproduction test** (`src/agents/testGenerator.js`): LLM generates a Jest test that reproduces the bug. The test is saved to `tests/ai_generated_bug.test.js` via `src/utils/testWriter.js`. Tests are run; the system **verifies the new test fails** (reproducing the bug). If the test does not fail, it is discarded and generation is retried (up to **2** attempts total).
    6. **Generate fix** via `src/agents/bugAnalyzer.js`: the LLM returns **complete corrected file content** for a `targetFile` (not a raw unified diff). **Review** the programmatically generated diff via `src/agents/patchReviewer.js`: the reviewer checks it against the bug context (correctness, regressions, standards, security) and returns `{ approved, reason }`. If **rejected** → revert the file and regenerate (max **5** retries, i.e. up to **6** attempts). Reviewer decisions are logged (`APPROVED` / `REJECTED` + reason).
    7. **Apply** the approved change with `src/services/patchService.js` `applyFixedFile()`: writes the new content, runs `git diff` to build a unified diff, then **`validatePatch()`** guardrails (same limits as below). The fix is already on disk after validation; `git apply` is not used for this path.
       - Max **100 changed lines** in the generated diff.
       - Only paths under allowed prefixes (see **Notes and Guardrails**).
       - Blocks `package.json`, typical `*config*`, and `*.env` paths in those trees.
    8. Run tests inside a **Docker** sandbox (`node:20`) with resource limits (including the AI-generated test; it should pass after the fix).
    9. If tests pass, commit, push the branch, and create a **GitHub Pull Request**.

- **Docker safety sandbox (`src/sandbox/dockerRunner.js`)**
  - Uses **Dockerode** to start `node:20` containers.
  - Mounts the cloned repo **read-only** at `/workspace` and overlays a **tmpfs** on `node_modules` (and nested package `node_modules` when applicable) so dependencies install without writing into tracked source.
  - Runs **`npm ci`** when a matching `package-lock.json` is present (root or monorepo layout), otherwise **`npm install --no-audit --no-fund --no-package-lock`**, then **`npm test`**; captures exit code and destroys the container.
  - **Safety restrictions**: memory limit **512 MB**, CPU limit (0.5 CPU).
  - **Networking**: defaults to allowing network access (so npm can fetch dependencies). Set `SANDBOX_NETWORK_MODE=none` to disable.
  - If Docker is unavailable, tests run **locally** in the worker (same npm command style, but without container isolation).
  - Logs: `Starting sandbox`, `Running tests`, `Sandbox finished`.

- **Code context (`src/services/contextService.js`)**
  - Builds structured context for the LLM: main file snippet (20 lines above/below the error line), parses `require()` and ES `import` from that file, resolves relative paths inside the repo, and loads up to **5 related files** (full code, truncated if needed).
  - Total context is capped at **20,000 characters** so the prompt stays within model limits.

- **Agents**
  - `src/agents/bugAnalyzer.js`: accepts error, stacktrace, and context; calls the LLM with main snippet + related files for analysis and **full-file** fix content (`targetFile`, `fixedFileContent`).
  - `src/agents/testGenerator.js`: accepts error, stacktrace, and context; calls the LLM to generate a Jest test that reproduces the bug; returns test file content.
  - `src/agents/patchReviewer.js`: accepts generated patch, error, stacktrace, and context; calls the LLM to decide if the patch is correct, introduces regressions, violates coding standards, or causes security risks; returns `{ approved: boolean, reason: string }`.

- **Services** (all under `src/services/`)
  - `src/services/repoService.js`: per-job workspace under `TEMP_REPO_PATH`, clone, and branch operations (via `simple-git`).
  - `src/services/githubService.js`: staging explicit paths, commit, push, and PRs via GitHub REST API.
  - `src/services/contextService.js`: stacktrace-driven context (snippet + related files).
  - `src/services/llmService.js`: OpenAI-compatible client for analysis, tests, fixes, and patch review.
  - `src/services/patchService.js`: `applyFixedFile`, diff validation; also exposes `applyPatch` / `normalizePatch` for unified-diff flows.
  - `src/services/webhookDedup.js`: Redis-backed Sentry event dedup and webhook rate budgets (with `index.js`).

- **Utils** (all under `src/utils/`)
  - `src/utils/stacktraceParser.js`: extracts file path and line number from Sentry-style stacktraces.
  - `src/utils/fileSnippet.js`: reads 20 lines above and below the target line (used by the context service).
  - `src/utils/testWriter.js`: `saveTest(repoPath, testCode)` writes the generated test to `tests/ai_generated_bug.test.js`; `removeTest(repoPath)` deletes it (e.g. when discarding a non-failing attempt).

---

### Setup

#### 1. Install dependencies

```bash
cd ai-bug-fix-agent
npm install
```

#### 2. Configure environment

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

Required variables:

- **`PORT`**: API server port (default `3000`).
- **`LLM_API_KEY`**: OpenAI API key used by the LLM service.
- **`GITHUB_TOKEN`**: GitHub personal access token with `repo`/PR permissions.
- **`GITHUB_REPO`**: Target repo in `owner/repo` format, e.g. `my-org/my-service`.
- **`GITHUB_PROD_BRANCH`**: Name of the production branch (e.g. `prod`, `main`).
- **`TEMP_REPO_PATH`**: Absolute **parent** directory for clones. Each job uses a **unique subdirectory** under this path (see `src/services/repoService.js`); do not point this at a single shared working copy.
- **`REDIS_URL`**: Redis connection string, e.g. `redis://127.0.0.1:6379`.

Optional variables (see **`.env.example`** for the full list and comments):

- **`SENTRY_CLIENT_SECRET`**: If set, the webhook verifies `sentry-hook-signature` using HMAC-SHA256 over the **raw** request body. If unset, verification is skipped.
- **`SENTRY_ALLOWED_PROJECTS`**: Comma-separated allowlist (stub in `index.js`; wire in when needed).
- **`NGROK_AUTHTOKEN`**: If set, the API starts an ngrok tunnel on startup and prints a public webhook URL for Sentry.
- **`DOCKER_SOCKET`**: Docker socket path (default `/var/run/docker.sock`).
- **`SANDBOX_NETWORK_MODE`**: Sandbox network mode (default `bridge`; use `none` to block outbound network).
- **`WORKER_CONCURRENCY`**: BullMQ worker concurrency (default `1`). Safe to raise: each job uses its own clone directory under `TEMP_REPO_PATH`.
- **`TRUST_PROXY`**: Set to `1` when behind ngrok/reverse proxy so rate limits use the real client IP.
- **`LLM_MODEL`**, **`LLM_BASE_URL`**: Generator model and API base (defaults: `gpt-4.1-mini`, OpenAI).
- **`LLM_REVIEW_MODEL`**, **`LLM_REVIEW_BASE_URL`**, **`LLM_REVIEW_API_KEY`**: Optional separate reviewer client (defaults align with generator; key falls back to `LLM_API_KEY`).
- **`LLM_REQUEST_TIMEOUT_MS`**, **`SANDBOX_DOCKER_TIMEOUT_MS`**, **`SANDBOX_LOCAL_TIMEOUT_MS`**: Request/sandbox wall-clock caps (see `config.js` defaults).
- **`WEBHOOK_RATE_LIMIT_MAX`**, **`WEBHOOK_RATE_LIMIT_WINDOW_MS`**, **`SENTRY_EVENT_DEDUP_TTL_SEC`**, **`WEBHOOK_GLOBAL_MAX_PER_MINUTE`**: Webhook rate limiting and Redis dedup (see `config.js`; `0` disables a limit).

If Docker is available, tests run in the container sandbox above. If not, the worker **falls back** to running the same style of npm commands in the clone (less isolated).

---

### How to Run Redis

- **Local Redis via Docker** (recommended):

```bash
docker run --name ai-agent-redis -p 6379:6379 -d redis:7-alpine
```

- **Or using a local Redis installation**:

```bash
redis-server
```

Make sure `REDIS_URL` in `.env` matches your Redis endpoint.

---

### How to Start the API Server

In one terminal:

```bash
cd ai-bug-fix-agent
npm start
```

The Express server will start on `http://localhost:${PORT}` (default: `http://localhost:3000`) and expose:

- `POST /sentry-webhook` – endpoint for Sentry error events.
- `GET /health` – simple health check.

---

### How to Start the Worker

In a separate terminal (Redis must be running):

```bash
cd ai-bug-fix-agent
npm run worker
```

The worker will:

- Connect to the `bugFixQueue` using **BullMQ** (concurrency from **`WORKER_CONCURRENCY`**, default `1`).
- Process jobs (one concurrent pipeline per worker slot when `WORKER_CONCURRENCY` is above `1`).
- Log each step: cloning, branch creation, **building context**, **test generation and verification**, LLM fix generation, **patch review**, applying the fix, tests, and PR creation.

---

### How to Simulate a Sentry Webhook

You can simulate a minimal Sentry-like payload using `curl`:

```bash
curl -X POST http://localhost:3000/sentry-webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event_id": "1234567890abcdef",
    "message": "TypeError: Cannot read properties of undefined",
    "exception": {
      "values": [
        {
          "type": "TypeError",
          "value": "Cannot read properties of undefined",
          "stacktrace": {
            "frames": [
              {
                "filename": "src/services/userService.js",
                "lineno": 42,
                "in_app": true
              }
            ]
          }
        }
      ]
    }
  }'
```

If successful, the API will respond with `202 Accepted` and log:

- `Received Sentry Error`
- `Job queued`

The worker process will then:

1. **Clone** the configured GitHub repo (`GITHUB_REPO`) into a **new subdirectory** under `TEMP_REPO_PATH`.
2. **Checkout** the production branch (`GITHUB_PROD_BRANCH`).
3. **Create** a branch named `ai-fix/sentry-1234567890abcdef`.
4. **Build context**: read the main file snippet (20 lines around line 42), parse its imports, resolve in-repo paths, and load up to 5 related files (total context ≤ 20k chars).
5. **Generate a Jest test** that reproduces the bug; save to `tests/ai_generated_bug.test.js`; run tests. The system requires the new test to **fail** (reproducing the bug). If it does not fail, the test is discarded (up to **two** generation attempts).
6. **Generate fix** with the LLM (full file content), then **review** the generated diff: the AI reviewer approves or rejects. If rejected, regenerate (max **5** retries, **6** attempts). On approval, **`applyFixedFile`** applies the change.
7. Run **post-fix** tests in Docker (reproduction test still present).
8. **Remove** the AI-generated test, **commit** (only the touched source file), **push** the fix branch.
9. **Create a PR** with title `AI Fix: TypeError: Cannot read properties of undefined`.

---

### Logging and Observability

Key log messages include:

- **Received Sentry Error** – webhook accepted.
- **Job queued** – job added to `bugFixQueue`.
- **Cloning repo** – repo clone start.
- **Building code context** – context service building main snippet + related files.
- **Generating reproduction test** – test generator and verification (test must fail before fix).
- **Generating fix** / **Reviewing generated diff** – LLM fix attempt and reviewer (`Patch reviewer: APPROVED — …` / `REJECTED — …`); retries on reject or apply failure.
- **Applying fixed file and generating diff** – `applyFixedFile` for the approved change.
- **Running post-fix tests** / **Sandbox** – Docker (or local fallback) test run.
- **Creating PR** – PR request to GitHub.

In production you can route these logs to a centralized system (e.g. Cloud Logging, Datadog, ELK).

---

### How AI-generated tests work

Before generating a fix, the agent tries to add a **Jest test that reproduces the bug**:

1. **Generation**: The LLM is given the error, stacktrace, and code context (main file snippet + related files) and returns a full Jest test file that exercises the failing code path.
2. **Saving**: The test is written to **`tests/ai_generated_bug.test.js`** in the cloned repo (the `tests/` directory is created if needed).
3. **Verification**: The test suite is run in the Docker sandbox. The agent **requires the new test to fail** (i.e. the test reproduces the bug). If the test fails, reproduction is confirmed and the test is kept.
4. **Retry**: If the generated test does **not** fail, the file is **discarded** (`removeTest`), and the agent retries (up to **two** generation attempts total). If reproduction is still not verified, the pipeline continues **without** a failing reproduction test (no test file is committed).
5. **After the fix**: Once the patch is applied, tests are run again. The agent also compares the number of Jest failures before vs. after the fix and will fail the job if the fix introduces *more* failing tests than the baseline.
6. **Before committing**: The worker **removes** `tests/ai_generated_bug.test.js` before committing/pushing. This keeps PRs focused on the fix; the reproduction test is currently used only as an internal verification step.

This flow improves confidence in the patch by verifying a reproduction (when possible) and preventing the fix from increasing the number of failing tests.

---

### Patch reviewer

Before a generated patch is applied, the **AI Patch Reviewer** (`src/agents/patchReviewer.js`) evaluates it:

- **Correctness**: Does it fix the reported error and root cause?
- **Regressions**: Could it break existing behavior or other code paths?
- **Coding standards**: Does it follow common Node.js/JS style?
- **Security**: Does it introduce or worsen security risks?

The reviewer returns `{ approved: boolean, reason: string }`. The worker logs the decision clearly:

- `Patch reviewer: APPROVED — <reason>`
- `Patch reviewer: REJECTED — <reason>`

If the patch is **rejected**, the worker regenerates a new patch (up to **5 retries**, 6 attempts in total). If still not approved after that, the job fails.

---

### Notes and Guardrails

- **Code context**: The LLM receives the main file snippet (20 lines above/below the error) plus up to 5 related files (resolved from imports). Total context is limited to **20k characters**; excess is truncated.
- **Patch validation** (`validatePatch` on the generated diff) enforces:
  - **Max 100 changed lines**.
  - Paths must start with one of: `src/`, `services/`, `controllers/`, `server/src/`, `server/services/`, `server/controllers/`, `client/src/`, `client/services/`, `client/controllers/`.
  - Blocks diffs touching `package.json`, paths matching typical `*config*`, or `*.env` in those trees (see `src/services/patchService.js`).
- The agent is designed to be **conservative**: if cloning, context building, patch application, tests, or PR creation fail, the job is logged and fails without impacting your production service.

