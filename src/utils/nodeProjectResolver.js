const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_DEPTH = 4;

function isSkippableDir(name) {
  // Avoid huge/irrelevant directories.
  return (
    name === 'node_modules' ||
    name === '.git' ||
    name === 'dist' ||
    name === 'build' ||
    name === '.next' ||
    name === '.nuxt' ||
    name === 'coverage'
  );
}

function safeReadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function walkForPackageJson(repoPath, maxDepth) {
  const results = [];

  /**
   * @param {string} absDir
   * @param {string} relDir
   * @param {number} depth
   */
  function visit(absDir, relDir, depth) {
    if (depth > maxDepth) return;

    const pkgPath = path.join(absDir, 'package.json');
    if (fs.existsSync(pkgPath) && fs.statSync(pkgPath).isFile()) {
      results.push({ relDir, absDir, pkgPath });
    }

    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (isSkippableDir(ent.name)) continue;
      visit(path.join(absDir, ent.name), path.join(relDir, ent.name), depth + 1);
    }
  }

  visit(repoPath, '', 0);
  return results;
}

function scoreProject(pkgJson) {
  const scripts = pkgJson?.scripts || {};
  const devDeps = pkgJson?.devDependencies || {};
  const deps = pkgJson?.dependencies || {};

  let score = 0;

  // Prefer projects that run jest in `npm test`.
  const testScript = typeof scripts.test === 'string' ? scripts.test : '';
  if (testScript.includes('jest')) score += 10;

  // Prefer projects that have jest installed.
  if (devDeps?.jest || deps?.jest) score += 6;

  // Prefer common jest config file patterns.
  if (pkgJson?.jest) score += 2; // package.json jest config

  // Slight preference for server directories.
  return score;
}

/**
 * Detect the "best" Node project root for running tests in monorepos.
 * Returns project root relative to repoPath ('' for repo root).
 *
 * @param {string} repoPath
 * @param {number} [maxDepth]
 * @returns {{ projectRelPath: string, projectAbsPath: string, packageJsonPath: string } | null}
 */
function detectNodeProjectRoot(repoPath, maxDepth = DEFAULT_MAX_DEPTH) {
  const candidates = walkForPackageJson(repoPath, maxDepth);
  if (!candidates.length) return null;

  /** @type {{ relDir: string, absDir: string, pkgPath: string, score: number }[]} */
  const scored = candidates.map((c) => {
    const pkgJson = safeReadJson(c.pkgPath) || {};
    const score = scoreProject(pkgJson);
    return { relDir: c.relDir, absDir: c.absDir, pkgPath: c.pkgPath, score };
  });

  scored.sort((a, b) => b.score - a.score);
  // If all are equal, prefer repo root if present.
  const best = scored[0];
  const rootPkg = scored.find((c) => c.relDir === '');
  if (rootPkg && scored.every((c) => c.score === best.score)) return rootPkg;
  return { projectRelPath: best.relDir, projectAbsPath: best.absDir, packageJsonPath: best.pkgPath };
}

/**
 * Try to locate a repo-relative file under monorepo project roots.
 *
 * @param {string} repoPath
 * @param {string} fileRelPath
 * @param {number} [maxDepth]
 * @returns {string} Resolved repo-relative path (may be unchanged)
 */
function resolveRepoFilePath(repoPath, fileRelPath, maxDepth = DEFAULT_MAX_DEPTH) {
  const normalized = fileRelPath.replace(/\\/g, '/');

  // Fast path: already exists where caller says.
  const directAbs = path.join(repoPath, normalized);
  if (fs.existsSync(directAbs) && fs.statSync(directAbs).isFile()) {
    return normalized;
  }

  // Try under each monorepo project root (e.g. server/, client/).
  const candidates = walkForPackageJson(repoPath, maxDepth);
  for (const c of candidates) {
    const relPrefix = c.relDir ? c.relDir : '';
    const candidateAbs = path.join(repoPath, relPrefix, normalized);
    if (fs.existsSync(candidateAbs) && fs.statSync(candidateAbs).isFile()) {
      return relPrefix ? path.posix.join(relPrefix.replace(/\\/g, '/'), normalized) : normalized;
    }
  }

  // Suffix-based resolution: if the path looks absolute or overly long
  // (e.g. "Users/Pankaj/Sites/.../server/src/foo.js"), walk the segments
  // and try progressively shorter suffixes against the repo.
  const parts = normalized.split('/');
  for (let i = 1; i < parts.length; i++) {
    const suffix = parts.slice(i).join('/');
    const suffixAbs = path.join(repoPath, suffix);
    if (fs.existsSync(suffixAbs) && fs.statSync(suffixAbs).isFile()) {
      return suffix;
    }
  }

  return normalized;
}

module.exports = {
  detectNodeProjectRoot,
  resolveRepoFilePath
};

