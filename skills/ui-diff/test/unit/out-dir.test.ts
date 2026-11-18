import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { commitOutDir, lastRunFailure, markRunFailed, stageOutDir } from '../../src/pipeline.js';

describe('output directory staging', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-outdir-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  function previousRun(name: string): string {
    const out = path.join(dir, name);
    mkdirSync(path.join(out, 'compare'), { recursive: true });
    mkdirSync(path.join(out, 'logs'), { recursive: true });
    writeFileSync(path.join(out, 'report.json'), JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z' }));
    writeFileSync(path.join(out, 'compare', 'home.png'), 'old image');
    writeFileSync(path.join(out, 'comment.md'), 'old comment');
    writeFileSync(path.join(out, 'summary.md'), 'my summary');
    writeFileSync(path.join(out, 'logs', 'base-server.log'), 'old log');
    return out;
  }

  it('keeps the previous results while a run is staged, and resets only the logs', () => {
    const out = previousRun('staging');
    const stage = stageOutDir(out);
    assert.equal(path.dirname(stage), out);
    assert.equal(readFileSync(path.join(out, 'report.json'), 'utf8'), JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z' }));
    assert.ok(existsSync(path.join(out, 'compare', 'home.png')));
    assert.ok(!existsSync(path.join(out, 'logs')), 'logs belong to the latest run');
    rmSync(stage, { recursive: true, force: true });
  });

  it('swaps in the new results on success and keeps files ui-diff does not write', () => {
    const out = previousRun('commit');
    const stage = stageOutDir(out);
    mkdirSync(path.join(stage, 'compare'));
    writeFileSync(path.join(stage, 'compare', 'about.png'), 'new image');
    writeFileSync(path.join(stage, 'report.json'), JSON.stringify({ createdAt: '2026-02-02T00:00:00.000Z' }));
    writeFileSync(path.join(out, 'last-run-failed.json'), '{}');
    commitOutDir(stage, out);
    assert.deepEqual(readdirSync(path.join(out, 'compare')), ['about.png'], 'old images must not mix with new ones');
    assert.match(readFileSync(path.join(out, 'report.json'), 'utf8'), /2026-02-02/);
    assert.ok(!existsSync(path.join(out, 'comment.md')), 'the comment of the previous run is stale');
    assert.ok(!existsSync(path.join(out, 'last-run-failed.json')));
    assert.equal(readFileSync(path.join(out, 'summary.md'), 'utf8'), 'my summary');
    assert.deepEqual(readdirSync(out).filter((e) => e.startsWith('.')), []);
  });

  it('records a failure next to the kept report', () => {
    const out = previousRun('failed');
    assert.equal(lastRunFailure(out), undefined);
    markRunFailed(out, new Error('base: server exited with code 3'));
    const failure = lastRunFailure(out)!;
    assert.equal(failure.error, 'base: server exited with code 3');
    assert.equal(failure.previousReport, '2026-01-01T00:00:00.000Z');
    const empty = path.join(dir, 'never-ran');
    mkdirSync(empty);
    markRunFailed(empty, new Error('boom'));
    assert.equal(lastRunFailure(empty), undefined, 'nothing to warn about without a kept report');
  });

  it('removes staging left by dead processes but not by running ones', async () => {
    const out = previousRun('stale');
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    const alive = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    try {
      mkdirSync(path.join(out, `.run-${dead}`));
      mkdirSync(path.join(out, `.old-${dead}`));
      mkdirSync(path.join(out, `.run-${alive.pid}`));
      const stage = stageOutDir(out);
      assert.deepEqual(readdirSync(out).filter((e) => e.startsWith('.')).sort(), [`.run-${alive.pid}`, path.basename(stage)].sort());
    } finally {
      alive.kill();
    }
  });
});
