import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inferFromPath, routeUnder } from '../../src/conventions.js';

describe('routing conventions', () => {
  const cases: Array<[string, ReturnType<typeof inferFromPath>]> = [
    ['app/page.tsx', { kind: 'page', framework: 'next-app', route: '/', dynamic: false }],
    ['src/app/(marketing)/pricing/page.tsx', { kind: 'page', framework: 'next-app', route: '/pricing', dynamic: false }],
    ['app/blog/[slug]/page.tsx', { kind: 'page', framework: 'next-app', route: '/blog/[slug]', dynamic: true }],
    ['app/dashboard/layout.tsx', { kind: 'layout', framework: 'next-app', route: '/dashboard', dynamic: false }],
    ['app/globals.css', { kind: 'global', framework: 'next-app', route: '/', dynamic: false }],
    ['pages/index.tsx', { kind: 'page', framework: 'next-pages', route: '/', dynamic: false }],
    ['pages/settings/profile.jsx', { kind: 'page', framework: 'next-pages', route: '/settings/profile', dynamic: false }],
    ['pages/_app.tsx', { kind: 'global', framework: 'next-pages', route: '/', dynamic: false }],
    ['src/routes/about/+page.svelte', { kind: 'page', framework: 'sveltekit', route: '/about', dynamic: false }],
    ['src/routes/+layout.svelte', { kind: 'layout', framework: 'sveltekit', route: '/', dynamic: false }],
    ['pages/contact.vue', { kind: 'page', framework: 'nuxt', route: '/contact', dynamic: false }],
    ['src/pages/index.astro', { kind: 'page', framework: 'astro', route: '/', dynamic: false }],
    ['app/routes/_index.tsx', { kind: 'page', framework: 'remix', route: '/', dynamic: false }],
    ['app/routes/blog.$slug.tsx', { kind: 'page', framework: 'remix', route: '/blog/$slug', dynamic: true }],
    ['index.html', { kind: 'page', framework: 'static', route: '/', dynamic: false }],
    ['about.html', { kind: 'page', framework: 'static', route: '/about.html', dynamic: false }],
    ['public/docs/index.html', { kind: 'page', framework: 'static', route: '/docs/', dynamic: false }],
  ];
  for (const [file, expected] of cases) {
    it(`maps ${file}`, () => assert.deepEqual(inferFromPath(file), expected));
  }

  it('ignores API routes and private folders', () => {
    assert.equal(inferFromPath('pages/api/users.ts'), undefined);
    assert.equal(inferFromPath('app/_components/page.tsx'), undefined);
    assert.equal(inferFromPath('src/components/Button.tsx'), undefined);
  });

  it('checks layout scopes', () => {
    assert.ok(routeUnder('/dashboard/settings', '/dashboard'));
    assert.ok(routeUnder('/dashboard', '/dashboard'));
    assert.ok(!routeUnder('/dashboards', '/dashboard'));
    assert.ok(routeUnder('/anything', '/'));
  });
});
