import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
