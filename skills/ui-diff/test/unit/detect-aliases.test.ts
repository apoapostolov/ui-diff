import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig, parseConfig } from '../../src/config.js';
import { mapChangesToRoutes, tsconfigAliases } from '../../src/detect.js';
import type { ChangedFile } from '../../src/git.js';
import { aliasesFromTsconfig, parseJsonc, tsconfigLinks } from '../../src/imports.js';

const reader = (files: Record<string, string>) => async (paths: string[]) => new Map(paths.filter((p) => p in files).map((p) => [p, files[p]]));
const changed = (...paths: string[]): ChangedFile[] => paths.map((p) => ({ status: 'M', path: p }));

// Exactly what create-next-app 16 writes: the "include" globs contain "/*", which is not a comment.
const NEXT_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "jsx": "react-jsx",
    "plugins": [
      {
        "name": "next"
      }
    ],
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", "**/*.mts"],
  "exclude": ["node_modules"]
}`;

describe('tsconfig parsing', () => {
  it('only strips comments outside strings', () => {
    assert.deepEqual(parseJsonc('{ // line\n "a": "**/*.ts", /* block */ "b": "x // y", "c": "q\\" /* not */", }'), { a: '**/*.ts', b: 'x // y', c: 'q" /* not */' });
    assert.equal(parseJsonc('{ "a": '), undefined);
  });

  it('reads the create-next-app alias', () => {
    assert.deepEqual(aliasesFromTsconfig(NEXT_TSCONFIG, ''), { '@/': './' });
  });

  it('follows project references and relative extends', () => {
    assert.deepEqual(tsconfigLinks({ references: [{ path: './tsconfig.app.json' }, { path: '../packages/ui' }], extends: './base' }, 'apps/web/tsconfig.json'), [
      'apps/web/tsconfig.app.json',
      'apps/packages/ui/tsconfig.json',
      'apps/web/base.json',
    ]);
    assert.deepEqual(tsconfigLinks({ extends: ['@tsconfig/node22/tsconfig.json', '../tsconfig.base.json'] }, 'tsconfig.json'), []);
  });

  it('collects paths from Vite-style referenced configs and extended bases', async () => {
    const files = {
      'tsconfig.json': '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }] }',
      'tsconfig.app.json': '{ /* Vite puts the app options here */ "extends": "./tsconfig.paths.json", "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }',
      'tsconfig.paths.json': '{ "compilerOptions": { "paths": { "~ui/*": ["./src/ui/*"], "@/*": ["./ignored/*"] } } }',
      'tsconfig.node.json': '{ "compilerOptions": { "types": ["node"] }, "include": ["vite.config.ts"] }',
    };
    assert.deepEqual(await tsconfigAliases(reader(files), ''), { '@/': 'src/', '~ui/': 'src/ui/' });
  });
});

describe('route mapping through aliases and layouts', () => {
  it('maps a create-next-app component change to its page, and a layout-only component to every route', async () => {
    const cfg = parseConfig({}, { repoRoot: '/repo' });
    const files: Record<string, string> = {
      'tsconfig.json': NEXT_TSCONFIG,
      'app/layout.tsx': 'import { Header } from "@/components/Header";\nexport default function RootLayout({ children }) { return <html><body><Header />{children}</body></html>; }',
      'app/page.tsx': 'import { Hero } from "@/components/Hero";\nexport default function Home() { return <Hero />; }',
      'app/pricing/page.tsx': 'export default function Pricing() { return <h1>Pricing</h1>; }',
      'components/Header.tsx': 'export function Header() { return <header />; }',
      'components/Hero.tsx': 'import styles from "./Hero.module.css";\nexport function Hero() { return <section className={styles.hero} />; }',
      'components/Hero.module.css': '.hero { padding: 96px 0; }',
    };
    const result = await mapChangesToRoutes({ cfg, changed: changed('components/Header.tsx', 'components/Hero.module.css'), headFiles: Object.keys(files), readFiles: reader(files) });
    assert.deepEqual(result.unmatched, []);
    const reasons = Object.fromEntries(result.routes.map((r) => [r.route.path, r.reasons.join(' | ')]));
    assert.deepEqual(Object.keys(reasons).sort(), ['/', '/pricing']);
    assert.match(reasons['/'], /components\/Hero\.module\.css → … → app\/page\.tsx/);
    assert.match(reasons['/'], /components\/Header\.tsx → app\/layout\.tsx/);
    assert.match(reasons['/pricing'], /components\/Header\.tsx → app\/layout\.tsx/);
  });

  it('maps a TanStack Router component imported through a tsconfig.app.json alias', async () => {
    const cfg = parseConfig({}, { repoRoot: '/repo' });
    const files: Record<string, string> = {
      'tsconfig.json': '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }',
      'tsconfig.app.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } }, "include": ["src"] }',
      'src/routes/__root.tsx': "import { createRootRoute } from '@tanstack/react-router'",
      'src/routes/index.tsx': "import { Hero } from '@/components/Hero'",
      'src/routes/about.tsx': "export const Route = 1",
      'src/components/Hero.tsx': "import './Hero.css'",
      'src/components/Hero.css': '.hero {}',
    };
    const result = await mapChangesToRoutes({ cfg, changed: changed('src/components/Hero.css'), headFiles: Object.keys(files), readFiles: reader(files) });
    assert.deepEqual(result.routes.map((r) => r.route.path), ['/']);
    assert.deepEqual(result.unmatched, []);
  });
});

describe('config paths', () => {
  it('accepts Windows-style separators', () => {
    const cfg = parseConfig(
      { cwd: '.\\site', routes: [{ path: '/', files: ['.\\index.html', 'assets\\**\\*.css'] }], globalFiles: ['styles\\global.css'], copyFiles: ['config\\.env.local'], detect: { exclude: ['**\\legacy\\**'] } },
      { repoRoot: '/repo', file: '/repo/web/ui-diff.config.json' },
    );
    assert.equal(cfg.cwd, './site');
    assert.deepEqual(cfg.routes[0].files, ['/web/index.html', '/web/assets/**/*.css']);
    assert.deepEqual(cfg.globalFiles, ['/web/styles/global.css']);
    assert.deepEqual(cfg.copyFiles, ['config/.env.local']);
    assert.deepEqual(cfg.detect.exclude, ['**/legacy/**']);
  });

  it('resolves a config reached through a symlinked directory', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-link-'));
    try {
      const repo = path.join(dir, 'repo');
      mkdirSync(path.join(repo, 'site'), { recursive: true });
      writeFileSync(path.join(repo, 'site', 'ui-diff.config.json'), JSON.stringify({ routes: [{ path: '/', files: ['index.html'] }] }));
      symlinkSync(repo, path.join(dir, 'link'));
      const cfg = loadConfig(repo, repo, path.join(dir, 'link', 'site', 'ui-diff.config.json'));
      assert.equal(cfg.dirRel, 'site');
      assert.deepEqual(cfg.routes[0].files, ['/site/index.html']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
