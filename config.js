/**
 * Global configuration for the AI bug fix agent.
 * @module config
 */

require('dotenv').config();

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
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379'
};

module.exports = config;

