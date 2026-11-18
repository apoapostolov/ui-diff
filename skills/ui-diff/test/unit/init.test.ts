import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { detectPackageManager, suggestStartCommand } from '../../src/cli.js';

const dirs: string[] = [];
function project(pkg: object, files: string[] = []): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ui-diff-init-'));
  dirs.push(dir);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  for (const f of files) writeFileSync(path.join(dir, f), '');
  return dir;
}
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('init start command', () => {
  it('prefers the dev script over calling the framework binary', () => {
    const dir = project({ scripts: { dev: 'vite --config vite.app.ts' }, devDependencies: { vite: '^7' } }, ['package-lock.json']);
    assert.deepEqual(suggestStartCommand(dir), { startCommand: 'npm run dev -- --port {port}', framework: 'Vite (dev script)' });
  });

  it('uses the lockfile package manager and leaves a script-defined port alone', () => {
    const pnpm = project({ scripts: { dev: 'vite dev' }, dependencies: { '@tanstack/react-start': '^1' } }, ['pnpm-lock.yaml']);
    assert.equal(suggestStartCommand(pnpm).startCommand, 'pnpm run dev --port {port}');
    const own = project({ scripts: { dev: 'next dev -p 3001' }, dependencies: { next: '^16' } });
    assert.equal(suggestStartCommand(own).startCommand, 'npm run dev');
    assert.match(suggestStartCommand(own).framework, /sets its own port/);
  });

  it('falls back to the framework binary when there is no dev script', () => {
    const dir = project({ dependencies: { next: '^16' } });
    assert.equal(suggestStartCommand(dir).startCommand, 'npx next dev --port {port}');
  });

  it('finds the lockfile of a monorepo root', () => {
    const root = project({ name: 'mono' }, ['yarn.lock']);
    const app = path.join(root, 'apps/web');
    mkdirSync(app, { recursive: true });
    assert.equal(detectPackageManager(app, root), 'yarn');
  });
});
