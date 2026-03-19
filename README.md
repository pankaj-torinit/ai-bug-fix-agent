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
    5. **Generate reproduction test** (`src/agents/testGenerator.js`): LLM generates a Jest test that reproduces the bug. The test is saved to `tests/ai_generated_bug.test.js` via `src/utils/testWriter.js`. Tests are run; the system **verifies the new test fails** (reproducing the bug). If the test does not fail, it is discarded and generation is retried **once**.
    6. **Generate patch** via `src/agents/bugAnalyzer.js`: pass context to the LLM to produce a **unified diff** patch. **Review patch** via `src/agents/patchReviewer.js`: the reviewer analyzes the patch against the bug context and error (correctness, regressions, coding standards, security). Returns `{ approved, reason }`. If **approved** → apply the patch. If **rejected** → regenerate patch (max **2 retries**, i.e. up to 3 attempts). Reviewer decisions are logged clearly (`APPROVED` / `REJECTED` + reason).
    7. Validate and apply the approved patch (`git apply`) with guardrails:
       - Max **100 changed lines**.
       - Only under `src/`, `services/`, or `controllers/`.
       - Never touch `package.json`, config, or auth files.
    8. Run tests inside a **Docker** sandbox (`node:20`) with resource limits (including the AI-generated test; it should pass after the fix).
    9. If tests pass, commit, push the branch, and create a **GitHub Pull Request**.

- **Docker safety sandbox (`src/sandbox/dockerRunner.js`)**
  - Uses **Dockerode** to start `node:20` containers.
  - Mounts the cloned repo at `/workspace` and runs `npm install && npm test`; captures exit code and destroys the container after the run.
  - **Security restrictions**: memory limit **512 MB**, CPU limit (0.5 CPU), **network disabled** (`NetworkMode: 'none'`).
  - Logs: `Starting sandbox`, `Running tests`, `Sandbox finished`.

- **Code context (`src/services/contextService.js`)**
  - Builds structured context for the LLM: main file snippet (20 lines above/below the error line), parses `require()` and ES `import` from that file, resolves relative paths inside the repo, and loads up to **5 related files** (full code, truncated if needed).
  - Total context is capped at **20,000 characters** so the prompt stays within model limits.

- **Agents**
  - `src/agents/bugAnalyzer.js`: accepts error, stacktrace, and context; calls the LLM with main snippet + all related files for analysis and patch generation.
  - `src/agents/testGenerator.js`: accepts error, stacktrace, and context; calls the LLM to generate a Jest test that reproduces the bug; returns test file content.
  - `src/agents/patchReviewer.js`: accepts generated patch, error, stacktrace, and context; calls the LLM to decide if the patch is correct, introduces regressions, violates coding standards, or causes security risks; returns `{ approved: boolean, reason: string }`.

- **Services** (all under `src/services/`)
  - `src/services/repoService.js`: cloning repo and branch operations (via `simple-git`).
  - `src/services/githubService.js`: pushing branches and creating PRs via GitHub REST API.
  - `src/services/llmService.js`: OpenAI client and bug analysis + patch generation (prompt includes main file + related files).
  - `src/services/patchService.js`: guardrails and `git apply`.

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
- **`OPENAI_API_KEY`**: OpenAI API key used by the LLM service.
- **`GITHUB_TOKEN`**: GitHub personal access token with `repo`/PR permissions.
- **`GITHUB_REPO`**: Target repo in `owner/repo` format, e.g. `my-org/my-service`.
- **`GITHUB_PROD_BRANCH`**: Name of the production branch (e.g. `prod`, `main`).
- **`TEMP_REPO_PATH`**: Absolute path where the agent clones the repo (e.g. `/tmp/ai-agent-repo`).
- **`REDIS_URL`**: Redis connection string, e.g. `redis://127.0.0.1:6379`.

Ensure Docker is installed and the user running this process can access the Docker socket (usually `/var/run/docker.sock`).

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

