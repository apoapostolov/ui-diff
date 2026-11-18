import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { firstMatch, globToRegExp, matchAny, matchGlob } from '../../src/glob.js';

describe('glob', () => {
  it('matches single-segment wildcards', () => {
    assert.ok(matchGlob('src/app.css', 'src/*.css'));
    assert.ok(!matchGlob('src/nested/app.css', 'src/*.css'));
    assert.ok(matchGlob('src/a.ts', 'src/?.ts'));
  });

  it('treats ** as any number of directories', () => {
    assert.ok(matchGlob('src/a/b/c.tsx', 'src/**/*.tsx'));
    assert.ok(matchGlob('src/c.tsx', 'src/**/*.tsx'));
    assert.ok(matchGlob('src/a/b', 'src/**'));
    assert.ok(!matchGlob('lib/c.tsx', 'src/**/*.tsx'));
  });

  it('matches basenames at any depth when the pattern has no slash', () => {
    assert.ok(matchGlob('a/b/tailwind.config.js', 'tailwind.config.*'));
    assert.ok(matchGlob('styles.css', '*.css'));
  });

  it('anchors patterns with a leading slash to the root', () => {
    assert.ok(matchGlob('index.html', '/index.html'));
    assert.ok(!matchGlob('docs/index.html', '/index.html'));
  });

  it('supports braces and character classes', () => {
    assert.ok(matchGlob('a/b.scss', '**/*.{css,scss}'));
    assert.ok(!matchGlob('a/b.less', '**/*.{css,scss}'));
    assert.ok(matchGlob('v1.txt', 'v[0-9].txt'));
    assert.ok(!matchGlob('va.txt', 'v[!a-z].txt'));
    assert.ok(matchGlob('a/x.test.ts', '**/*.{test,spec}.*'));
  });

  it('escapes regex metacharacters', () => {
    assert.ok(matchGlob('a+b(1).css', 'a+b(1).css'));
    assert.ok(!matchGlob('aab1.css', 'a+b(1).css'));
    assert.equal(globToRegExp('x.y').test('xzy'), false);
  });

  it('applies later negations', () => {
    const patterns = ['src/**', '!src/**/*.test.ts'];
    assert.ok(matchAny('src/a.ts', patterns));
    assert.ok(!matchAny('src/a.test.ts', patterns));
    assert.equal(firstMatch('src/a.ts', patterns), 'src/**');
    assert.equal(firstMatch('src/a.test.ts', patterns), undefined);
  });
});
