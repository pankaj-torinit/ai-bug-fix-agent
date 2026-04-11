const Redis = require('ioredis');
const config = require('../../config');

/** @type {Redis | null} */
let redisClient = null;

/**
 * @returns {Redis}
 */
function getWebhookRedis() {
  if (!redisClient) {
    redisClient = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true
    });
  }
  return redisClient;
}

const DEDUP_PREFIX = 'sentry:webhook:dedup:';

/**
 * Atomically claim this event for processing (W9 deduplication).
 * @param {string} eventId
 * @param {number} ttlSec
 * @returns {Promise<boolean>} true if this request won the claim
 */
async function claimSentryEventDedup(eventId, ttlSec) {
  if (!eventId || typeof eventId !== 'string') {
    return true;
  }
  try {
    const redis = getWebhookRedis();
    const key = DEDUP_PREFIX + eventId;
    const result = await redis.set(key, '1', 'EX', ttlSec, 'NX');
    return result === 'OK';
  } catch (err) {
    console.error('[Webhook] Redis dedup error (fail-open, allowing event):', err.message);
    return true;
  }
}

/**
 * @param {string} eventId
 * @returns {Promise<void>}
 */
async function releaseSentryEventDedup(eventId) {
  if (!eventId || typeof eventId !== 'string') return;
  try {
    await getWebhookRedis().del(DEDUP_PREFIX + eventId);
  } catch (err) {
    console.error('[Webhook] Redis dedup release error:', err.message);
  }
}

/**
 * Global per-minute webhook budget (W9 storm protection).
 * @returns {Promise<boolean>} true if under budget
 */
async function consumeGlobalWebhookBudget() {
  const max = config.webhookGlobalMaxPerMinute;
  if (!max || max <= 0) return true;

  try {
    const redis = getWebhookRedis();
    const bucket = Math.floor(Date.now() / 60000);
    const key = `webhook:global:minute:${bucket}`;
    const n = await redis.incr(key);
    if (n === 1) {
      await redis.expire(key, 120);
    }
    return n <= max;
  } catch (err) {
    console.error('[Webhook] Global budget Redis error (fail-open):', err.message);
    return true;
  }
}

module.exports = {
  getWebhookRedis,
  claimSentryEventDedup,
  releaseSentryEventDedup,
  consumeGlobalWebhookBudget
};
