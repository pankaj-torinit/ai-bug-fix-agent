const fs = require('fs');
const os = require('os');
const path = require('path');
const { readCodeSnippet } = require('../../utils/fileSnippet');

describe('readCodeSnippet', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snippet-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty snippet when file is missing', () => {
    const r = readCodeSnippet(tmpDir, 'missing.js', 5);
    expect(r).toEqual({ snippet: '', startLine: 0, endLine: 0 });
  });

  it('returns numbered lines around target with default radius', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(path.join(tmpDir, 'a.js'), lines.join('\n'), 'utf8');
    const r = readCodeSnippet(tmpDir, 'a.js', 15, 2);
    expect(r.startLine).toBe(13);
    expect(r.endLine).toBe(17);
    expect(r.snippet).toContain('15: line 15');
    expect(r.snippet).not.toContain('10: line 10');
  });

  it('clamps start to line 1 for targets near top', () => {
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'a\nb\nc\n', 'utf8');
    const r = readCodeSnippet(tmpDir, 'b.js', 1, 5);
    expect(r.startLine).toBe(1);
    // Trailing newline yields an extra empty line in split()
    expect(r.endLine).toBe(4);
  });
});
