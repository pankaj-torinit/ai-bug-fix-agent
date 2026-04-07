/**
 * BullMQ queue configuration for bug fix jobs.
 * @module queue
 */

const { Queue } = require('bullmq');
const config = require('./config');

/** Redis connection options for BullMQ (Queue + Worker). Not wrapped — Worker uses `{ connection }`. */
const connection = { url: config.redisUrl };

/**
 * bugFixQueue is responsible for processing production error events.
 */
const bugFixQueue = new Queue('bugFixQueue', { connection });

module.exports = {
  bugFixQueue,
  connection
};

