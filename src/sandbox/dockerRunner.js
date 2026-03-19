const Docker = require('dockerode');

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

const { detectNodeProjectRoot } = require('../utils/nodeProjectResolver');

/** Memory limit: 512 MB. */
const MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;

/** CPU limit: 0.5 CPU (NanoCpus = 500_000_000). */
const NANO_CPUS = 500_000_000;

// Default to allowing network so `npm install` can fetch dependencies.
// You can explicitly disable it by setting SANDBOX_NETWORK_MODE=none.
const SANDBOX_NETWORK_MODE = process.env.SANDBOX_NETWORK_MODE || 'bridge';

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

  const container = await docker.createContainer({
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

  let logs = '';
  try {
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
