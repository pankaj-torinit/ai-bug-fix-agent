const path = require('path');
const fs = require('fs');
const simpleGit = require('simple-git');
const config = require('../../config');

/**
 * @typedef {import('simple-git').SimpleGit} SimpleGit
 */

/**
 * Ensure the temp repo directory exists and is empty.
 * @returns {string} Absolute path to temp repo dir.
 */
function prepareTempRepoPath() {
  const repoPath = config.tempRepoPath;
  if (fs.existsSync(repoPath)) {
    // Simple but effective cleanup for temp dir
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
  fs.mkdirSync(repoPath, { recursive: true });
  return repoPath;
}

/**
 * Clone the target repository.
 *
 * @param {string} repoUrl
 * @returns {Promise<{ git: SimpleGit, repoPath: string }>}
 */
async function cloneRepo(repoUrl) {
  const repoPath = prepareTempRepoPath();
  /** @type {SimpleGit} */
  const git = simpleGit();
  console.log('[RepoService] Cloning repo', repoUrl, 'into', repoPath);
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
