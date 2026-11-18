import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { doctorLine, doctorOk, type DoctorCheck } from '../../src/cli.js';

describe('doctor', () => {
  const missingChromium: DoctorCheck = { check: 'browser', ok: false, detail: 'Playwright Chromium not installed yet', optional: true };

  it('reports a self-installable Chromium as WARN, not FAIL', () => {
    assert.match(doctorLine(missingChromium), /^WARN browser:/);
    assert.ok(doctorOk([{ check: 'node', ok: true, detail: '22.0.0' }, missingChromium]));
  });

  it('still fails on required checks', () => {
    const git: DoctorCheck = { check: 'git repository', ok: false, detail: 'not a git repository' };
    assert.match(doctorLine(git), /^FAIL git repository:/);
    assert.ok(!doctorOk([git, missingChromium]));
    assert.match(doctorLine({ check: 'node', ok: true, detail: '22.0.0' }), /^ok {3}node: 22\.0\.0$/);
  });
});

describe('doctor command', () => {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli.ts');
  let dir: string;
  let repo: string;
  let signedOut: string;
  let noGh: string;

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-doctor-'));
    repo = path.join(dir, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    writeFileSync(path.join(repo, 'ui-diff.config.json'), JSON.stringify({ startCommand: 'node serve.mjs --port {port}', routes: ['/'] }));
    signedOut = path.join(dir, 'signed-out');
    mkdirSync(signedOut);
    writeFileSync(path.join(signedOut, 'gh'), '#!/bin/sh\necho "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2\nexit 1\n');
    chmodSync(path.join(signedOut, 'gh'), 0o755);
    noGh = path.join(dir, 'no-gh');
    mkdirSync(noGh);
    symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), path.join(noGh, 'git'));
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  function doctor(cwd: string, searchPath: string): { ok: boolean; checks: DoctorCheck[]; stderr: string } {
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, 'doctor'], { cwd, env: { ...process.env, PATH: searchPath }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return { ...(JSON.parse(result.stdout) as { ok: boolean; checks: DoctorCheck[] }), stderr: result.stderr };
  }

  it('shows a missing gh login as WARN and stays ok, because only publish and --pr need it', () => {
    const report = doctor(repo, `${signedOut}${path.delimiter}${process.env.PATH}`);
    const gh = report.checks.find((c) => c.check === 'gh auth')!;
    assert.equal(gh.ok, false);
    assert.equal(gh.optional, true);
    assert.match(gh.detail, /^You are not logged into any GitHub hosts\..*; only publish and --pr need it$/);
    assert.match(report.stderr, /WARN gh auth: /);
    assert.doesNotMatch(report.stderr, /FAIL/);
    assert.equal(report.ok, true);
  });

  it('treats gh not being installed the same way', () => {
    const report = doctor(repo, noGh);
    assert.deepEqual(report.checks.find((c) => c.check === 'gh auth'), { check: 'gh auth', ok: false, detail: 'gh not installed; only publish and --pr need it', optional: true });
    assert.equal(report.ok, true);
  });

  it('keeps FAIL for what blocks a basic run', () => {
    const outside = path.join(dir, 'not-a-repo');
    mkdirSync(outside);
    const report = doctor(outside, noGh);
    assert.match(report.stderr, /FAIL git repository: /);
    assert.equal(report.ok, false);
  });
});
