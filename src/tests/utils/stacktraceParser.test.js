const { parseStacktrace } = require('../../utils/stacktraceParser');

describe('parseStacktrace', () => {
  it('returns empty result for non-array input', () => {
    expect(parseStacktrace(null)).toEqual({
      file: null,
      line: null,
      stacktrace: [],
      contextLines: []
    });
    expect(parseStacktrace(undefined)).toEqual({
      file: null,
      line: null,
      stacktrace: [],
      contextLines: []
    });
  });

  it('parses string frames as file:line (newest frame is last in array, like Sentry oldest→newest)', () => {
    const r = parseStacktrace(['other:2', 'src/app.js:10']);
    expect(r.file).toBe('src/app.js');
    expect(r.line).toBe(10);
    expect(r.stacktrace).toContain('src/app.js:10');
    expect(r.contextLines).toContain('src/app.js:10');
  });

  it('uses first parseable string after reverse (newest) as top frame', () => {
    const r = parseStacktrace(['src/old.js:1', 'src/new.js:42']);
    expect(r.file).toBe('src/new.js');
    expect(r.line).toBe(42);
  });

  it('normalizes Sentry-style paths and webpack prefixes', () => {
    const r = parseStacktrace([
      {
        filename: 'webpack:///./src/foo.js',
        lineno: 7,
        in_app: true
      }
    ]);
    expect(r.file).toBe('./src/foo.js');
    expect(r.line).toBe(7);
    expect(r.stacktrace.some((s) => s.includes('foo.js:7'))).toBe(true);
  });

  it('prefers in_app frame over non-in-app when both have line numbers', () => {
    const r = parseStacktrace([
      { filename: 'node_modules/x/y.js', lineno: 1, in_app: false },
      { filename: 'src/handler.js', lineno: 12, in_app: true }
    ]);
    expect(r.file).toBe('src/handler.js');
    expect(r.line).toBe(12);
  });
});
