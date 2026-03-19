const path = require('path');

/**
 * @typedef {Object} ParsedStacktrace
 * @property {string|null} file
 * @property {number|null} line
 * @property {string[]} stacktrace - Human-readable stacktrace lines
 * @property {string[]} contextLines - Lines that look like `file:line`
 */

/**
 * Normalize Sentry stacktrace frames or raw strings into paths and lines.
 *
 * @param {Array<any>} frames - Sentry frames or simple strings like "src/services/userService.js:42"
 * @returns {ParsedStacktrace}
 */
function parseStacktrace(frames) {
  /** @type {string[]} */
  const stackLines = [];
  /** @type {string[]} */
  const contextLines = [];

  let topFile = null;
  let topLine = null;

  if (!Array.isArray(frames)) {
    return { file: null, line: null, stacktrace: [], contextLines: [] };
  }

  // Sentry frames are typically ordered oldest..newest; we care about the last in-app frame.
  const reversed = [...frames].reverse();

  for (const frame of reversed) {
    if (typeof frame === 'string') {
      stackLines.push(frame);
      const parsed = parseLineLike(frame);
      if (parsed) {
        contextLines.push(frame);
        if (!topFile) {
          topFile = parsed.file;
          topLine = parsed.line;
        }
      }
      continue;
    }

    const filename = frame.filename || frame.abs_path || frame.module || null;
    const lineno = frame.lineno || frame.line || null;

    if (filename && lineno) {
      const relPath = normalizePath(filename);
      const line = Number(lineno);
      const rendered = `${relPath}:${line}`;
      stackLines.push(rendered);
      contextLines.push(rendered);

      const inApp = frame.in_app !== false; // Prefer in_app frames
      if (!topFile || inApp) {
        topFile = relPath;
        topLine = line;
      }
    } else if (filename) {
      const relPath = normalizePath(filename);
      stackLines.push(relPath);
    }
  }

  return {
    file: topFile,
    line: topLine,
    stacktrace: stackLines,
    contextLines
  };
}

/**
 * Parse a simple "file:line" string.
 * @param {string} line
 * @returns {{file: string, line: number} | null}
 */
function parseLineLike(line) {
  const match = line.match(/(.+):(\d+)(?::\d+)?$/);
  if (!match) return null;
  const file = normalizePath(match[1]);
  const lineno = Number(match[2]);
  if (!file || Number.isNaN(lineno)) return null;
  return { file, line: lineno };
}

/**
 * Normalize paths to repo-relative style.
 * @param {string} p
 * @returns {string}
 */
function normalizePath(p) {
  let result = p.replace(/^webpack:\/\//, '').replace(/^app:\/\/\/?/, '');
  // strip query/hash
  result = result.split(/[?#]/)[0];
  // Normalize to posix-like for git repo
  result = result.replace(/^[A-Za-z]:[\\/]/, ''); // drop drive letters
  result = result.replace(/\\/g, '/');
  // Strip leading slashes common in Sentry
  result = result.replace(/^\/+/, '');
  return result || path.basename(p);
}

module.exports = {
  parseStacktrace
};
