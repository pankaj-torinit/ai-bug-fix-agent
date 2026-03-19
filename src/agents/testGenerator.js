const llmService = require('../services/llmService');

/**
 * @typedef {{ mainFile: string, mainSnippet: string, relatedFiles: Array<{ path: string, code: string }> }} CodeContext
 */

/**
 * Generate a Jest test that reproduces the bug.
 *
 * @param {Object} params
 * @param {string} params.error - Error message
 * @param {string[]} params.stacktrace - Stacktrace lines
 * @param {CodeContext} params.context - Structured context from contextService.buildContext()
 * @returns {Promise<string>} Jest test file content
 */
async function generateTest(params) {
  const { error, stacktrace, context } = params;

  const relatedSections = [];
  if (context.relatedFiles && context.relatedFiles.length > 0) {
    relatedSections.push(
      'Related files:',
      ...context.relatedFiles.map((f) => `\n--- ${f.path} ---\n${f.code}`)
    );
  }

  return llmService.generateReproductionTest({
    error,
    stacktrace,
    mainFile: context.mainFile,
    mainSnippet: context.mainSnippet,
    relatedFilesSection: relatedSections.length ? relatedSections.join('\n') : undefined
  });
}

module.exports = {
  generateTest
};
