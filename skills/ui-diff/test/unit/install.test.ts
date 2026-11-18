import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../../install.sh', import.meta.url));
const skillDir = fileURLToPath(new URL('../../', import.meta.url));
const homes: string[] = [];

function freshHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'ui-diff-install-'));
  homes.push(home);
  return home;
}

function install(home: string, ...args: string[]) {
  return spawnSync('bash', [script, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
}

after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

describe('install.sh --copy', () => {
  it('copies the skill into an empty location', () => {
    const home = freshHome();
    const run = install(home, '--claude', '--copy');
    assert.equal(run.status, 0, run.stderr);
    const dest = path.join(home, '.claude/skills/ui-diff');
    assert.match(readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), /^name: ui-diff$/m);
    assert.ok(!existsSync(path.join(dest, 'node_modules')));
  });

  it('refreshes an existing copy of the skill', () => {
    const home = freshHome();
    const dest = path.join(home, '.claude/skills/ui-diff');
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, 'SKILL.md'), '---\nname: ui-diff\ndescription: old\n---\n');
    writeFileSync(path.join(dest, 'stale.txt'), 'old');
    const run = install(home, '--claude', '--copy');
    assert.equal(run.status, 0, run.stderr);
    assert.ok(!existsSync(path.join(dest, 'stale.txt')));
    assert.ok(existsSync(path.join(dest, 'bin/ui-diff.mjs')));
  });

  it('refuses to delete a folder that is not the ui-diff skill', () => {
    const home = freshHome();
    const dest = path.join(home, '.claude/skills/ui-diff');
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, 'notes.md'), 'keep me');
    const run = install(home, '--claude', '--copy');
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /refusing to replace/);
    assert.equal(readFileSync(path.join(dest, 'notes.md'), 'utf8'), 'keep me');
  });

  it('replaces a symlinked install with a copy instead of writing through the link', () => {
    const home = freshHome();
    const target = path.join(home, 'elsewhere');
    mkdirSync(target);
    const dest = path.join(home, '.claude/skills/ui-diff');
    mkdirSync(path.dirname(dest), { recursive: true });
    symlinkSync(target, dest);
    const run = install(home, '--claude', '--copy');
    assert.equal(run.status, 0, run.stderr);
    assert.ok(existsSync(path.join(dest, 'SKILL.md')));
    assert.ok(!existsSync(path.join(target, 'SKILL.md')));
    assert.ok(existsSync(path.join(skillDir, 'SKILL.md')));
  });
});
