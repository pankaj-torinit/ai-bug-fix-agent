const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  detectNodeProjectRoot,
  resolveRepoFilePath
} = require('../../utils/nodeProjectResolver');

describe('nodeProjectResolver', () => {
  let repo;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-resolver-'));
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  describe('detectNodeProjectRoot', () => {
    it('returns null when no package.json exists', () => {
      expect(detectNodeProjectRoot(repo)).toBeNull();
    });

    it('returns root project when only repo-root package.json exists', () => {
      fs.writeFileSync(
        path.join(repo, 'package.json'),
        JSON.stringify({ name: 'root' }),
        'utf8'
      );
      const r = detectNodeProjectRoot(repo);
      expect(r).not.toBeNull();
      expect(r.projectRelPath).toBe('');
      expect(r.projectAbsPath).toBe(repo);
    });

    it('prefers nested package with jest in test script', () => {
      fs.writeFileSync(
        path.join(repo, 'package.json'),
        JSON.stringify({ name: 'root', scripts: { test: 'echo ok' } }),
        'utf8'
      );
      const serverDir = path.join(repo, 'server');
      fs.mkdirSync(serverDir, { recursive: true });
      fs.writeFileSync(
        path.join(serverDir, 'package.json'),
        JSON.stringify({
          name: 'server',
          scripts: { test: 'jest' },
          devDependencies: { jest: '^29.0.0' }
        }),
        'utf8'
      );
      const r = detectNodeProjectRoot(repo);
      expect(r.projectRelPath).toBe('server');
      expect(r.packageJsonPath).toBe(path.join(serverDir, 'package.json'));
    });
  });

  describe('resolveRepoFilePath', () => {
    it('returns path unchanged when file exists at repo root', () => {
      fs.writeFileSync(
        path.join(repo, 'package.json'),
        '{}',
        'utf8'
      );
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'src', 'app.js'), '//', 'utf8');
      expect(resolveRepoFilePath(repo, 'src/app.js')).toBe('src/app.js');
    });

    it('resolves under monorepo package root when direct path missing', () => {
      fs.writeFileSync(
        path.join(repo, 'package.json'),
        '{}',
        'utf8'
      );
      const svc = path.join(repo, 'packages', 'api');
      fs.mkdirSync(path.join(svc, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(svc, 'package.json'),
        '{"name":"api"}',
        'utf8'
      );
      fs.writeFileSync(path.join(svc, 'src', 'x.js'), '//', 'utf8');
      const rel = resolveRepoFilePath(repo, 'src/x.js');
      expect(rel.replace(/\\/g, '/')).toBe('packages/api/src/x.js');
    });
  });
});
