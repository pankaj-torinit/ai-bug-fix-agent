const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { detectNodeProjectRoot } = require('../utils/nodeProjectResolver');

/**
 * Normalize a patch string returned by the LLM into something `git apply` can consume.
 *
 * 1. Strip markdown fences
 * 2. Extract only the unified-diff block (starting at `--- a/`)
 * 3. Remove uniform indentation the model may have added
 * 4. Convert bare empty lines inside hunks to context lines (single space)
 * 5. Recalculate @@ hunk header line counts so they match the actual body
 *
 * @param {string} rawPatch
 * @returns {string}
 */
function normalizePatch(rawPatch) {
  if (typeof rawPatch !== 'string') {
    throw new TypeError('Patch must be a string');
  }

  const raw = rawPatch.replaceAll('\r\n', '\n');

  const lines = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('```') && line !== '```');

  const startIdx = lines.findIndex((l) => /^---\s+a\//.test(l.trimStart()));
  if (startIdx === -1) return raw.trim();

  const tail = lines.slice(startIdx);

  // ── Step 1: strip uniform indentation ──
  let indentMin = Infinity;
  for (const l of tail) {
    if (l.trim() === '') continue;
    const t = l.trimStart();
    if (
      t.startsWith('--- ') ||
      t.startsWith('+++ ') ||
      t.startsWith('@@ ') ||
      t.startsWith('diff --git') ||
      t.startsWith('index ')
    ) {
      const indent = l.length - t.length;
      if (indent < indentMin) indentMin = indent;
    }
  }
  if (!Number.isFinite(indentMin)) indentMin = 0;

  const deindented = tail.map((l) => {
    if (l.trim() === '') return '';
    let i = 0;
    while (i < indentMin && (l[i] === ' ' || l[i] === '\t')) i += 1;
    return l.slice(i);
  });

  // ── Step 2: extract only valid diff lines ──
  const isFileHeader = (l) =>
    l.startsWith('diff --git ') ||
    l.startsWith('index ') ||
    l.startsWith('new file mode') ||
    l.startsWith('deleted file mode') ||
    l.startsWith('--- a/') ||
    l.startsWith('+++ b/');

  const isHunkHeader = (l) => l.startsWith('@@ ');
  const isHunkLine = (l) =>
    l.startsWith(' ') || l.startsWith('+') || l.startsWith('-') || l.startsWith('\\');

  const extracted = [];
  let inHunk = false;

  for (const l of deindented) {
    if (l === '') {
      if (inHunk) {
        extracted.push(' ');
      }
      continue;
    }

    if (isFileHeader(l)) {
      inHunk = false;
      extracted.push(l);
      continue;
    }

    if (isHunkHeader(l)) {
      inHunk = true;
      extracted.push(l);
      continue;
    }

    if (inHunk && isHunkLine(l)) {
      extracted.push(l);
      continue;
    }

    if (extracted.length > 0) break;
  }

  // ── Step 3: recalculate @@ line counts ──
  const fixed = recalcHunkHeaders(extracted);

  return fixed.join('\n').trim();
}

/**
 * Walk through extracted diff lines and rewrite every `@@ -A,B +C,D @@`
 * header so that B and D match the actual number of old/new lines in the hunk body.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function recalcHunkHeaders(lines) {
  const result = [];
  let hunkHeaderIdx = -1;
  let oldStart = 0;
  let newStart = 0;
  let oldCount = 0;
  let newCount = 0;

  function flushHunk() {
    if (hunkHeaderIdx === -1) return;
    result[hunkHeaderIdx] = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
  }

  for (const l of lines) {
    if (l.startsWith('@@ ')) {
      flushHunk();
      hunkHeaderIdx = result.length;

      const m = l.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldStart = m ? Number(m[1]) : 1;
      newStart = m ? Number(m[2]) : 1;
      oldCount = 0;
      newCount = 0;
      result.push(l);
      continue;
    }

    if (hunkHeaderIdx !== -1) {
      if (l.startsWith('-')) {
        oldCount += 1;
      } else if (l.startsWith('+')) {
        newCount += 1;
      } else if (l.startsWith(' ') || l.startsWith('\\')) {
        if (!l.startsWith('\\')) {
          oldCount += 1;
          newCount += 1;
        }
      } else {
        flushHunk();
        hunkHeaderIdx = -1;
      }
    }

    result.push(l);
  }

  flushHunk();
  return result;
}

/**
 * Guardrails: validate patch does not exceed line limit and does not modify forbidden paths.
 *
 * @param {string} patch
 */
