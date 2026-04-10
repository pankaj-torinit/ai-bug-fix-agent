const { buildUntrustedRepoTestEnv } = require('../../utils/safeTestEnv');

describe('buildUntrustedRepoTestEnv', () => {
  it('drops agent and infrastructure secrets', () => {
    const host = {
      PATH: '/usr/bin',
      HOME: '/home/u',
      LLM_API_KEY: 'sk-secret',
      GITHUB_TOKEN: 'ghp_secret',
      REDIS_URL: 'redis://:pass@host:6379',
      GITHUB_REPO: 'o/r',
      SENTRY_CLIENT_SECRET: 'sentry',
      NGROK_AUTHTOKEN: 'ngrok',
      LLM_BASE_URL: 'https://api.example.com',
      npm_config_foo: 'bar'
    };
    const out = buildUntrustedRepoTestEnv(host);
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/u');
    expect(out.LLM_API_KEY).toBeUndefined();
    expect(out.GITHUB_TOKEN).toBeUndefined();
    expect(out.REDIS_URL).toBeUndefined();
    expect(out.GITHUB_REPO).toBeUndefined();
    expect(out.SENTRY_CLIENT_SECRET).toBeUndefined();
    expect(out.NGROK_AUTHTOKEN).toBeUndefined();
    expect(out.LLM_BASE_URL).toBeUndefined();
    expect(out.npm_config_foo).toBeUndefined();
  });

  it('does not forward proxy or other convenience vars', () => {
    const out = buildUntrustedRepoTestEnv({
      PATH: '/',
      HOME: '/h',
      HTTPS_PROXY: 'http://proxy:8080',
      LANG: 'C.UTF-8'
    });
    expect(out.HTTPS_PROXY).toBeUndefined();
    expect(out.LANG).toBeUndefined();
  });
});
