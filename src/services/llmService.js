const OpenAI = require('openai');
const config = require('../../config');

/** @type {OpenAI} */
let client;

/**
 * Initialize OpenAI client lazily.
 * @returns {OpenAI}
 */
function getClient() {
  if (!client) {
    if (!config.openaiApiKey) {
      throw new Error('OPENAI_API_KEY is not set');
    }
    client = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return client;
}

/**
 * @typedef {Object} AnalyzeBugInput
 * @property {string} error
 * @property {string[]} stacktrace
 * @property {string} codeSnippet - Full file content (with line numbers) or snippet
 * @property {string} [mainFile] - Repo-relative path of main file
 * @property {string} [relatedFilesSection] - Formatted related file contents for prompt
 * @property {string} [previousAttemptError] - Error from a failed previous patch attempt
 */

/**
 * @typedef {Object} AnalyzeBugResult
 * @property {string} rootCause
 * @property {string} patchExplanation
 * @property {string} fixedFileContent - The complete corrected file content
 * @property {string} targetFile - Repo-relative file path
 */

/**
 * Ask the LLM to analyze a bug and return the fixed file content.
 * We compute the unified diff ourselves rather than trusting the LLM to produce one.
 *
 * @param {AnalyzeBugInput} params
 * @returns {Promise<AnalyzeBugResult>}
 */
async function analyzeBug(params) {
  console.log('[LLMService] Analyzing bug with LLM');
  const client = getClient();

  const systemPrompt = [
    'You are an expert senior Node.js engineer.',
    'Given a production error, stacktrace, and the ACTUAL source code of the relevant file, you must:',
    '1. Explain the root cause in concise technical terms.',
    '2. Propose a minimal, safe fix.',
    '3. Return the COMPLETE FIXED FILE CONTENT with your fix applied.',
    '',
    'CRITICAL RULES:',
    '- The fixed file must be based on the EXACT source code provided. Do NOT rewrite or restructure the file.',
    '- Make the MINIMAL change necessary to fix the bug. Keep all other code exactly as-is.',
    '- Preserve all existing imports, exports, function signatures, comments, and whitespace.',
    '- Only modify the lines that directly cause the bug.',
    '- Never modify configuration, auth logic, or package.json.',
    '- Ensure the fix compiles and keeps existing behavior except for the bug fix.',
    '- The fixedFileContent must be the COMPLETE file, not a snippet or partial content.',
    '- The source code below may have line numbers prefixed (e.g. "8: const x = ..."). Strip the line numbers — return only the raw source code.',
    '- Do NOT return an empty string for fixedFileContent. It must contain the full corrected file.'
  ].join('\n');

  // Strip line number prefixes from the snippet so the model sees raw code
  const rawSnippet = params.codeSnippet
    .split('\n')
    .map((line) => line.replace(/^\s*\d+:\s?/, ''))
    .join('\n');

  const sections = [
    'Production error message:',
    params.error,
    '',
    'Stacktrace:',
    params.stacktrace.join('\n'),
    '',
    `===== ACTUAL FILE: ${params.mainFile || 'unknown'} =====`,
    rawSnippet,
    '===== END FILE ====='
  ];

  if (params.relatedFilesSection) {
    sections.push('', params.relatedFilesSection);
  }

  if (params.previousAttemptError) {
    sections.push(
      '',
      'IMPORTANT: A previous attempt to generate a fix FAILED with this error:',
      params.previousAttemptError,
      'You MUST fix this issue. Make sure your fixedFileContent is the COMPLETE corrected file based on the exact source above.'
    );
  }

  sections.push(
    '',
    'Return JSON with these fields:',
    '- "rootCause": concise explanation of why the bug happens',
    '- "patchExplanation": what the fix does',
    '- "fixedFileContent": the COMPLETE corrected file content as a string (all lines, not just the changed ones)'
  );

  const userPrompt = sections.join('\n');

  const response = await client.chat.completions.create({
    model: 'gpt-4.1-mini',
    temperature: 0.2,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    response_format: { type: 'json_object' }
  });

  const content = response.choices[0].message.content;
  const finishReason = response.choices[0].finish_reason;
  if (!content) {
    throw new Error('Empty response from LLM');
  }
  if (finishReason === 'length') {
    console.warn('[LLMService] Response was truncated (finish_reason=length)');
  }

  console.log('[LLMService] Raw LLM response (first 500 chars):', content.slice(0, 500));

  const parsed = JSON.parse(content);

  // The LLM may use varying key names; try common alternatives.
  const fixedFileContent =
    parsed.fixedFileContent ??
    parsed.fixed_file_content ??
    parsed.fixedCode ??
    parsed.fixed_code ??
    parsed.fileContent ??
    parsed.file_content ??
    parsed.code ??
    null;

  if (typeof fixedFileContent !== 'string' || !fixedFileContent.trim()) {
    console.error('[LLMService] LLM response keys:', Object.keys(parsed));
    console.error('[LLMService] fixedFileContent type:', typeof fixedFileContent, 'value preview:', JSON.stringify(fixedFileContent)?.slice(0, 200));
    throw new Error('LLM did not return fixedFileContent. Keys: ' + Object.keys(parsed).join(', '));
  }

  return {
    rootCause: parsed.rootCause || parsed.root_cause || '',
    patchExplanation: parsed.patchExplanation || parsed.patch_explanation || '',
    fixedFileContent,
    targetFile: params.mainFile || ''
  };
}

/**
 * @typedef {Object} GenerateTestInput
 * @property {string} error
 * @property {string[]} stacktrace
 * @property {string} mainFile
 * @property {string} mainSnippet
 * @property {string} [relatedFilesSection]
 */

/**
 * Generate a Jest test that reproduces the given bug.
 *
 * @param {GenerateTestInput} params
 * @returns {Promise<string>} Jest test file content.
 */
async function generateReproductionTest(params) {
  console.log('[LLMService] Generating reproduction test');
  const client = getClient();

  const systemPrompt =
    'You are an expert Node.js engineer. Given a production error, stacktrace, and code context, ' +
    'write a single Jest test file that reproduces the bug. The test must:\n' +
    '1. Use describe/it from Jest.\n' +
    '2. Call the code path that triggers the error (same file/function implied by the stacktrace).\n' +
    '3. Expect the current buggy behavior (so the test should FAIL before the fix and PASS after).\n' +
    '4. Be self-contained: require/import only what exists in the repo; use the main file and related context to infer the API.\n' +
    '5. Return ONLY valid JavaScript for a single test file, no markdown or explanation.';

  const sections = [
    'Error:',
    params.error,
    '',
    'Stacktrace:',
    params.stacktrace.join('\n'),
    '',
    'Main file: ' + params.mainFile,
    params.mainSnippet
  ];
  if (params.relatedFilesSection) {
    sections.push('', params.relatedFilesSection);
  }
  sections.push('', 'Return JSON with a single key "testCode" containing the full Jest test file content (plain string).');

  const userPrompt = sections.join('\n');

  const response = await client.chat.completions.create({
    model: 'gpt-4.1-mini',
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    response_format: { type: 'json_object' }
  });

  const content = response.choices[0].message.content;
  if (!content) throw new Error('Empty response from LLM');
  const parsed = JSON.parse(content);
  const testCode = parsed.testCode;
  if (typeof testCode !== 'string' || !testCode.trim()) {
    throw new Error('LLM did not return testCode');
  }
  return testCode.trim();
}

/**
 * @typedef {Object} ReviewPatchInput
 * @property {string} patch - Unified diff string
 * @property {string} error - Error message
 * @property {string[]} stacktrace
 * @property {string} mainFile
 * @property {string} mainSnippet
 * @property {string} [relatedFilesSection]
 */

/**
 * @typedef {Object} ReviewPatchResult
 * @property {boolean} approved
 * @property {string} reason
 */

/**
 * Review a generated patch for correctness, regressions, standards, and security.
 *
 * @param {ReviewPatchInput} params
 * @returns {Promise<ReviewPatchResult>}
 */
async function reviewPatch(params) {
  console.log('[LLMService] Reviewing patch');
  const client = getClient();

  const systemPrompt =
    'You are a senior code reviewer. Given a bug report and a proposed patch (unified diff), decide whether to approve it.\n\n' +
    'Evaluate:\n' +
    '1. **Correctness**: Does the patch fix the reported error and address the root cause?\n' +
    '2. **Regressions**: Could it break existing behavior or other code paths?\n' +
    '3. **Coding standards**: Does it follow common Node.js/JS style (naming, structure, no obvious anti-patterns)?\n' +
    '4. **Security**: Does it introduce or worsen security risks (e.g. injection, unsafe eval, leaking secrets)?\n\n' +
    'Return JSON with exactly: "approved" (boolean) and "reason" (string). ' +
    'Approve only if the patch is correct, low regression risk, and does not violate standards or security. ' +
    'Keep the reason concise (1-3 sentences).';

  const userPrompt = [
    'Error:',
    params.error,
    '',
    'Stacktrace:',
    params.stacktrace.join('\n'),
    '',
    'Relevant code (main file snippet):',
    params.mainFile || '',
    params.mainSnippet,
    '',
    (params.relatedFilesSection ? ['Related context:', params.relatedFilesSection, ''].join('\n') : ''),
    'Proposed patch (unified diff):',
    '```diff',
    params.patch,
    '```'
  ].join('\n');

  const response = await client.chat.completions.create({
    model: 'gpt-4.1-mini',
    temperature: 0.1,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    response_format: { type: 'json_object' }
  });

  const content = response.choices[0].message.content;
  if (!content) throw new Error('Empty response from LLM');
  const parsed = JSON.parse(content);
  const approved = Boolean(parsed.approved);
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : 'No reason provided';
  return { approved, reason };
}

module.exports = {
  analyzeBug,
  generateReproductionTest,
  reviewPatch
};
