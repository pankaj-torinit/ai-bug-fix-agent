const fs = require('node:fs');
const Docker = require('dockerode');
const { spawn } = require('node:child_process');
const path = require('node:path');
const config = require('../../config');

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

const { detectNodeProjectRoot } = require('../utils/nodeProjectResolver');
const { buildUntrustedRepoTestEnv } = require('../utils/safeTestEnv');

/** Memory limit: 512 MB. */
const MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;

/** CPU limit: 0.5 CPU (NanoCpus = 500_000_000). */
const NANO_CPUS = 500_000_000;

// Default to allowing network so `npm install` can fetch dependencies.
// You can explicitly disable it by setting SANDBOX_NETWORK_MODE=none.
const SANDBOX_NETWORK_MODE = process.env.SANDBOX_NETWORK_MODE || 'bridge';

/**
 * Writable tmpfs for `node_modules` only (read-only repo bind, W12). Avoid tmpfs for other paths
 * under `/workspace`: runc often cannot create mount points on a read-only bind mount.
 *
 * @param {string} projectRel - Repo-relative project dir, or '' for repo root.
 * @returns {Record<string, string>} Docker HostConfig.Tmpfs map
 */
function buildSandboxTmpfs(projectRel) {
  const rel = projectRel ? projectRel.replace(/\\/g, '/') : '';
  const base = '/workspace';
  const nodeModulesOpts = 'rw,nosuid,nodev,size=512m';

  // Only tmpfs `node_modules` here. Extra tmpfs under `/workspace` (e.g. `.nyc_output`) breaks on
  // many runc/Docker setups: the runtime mkdirs mount points on the RO bind mount and fails with
  // EROFS even when the host pre-created those dirs. Coverage/nyc output can live under
  // `node_modules` via env in the shell command if needed.
  const out = {
    [`${base}/node_modules`]: nodeModulesOpts
  };
  if (rel) {
    out[`${base}/${rel}/node_modules`] = nodeModulesOpts;
  }
  return out;
}

/**
 * Docker needs an existing directory to attach tmpfs over the bind mount; create empty
 * `node_modules` dirs on the host clone before `createContainer`.
 *
 * @param {string} repoPath - Absolute path to the cloned repo root.
 * @param {string} projectRel - Repo-relative project dir, or ''.
 */
function ensureSandboxTmpfsMountPoints(repoPath, projectRel) {
  const rel = projectRel ? projectRel.replace(/\\/g, '/') : '';
  const dirs = [path.join(repoPath, 'node_modules')];
  if (rel) {
    dirs.push(path.join(repoPath, rel, 'node_modules'));
  }
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/** @param {string} s */
function shellSingleQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/**
 * Install deps + run tests without writing to the read-only bind mount (lockfile lives on RO FS).
 * Uses `npm ci` when a matching package-lock.json is present; otherwise `npm install --no-package-lock`.
 *
 * @param {string} repoPath
 * @param {string} projectRel - Repo-relative project dir, or '' for repo root.
 * @returns {string} Shell snippet for `sh -c`.
 */
function buildSandboxShellCommand(repoPath, projectRel) {
  const rel = projectRel ? projectRel.replace(/\\/g, '/') : '';
  const rootLock = fs.existsSync(path.join(repoPath, 'package-lock.json'));
  const nestedLock = Boolean(rel && fs.existsSync(path.join(repoPath, projectRel, 'package-lock.json')));
  const env = 'NODE_ENV=development';

  if (rootLock && !rel) {
    return `${env} npm ci --no-audit --no-fund && npm test`;
  }
  if (rootLock && rel) {
    return `${env} cd /workspace && npm ci --no-audit --no-fund && npm test --prefix ${shellSingleQuote(rel)}`;
  }
  if (nestedLock && rel) {
    return `${env} cd ${shellSingleQuote(`/workspace/${rel}`)} && npm ci --no-audit --no-fund && npm test`;
  }
  if (!rel) {
    return `${env} npm install --no-audit --no-fund --no-package-lock && npm test`;
  }
  return `${env} cd ${shellSingleQuote(`/workspace/${rel}`)} && npm install --no-audit --no-fund --no-package-lock && npm test`;
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Run tests directly in the worker process (no Docker).
 * This is used as a fallback when Docker is not available.
 *
 * @param {string} repoPath
 * @returns {Promise<{ success: boolean, logs: string, failedTests: number }>}
 */
async function runTestsLocally(repoPath) {
  console.log('[Sandbox] Falling back to local test run (no Docker)');

  const detected = detectNodeProjectRoot(repoPath);
  const projectRel = detected?.projectRelPath || '';
  const workDir = projectRel ? path.join(repoPath, projectRel) : repoPath;

  const localMs = config.sandboxLocalTimeoutMs;

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(
      'sh',
      ['-c', 'NODE_ENV=development npm install --no-audit --no-fund && npm test'],
      {
        cwd: workDir,
        // Do not pass process.env: npm lifecycle scripts must not see agent secrets.
        env: buildUntrustedRepoTestEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    let logs = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      logs += `\n[Sandbox] Local test timed out after ${localMs}ms\n`;
      console.error('[Sandbox] Local test timed out after %d ms', localMs);
      resolve({
        success: false,
        logs,
        failedTests: parseFailedTestCount(logs)
      });
    }, localMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      logs += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      logs += text;
      process.stderr.write(text);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const success = code === 0;
      console.log('[Sandbox] Local test run finished (exit code %d)', code);
      const failedTests = parseFailedTestCount(logs);
      console.log('[Sandbox] Failed tests detected (local): %d', failedTests);
      resolve({ success, logs, failedTests });
    });
  });
}

