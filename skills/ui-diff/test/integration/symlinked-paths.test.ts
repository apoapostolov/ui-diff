import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { runPipeline } from '../../src/pipeline.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const SERVER = `import http from 'node:http'; import { readFile } from 'node:fs/promises'; import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
http.createServer(async (req, res) => {
  const file = path.join(root, new URL(req.url, 'http://x').pathname.replace(/\\/$/, '/index.html'));
  try { res.end(await readFile(file)); } catch { res.writeHead(404); res.end('missing'); }
}).listen(Number(process.argv[3]), '127.0.0.1');`;

// The repo is reached through a symlinked directory, like /tmp -> /private/tmp on macOS.
describe('repository reached through a symlinked path', { timeout: 120_000 }, () => {
  let dir: string;
  let linkedRepo: string;
  let realRepo: string;
  let sha: string;

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-symlink-'));
    realRepo = path.join(dir, 'private', 'repo');
    mkdirSync(realRepo, { recursive: true });
    symlinkSync(path.join(dir, 'private'), path.join(dir, 'tmp'));
    linkedRepo = path.join(dir, 'tmp', 'repo');
    git(dir, 'init', '-q', '-b', 'main', realRepo);
    writeFileSync(path.join(realRepo, 'serve.mjs'), SERVER);
    writeFileSync(path.join(realRepo, 'index.html'), '<!doctype html><html lang="en"><head><title>t</title></head><body style="margin:24px;color:#111111"><h1>Hello</h1></body></html>');
    writeFileSync(path.join(realRepo, 'tokens.json'), JSON.stringify({ color: { $type: 'color', ink: { $value: '#111111' } } }));
    writeFileSync(path.join(realRepo, 'ui-diff.config.json'), JSON.stringify({ startCommand: 'node serve.mjs --port {port}', routes: ['/'], viewports: [{ name: 'desktop', width: 800, height: 600 }] }));
    git(realRepo, 'add', '-A');
    git(realRepo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
    sha = git(realRepo, 'rev-parse', 'HEAD');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps .ui-diff out of git status and reports --tokens files relative to the repo', async () => {
    const cfg = loadConfig(linkedRepo, linkedRepo);
    const { report } = await runPipeline({ cfg, outDir: path.join(linkedRepo, '.ui-diff'), base: sha, head: sha, allRoutes: true, tokens: [path.join(linkedRepo, 'tokens.json')] });
    assert.equal(report.stats.errors, 0, JSON.stringify(report.captures.map((c) => c.error)));
    assert.deepEqual(report.tokens?.files, ['tokens.json']);
    assert.equal(git(realRepo, 'status', '--porcelain'), '');
    assert.equal(git(realRepo, 'worktree', 'list').split('\n').length, 1);
  });
});
