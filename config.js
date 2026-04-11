/**
 * Global configuration for the AI bug fix agent.
 * @module config
 */

require('dotenv').config();

/**
 * @param {string} name
 * @param {number} defaultMs
 * @returns {number}
 */
function parseTimeoutMs(name, defaultMs) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultMs;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : defaultMs;
}

/**
 * @typedef {Object} Config
 * @property {number} port
 * @property {string} openaiApiKey
 * @property {string} llmReviewApiKey
 * @property {string} githubToken
 * @property {string} githubRepo
 * @property {string} githubProdBranch
 * @property {string} tempRepoPath
 * @property {string} redisUrl
 * @property {number} llmRequestTimeoutMs
 * @property {number} sandboxDockerTimeoutMs
 * @property {number} sandboxLocalTimeoutMs
 */

/** @type {Config} */
const config = {
  port: Number(process.env.PORT) || 3000,
  openaiApiKey: process.env.LLM_API_KEY || '',
  /** Patch reviewer; falls back to LLM_API_KEY when unset */
  llmReviewApiKey: process.env.LLM_REVIEW_API_KEY || '',
  githubToken: process.env.GITHUB_TOKEN || '',
  githubRepo: process.env.GITHUB_REPO || '',
  githubProdBranch: process.env.GITHUB_PROD_BRANCH || 'prod',
  tempRepoPath: process.env.TEMP_REPO_PATH || '/tmp/ai-agent-repo',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  /** Per-request cap for chat.completions (W7; matches OpenAI SDK default unless overridden) */
  llmRequestTimeoutMs: parseTimeoutMs('LLM_REQUEST_TIMEOUT_MS', 600000),
  /** Wall-clock cap for Docker npm install + test */
  sandboxDockerTimeoutMs: parseTimeoutMs('SANDBOX_DOCKER_TIMEOUT_MS', 900000),
  /** Wall-clock cap for local fallback npm install + test */
  sandboxLocalTimeoutMs: parseTimeoutMs('SANDBOX_LOCAL_TIMEOUT_MS', 900000)
};

module.exports = config;

