import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertSafePreviewUrl, isCredentialOrigin, resolveAuth, sanitizeUrl } from '../../src/auth.js';
import { redact, UiDiffError } from '../../src/log.js';

describe('protected previews', () => {
  it('refuses bypass tokens, share links and embedded credentials in URLs', () => {
    assert.throws(() => assertSafePreviewUrl('https://app-git-x.vercel.app/?x-vercel-protection-bypass=abc', 'head URL'), /token-like query parameter/);
    assert.throws(() => assertSafePreviewUrl('https://app.vercel.app/?_vercel_share=abc', 'head URL'), /_vercel_share/);
    assert.throws(() => assertSafePreviewUrl('https://user:pass@staging.example.com', 'base URL'), /embedded credentials/);
    assert.throws(() => assertSafePreviewUrl('file:///etc/passwd', 'base URL'), /http\(s\)/);
    assert.equal(assertSafePreviewUrl('https://app-git-x.vercel.app/?theme=dark', 'head URL').hostname, 'app-git-x.vercel.app');
  });

  it('sanitizes URLs before they are displayed', () => {
    assert.equal(sanitizeUrl('https://u:p@x.dev/a?token=1&theme=dark'), 'https://x.dev/a?theme=dark');
  });

  it('reads credentials only from the environment and redacts them', () => {
    const env = { BYPASS: 'super-secret-value-123', JWT: 'jwt-cookie-value-456' };
    const auth = resolveAuth(
      { headers: [{ name: 'x-vercel-protection-bypass', env: 'BYPASS' }], cookies: [{ name: '_vercel_jwt', env: 'JWT', path: '/' }] },
      ['https://app-git-feature.vercel.app/', 'https://app-git-main.vercel.app'],
      env,
    );
    assert.deepEqual(auth?.headers, { 'x-vercel-protection-bypass': 'super-secret-value-123' });
    assert.deepEqual(auth?.origins, ['https://app-git-feature.vercel.app', 'https://app-git-main.vercel.app']);
    assert.equal(auth?.cookies[0].value, 'jwt-cookie-value-456');
    assert.equal(redact('header was super-secret-value-123 and jwt-cookie-value-456'), 'header was [redacted] and [redacted]');
  });

  it('fails clearly when a credential variable is missing', () => {
    assert.throws(() => resolveAuth({ headers: [{ name: 'authorization', env: 'NOPE_NOT_SET', prefix: 'Bearer ' }], cookies: [] }, ['https://x.dev'], {}), UiDiffError);
  });

  it('scopes credentials to explicit origins', () => {
    assert.throws(() => resolveAuth({ headers: [{ name: 'x', env: 'A' }], cookies: [] }, [], { A: 'value-1234' }), /no preview URL/);
    const auth = resolveAuth({ headers: [{ name: 'x', env: 'A' }], cookies: [], origins: ['https://preview.internal'] }, [], { A: 'value-1234' });
    assert.ok(isCredentialOrigin('https://preview.internal/path?q=1', auth!.origins));
    assert.ok(!isCredentialOrigin('https://fonts.googleapis.com/css', auth!.origins));
    assert.ok(!isCredentialOrigin('https://preview.internal.evil.com/', auth!.origins));
    assert.ok(!isCredentialOrigin('not a url', auth!.origins));
  });
});
