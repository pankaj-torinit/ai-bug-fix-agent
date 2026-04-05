/**
 * Hardening for Sentry-sourced (attacker-controlled) text before it is embedded in LLM prompts.
 * This does not make prompt injection impossible; it reduces risk and marks data as non-instructional.
 */

const DEFAULT_MAX_ERROR_CHARS = 8000;
const DEFAULT_MAX_STACK_LINE_CHARS = 2000;
const DEFAULT_MAX_STACK_LINES = 150;
const DEFAULT_MAX_RETRY_FEEDBACK_CHARS = 4000;

/** @type {RegExp} */
const CTRL_EXCEPT_NEWLINE_TAB = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * @param {unknown} str
 * @param {number} maxLen
 * @returns {string}
 */
function sanitizeUntrustedPlainText(str, maxLen = DEFAULT_MAX_ERROR_CHARS) {
  let s = str == null ? '' : String(str);
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.replace(CTRL_EXCEPT_NEWLINE_TAB, '');
  if (s.length > maxLen) {
    s = `${s.slice(0, maxLen)}\n…[truncated]`;
  }
  return s;
}

/**
 * @param {unknown} lines
 * @param {number} maxLines
 * @param {number} maxLineLen
 * @returns {string[]}
 */
function sanitizeUntrustedStacktrace(
  lines,
  maxLines = DEFAULT_MAX_STACK_LINES,
  maxLineLen = DEFAULT_MAX_STACK_LINE_CHARS
) {
  if (!Array.isArray(lines)) return [];
  return lines
    .slice(0, maxLines)
    .map((line) => sanitizeUntrustedPlainText(line, maxLineLen));
}

/**
 * Prevent the wrapped body from breaking out of delimiter pairs in the user message.
 * @param {string} body
 * @param {string} beginMarker
 * @param {string} endMarker
 * @returns {string}
 */
function stripDelimiterCollisions(body, beginMarker, endMarker) {
  return body.split(beginMarker).join('[removed_marker]').split(endMarker).join('[removed_marker]');
}

/**
 * @param {string} beginMarker
 * @param {string} endMarker
 * @param {string} body
 * @returns {string}
 */
function wrapUntrustedBlock(beginMarker, endMarker, body) {
  const inner = stripDelimiterCollisions(body, beginMarker, endMarker);
  return `${beginMarker}\n${inner}\n${endMarker}`;
}

const MARKERS = {
  errorBegin: '<<<UNTRUSTED_SENTRY_ERROR_BEGIN>>>',
  errorEnd: '<<<UNTRUSTED_SENTRY_ERROR_END>>>',
  stackBegin: '<<<UNTRUSTED_SENTRY_STACK_BEGIN>>>',
  stackEnd: '<<<UNTRUSTED_SENTRY_STACK_END>>>',
  retryBegin: '<<<UNTRUSTED_RETRY_FEEDBACK_BEGIN>>>',
  retryEnd: '<<<UNTRUSTED_RETRY_FEEDBACK_END>>>'
};

module.exports = {
  DEFAULT_MAX_ERROR_CHARS,
  DEFAULT_MAX_STACK_LINE_CHARS,
  DEFAULT_MAX_STACK_LINES,
  DEFAULT_MAX_RETRY_FEEDBACK_CHARS,
  sanitizeUntrustedPlainText,
  sanitizeUntrustedStacktrace,
  wrapUntrustedBlock,
  MARKERS
};
