const fs = require('fs');
const path = require('path');

/**
 * Read a snippet of code around a specific line number.
 *
 * @param {string} repoPath - Absolute path to the cloned repository root.
 * @param {string} filePath - Repo-relative file path (e.g. "src/services/userService.js").
 * @param {number} lineNumber - 1-based target line.
 * @param {number} [radius=20] - Number of lines above/below to include.
 * @returns {{ snippet: string, startLine: number, endLine: number }}
 */
function readCodeSnippet(repoPath, filePath, lineNumber, radius = 20) {
  const absPath = path.join(repoPath, filePath);

  if (!fs.existsSync(absPath)) {
    return { snippet: '', startLine: 0, endLine: 0 };
  }

  const fileContent = fs.readFileSync(absPath, 'utf8');
  const lines = fileContent.split(/\r?\n/);

  const idx = Math.max(1, Number(lineNumber) || 1);
  const start = Math.max(1, idx - radius);
  const end = Math.min(lines.length, idx + radius);

  const snippetLines = [];
  for (let i = start; i <= end; i += 1) {
    snippetLines.push(`${i}: ${lines[i - 1]}`);
  }

  return {
    snippet: snippetLines.join('\n'),
    startLine: start,
    endLine: end
  };
}

module.exports = {
  readCodeSnippet
};
