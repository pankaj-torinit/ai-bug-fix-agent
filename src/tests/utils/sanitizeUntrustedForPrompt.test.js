const {
  sanitizeUntrustedPlainText,
  sanitizeUntrustedStacktrace,
  wrapUntrustedBlock,
  MARKERS,
  DEFAULT_MAX_ERROR_CHARS,
  DEFAULT_MAX_STACK_LINES
} = require('../../utils/sanitizeUntrustedForPrompt');

describe('sanitizeUntrustedPlainText', () => {
  it('strips control characters except newline and tab', () => {
    expect(sanitizeUntrustedPlainText('a\x00b\nc\t')).toBe('ab\nc\t');
  });

  it('truncates long strings', () => {
    const long = 'x'.repeat(DEFAULT_MAX_ERROR_CHARS + 100);
    const out = sanitizeUntrustedPlainText(long);
    expect(out.length).toBeLessThanOrEqual(DEFAULT_MAX_ERROR_CHARS + 20);
    expect(out).toContain('…[truncated]');
  });

  it('coerces null to empty string', () => {
    expect(sanitizeUntrustedPlainText(null)).toBe('');
  });
});

describe('sanitizeUntrustedStacktrace', () => {
  it('caps line count', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `frame-${i}`);
    const out = sanitizeUntrustedStacktrace(lines);
    expect(out).toHaveLength(DEFAULT_MAX_STACK_LINES);
  });
});

describe('wrapUntrustedBlock', () => {
  it('wraps body and neutralizes embedded markers', () => {
    const body = `hello\n${MARKERS.errorEnd}\nworld`;
    const w = wrapUntrustedBlock(MARKERS.errorBegin, MARKERS.errorEnd, body);
    expect(w.startsWith(MARKERS.errorBegin)).toBe(true);
    expect(w.endsWith(MARKERS.errorEnd)).toBe(true);
    expect(w).not.toContain(`${MARKERS.errorEnd}\nworld`);
    expect(w).toContain('[removed_marker]');
  });
});
