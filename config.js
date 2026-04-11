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
 * @param {string} name
 * @param {number} defaultVal
 * @param {boolean} [zeroDisables] - if true, 0 means disabled
 * @returns {number}
 */
function parsePositiveIntEnv(name, defaultVal, zeroDisables = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultVal;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return defaultVal;
  if (zeroDisables && n === 0) return 0;
  return n;
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
 * @property {number} webhookRateLimitWindowMs
 * @property {number} webhookRateLimitMax
 * @property {number} sentryEventDedupTtlSec
 * @property {number} webhookGlobalMaxPerMinute
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
  sandboxLocalTimeoutMs: parseTimeoutMs('SANDBOX_LOCAL_TIMEOUT_MS', 900000),
  /** Per-IP rate limit window for POST /sentry-webhook (W9) */
  webhookRateLimitWindowMs: parseTimeoutMs('WEBHOOK_RATE_LIMIT_WINDOW_MS', 900000),
  /** Max webhook POSTs per IP per window; 0 = disable */
  webhookRateLimitMax: parsePositiveIntEnv('WEBHOOK_RATE_LIMIT_MAX', 100, true),
  /** Redis NX TTL so the same Sentry event_id is not queued twice */
  sentryEventDedupTtlSec: parsePositiveIntEnv('SENTRY_EVENT_DEDUP_TTL_SEC', 604800),
  /** Max webhooks accepted globally per clock minute; 0 = disable */
  webhookGlobalMaxPerMinute: parsePositiveIntEnv('WEBHOOK_GLOBAL_MAX_PER_MINUTE', 120, true)
};

module.exports = config;

