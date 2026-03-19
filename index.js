/**
 * Entry point - Express API server for Sentry webhooks.
 */

const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { bugFixQueue } = require('./queue');
const { parseStacktrace } = require('./src/utils/stacktraceParser');
const crypto = require('crypto');
const ngrok = require('@ngrok/ngrok');
const app = express();

const SENTRY_CLIENT_SECRET = process.env.SENTRY_CLIENT_SECRET;
app.use(bodyParser.json({ limit: '1mb' }));

// Log every incoming request with trigger time and duration
app.use((req, res, next) => {
  const start = Date.now();
  const timestamp = new Date().toISOString();
  const cyan = '\x1b[36m';
  const reset = '\x1b[0m';
  console.log(`${cyan}[Request] ${timestamp} ${req.method} ${req.originalUrl}${reset}`);

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const status = res.statusCode;
    const green = '\x1b[32m';
    const yellow = '\x1b[33m';
    const red = '\x1b[31m';

    let color = green;
    if (status >= 400 && status < 500) {
      color = yellow;
    } else if (status >= 500) {
      color = red;
    }

    console.log(
      `${color}[Request Completed] ${timestamp} ${req.method} ${req.originalUrl} - ${status} in ${durationMs}ms${reset}`
    );
  });

  next();
});

/**
 * Validate incoming Sentry webhook request.
 * Handles:
 * - Raw event payloads
 * - Alert rule webhooks where the event is nested under `data.event`
 * - Issue webhooks (which we currently ignore for processing, as they lack full event data)
 * @param {import('express').Request} req
 * @returns {{ valid: boolean, reason?: string, event?: any }}
 */
function validateSentryPayload(req) {
  const payload = req.body;

  if (!payload) {
    return { valid: false, reason: 'Empty payload' };
  }

  // Optional: restrict to allowed projects
  // const projectSlug = payload.data?.issue?.project?.slug || payload.issue?.project?.slug;
  // const allowedProjects = (process.env.SENTRY_ALLOWED_PROJECTS || '').split(',').filter(Boolean);
  // if (allowedProjects.length && !allowedProjects.includes(projectSlug)) {
  //   console.log(`⏩ Skipping project: ${projectSlug}`);
  //   return { valid: false, reason: 'Project not in scope' };
  // }

  // Action/resource routing from Sentry
  const { action } = payload;
  const resource = req.headers['sentry-hook-resource'];

  // Prefer alert rule "triggered" webhooks that include full event data
  if (action === 'triggered' && resource === 'event_alert') {
    console.log('🔔 Received Sentry event alert (triggered).');
  } else if (action === 'created' && resource === 'issue') {
    // Issue-only webhook; does not contain full event/stacktrace, so we skip processing.
    const issueTitle = payload.data?.issue?.title;
    console.log(`⏩ Ignoring issue webhook without event data: ${issueTitle || 'unknown title'}`);
    return { valid: false, reason: 'Issue webhook without event data' };
  } else if (action || resource) {
    // Any other combination we currently ignore
    return { valid: false, reason: `Ignoring webhook: action=${action}, resource=${resource}` };
  }

  // Normalize to an "event" object:
  // - plain event payloads
  // - alert webhooks where event is under data.event
  const event = payload.event || payload.data?.event || payload;

  // Sentry's event payloads can be complex; we only require a minimal set.
  const eventId = event.event_id;
  const issueTitle = payload.data?.issue?.title;
  const exception = event.exception?.values?.[0];
  const message =
    event.message?.formatted ||
    event.logentry?.formatted ||
    event.message ||
    exception?.value ||
    issueTitle ||
    'Sentry event';
  const stacktrace = (exception?.stacktrace?.frames) || event.stacktrace || [];

  if (!eventId) return { valid: false, reason: 'Missing event_id' };
  if (!stacktrace || !Array.isArray(stacktrace) || stacktrace.length === 0) {
    return { valid: false, reason: 'Missing stacktrace' };
  }

  // Optional: verify Sentry signature if secret is configured
  if (SENTRY_CLIENT_SECRET) {
    const signature = req.headers['sentry-hook-signature'];
    const body = JSON.stringify(payload);
    const hmac = crypto.createHmac('sha256', SENTRY_CLIENT_SECRET);
    hmac.update(body, 'utf8');
    const digest = hmac.digest('hex');

    if (digest !== signature) {
      return { valid: false, reason: 'Invalid signature' };
    }
  }

  return { valid: true, event };
}

app.post('/sentry-webhook', async (req, res) => {
  console.log('[Webhook] Received Sentry Error');

  // Persist raw webhook payload for debugging/audit
  try {
    const requestsDir = path.join(__dirname, 'requests');
    if (!fs.existsSync(requestsDir)) {
      fs.mkdirSync(requestsDir, { recursive: true });
    }
    const filename = `sentry-${Date.now()}.json`;
    const filePath = path.join(requestsDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2), 'utf8');
    console.log(`[Webhook] Saved raw payload to ${filePath}`);
  } catch (err) {
    console.error('[Webhook] Failed to persist raw payload', err);
  }

  const validation = validateSentryPayload(req);
  if (!validation.valid) {
    console.error('[Webhook] Invalid payload:', validation.reason);
    return res.status(400).json({ error: 'Invalid payload', reason: validation.reason });
  }

  const payload = req.body;
  const event = validation.event;
  const eventId = event.event_id;
  const issueTitle = payload.data?.issue?.title;
  const exception = event.exception?.values?.[0];
  const message =
    event.message?.formatted ||
    event.logentry?.formatted ||
    event.message ||
    exception?.value ||
    issueTitle ||
    'Sentry event';
  const stacktraceFrames = (exception?.stacktrace?.frames) || event.stacktrace || [];
  let file;
  let line;
  let stacktrace;
  let contextLines;

  try {
    console.log('[Webhook] Parsing stacktrace frames for event', eventId);
    ({ file, line, stacktrace, contextLines } = parseStacktrace(stacktraceFrames));
  } catch (err) {
    console.error('[Webhook] Failed to parse stacktrace frames, enqueuing with minimal data', err);
    file = null;
    line = null;
    stacktrace = stacktraceFrames || [];
    contextLines = [];
  }

  const jobData = {
    eventId,
    message,
    stacktrace,
    file,
    line,
    contextLines,
    rawPayload: payload
  };

  try {
    console.log('[Webhook] Enqueuing job for event', eventId);
    await bugFixQueue.add('processBug', jobData, {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: false
    });
    console.log('[Webhook] Job queued for event', eventId);
    res.status(202).json({ status: 'queued', eventId });
  } catch (err) {
    console.error('[Webhook] Failed to queue job', err);
    res.status(500).json({ error: 'Failed to queue job' });
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(config.port, async () => {
  console.log(`API server listening on port ${config.port}`);

  // Start the ngrok tunnel automatically
  try {
    const session = await ngrok.connect({
      addr: config.port,
      authtoken: process.env.NGROK_AUTHTOKEN,
    });

    console.log(`🚀 Public Webhook URL: ${session.url()}/sentry-webhook`);
    console.log(`👉 Paste this URL into Sentry Developer Settings!`);
  } catch (err) {
    console.error('Error starting ngrok:', err);
  }
});

