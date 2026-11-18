import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { excludeFromGit } from '../../src/pipeline.js';

// macOS resolves /tmp and /var to /private/...; a symlinked directory reproduces that on Linux.
describe('output folder under a symlinked path', () => {
  for (const [label, logicalSide] of [
    ['out dir given through the link', 'out'],
    ['repo root given through the link', 'repo'],
  ] as const) {
    it(`is added to .git/info/exclude (${label})`, async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-exclude-'));
      try {
        const real = path.join(dir, 'private', 'repo');
        mkdirSync(real, { recursive: true });
        execFileSync('git', ['init', '-q', real]);
        symlinkSync(path.join(dir, 'private'), path.join(dir, 'tmp'));
        const linked = path.join(dir, 'tmp', 'repo');
        const repoRoot = logicalSide === 'repo' ? linked : real;
        const outDir = path.join(logicalSide === 'out' ? linked : real, '.ui-diff');
        mkdirSync(outDir);
        await excludeFromGit(repoRoot, outDir);
        assert.match(readFileSync(path.join(real, '.git', 'info', 'exclude'), 'utf8'), /^\/\.ui-diff\/$/m);
        assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: real, encoding: 'utf8' }), '');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
