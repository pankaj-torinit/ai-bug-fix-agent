const fs = require('node:fs');
const path = require('node:path');
const llmService = require('../services/llmService');
const { resolveRepoFilePath } = require('../utils/nodeProjectResolver');

/**
 * @typedef {{ mainFile: string, mainSnippet: string, relatedFiles: Array<{ path: string, code: string }> }} CodeContext
 */

/**
 * Analyze a bug using LLM with full code context (main snippet + related files).
 * If the LLM identifies a target file not in the provided context, a second call
 * is made with that file's content so the LLM can produce an accurate fix.
 *
 * @param {Object} params
 * @param {string} params.error - Error message
 * @param {string[]} params.stacktrace - Stacktrace lines
 * @param {CodeContext} params.context - Structured context from contextService.buildContext()
 * @param {string} [params.repoPath] - Absolute path to cloned repo
 * @param {string} [params.previousAttemptError] - Feedback from a failed previous attempt
 * @returns {Promise<import('../services/llmService').AnalyzeBugResult>}
 */
async function analyzeBugWithContext(params) {
  const { error, stacktrace, context, repoPath, previousAttemptError } = params;

  const codeSnippet = context.mainSnippet;

  const availableFiles = [context.mainFile];
  const contextFilePaths = new Set([context.mainFile]);

  const relatedSections = [];
  if (context.relatedFiles && context.relatedFiles.length > 0) {
    relatedSections.push(
      'OTHER SOURCE FILES (the bug may be in one of these — check carefully):',
      ...context.relatedFiles.map(
        (f) => `\n===== FILE: ${f.path} =====\n${f.code}\n===== END FILE =====`
      )
    );
    for (const f of context.relatedFiles) {
      availableFiles.push(f.path);
      contextFilePaths.add(f.path);
    }
  }

  const result = await llmService.analyzeBug({
    error,
    stacktrace,
    codeSnippet,
    mainFile: context.mainFile,
    availableFiles,
    repoPath,
    relatedFilesSection: relatedSections.join('\n'),
    previousAttemptError
  });

  // Phase 2: The LLM may identify the root cause in a file not in the context.
  // Check both rootCauseFile and targetFile — either can point to the real file.
  const candidateFile = result.rootCauseFile || result.targetFile;
  const needsPhase2 =
    repoPath &&
    candidateFile &&
    candidateFile !== context.mainFile &&
    !contextFilePaths.has(candidateFile);

  if (needsPhase2) {
    const resolved = resolveRepoFilePath(repoPath, candidateFile);
    const absPath = path.join(repoPath, resolved);

    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      console.log(
        '[BugAnalyzer] LLM identified root cause in "%s" which was not in context — loading it and re-prompting',
        resolved
      );

      const targetContent = fs.readFileSync(absPath, 'utf8');
      const targetLines = targetContent.split('\n');
      const numberedContent = targetLines.map((l, i) => `${i + 1}: ${l}`).join('\n');

      const newAvailableFiles = [...new Set([...availableFiles, resolved])];
      const newRelated = [
        relatedSections.join('\n'),
        `\n===== FILE: ${resolved} =====\n${targetContent}\n===== END FILE =====`
      ].filter(Boolean).join('\n');

      return llmService.analyzeBug({
        error,
        stacktrace,
        codeSnippet: numberedContent,
        mainFile: resolved,
        availableFiles: newAvailableFiles,
        repoPath,
        relatedFilesSection: newRelated,
        previousAttemptError: `The root cause is in ${resolved}. You MUST fix THIS file. Here is its full content.`
      });
    }
  }

  return result;
}

module.exports = {
  analyzeBugWithContext
};