- Connect to the `bugFixQueue` using **BullMQ**.
- Process incoming jobs one by one.
- Log each step: cloning, branch creation, **building context**, **test generation and verification**, LLM analysis, patch application, tests, and PR creation.

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

1. **Clone** the configured GitHub repo (`GITHUB_REPO`) into `TEMP_REPO_PATH`.
2. **Checkout** the production branch (`GITHUB_PROD_BRANCH`).
3. **Create** a branch named `ai-fix/sentry-1234567890abcdef`.
4. **Build context**: read the main file snippet (20 lines around line 42), parse its imports, resolve in-repo paths, and load up to 5 related files (total context ≤ 20k chars).
5. **Generate a Jest test** that reproduces the bug; save to `tests/ai_generated_bug.test.js`; run tests. The system requires the new test to **fail** (reproducing the bug). If it does not fail, the test is discarded and generation is retried once.
6. **Generate patch** with the LLM, then **review patch**: the AI reviewer approves or rejects (correctness, regressions, standards, security). If rejected, regenerate patch (max 2 retries).
7. **Apply** the approved patch with guardrails and run tests in Docker (the reproduction test should now pass).
8. **Commit & push** the fix branch.
9. **Create a PR** with title `AI Fix: TypeError: Cannot read properties of undefined`.

---

### Logging and Observability

Key log messages include:

- **Received Sentry Error** – webhook accepted.
- **Job queued** – job added to `bugFixQueue`.
- **Cloning repo** – repo clone start.
- **Building code context** – context service building main snippet + related files.
- **Generating reproduction test** – test generator and verification (test must fail before fix).
- **Generating patch** / **Reviewing patch** – patch generation and reviewer decision (`Patch reviewer: APPROVED — …` or `Patch reviewer: REJECTED — …`); retry if rejected.
- **Analyzing bug** – LLM analysis phase (with full context).
- **Applying patch** – patch application.
- **Running tests / Tests completed** – Docker sandbox test run.
- **Creating PR** – PR request to GitHub.

In production you can route these logs to a centralized system (e.g. Cloud Logging, Datadog, ELK).

---

### How AI-generated tests work

Before generating a fix, the agent tries to add a **Jest test that reproduces the bug**:

1. **Generation**: The LLM is given the error, stacktrace, and code context (main file snippet + related files) and returns a full Jest test file that exercises the failing code path.
2. **Saving**: The test is written to **`tests/ai_generated_bug.test.js`** in the cloned repo (the `tests/` directory is created if needed).
3. **Verification**: The test suite is run in the Docker sandbox. The agent **requires the new test to fail** (i.e. the test reproduces the bug). If the test fails, reproduction is confirmed and the test is kept.
4. **Retry**: If the generated test does **not** fail (e.g. wrong code path or assertion), the file is **discarded** (`removeTest`), and the agent **retries once**: generate a new test, save, and run again. If the second attempt also does not fail, the agent proceeds without a reproduction test (no test file is committed).
5. **After the fix**: Once the patch is applied, tests are run again. The reproduction test (if present) should **pass**, confirming the fix.

This ensures that when a test is included in the PR, it actually failed before the fix and passes after it, improving confidence in the patch.

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

If the patch is **rejected**, the worker regenerates a new patch (up to **2 retries**, 3 attempts in total). If still not approved after that, the job fails.

---

### Notes and Guardrails

- **Code context**: The LLM receives the main file snippet (20 lines above/below the error) plus up to 5 related files (resolved from imports). Total context is limited to **20k characters**; excess is truncated.
- **Patch validation** enforces:
  - **Max 100 changed lines**.
  - Only files under `src/`, `services/`, or `controllers/`.
  - No modifications to `package.json`, config, or auth modules.
- The agent is designed to be **conservative**: if cloning, context building, patch application, tests, or PR creation fail, the job is logged and fails without impacting your production service.

