import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { uploadGuard } from '../../src/github.js';
import { sampleReport } from './fixtures.js';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('upload guard', () => {
  it('refuses public and unverifiable repositories unless explicitly allowed', () => {
    assert.equal(uploadGuard('PRIVATE', { allowPublic: false, assumePrivate: false }).allowed, true);
    assert.match(uploadGuard('PUBLIC', { allowPublic: false, assumePrivate: false }).reason!, /public/);
    assert.equal(uploadGuard('PUBLIC', { allowPublic: true, assumePrivate: false }).allowed, true);
    assert.match(uploadGuard(undefined, { allowPublic: false, assumePrivate: false }).reason!, /Could not verify/);
    assert.equal(uploadGuard(undefined, { allowPublic: false, assumePrivate: true }).allowed, true);
    assert.match(uploadGuard('INTERNAL', { allowPublic: false, assumePrivate: false }).warning!, /enterprise/);
  });
});

describe('publish --dry-run', () => {
  let dir: string;
  let fakeBin: string;
  const savedPath = process.env.PATH;

  function dryRun(repo: string, visibility: string, searchPath = `${fakeBin}${path.delimiter}${savedPath}`): Record<string, unknown> {
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(skillRoot, 'src', 'cli.ts'), 'publish', '--pr', '3', '--dry-run'], {
      cwd: repo,
      env: { ...process.env, PATH: searchPath, FAKE_GH_VISIBILITY: visibility },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }

  function repoWithReport(name: string, remote?: string): string {
    const repo = path.join(dir, name);
    mkdirSync(path.join(repo, '.ui-diff'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo });
    writeFileSync(path.join(repo, '.ui-diff', 'report.json'), JSON.stringify(sampleReport()));
    return repo;
  }

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-dryrun-'));
    fakeBin = path.join(dir, 'bin');
    mkdirSync(fakeBin);
    const gh = path.join(fakeBin, 'gh');
    writeFileSync(
      gh,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
require('fs').appendFileSync(${JSON.stringify(path.join(dir, 'gh.log'))}, JSON.stringify(args) + '\\n');
if (args[0] === 'repo' && args[1] === 'view') { if (process.env.FAKE_GH_VISIBILITY === 'ERROR') process.exit(1); console.log(JSON.stringify({ visibility: process.env.FAKE_GH_VISIBILITY })); process.exit(0); }
process.exit(1);
`,
    );
    chmodSync(gh, 0o755);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('reports that a public repository would be refused', () => {
    const result = dryRun(repoWithReport('public', 'https://github.com/qa-org/public-app.git'), 'PUBLIC');
    assert.equal(result.publishable, false);
    assert.equal(result.visibility, 'PUBLIC');
    assert.match((result.problems as string[])[0], /public/);
    assert.ok((result.wouldUpload as unknown[]).length > 0);
    const calls = readFileSync(path.join(dir, 'gh.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    assert.ok(calls.every((c) => c[0] === 'repo' && c[1] === 'view'), 'dry run must only read the visibility');
  });

  it('is publishable for a private repository', () => {
    const result = dryRun(repoWithReport('private', 'https://github.com/qa-org/private-app.git'), 'PRIVATE');
    assert.equal(result.publishable, true);
    assert.deepEqual(result.problems, []);
  });

  it('reports the visibility as unknown when gh is not installed', () => {
    const noGh = path.join(dir, 'no-gh-bin');
    mkdirSync(noGh);
    symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), path.join(noGh, 'git'));
    const result = dryRun(repoWithReport('no-gh', 'https://github.com/qa-org/app.git'), 'PRIVATE', noGh);
    assert.equal(result.publishable, false);
    assert.equal(result.visibility, 'unknown');
    assert.ok((result.problems as string[]).some((p) => /Could not verify/.test(p)));
    assert.ok((result.hints as string[]).some((h) => /Install the GitHub CLI/.test(h)));
  });

  it('still renders the comment without a git remote and says why a real publish would stop', () => {
    const repo = repoWithReport('no-remote');
    const result = dryRun(repo, 'PRIVATE');
    assert.equal(result.publishable, false);
    assert.ok((result.problems as string[]).some((p) => /Cannot derive image links/.test(p)));
    assert.ok((result.problems as string[]).some((p) => /Could not verify/.test(p)));
    const body = readFileSync(path.join(repo, '.ui-diff', 'comment.md'), 'utf8');
    assert.match(body, /<img src="compare\/home__desktop__light__focus-1\.png"/);
  });
});
