const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const simpleGit = require('simple-git');
const config = require('../../config');

/**
 * @typedef {import('simple-git').SimpleGit} SimpleGit
 */

/**
 * @param {string|number} id
 * @returns {string}
 */
function sanitizeWorkspaceSegment(id) {
  const s = String(id)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s.slice(0, 96) || 'job';
}

/**
 * Create an empty per-job workspace under {@link config.tempRepoPath} (W10 — safe for concurrent workers).
 *
 * @param {string} workspaceId - e.g. `${job.id}-${eventId}`
 * @returns {string} Absolute path to the new empty directory (clone target)
 */
function prepareJobWorkspacePath(workspaceId) {
  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new TypeError('workspaceId is required for isolated clone directory');
  }
  const base = config.tempRepoPath;
  fs.mkdirSync(base, { recursive: true });
  const unique = `${sanitizeWorkspaceSegment(workspaceId)}-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const repoPath = path.join(base, unique);
  if (fs.existsSync(repoPath)) {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
  fs.mkdirSync(repoPath, { recursive: true });
  return repoPath;
}

/**
 * Clone the target repository into a job-specific directory.
 *
 * @param {string} repoUrl
 * @param {string} workspaceId - Unique per BullMQ job (e.g. `${job.id}-${eventId}`)
 * @returns {Promise<{ git: SimpleGit, repoPath: string }>}
 */
async function cloneRepo(repoUrl, workspaceId) {
  const repoPath = prepareJobWorkspacePath(workspaceId);
  /** @type {SimpleGit} */
  const git = simpleGit();
  const repoLabel = config.githubRepo || '(unknown repo)';
  console.log('[RepoService] Cloning', repoLabel, 'into', repoPath);
  await git.clone(repoUrl, repoPath);
  const repoGit = simpleGit(repoPath);
  return { git: repoGit, repoPath };
}

/**
 * Checkout a branch (e.g. production).
 * @param {SimpleGit} git
 * @param {string} branch
 */
async function checkoutBranch(git, branch) {
  console.log('[RepoService] Checking out branch', branch);
  await git.checkout(branch);
}

/**
 * Create and checkout a new fix branch.
 *
 * @param {SimpleGit} git
 * @param {string} baseBranch
 * @param {string} branchName
 */
async function createFixBranch(git, baseBranch, branchName) {
  console.log('[RepoService] Creating fix branch', branchName, 'from', baseBranch);
  await git.checkout(baseBranch);
  await git.checkoutBranch(branchName, baseBranch);
}

module.exports = {
  cloneRepo,
  checkoutBranch,
  createFixBranch
};
