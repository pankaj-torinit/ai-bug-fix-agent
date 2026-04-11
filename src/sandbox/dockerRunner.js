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
  const workDir = projectRel ? `/workspace/${projectRel}` : '/workspace';

  let container;
  try {
    container = await docker.createContainer({
      Image: 'node:20',
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: [`${repoPath}:/workspace`],
        Memory: MEMORY_LIMIT_BYTES,
        NanoCpus: NANO_CPUS,
        NetworkMode: SANDBOX_NETWORK_MODE
      },
      WorkingDir: workDir,
      Cmd: ['sh', '-c', 'NODE_ENV=development npm install --no-audit --no-fund && npm test']
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
