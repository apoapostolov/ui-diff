import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const workflow = readFileSync(new URL('../../../../examples/workflows/ui-diff.yml', import.meta.url), 'utf8');

/** Pulls the shell script of the "Detect the package manager" step out of the workflow. */
function detectScript(): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l) => l.includes('name: Detect the package manager'));
  const run = lines.findIndex((l, i) => i > start && /^\s+run: \|$/.test(l));
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (!line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

function detect(lockfile?: string): Record<string, string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'ui-diff-wf-'));
  try {
    if (lockfile) writeFileSync(path.join(dir, lockfile), '');
    const out = path.join(dir, 'out');
    writeFileSync(out, '');
    execFileSync('bash', ['-e', '-c', detectScript()], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: out } });
    return Object.fromEntries(
      readFileSync(out, 'utf8')
        .trim()
        .split('\n')
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('example CI workflow', () => {
  it('installs app dependencies with the package manager of the lockfile', () => {
    assert.deepEqual(detect('pnpm-lock.yaml'), { name: 'pnpm', install: 'pnpm install --frozen-lockfile' });
    assert.deepEqual(detect('yarn.lock'), { name: 'yarn', install: 'yarn install --immutable' });
    assert.deepEqual(detect('bun.lockb'), { name: 'bun', install: 'bun install --frozen-lockfile' });
    assert.deepEqual(detect('package-lock.json'), { name: 'npm', install: 'npm ci' });
    assert.deepEqual(detect(), { name: 'npm', install: 'npm ci' });
  });

  it('does not assume npm for the app', () => {
    assert.doesNotMatch(workflow, /cache: npm/);
    assert.doesNotMatch(workflow, /run: npm ci\n/);
    assert.match(workflow, /run: \$\{\{ steps\.pm\.outputs\.install \}\}/);
    assert.match(workflow, /corepack enable/);
  });
});
