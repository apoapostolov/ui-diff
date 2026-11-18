import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  try { const body = await readFile(file); res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); }
  catch { res.writeHead(404); res.end('missing'); }
}).listen(Number(process.argv[3] ?? process.env.PORT), '127.0.0.1');`;

// Moves with requestAnimationFrame, which neither CSS freezing nor capture.fixedTime stops.
const CAROUSEL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Carousel</title>
<style>body{margin:40px;font-family:Arial} .track{width:600px;overflow:hidden} .slides{display:flex;width:1800px} .slide{width:600px;height:160px;display:grid;place-items:center;font-size:40px;color:#fff}</style></head>
<body><main><h1>Carousel</h1><div class="track"><div class="slides" id="s"><div class="slide" style="background:#1d4ed8">One</div><div class="slide" style="background:#15803d">Two</div><div class="slide" style="background:#b91c1c">Three</div></div></div></main>
<script>const start = performance.now(); (function tick(now) { document.getElementById('s').style.transform = 'translateX(' + (-(((now - start) / 6) % 1200)) + 'px)'; requestAnimationFrame(tick); })(start);</script></body></html>`;

describe('pages that never settle', { timeout: 180_000 }, () => {
  let dir: string;
  let repo: string;
  let sha: string;

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-unsettled-'));
    repo = path.join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'serve.mjs'), SERVER);
    writeFileSync(path.join(repo, 'index.html'), CAROUSEL);
    writeFileSync(
      path.join(repo, 'ui-diff.config.json'),
      JSON.stringify({ startCommand: 'node serve.mjs --port {port}', routes: [{ path: '/', name: 'carousel' }], viewports: [{ name: 'desktop', width: 800, height: 400 }], a11y: { enabled: true } }),
    );
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'carousel');
    sha = git(repo, 'rev-parse', 'HEAD');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('names the moving element and suggests masking it', async () => {
    const cfg = loadConfig(repo, repo);
    const { report } = await runPipeline({ cfg, outDir: path.join(dir, 'out'), base: sha, head: sha, allRoutes: true });
    const capture = report.captures[0];
    assert.equal(capture.error, undefined);
    for (const side of ['base', 'head']) {
      const warning = capture.warnings.find((w) => w.startsWith(`${side}: page did not settle`));
      assert.ok(warning, `expected a "did not settle" warning for ${side}, got ${JSON.stringify(capture.warnings)}`);
      assert.match(warning, /div\.track \(600×160 px at 40,\d+\)/);
      assert.match(warning, /"mask": \["div\.track"\]/);
    }
    if (capture.status === 'changed') assert.ok(capture.warnings.some((w) => w.startsWith('every difference is inside an area that kept changing by itself')));
    assert.deepEqual(report.a11y?.errors ?? [], [], 'axe must run once the page clock is resumed');
    assert.ok(report.a11y?.audited.includes(capture.id));
  });

  it('compares cleanly once that element is masked', async () => {
    const cfg = loadConfig(repo, repo);
    const masked = { ...cfg, capture: { ...cfg.capture, mask: ['div.track'] } };
    const { report } = await runPipeline({ cfg: masked, outDir: path.join(dir, 'masked'), base: sha, head: sha, allRoutes: true });
    assert.equal(report.captures[0].status, 'unchanged');
    assert.deepEqual(report.captures[0].warnings, []);
  });
});
