/**
 * Build a minimal process.env for running `npm install` / `npm test` inside an
 * untrusted cloned repository. Must NOT pass through agent secrets (API keys,
 * GitHub tokens, Redis URLs, etc.).
 *
 * @param {NodeJS.ProcessEnv} [hostEnv]
 * @returns {NodeJS.ProcessEnv}
 */
function buildUntrustedRepoTestEnv(hostEnv = process.env) {
  // Only what `sh` + `npm` need to resolve binaries and home-dir paths.
  // Everything else (proxy, locale, CI, etc.) must not leak from the agent — use Docker if you need a fuller sandbox.
  /** @type {string[]} */
  const allowedKeys = ['PATH', 'HOME', 'USERPROFILE'];

  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const key of allowedKeys) {
    if (hostEnv[key] !== undefined) {
      out[key] = hostEnv[key];
    }
  }
  return out;
}

module.exports = {
  buildUntrustedRepoTestEnv
};
