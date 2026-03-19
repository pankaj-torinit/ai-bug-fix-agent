const fs = require('node:fs');
const path = require('node:path');
const { readCodeSnippet } = require('../utils/fileSnippet');
const { resolveRepoFilePath } = require('../utils/nodeProjectResolver');

/** Maximum number of related files to include in context. */
const MAX_RELATED_FILES = 5;

/** Maximum total context size in characters (mainSnippet + related file contents). */
const MAX_CONTEXT_CHARS = 20_000;

/**
 * @typedef {Object} RelatedFile
 * @property {string} path - Repo-relative file path
 * @property {string} code - Full file content (possibly truncated)
 */

/**
 * @typedef {Object} CodeContext
 * @property {string} mainFile - Repo-relative path of the stacktrace file
 * @property {string} mainSnippet - Snippet (20 lines above/below error line)
 * @property {RelatedFile[]} relatedFiles
 */

/**
 * Extract import specifiers from file content (require and ES imports).
 * Only static string literals are considered; dynamic requires are skipped.
 *
 * @param {string} fileContent
 * @returns {string[]} Unique import paths (relative or package names)
 */
function extractImports(fileContent) {
  const specifiers = new Set();

  // require('...') or require("...")
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = requireRe.exec(fileContent)) !== null) {
    specifiers.add(m[1]);
  }

  // import x from '...' or import { a } from '...'
  const importFromRe = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+)?['"]([^'"]+)['"]/g;
  while ((m = importFromRe.exec(fileContent)) !== null) {
    specifiers.add(m[1]);
  }

  // import '...' (side-effect)
  const importSideEffectRe = /import\s+['"]([^'"]+)['"]\s*;?/g;
  while ((m = importSideEffectRe.exec(fileContent)) !== null) {
    specifiers.add(m[1]);
  }

  return [...specifiers];
}

/**
 * Resolve an import specifier relative to the given file's directory.
 * Returns repo-relative path or null if not an in-repo file (e.g. node_modules).
 *
 * @param {string} repoPath - Absolute path to repo root
 * @param {string} fromFile - Repo-relative path of the file containing the import
 * @param {string} specifier - Import path (e.g. './util', '../lib/foo')
 * @returns {string|null} Repo-relative path or null
 */
function resolveImportPath(repoPath, fromFile, specifier) {
  // Skip node modules and non-relative paths (we only want in-repo files)
  if (!specifier.startsWith('.')) {
    return null;
  }

  const fromDir = path.dirname(path.join(repoPath, fromFile));
  let resolved = path.resolve(fromDir, specifier);
  const repoRoot = path.resolve(repoPath);

  if (!resolved.startsWith(repoRoot)) {
    return null;
  }

  // Resolve to actual file if extension omitted
  const ext = path.extname(resolved);
  if (!ext) {
    const withJs = resolved + '.js';
    const withTs = resolved + '.ts';
    const withMjs = resolved + '.mjs';
    if (fs.existsSync(withJs)) resolved = withJs;
    else if (fs.existsSync(withTs)) resolved = withTs;
    else if (fs.existsSync(withMjs)) resolved = withMjs;
    else if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        const indexJs = path.join(resolved, 'index.js');
        const indexTs = path.join(resolved, 'index.ts');
        if (fs.existsSync(indexJs)) resolved = indexJs;
        else if (fs.existsSync(indexTs)) resolved = indexTs;
        else return null;
      }
    } else {
      return null;
    }
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return null;
  }

  const relative = path.relative(repoRoot, resolved).replaceAll('\\', '/');
  // Exclude node_modules and anything outside allowed areas if desired
  if (relative.includes('node_modules')) {
    return null;
  }
  return relative;
}

/**
 * Build structured code context for LLM: main file snippet + up to 5 related files.
 * Total context is capped at MAX_CONTEXT_CHARS.
 *
 * @param {string} repoPath - Absolute path to cloned repository root
 * @param {string} mainFile - Repo-relative path of the file from the stacktrace
 * @param {number} line - 1-based line number of the error
 * @returns {CodeContext}
 */
function buildContext(repoPath, mainFile, line) {
  const resolvedMainFile = resolveRepoFilePath(repoPath, mainFile);
  const mainAbsPath = path.join(repoPath, resolvedMainFile);
  if (!fs.existsSync(mainAbsPath)) {
    return {
      mainFile: resolvedMainFile,
      mainSnippet: '',
      relatedFiles: []
    };
  }

  const mainFileContent = fs.readFileSync(mainAbsPath, 'utf8');

  // For files under ~200 lines, send the full file so the LLM can produce
  // an exact unified diff. For larger files, fall back to the snippet.
  const mainFileLines = mainFileContent.split('\n');
  let mainSnippet;
  if (mainFileLines.length <= 200) {
    mainSnippet = mainFileLines.map((l, i) => `${i + 1}: ${l}`).join('\n');
  } else {
    mainSnippet = readCodeSnippet(repoPath, resolvedMainFile, line, 20).snippet;
  }

  const importSpecifiers = extractImports(mainFileContent);

  /** @type {RelatedFile[]} */
  const relatedFiles = [];
  const seen = new Set([resolvedMainFile]);
  let relatedChars = 0;

  for (const spec of importSpecifiers) {
    if (relatedFiles.length >= MAX_RELATED_FILES) break;
    const resolved = resolveImportPath(repoPath, resolvedMainFile, spec);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);

    const absPath = path.join(repoPath, resolved);
    let code = fs.readFileSync(absPath, 'utf8');
    const budget = MAX_CONTEXT_CHARS - mainSnippet.length - relatedChars;
    if (budget <= 0) break;
    if (code.length > budget) {
      code = code.slice(0, budget) + '\n// ... truncated for context limit';
    }
    relatedChars += code.length;
    relatedFiles.push({ path: resolved, code });
  }

  const mainBudget = MAX_CONTEXT_CHARS - relatedChars;
  const finalMainSnippet =
    mainSnippet.length > mainBudget
      ? mainSnippet.slice(0, mainBudget) + '\n// ... truncated'
      : mainSnippet;

  return {
    mainFile: resolvedMainFile,
    mainSnippet: finalMainSnippet,
    relatedFiles
  };
}

module.exports = {
  buildContext,
  MAX_CONTEXT_CHARS,
  MAX_RELATED_FILES
};
