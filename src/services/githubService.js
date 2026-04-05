const nodeFetch = require('node-fetch');
const fetch = typeof nodeFetch === 'function' ? nodeFetch : nodeFetch.default;
const config = require('../../config');

const GITHUB_API_BASE = 'https://api.github.com';

/**
 * @typedef {Object} PullRequestPayload
 * @property {string} title
 * @property {string} body
 * @property {string} head
 * @property {string} base
 */

/**
 * Build common GitHub request headers.
 * @returns {Record<string, string>}
 */
function getGithubHeaders() {
  if (!config.githubToken) {
    throw new Error('GITHUB_TOKEN is not set');
  }
  return {
    Authorization: `Bearer ${config.githubToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ai-bug-fix-agent'
  };
}

/**
 * Clone repository is handled by repoService using git; this function returns the URL.
 * If GITHUB_TOKEN is set, returns an authenticated URL for private repos.
 *
 * @param {string} repo - owner/repo
 * @returns {string}
 */
function getCloneUrl(repo) {
  if (config.githubToken) {
    return `https://x-access-token:${config.githubToken}@github.com/${repo}.git`;
  }
  return `https://github.com/${repo}.git`;
}

/**
 * Commit local changes. This is done via simple-git in worker, but
 * GithubService provides a convenience helper for commit messages.
 *
 * @param {import('simple-git').SimpleGit} git
 * @param {string} message
 */
async function commitChanges(git, message) {
  console.log('[GithubService] Staging all changes');
  await git.add('.');

  try {
    await git.raw(['reset', 'HEAD', '--', '**/ai_generated_bug.test.js']);
    console.log('[GithubService] Excluded ai_generated_bug.test.js from commit');
  } catch {
    // File was not staged — nothing to unstage
  }

  console.log(
    '[GithubService] Committing with message:',
    message.length > 120 ? `${message.slice(0, 120)}… (${message.length} chars)` : message
  );
  await git.commit(message);
}

/**
 * Push branch to GitHub.
 *
 * @param {import('simple-git').SimpleGit} git
 * @param {string} branchName
 */
async function pushBranch(git, branchName) {
  console.log('[GithubService] Pushing branch', branchName);
  await git.push('origin', branchName, { '--set-upstream': null });
}

/**
 * Create a pull request via GitHub REST API.
 *
 * @param {PullRequestPayload} payload
 * @returns {Promise<any>}
 */
async function createPullRequest(payload) {
  if (!config.githubRepo) {
    throw new Error('GITHUB_REPO is not set');
  }

  const url = `${GITHUB_API_BASE}/repos/${config.githubRepo}/pulls`;
  console.log('[GithubService] Creating PR', payload.title);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getGithubHeaders()
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    const safeBody = text.length > 500 ? `${text.slice(0, 500)}… (${text.length} chars)` : text;
    console.error('[GithubService] Failed to create PR:', res.status, safeBody);
    throw new Error(`Failed to create PR: ${res.status}`);
  }

  const json = await res.json();
  console.log('[GithubService] PR created:', json.html_url);
  return json;
}

module.exports = {
  getCloneUrl,
  commitChanges,
  pushBranch,
  createPullRequest
};