function validatePatch(patch) {
  const lines = patch.split('\n');

  const allowedPrefixes = [
    'src/',
    'services/',
    'controllers/',
    'server/src/',
    'server/services/',
    'server/controllers/',
    'client/src/',
    'client/services/',
    'client/controllers/'
  ];

  const forbiddenPatterns = [
    /^---\s+a\/(server\/|client\/)?package\.json/,
    /^---\s+a\/(server\/|client\/)?.*config/i,
    /^---\s+a\/(server\/|client\/)?.*\.env/i
  ];

  let changedLines = 0;
  let currentFile = null;

  for (const line of lines) {
    if (line.startsWith('--- a/')) {
      currentFile = line.replace('--- a/', '').trim();
      const allowed = allowedPrefixes.some((p) => currentFile.startsWith(p));
      if (!allowed) {
        throw new Error(`Patch modifies forbidden path: ${currentFile}`);
      }
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(line)) {
          throw new Error(`Patch attempts to modify forbidden file: ${currentFile}`);
        }
      }
    } else if (/^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line)) {
      changedLines += 1;
      if (changedLines > 100) {
        throw new Error('Patch exceeds maximum of 100 changed lines');
      }
    }
  }

  if (changedLines === 0) {
    throw new Error('Patch has no changes');
  }
}

/**
 * Given a possibly-absolute or overly-long path from the LLM, try to find the
 * shortest suffix that actually exists in the repo.
 *
 * E.g. "Users/Pankaj/Sites/foo/server/src/bar.js" → "server/src/bar.js"
 *
 * @param {string} filePath
 * @param {string} repoPath
 * @returns {string}
 */
function resolveToRepoRelative(filePath, repoPath) {
  const fs = require('node:fs');

  // Fast path: already repo-relative
  if (fs.existsSync(path.join(repoPath, filePath))) return filePath;

  // Walk the path segments, trying progressively shorter suffixes
  const parts = filePath.split('/');
  for (let i = 1; i < parts.length; i++) {
    const suffix = parts.slice(i).join('/');
    if (fs.existsSync(path.join(repoPath, suffix))) return suffix;
  }

  return filePath;
}

/**
 * Fix diff `--- a/` and `+++ b/` paths so `git apply` can find the files.
 *
 * Handles two cases:
 * 1. Absolute/long paths from Sentry stacktraces embedded by the LLM
 *    e.g. `Users/Pankaj/Sites/proj/server/src/foo.js` → `server/src/foo.js`
 * 2. Monorepo short paths missing the project prefix
 *    e.g. `src/foo.js` → `server/src/foo.js`
 *
 * @param {string} patch
 * @param {string} repoPath
 * @returns {string}
 */
function fixDiffPaths(patch, repoPath) {
  const fs = require('node:fs');
  const lines = patch.split('\n');
  const detected = detectNodeProjectRoot(repoPath);
  const prefix = detected?.projectRelPath;

  const result = lines.map((line) => {
    const mOld = line.match(/^(--- a\/)(.+)$/);
    if (mOld) {
      let filePath = resolveToRepoRelative(mOld[2], repoPath);
      if (prefix && !filePath.startsWith(prefix + '/')) {
        const candidate = path.join(repoPath, prefix, filePath);
        if (fs.existsSync(candidate)) filePath = `${prefix}/${filePath}`;
      }
      return `--- a/${filePath}`;
    }

    const mNew = line.match(/^(\+\+\+ b\/)(.+)$/);
    if (mNew) {
      let filePath = resolveToRepoRelative(mNew[2], repoPath);
      if (prefix && !filePath.startsWith(prefix + '/')) {
        const candidate = path.join(repoPath, prefix, filePath);
        if (fs.existsSync(candidate)) filePath = `${prefix}/${filePath}`;
      }
      return `+++ b/${filePath}`;
    }

    return line;
  });

  return result.join('\n');
}

