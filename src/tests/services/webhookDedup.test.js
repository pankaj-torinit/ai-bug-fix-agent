const mockSet = jest.fn();
const mockDel = jest.fn();
const mockIncr = jest.fn();
const mockExpire = jest.fn();

jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => ({
    set: (...args) => mockSet(...args),
    del: (...args) => mockDel(...args),
    incr: (...args) => mockIncr(...args),
    expire: (...args) => mockExpire(...args)
  }))
);

describe('webhookDedup', () => {
  beforeEach(() => {
    jest.resetModules();
    mockSet.mockReset();
    mockDel.mockReset();
    mockIncr.mockReset();
    mockExpire.mockReset();
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
  });

  it('claimSentryEventDedup returns true when SET NX succeeds', async () => {
    mockSet.mockResolvedValue('OK');
    const { claimSentryEventDedup } = require('../../services/webhookDedup');
    await expect(claimSentryEventDedup('abc', 3600)).resolves.toBe(true);
    expect(mockSet).toHaveBeenCalledWith('sentry:webhook:dedup:abc', '1', 'EX', 3600, 'NX');
  });

  it('claimSentryEventDedup returns false when key already held', async () => {
    mockSet.mockResolvedValue(null);
    const { claimSentryEventDedup } = require('../../services/webhookDedup');
    await expect(claimSentryEventDedup('abc', 3600)).resolves.toBe(false);
  });

  it('consumeGlobalWebhookBudget allows when under cap', async () => {
    jest.resetModules();
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    process.env.WEBHOOK_GLOBAL_MAX_PER_MINUTE = '10';
    mockIncr.mockResolvedValue(3);
    mockExpire.mockResolvedValue(1);
    const { consumeGlobalWebhookBudget } = require('../../services/webhookDedup');
    await expect(consumeGlobalWebhookBudget()).resolves.toBe(true);
  });
});
