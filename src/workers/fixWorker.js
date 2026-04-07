const config = require('../../config');
const { connection } = require('../../queue');
const { Worker } = require('bullmq');
const repoService = require('../services/repoService');
const githubService = require('../services/githubService');
const { buildContext } = require('../services/contextService');
const testGenerator = require('../agents/testGenerator');
const { saveTest, removeTest } = require('../utils/testWriter');
const bugAnalyzer = require('../agents/bugAnalyzer');
const patchReviewer = require('../agents/patchReviewer');
const patchService = require('../services/patchService');
const { runTestsInSandbox } = require('../sandbox/dockerRunner');

/**
 * Process a single bug fix job: clone, build context, analyze, patch, test, push, open PR.
 *
 * @param {Object} job - BullMQ job
 * @param {Object} job.data
 * @param {string} job.data.eventId
 * @param {string} job.data.message
 * @param {string[]} job.data.stacktrace
 * @param {string|null} job.data.file
 * @param {number|null} job.data.line
 */
async function processBug(job) {
  const { eventId, message, stacktrace, file, line } = job.data;

  console.log('[Worker] Processing bug fix for event', eventId);

  if (!file || !line) {
    console.warn('[Worker] No file/line in stacktrace; skipping');
    return;
  }

  const repoUrl = githubService.getCloneUrl(config.githubRepo);
  const branchName = `ai-fix/sentry-${eventId}`;

  console.log('[Worker] Cloning repo');
  const { git, repoPath } = await repoService.cloneRepo(repoUrl);

  console.log('[Worker] Checking out prod branch');
  await repoService.checkoutBranch(git, config.githubProdBranch);

  console.log('[Worker] Creating fix branch');
  await repoService.createFixBranch(git, config.githubProdBranch, branchName);

  console.log('[Worker] Building code context');
  const context = buildContext(repoPath, file, line, stacktrace);

  let reproductionVerified = false;
  let baselineFailedTests = 0;
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    console.log('[Worker] Generating reproduction test (attempt %d)', attempt);
    const testCode = await testGenerator.generateTest({ error: message, stacktrace, context });
    saveTest(repoPath, testCode);
    console.log('[Worker] Running tests to verify test reproduces bug');
    const { success, failedTests: preFailed } = await runTestsInSandbox(repoPath);
    if (!success) {
      reproductionVerified = true;
      baselineFailedTests = preFailed;
      console.log('[Worker] Test fails as expected; reproduction verified (baseline failures: %d)', baselineFailedTests);
      break;
    }
    console.log('[Worker] Test did not fail; discarding and retrying');
    removeTest(repoPath);
  }
  if (!reproductionVerified) {
    console.log('[Worker] Could not generate a failing reproduction test after %d attempt(s); proceeding without it', maxAttempts);
  }

  const maxPatchRetries = 5;
  let analysis;
  let generatedDiff;
  let patchApplied = false;
  let lastFeedback = '';
  let lastTargetFile = '';

  for (let attempt = 1; attempt <= maxPatchRetries + 1; attempt += 1) {
    console.log('[Worker] Generating fix (attempt %d)', attempt);
    const previousAttemptError = attempt > 1 ? lastFeedback : undefined;
    analysis = await bugAnalyzer.analyzeBugWithContext({
      error: message,
      stacktrace,
      context,
      repoPath,
      previousAttemptError
    });

    const { fixedFileContent, targetFile } = analysis;
    if (!fixedFileContent || typeof fixedFileContent !== 'string') {
      throw new Error('LLM did not return fixedFileContent');
    }

    // Apply the fixed file content and get back the generated diff
    try {
      console.log('[Worker] Applying fixed file and generating diff (target: %s)', targetFile);
      generatedDiff = patchService.applyFixedFile(repoPath, targetFile, fixedFileContent);
    } catch (err) {
      const applyError = err.message || String(err);
      lastFeedback = `[Targeted file: ${targetFile}] ${applyError}`;
      lastTargetFile = targetFile;
      console.error('[Worker] Failed to apply fix on attempt %d: %s', attempt, applyError);
      if (attempt <= maxPatchRetries) {
        console.log('[Worker] Regenerating fix (retry %d of %d)', attempt, maxPatchRetries);
      }
      continue;
    }

    console.log('[Worker] Reviewing generated diff');
    const review = await patchReviewer.reviewPatch({
      patch: generatedDiff,
      error: message,
      stacktrace,
      context
    });

    if (!review.approved) {
      lastFeedback = `[Targeted file: ${targetFile}] Reviewer rejected: ${review.reason}`;
      lastTargetFile = targetFile;
      console.log('[Worker] Patch reviewer: REJECTED — %s', review.reason);
      // Revert the file so the next attempt starts clean
      const { spawnSync } = require('node:child_process');
      spawnSync('git', ['checkout', '--', targetFile], { cwd: repoPath });
      if (attempt <= maxPatchRetries) {
        console.log('[Worker] Regenerating fix (retry %d of %d)', attempt, maxPatchRetries);
        continue;
      }
      break;
    }

    console.log('[Worker] Patch reviewer: APPROVED — %s', review.reason);
    patchApplied = true;
    break;
  }

  if (!patchApplied) {
    throw new Error('Fix could not be applied after ' + (maxPatchRetries + 1) + ' attempt(s). Last feedback: ' + (lastFeedback || 'Unknown reason'));
  }

  console.log('[Worker] Running post-fix tests');
  const { success, failedTests: postFailed } = await runTestsInSandbox(repoPath);

  if (!success) {
    console.log('[Worker] Post-fix failures: %d | Baseline failures: %d', postFailed, baselineFailedTests);

    if (postFailed > baselineFailedTests) {
      throw new Error(
        `Fix introduced new test failures (baseline: ${baselineFailedTests}, post-fix: ${postFailed})`
      );
    }

    if (postFailed > 0 && postFailed <= baselineFailedTests) {
      console.log('[Worker] Failed tests did not increase (baseline %d → post-fix %d); accepting fix', baselineFailedTests, postFailed);
    }
  }

  console.log('[Worker] Removing AI-generated test before commit');
  removeTest(repoPath);

  const commitMessage = `AI Fix: ${message}`.slice(0, 72);
  console.log('[Worker] Committing changes');
  await githubService.commitChanges(git, commitMessage);

  console.log('[Worker] Pushing branch');
  await githubService.pushBranch(git, branchName);

  const prBody = [
    '## Error',
    message,
    '',
    '## Stacktrace',
    '```',
    stacktrace.join('\n'),
    '```',
    '',
    '## Root cause',
    analysis.rootCause || '(see LLM analysis)',
    '',
    '## Patch explanation',
    analysis.patchExplanation || '(see diff)'
  ].join('\n');

  console.log('[Worker] Creating PR');
  await githubService.createPullRequest({
    title: `AI Fix: ${message}`.slice(0, 256),
    body: prBody,
    head: branchName,
    base: config.githubProdBranch
  });

  console.log('[Worker] Bug fix pipeline completed for event', eventId);
}

const worker = new Worker(
  'bugFixQueue',
  async (job) => {
    await processBug(job);
  },
  { connection }
);

worker.on('completed', (job) => {
  console.log('[Worker] Job', job.id, 'completed');
});

worker.on('failed', (job, err) => {
  console.error('[Worker] Job', job?.id, 'failed:', err?.message);
});

console.log('[Worker] Bug fix worker started, waiting for jobs...');
