const llmService = require('../services/llmService');

/**
 * @typedef {{ mainFile: string, mainSnippet: string, relatedFiles: Array<{ path: string, code: string }> }} CodeContext
 */

/**
 * Review a generated patch against the bug context and error.
 * Returns whether the patch is approved and a reason.
 *
 * @param {Object} params
 * @param {string} params.patch - Unified diff string
 * @param {string} params.error - Error message
 * @param {string[]} params.stacktrace - Stacktrace lines
 * @param {CodeContext} params.context - Structured context from contextService.buildContext()
 * @returns {Promise<{ approved: boolean, reason: string }>}
 */
async function reviewPatch(params) {
  const { patch, error, stacktrace, context } = params;

  const relatedSections = [];
  if (context.relatedFiles && context.relatedFiles.length > 0) {
    relatedSections.push(
      ...context.relatedFiles.map((f) => `--- ${f.path} ---\n${f.code}`)
    );
  }

  return llmService.reviewPatch({
    patch,
    error,
    stacktrace,
    mainFile: context.mainFile,
    mainSnippet: context.mainSnippet,
    relatedFilesSection: relatedSections.length ? relatedSections.join('\n\n') : undefined
  });
}

module.exports = {
  reviewPatch
};