/**
 * Run tests in a Docker safety sandbox with resource and network restrictions.
 * Creates a container, runs npm install && npm test, captures exit code, then destroys the container.
 *
 * @param {string} repoPath - Absolute path to the cloned repository (will be mounted at /workspace).
 * @returns {Promise<{ success: boolean, logs: string }>}
 */
async function runTestsInSandbox(repoPath) {
  console.log('[Sandbox] Starting sandbox');

  const detected = detectNodeProjectRoot(repoPath);
  const projectRel = detected?.projectRelPath || '';
  const shellCmd = buildSandboxShellCommand(repoPath, projectRel);
  ensureSandboxTmpfsMountPoints(repoPath, projectRel);

  let container;
  try {
    container = await docker.createContainer({
      Image: 'node:20',
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        // Read-only: lifecycle scripts cannot mutate application source; `node_modules` uses tmpfs
        // (see buildSandboxTmpfs — do not add tmpfs under /workspace except node_modules; runc + RO bind fails).
        Binds: [`${repoPath}:/workspace:ro`],
        Tmpfs: buildSandboxTmpfs(projectRel),
        Memory: MEMORY_LIMIT_BYTES,
        NanoCpus: NANO_CPUS,
        NetworkMode: SANDBOX_NETWORK_MODE
      },
      WorkingDir: '/workspace',
      Cmd: ['sh', '-c', shellCmd]
    });
  } catch (err) {
    console.warn(
      '[Sandbox] Failed to create Docker container (%s). Falling back to local test run.',
      err.message
    );
    return runTestsLocally(repoPath);
  }

  let logs = '';
  try {
    const runSandbox = async () => {
      await container.start();
      console.log('[Sandbox] Running tests');

      const stream = await container.logs({
        follow: true,
        stdout: true,
        stderr: true
      });

      await new Promise((resolve, reject) => {
        stream.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          logs += text;
          process.stdout.write(text);
        });
        stream.on('end', resolve);
        stream.on('error', reject);
      });

      const status = await container.wait();
      const success = status.StatusCode === 0;
      console.log('[Sandbox] Sandbox finished (exit code %d)', status.StatusCode);

      const failedTests = parseFailedTestCount(logs);
      console.log('[Sandbox] Failed tests detected: %d', failedTests);

      return { success, logs, failedTests };
    };

    const sandboxTask = runSandbox();
    try {
      return await withTimeout(
        sandboxTask,
        config.sandboxDockerTimeoutMs,
        'Docker sandbox'
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes('timed out')) {
        console.error('[Sandbox] %s — killing container', err.message);
        try {
          await container.kill();
        } catch {
          // ignore
        }
        void sandboxTask.catch(() => {});
      }
      throw err;
    }
  } finally {
    try {
      await container.remove({ force: true });
    } catch (err) {
      console.warn('[Sandbox] Container cleanup failed (non-fatal):', err.message);
    }
  }
}

/**
 * Parse the number of failed tests from Jest output logs.
 * Looks for the "Tests: N failed" line in the Jest summary.
 *
 * @param {string} logs
 * @returns {number} Number of failed tests (0 if none found)
 */
function parseFailedTestCount(logs) {
  const match = logs.match(/Tests:\s+(\d+)\s+failed/);
  return match ? Number(match[1]) : 0;
}

module.exports = {
  runTestsInSandbox
};
