import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseConfig } from '../../src/config.js';
import { lockfileHash, planInstall, SharedInstalls } from '../../src/sides.js';

const LOCK = '{\n  "name": "app",\n  "lockfileVersion": 3,\n  "packages": {}\n}\n';

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-install-'));
  const repo = path.join(dir, 'repo');
  mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  writeFileSync(path.join(repo, 'package.json'), '{"name":"app"}');
  writeFileSync(path.join(repo, 'package-lock.json'), LOCK);
  const worktree = (name: string, lock: string) => {
    const wt = path.join(dir, name);
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(wt, 'package.json'), '{"name":"app"}');
    writeFileSync(path.join(wt, 'package-lock.json'), lock);
    return wt;
  };
  const cfg = parseConfig({ startCommand: 'node serve.mjs {port}' }, { repoRoot: repo });
  return { dir, repo, worktree, cfg };
}

describe('dependency installs in worktrees', () => {
  it('reuses your node_modules when the lockfile only differs in line endings or trailing whitespace', () => {
    const { dir, worktree, cfg } = setup();
    try {
      const wt = worktree('head', LOCK.replace(/\n/g, '\r\n') + '\n\n');
      assert.equal(lockfileHash(path.join(wt, 'package-lock.json')), lockfileHash(path.join(cfg.repoRoot, 'package-lock.json')));
      const plan = planInstall(cfg, wt);
      assert.equal(plan.kind, 'link');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('installs when the lockfile really differs, with a key shared by identical lockfiles', () => {
    const { dir, worktree, cfg } = setup();
    try {
      const other = LOCK.replace('"packages": {}', '"packages": { "node_modules/x": { "version": "1.0.0" } }');
      const base = planInstall(cfg, worktree('base', other));
      const head = planInstall(cfg, worktree('head', other.replace(/\n/g, '\r\n')));
      const third = planInstall(cfg, worktree('third', LOCK.replace('"app"', '"app2"')));
      assert.equal(base.kind, 'command');
      assert.match(base.command!, /^npm ci/);
      assert.ok(base.lockKey);
      assert.equal(head.lockKey, base.lockKey);
      assert.notEqual(third.lockKey, base.lockKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs one install per lockfile and lets the other side link to it', async () => {
    const shared = new SharedInstalls();
    let installs = 0;
    const install = async () => {
      installs++;
      await new Promise((r) => setTimeout(r, 20));
    };
    const [base, head] = await Promise.all([shared.run('k', '/tmp/base', install), shared.run('k', '/tmp/head', install)]);
    assert.equal(installs, 1);
    assert.equal(base, undefined);
    assert.equal(head, '/tmp/base');
    assert.equal(await shared.run('other', '/tmp/x', install), undefined);
    assert.equal(installs, 2);
  });

  it('installs on its own when the shared install failed', async () => {
    const shared = new SharedInstalls();
    let calls = 0;
    const failing = shared.run('k', '/tmp/base', async () => {
      calls++;
      throw new Error('boom');
    });
    const second = shared.run('k', '/tmp/head', async () => {
      calls++;
    });
    await assert.rejects(failing, /boom/);
    assert.equal(await second, undefined);
    assert.equal(calls, 2);
  });
});