/**
 * Apply unified diff patch to repo using git apply.
 *
 * @param {string} repoPath
 * @param {string} rawPatch
 */
function applyPatch(repoPath, rawPatch) {
  console.log('[PatchService] Normalizing patch');
  let patch = normalizePatch(rawPatch);

  console.log('[PatchService] Fixing diff paths for monorepo');
  patch = fixDiffPaths(patch, repoPath);

  console.log('[PatchService] Validating patch');
  validatePatch(patch);

  console.log('[PatchService] Applying patch via git apply');
  const result = spawnSync('git', ['apply', '--whitespace=nowarn'], {
    cwd: repoPath,
    input: patch,
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    try {
      const fs = require('node:fs');
      const debugPath = '/tmp/ai-agent-last-patch.diff';
      fs.writeFileSync(debugPath, patch, 'utf8');
      const patchLines = patch.split('\n');
      console.error('[PatchService] Debug patch saved:', debugPath, `(lines=${patchLines.length})`);
      // Do not print patch to logs — may contain proprietary source or secrets.
    } catch (_) {
      // Non-fatal
    }
    console.error('[PatchService] git apply failed:', result.stderr);
    throw new Error(`git apply failed: ${result.stderr || result.stdout}`);
  }
}

/**
 * Apply a fix by writing the new file content and generating the diff programmatically.
 * This avoids relying on the LLM to produce a syntactically valid unified diff.
 *
 * @param {string} repoPath - Absolute path to cloned repo root
 * @param {string} targetFile - Repo-relative path to the file being fixed
 * @param {string} fixedContent - The complete corrected file content from the LLM
 * @returns {string} The generated unified diff (for review/logging)
 */
function applyFixedFile(repoPath, targetFile, fixedContent) {
  const fs = require('node:fs');
  const absPath = path.join(repoPath, targetFile);

  if (!fs.existsSync(absPath)) {
    throw new Error(`Target file does not exist: ${targetFile}`);
  }

  const originalContent = fs.readFileSync(absPath, 'utf8');

  if (originalContent === fixedContent) {
    throw new Error('Fixed file content is identical to the original — no changes');
  }

  // Write the fixed content
  fs.writeFileSync(absPath, fixedContent, 'utf8');

  // Generate the diff using git diff
  console.log('[PatchService] Generating diff via git diff');
  const diffResult = spawnSync('git', ['diff', '--', targetFile], {
    cwd: repoPath,
    encoding: 'utf8'
  });

  const diff = diffResult.stdout || '';

  if (!diff.trim()) {
    // Restore original if diff is empty (e.g. only whitespace changes that git ignores)
    fs.writeFileSync(absPath, originalContent, 'utf8');
    throw new Error('git diff produced no output — fix may be whitespace-only or identical');
  }

  // Validate the generated diff
  console.log('[PatchService] Validating generated diff');
  try {
    validatePatch(diff);
  } catch (err) {
    // Restore original on validation failure
    fs.writeFileSync(absPath, originalContent, 'utf8');
    throw err;
  }

  // The file is already written with the fix; git diff confirms the changes.
  // We do NOT need to `git apply` since we wrote the file directly.
  console.log('[PatchService] Fix applied successfully');
  return diff;
}

module.exports = {
  applyPatch,
  applyFixedFile,
  normalizePatch,
  validatePatch,
  fixDiffPaths,
  recalcHunkHeaders
};
