import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { runPipeline } from '../../src/pipeline.js';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commit = (cwd: string, message: string) => {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=ui-diff-test', '-c', 'user.email=test@example.com', 'commit', '-qm', message);
  return git(cwd, 'rev-parse', 'HEAD');
};

const SERVER = `import http from 'node:http'; import { readFile } from 'node:fs/promises'; import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
http.createServer(async (req, res) => {
  try { res.writeHead(200, { 'content-type': 'text/html' }); res.end(await readFile(path.join(root, 'index.html'))); }
  catch { res.writeHead(404); res.end('missing'); }
}).listen(Number(process.argv[3] ?? process.env.PORT), '127.0.0.1');`;
const page = (color: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Keep</title></head>
<body style="margin:0;font-family:Arial"><main><h1 style="color:${color}">Keep the last report</h1></main></body></html>`;

describe('a failed run keeps the previous report', { timeout: 180_000 }, () => {
  let dir: string;
  let repo: string;
  let baseSha: string;
  let headSha: string;

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-keep-'));
    repo = path.join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'serve.mjs'), SERVER);
    writeFileSync(path.join(repo, 'index.html'), page('#111111'));
    writeFileSync(
      path.join(repo, 'ui-diff.config.json'),
      JSON.stringify({ startCommand: 'node serve.mjs --port {port}', routes: [{ path: '/', name: 'home', files: ['index.html'] }], viewports: [{ name: 'desktop', width: 640, height: 400 }] }),
    );
    baseSha = commit(repo, 'base');
    writeFileSync(path.join(repo, 'index.html'), page('#dc2626'));
    headSha = commit(repo, 'head');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(skillRoot, 'src', 'cli.ts'), ...args], { cwd: repo, encoding: 'utf8' });

  it('swaps results only on success and says when the report is from an earlier run', async () => {
    const cfg = loadConfig(repo, repo);
    const outDir = path.join(repo, '.ui-diff');
    const first = await runPipeline({ cfg, outDir, base: baseSha, head: headSha });
    assert.equal(first.reportFile, path.join(outDir, 'report.json'));
    assert.equal(first.report.stats.changed, 1);
    const compare = path.join(outDir, first.report.captures[0].images.compare!);
    assert.ok(existsSync(compare));
    const kept = readFileSync(path.join(outDir, 'report.json'), 'utf8');
    const preview = path.join(outDir, 'comment.preview.md');
    assert.equal(cli('render').status, 0);
    assert.ok(existsSync(preview));

    // A config whose app exits at once, kept out of git status like a local experiment would be.
    writeFileSync(path.join(repo, 'broken.config.json'), JSON.stringify({ ...JSON.parse(readFileSync(path.join(repo, 'ui-diff.config.json'), 'utf8')), startCommand: 'node -e "console.error(\'boom from the app\'); process.exit(3)"' }));
    appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'broken.config.json\n');
    const failed = cli('run', '--config', 'broken.config.json', '--base', baseSha, '--head', headSha);
    assert.notEqual(failed.status, 0);
    const errorAt = failed.stderr.indexOf('[ui-diff] error: ');
    const keptAt = failed.stderr.indexOf('warning: kept the previous report');
    assert.ok(errorAt >= 0 && keptAt > errorAt, `the real error must come first:\n${failed.stderr}`);
    assert.equal(readFileSync(path.join(outDir, 'report.json'), 'utf8'), kept, 'the previous report must survive a failed run');
    assert.ok(existsSync(compare), 'and so must its images');
    assert.ok(existsSync(preview), 'and the preview rendered from it');
    const logs = readdirSync(path.join(outDir, 'logs')).map((f) => readFileSync(path.join(outDir, 'logs', f), 'utf8')).join('\n');
    assert.match(logs, /boom from the app/, 'logs/ shows the failed run');
    assert.deepEqual(readdirSync(outDir).filter((e) => e.startsWith('.')), [], 'no staging directory is left behind');
    assert.equal(git(repo, 'status', '--porcelain'), '');

    const render = cli('render');
    assert.equal(render.status, 0, render.stderr);
    assert.match(render.stderr, /the last run failed .*this report is from an earlier run/);

    const again = await runPipeline({ cfg, outDir, base: baseSha, head: headSha });
    assert.notEqual(again.report.createdAt, first.report.createdAt);
    assert.ok(!existsSync(path.join(outDir, 'last-run-failed.json')), 'a successful run clears the warning');
    assert.ok(!existsSync(preview), 'and drops the preview of the old report');
  });
});
