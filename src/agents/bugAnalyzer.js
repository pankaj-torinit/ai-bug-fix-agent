const llmService = require('../services/llmService');

/**
 * @typedef {{ mainFile: string, mainSnippet: string, relatedFiles: Array<{ path: string, code: string }> }} CodeContext
 */

/**
 * Analyze a bug using LLM with full code context (main snippet + related files).
 * Returns the fixed file content rather than a diff (the diff is computed programmatically later).
 *
 * @param {Object} params
 * @param {string} params.error - Error message
 * @param {string[]} params.stacktrace - Stacktrace lines
 * @param {CodeContext} params.context - Structured context from contextService.buildContext()
 * @param {string} [params.previousAttemptError] - Feedback from a failed previous attempt
 * @returns {Promise<import('../services/llmService').AnalyzeBugResult>}
 */
async function analyzeBugWithContext(params) {
  const { error, stacktrace, context, previousAttemptError } = params;

  const codeSnippet = context.mainSnippet;
  const relatedSections = [];

  if (context.relatedFiles && context.relatedFiles.length > 0) {
    relatedSections.push(
      'Related files (imported by the main file):',
      ...context.relatedFiles.map(
        (f) => `\n--- ${f.path} ---\n${f.code}`
      )
    );
  }

  return llmService.analyzeBug({
    error,
    stacktrace,
    codeSnippet,
    mainFile: context.mainFile,
    relatedFilesSection: relatedSections.join('\n'),
    previousAttemptError
  });
}

module.exports = {
  analyzeBugWithContext
};
