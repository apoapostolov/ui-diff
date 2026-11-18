import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parseRemoteUrl } from '../../src/git.js';
import { encodePath, linkBaseFor, listAssetPrs, publishToBranch, pruneBranch, runsToRemove } from '../../src/publish.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('assets branch publishing', () => {
  let dir: string;
  let repo: string;
  let remote: string;
  let files: string[];

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-publish-'));
    remote = path.join(dir, 'origin.git');
    repo = path.join(dir, 'repo');
    git(dir, 'init', '-q', '--bare', remote);
    git(dir, 'init', '-q', '-b', 'main', repo);
    writeFileSync(path.join(repo, 'app.txt'), 'app');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
    git(repo, 'remote', 'add', 'origin', remote);
    files = ['a.png', 'b.png'].map((name) => {
      const file = path.join(dir, name);
      writeFileSync(file, `fake ${name}`);
      return file;
    });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('computes which old runs to remove', () => {
    const paths = ['pr-1/default/20260101-a/x.png', 'pr-1/default/20260102-b/x.png', 'pr-1/default/20260103-c/x.png', 'pr-1/web/20260101-a/x.png', 'pr-2/default/20260101-a/x.png'];
    assert.deepEqual(runsToRemove(paths, 'pr-1/default', 1), ['pr-1/default/20260101-a', 'pr-1/default/20260102-b', 'pr-1/default/20260103-c']);
    assert.deepEqual(runsToRemove(paths, 'pr-1/default', 2), ['pr-1/default/20260101-a', 'pr-1/default/20260102-b']);
  });

  it('pushes a single orphan commit without touching the working tree, index or HEAD', async () => {
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const result = await publishToBranch({
      repoRoot: repo,
      remote: 'origin',
      branch: 'ui-diff-assets',
      runDir: 'pr-1/default/20260101T000000Z-aaaaaaa',
      groupDir: 'pr-1/default',
      keepRuns: 1,
      files: files.map((f) => ({ local: f, dest: `compare/${path.basename(f)}` })),
      message: 'ui-diff: test',
    });
    assert.equal(result.pushed, true);
    assert.equal(git(remote, 'rev-list', '--count', 'ui-diff-assets'), '1');
    assert.equal(git(remote, 'log', '-1', '--format=%P', 'ui-diff-assets'), '');
    assert.deepEqual(git(remote, 'ls-tree', '-r', '--name-only', 'ui-diff-assets').split('\n'), [
      'README.md',
      'pr-1/default/20260101T000000Z-aaaaaaa/compare/a.png',
      'pr-1/default/20260101T000000Z-aaaaaaa/compare/b.png',
    ]);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), headBefore);
    assert.equal(git(repo, 'status', '--porcelain'), '');
    assert.equal(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/ui-diff'), '');
  });

  it('replaces older runs of the same PR and keeps other PRs', async () => {
    await publishToBranch({ repoRoot: repo, remote: 'origin', branch: 'ui-diff-assets', runDir: 'pr-2/default/20260101T000000Z-bbbbbbb', groupDir: 'pr-2/default', keepRuns: 1, files: [{ local: files[0], dest: 'x.png' }], message: 'pr 2' });
    const again = await publishToBranch({ repoRoot: repo, remote: 'origin', branch: 'ui-diff-assets', runDir: 'pr-1/default/20260102T000000Z-ccccccc', groupDir: 'pr-1/default', keepRuns: 1, files: [{ local: files[1], dest: 'y.png' }], message: 'pr 1 again' });
    assert.deepEqual(again.removed.sort(), ['pr-1/default/20260101T000000Z-aaaaaaa/compare/a.png', 'pr-1/default/20260101T000000Z-aaaaaaa/compare/b.png']);
    assert.deepEqual(git(remote, 'ls-tree', '-r', '--name-only', 'ui-diff-assets').split('\n'), ['README.md', 'pr-1/default/20260102T000000Z-ccccccc/y.png', 'pr-2/default/20260101T000000Z-bbbbbbb/x.png']);
    assert.equal(git(remote, 'rev-list', '--count', 'ui-diff-assets'), '1');
  });

  it('does not push when nothing changed', async () => {
    const result = await publishToBranch({ repoRoot: repo, remote: 'origin', branch: 'ui-diff-assets', runDir: 'pr-1/default/20260102T000000Z-ccccccc', groupDir: 'pr-1/default', keepRuns: 1, files: [{ local: files[1], dest: 'y.png' }], message: 'noop' });
    assert.equal(result.pushed, false);
  });

  it('lists and prunes PR folders', async () => {
    assert.deepEqual(await listAssetPrs(repo, 'origin', 'ui-diff-assets'), [1, 2]);
    const pruned = await pruneBranch({ repoRoot: repo, remote: 'origin', branch: 'ui-diff-assets', prs: [2] });
    assert.equal(pruned.pushed, true);
    assert.deepEqual(await listAssetPrs(repo, 'origin', 'ui-diff-assets'), [1]);
  });

  it('builds links that work for private repos', () => {
    const info = parseRemoteUrl('git@github.com:acme/web-app.git')!;
    assert.deepEqual(info, { host: 'github.com', owner: 'acme', repo: 'web-app' });
    assert.equal(linkBaseFor(info, 'ui-diff-assets'), 'https://github.com/acme/web-app/raw/ui-diff-assets');
    assert.deepEqual(parseRemoteUrl('https://x-access-token:abc@ghe.corp.dev/org/sub/repo'), { host: 'ghe.corp.dev', owner: 'org/sub', repo: 'repo' });
    assert.equal(encodePath('pr-1/a b#c.png'), 'pr-1/a%20b%23c.png');
  });
});
