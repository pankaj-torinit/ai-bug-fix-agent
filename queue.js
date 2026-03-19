/**
 * BullMQ queue configuration for bug fix jobs.
 * @module queue
 */

const { Queue } = require('bullmq');
const config = require('./config');

const connection = { connection: { url: config.redisUrl } };

/**
 * bugFixQueue is responsible for processing production error events.
 */
const bugFixQueue = new Queue('bugFixQueue', connection);

module.exports = {
  bugFixQueue,
  connection
};

