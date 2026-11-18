import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { main } from '../../src/cli.js';
import { loadConfig } from '../../src/config.js';
import { runPipeline } from '../../src/pipeline.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commit = (cwd: string, message: string) => {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=ui-diff-test', '-c', 'user.email=test@example.com', 'commit', '-qm', message);
  return git(cwd, 'rev-parse', 'HEAD');
};

const SERVER = `import http from 'node:http'; import { readFile } from 'node:fs/promises'; import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(root, url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname);
  try { const body = await readFile(file); res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(body); }
  catch { res.writeHead(404); res.end('missing'); }
}).listen(Number(process.argv[3] ?? process.env.PORT), '127.0.0.1');`;

const page = (body: string, extraHead = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title><link rel="stylesheet" href="styles.css">${extraHead}
<script>const p = new URLSearchParams(location.search); if (p.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark'; if (p.get('layout')) document.documentElement.dataset.layout = p.get('layout');</script></head>
<body><main>${body}</main><footer>Rendered <span id="t"></span> · pick <span id="r"></span></footer>
<script>document.getElementById('t').textContent = new Date().toISOString(); document.getElementById('r').textContent = Math.random().toFixed(6);</script></body></html>`;

const BEFORE_BODY = `<h1>Fixture shop</h1><p class="lead">Simple things, nicely made.</p><a class="buy" href="#">Buy now</a>
<form><label for="email">Email</label><input id="email"></form><img src="hero.svg">`;
const AFTER_BODY = `<h1>Fixture shop</h1><p class="lead">Simple things, nicely made.</p><a class="buy" href="#">Buy now</a><span class="sale">Sale</span>
<form><input id="email"></form><img src="hero.svg" alt="Hero illustration">`;
const CSS_BEFORE = `body { margin: 0; padding: 24px; font-family: Arial, sans-serif; color: #111827; background: #ffffff; }
[data-theme=dark] body { color: #f9fafb; background: #111827; }
.buy { display: inline-block; padding: 8px 16px; background: #2563eb; color: #ffffff; border-radius: 4px; text-decoration: none; transition: transform 200ms; }
.buy:hover { transform: scale(1.1); }
[data-layout="2"] main { text-align: center; }`;
const CSS_AFTER = `${CSS_BEFORE}
.buy { padding: 12px 24px; background: #7c3aed; border-radius: 9999px; }
.sale { margin-left: 8px; padding: 3px 7px; background: #ff5a1f; color: #fff; font-size: 13px; }`;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><rect width="200" height="80" fill="#bfdbfe"/></svg>';
const TOKENS = {
  color: { $type: 'color', ink: { $value: '#111827' }, paper: { $value: '#ffffff' }, night: { $value: '#111827' }, snow: { $value: '#f9fafb' }, blue: { $value: '#2563eb' }, violet: { $value: '#7c3aed' } },
  space: { $type: 'dimension', 2: { $value: '8px' }, 3: { $value: '12px' }, 4: { $value: '16px' }, 6: { $value: '24px' } },
  radius: { sm: { $value: '4px' }, full: { $value: '9999px' } },
  font: { size: { $type: 'dimension', md: { $value: '16px' }, xl: { $value: '32px' } } },
};

describe('ui-diff end to end', { timeout: 300_000 }, () => {
  let dir: string;
  let repo: string;
  let baseSha: string;
  let headSha: string;
  const cwd = process.cwd();

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-e2e-'));
    repo = path.join(dir, 'repo');
    const site = path.join(repo, 'site');
    mkdirSync(site, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main', repo);
    writeFileSync(path.join(site, 'serve.mjs'), SERVER);
    writeFileSync(path.join(site, 'hero.svg'), SVG);
    writeFileSync(path.join(site, 'tokens.json'), JSON.stringify(TOKENS));
    writeFileSync(path.join(site, 'index.html'), page(BEFORE_BODY));
    writeFileSync(path.join(site, 'about.html'), page('<h1>About</h1>'));
    writeFileSync(path.join(site, 'styles.css'), CSS_BEFORE);
    writeFileSync(
      path.join(site, 'ui-diff.config.json'),
      JSON.stringify({
        startCommand: 'node serve.mjs --port {port}',
        routes: [
          { path: '/', name: 'home', files: ['index.html'], variants: { param: 'layout', values: '1..2', viewports: ['desktop'] }, motion: { steps: [{ hover: '.buy' }, { wait: 300 }], durationMs: 1200 } },
          { path: '/about.html', name: 'about', files: ['about.html'] },
        ],
        globalFiles: ['styles.css'],
        viewports: [
          { name: 'desktop', width: 800, height: 600 },
          { name: 'mobile', width: 390, height: 700, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
        ],
        themes: [{ name: 'light' }, { name: 'dark', query: { theme: 'dark' }, colorScheme: 'dark' }],
        capture: { fixedTime: '2026-01-01T00:00:00Z' },
        tokens: { enabled: true, files: ['tokens.json'] },
        a11y: { enabled: true, themes: ['light'] },
        motion: { enabled: true, fps: 8 },
      }),
    );
    baseSha = commit(repo, 'before');
    writeFileSync(path.join(site, 'index.html'), page(AFTER_BODY));
    writeFileSync(path.join(site, 'styles.css'), CSS_AFTER);
    headSha = commit(repo, 'after');
  });

  after(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('captures base and head in worktrees and reports visual, a11y and token changes', async () => {
    const cfg = loadConfig(repo, repo, 'site/ui-diff.config.json');
    const outDir = path.join(repo, '.ui-diff');
    const { report } = await runPipeline({ cfg, outDir, base: baseSha, head: headSha });

    assert.deepEqual(report.routes.map((r) => r.path).sort(), ['/', '/about.html']);
    assert.equal(report.stats.errors, 0, JSON.stringify(report.captures.map((c) => c.error)));
    const home = report.captures.find((c) => c.id === 'home__desktop__light')!;
    assert.equal(home.status, 'changed');
    assert.ok(existsSync(path.join(outDir, home.images.compare!)));
    assert.ok(report.captures.filter((c) => c.route.path === '/about.html').every((c) => c.status === 'unchanged'));

    const a11yRules = report.a11y!.added.map((i) => i.rule);
    assert.ok(a11yRules.includes('label'), `expected a new label issue, got ${a11yRules}`);
    assert.ok(a11yRules.includes('color-contrast'), `expected a new contrast issue, got ${a11yRules}`);
    assert.ok(report.a11y!.fixed.some((i) => i.rule === 'image-alt'));
    assert.ok(report.a11y!.audited.every((id) => id.endsWith('__light')));

    const values = report.tokens!.findings.filter((f) => f.isNew).map((f) => `${f.property} ${f.value}`);
    for (const expected of ['background-color #ff5a1f', 'spacing 3px', 'spacing 7px', 'font-size 13px']) assert.ok(values.includes(expected), `missing ${expected} in ${values}`);

    assert.equal(report.variants.length, 1);
    assert.equal(report.variants[0].items.filter((i) => i.image).length, 2);
    assert.ok(report.motion[0].gif && existsSync(path.join(outDir, report.motion[0].gif)));
    assert.equal(readFileSync(path.join(outDir, report.motion[0].gif!)).subarray(0, 3).toString(), 'GIF');

    assert.equal(git(repo, 'status', '--porcelain'), '');
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1);
  });

  it('renders the same commit identically on both sides', async () => {
    const cfg = loadConfig(repo, repo, 'site/ui-diff.config.json');
    const { report } = await runPipeline({ cfg, outDir: path.join(dir, 'self'), base: headSha, head: headSha, allRoutes: true });
    assert.equal(report.stats.captures, 8);
    assert.equal(report.stats.unchanged, 8, JSON.stringify(report.captures.map((c) => [c.id, c.status, c.diff?.changedPixels])));
    assert.deepEqual(report.a11y!.added, []);
    assert.deepEqual(report.tokens!.findings, []);
  });

  it('publishes to the assets branch and writes the comment without posting', async () => {
    const bare = path.join(dir, 'origin.git');
    git(dir, 'init', '-q', '--bare', bare);
    process.chdir(repo);
    writeFileSync(path.join(repo, '.ui-diff', 'summary.md'), '**What changed**\n- The buy button is now a violet pill.');
    const code = await main(['publish', '--config', 'site/ui-diff.config.json', '--pr', '42', '--remote', bare, '--link-base', 'https://github.com/acme/shop/raw/ui-diff-assets', '--no-comment', '--assume-private', '--quiet']);
    process.chdir(cwd);
    assert.equal(code, 0);
    const files = git(bare, 'ls-tree', '-r', '--name-only', 'ui-diff-assets').split('\n');
    assert.ok(files.includes('README.md'));
    assert.ok(files.some((f) => /^pr-42\/default\/\d{8}T\d{6}Z-[0-9a-f]{7}\/compare\/home__desktop__light/.test(f)), files.join('\n'));
    const body = readFileSync(path.join(repo, '.ui-diff', 'comment.md'), 'utf8');
    assert.ok(body.startsWith('<!-- ui-diff:sticky id=default -->'));
    assert.match(body, /violet pill/);
    assert.match(body, /https:\/\/github\.com\/acme\/shop\/raw\/ui-diff-assets\/pr-42\/default\//);
  });
});

describe('protected previews', { timeout: 120_000 }, () => {
  const SECRET = 'preview-secret-7d1c2a';
  let dir: string;
  let preview: http.Server;
  let thirdParty: http.Server;
  const seenByThirdParty: Array<string | undefined> = [];

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-auth-'));
    git(dir, 'init', '-q', '-b', 'main', dir);
    writeFileSync(path.join(dir, 'ui-diff.config.json'), JSON.stringify({ routes: ['/'], viewports: [{ name: 'desktop', width: 800, height: 600 }], auth: { headers: [{ name: 'x-preview-token', env: 'UI_DIFF_TEST_TOKEN' }] } }));
    commit(dir, 'config');
    thirdParty = http.createServer((req, res) => {
      seenByThirdParty.push(req.headers['x-preview-token'] as string | undefined);
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end(SVG);
    });
    await new Promise<void>((r) => thirdParty.listen(0, '127.0.0.1', r));
    const tpPort = (thirdParty.address() as AddressInfo).port;
    preview = http.createServer((req, res) => {
      if (req.headers['x-preview-token'] !== SECRET) {
        res.writeHead(401);
        res.end('protected');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html lang="en"><head><title>p</title></head><body><h1>Preview ${req.url}</h1><img alt="cdn" src="http://localhost:${tpPort}/pixel.svg"></body></html>`);
    });
    await new Promise<void>((r) => preview.listen(0, '127.0.0.1', r));
  });

  after(() => {
    preview.close();
    thirdParty.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends credentials only to the preview origin and never stores them', async () => {
    const port = (preview.address() as AddressInfo).port;
    process.env.UI_DIFF_TEST_TOKEN = SECRET;
    try {
      const cfg = loadConfig(dir, dir);
      const outDir = path.join(dir, '.ui-diff');
      const { report } = await runPipeline({ cfg, outDir, baseUrl: `http://127.0.0.1:${port}/`, headUrl: `http://127.0.0.1:${port}/` });
      assert.equal(report.stats.errors, 0, JSON.stringify(report.captures.map((c) => c.error)));
      assert.equal(report.stats.unchanged, 1);
      assert.ok(seenByThirdParty.length > 0, 'third-party asset was requested');
      assert.ok(seenByThirdParty.every((h) => h === undefined), 'credential leaked to a third-party origin');
      for (const file of ['report.json', 'comment.local.md', 'summary.auto.md']) {
        assert.ok(!readFileSync(path.join(outDir, file), 'utf8').includes(SECRET), `${file} contains the secret`);
      }
    } finally {
      delete process.env.UI_DIFF_TEST_TOKEN;
    }
  });
});
