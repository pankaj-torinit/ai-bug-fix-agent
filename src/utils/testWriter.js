const fs = require('node:fs');
const path = require('node:path');

const { detectNodeProjectRoot } = require('./nodeProjectResolver');

/** Relative path for the AI-generated reproduction test within a Node project. */
const AI_TEST_FILENAME = 'ai_generated_bug.test.js';

/**
 * Save generated Jest test code to the repo.
 * Creates the tests/ directory if it does not exist.
 *
 * @param {string} repoPath - Absolute path to the cloned repository root.
 * @param {string} testCode - Full contents of the test file (Jest test code).
 * @returns {string} Repo-relative path of the written file.
 */
function saveTest(repoPath, testCode) {
  const detected = detectNodeProjectRoot(repoPath);
  const projectRel = detected?.projectRelPath || '';
  const testRelPath = projectRel ? path.posix.join(projectRel, 'tests', AI_TEST_FILENAME) : path.posix.join('tests', AI_TEST_FILENAME);
  const absolutePath = path.join(repoPath, testRelPath);
  const dir = path.dirname(absolutePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(absolutePath, testCode, 'utf8');
  return testRelPath;
}

/**
 * Remove the AI-generated test file from the repo (e.g. when discarding a failed attempt).
 *
 * @param {string} repoPath - Absolute path to the cloned repository root.
 * @returns {boolean} True if the file existed and was removed.
 */
function removeTest(repoPath) {
  const detected = detectNodeProjectRoot(repoPath);
  const projectRel = detected?.projectRelPath || '';
  const testRelPath = projectRel ? path.posix.join(projectRel, 'tests', AI_TEST_FILENAME) : path.posix.join('tests', AI_TEST_FILENAME);
  const absolutePath = path.join(repoPath, testRelPath);
  if (!fs.existsSync(absolutePath)) return false;
  fs.unlinkSync(absolutePath);
  return true;
}

module.exports = {
  saveTest,
  removeTest,
  AI_TEST_FILENAME
};
