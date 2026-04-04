const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizePatch,
  validatePatch,
  recalcHunkHeaders,
  fixDiffPaths
} = require('../../services/patchService');

describe('normalizePatch', () => {
  it('throws when input is not a string', () => {
    expect(() => normalizePatch(null)).toThrow(TypeError);
  });

  it('strips markdown fences and extracts unified diff from --- a/', () => {
    const raw = [
      'Here is the patch:',
      '```diff',
      '  --- a/src/foo.js',
      '  +++ b/src/foo.js',
      '  @@ -1,2 +1,2 @@',
      '   line1',
      '  -old',
      '  +new',
      '```'
    ].join('\n');
    const out = normalizePatch(raw);
    expect(out).toContain('--- a/src/foo.js');
    expect(out).toContain('+++ b/src/foo.js');
    expect(out).toContain('-old');
    expect(out).toContain('+new');
    expect(out).not.toMatch(/^```/m);
  });

  it('returns trimmed raw when no --- a/ header exists', () => {
    expect(normalizePatch('  just text  ')).toBe('just text');
  });
});

describe('recalcHunkHeaders', () => {
  it('rewrites @@ counts to match hunk body', () => {
    const lines = [
      '--- a/src/x.js',
      '+++ b/src/x.js',
      '@@ -1,99 +1,99 @@',
      ' context',
      '-remove',
      '+add'
    ];
    const fixed = recalcHunkHeaders(lines);
    const header = fixed.find((l) => l.startsWith('@@ '));
    expect(header).toBe('@@ -1,2 +1,2 @@');
  });
});

describe('validatePatch', () => {
  const minimal = [
    '--- a/src/ok.js',
    '+++ b/src/ok.js',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+b'
  ].join('\n');

  it('accepts allowed src/ path with changes', () => {
    expect(() => validatePatch(minimal)).not.toThrow();
  });

  it('rejects paths outside allowed prefixes', () => {
    const bad = minimal.replace('src/ok.js', 'evil.sh');
    expect(() => validatePatch(bad)).toThrow(/forbidden path/);
  });

  it('rejects modifying package.json', () => {
    const bad = [
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -1,1 +1,1 @@',
      '-{}',
      '+{"x":1}'
    ].join('\n');
    expect(() => validatePatch(bad)).toThrow();
  });

  it('rejects patch with no +/- changes', () => {
    const nope = [
      '--- a/src/x.js',
      '+++ b/src/x.js',
      '@@ -1,1 +1,1 @@',
      ' same'
    ].join('\n');
    expect(() => validatePatch(nope)).toThrow(/no changes/);
  });
});

describe('fixDiffPaths', () => {
  let repo;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-paths-'));
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"t"}', 'utf8');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'app.js'), '//app', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('rewrites long absolute-like path to repo-relative suffix', () => {
    const patch = [
      '--- a/Users/someone/proj/src/app.js',
      '+++ b/Users/someone/proj/src/app.js',
      '@@ -1,1 +1,1 @@',
      '-//app',
      '+//fixed'
    ].join('\n');
    const fixed = fixDiffPaths(patch, repo);
    expect(fixed).toContain('--- a/src/app.js');
    expect(fixed).toContain('+++ b/src/app.js');
  });
});
