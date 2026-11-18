import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contextOptions } from '../../src/capture.js';
import { parseConfig } from '../../src/config.js';
import { createImage, encodePng, fillRect } from '../../src/image.js';
import { renderComment } from '../../src/markdown.js';
import { distinctFrames, motionWarning, type RawFrame } from '../../src/motion.js';
import { motionTargets } from '../../src/pipeline.js';
import { autoSummary } from '../../src/report.js';
import { sampleReport } from './fixtures.js';

function frame(t: number, x: number): RawFrame {
  const png = createImage(40, 20, [255, 255, 255, 255]);
  fillRect(png, { x, y: 5, width: 6, height: 6 }, [37, 99, 235, 255]);
  return { t, data: encodePng(png) };
}

describe('motion clips', () => {
  it('records only routes with a visual change unless --motion-all', () => {
    const routes = [{ path: '/' }, { path: '/about' }, { path: '/pricing' }];
    const changed = new Set(['/pricing']);
    assert.deepEqual(motionTargets(routes, changed, false), [{ path: '/pricing' }]);
    assert.deepEqual(motionTargets(routes, changed, true), routes);
    assert.deepEqual(motionTargets(routes, new Set(), false), []);
  });

  it('records motion with prefers-reduced-motion: no-preference while static captures stay reduced', () => {
    const cfg = parseConfig({ startCommand: 'x {port}' }, { repoRoot: '/repo' });
    assert.equal(cfg.capture.disableAnimations, true);
    const viewport = { name: 'desktop', width: 800, height: 600 };
    assert.equal(contextOptions(viewport, undefined, cfg, false).reducedMotion, 'reduce');
    assert.equal(contextOptions(viewport, undefined, cfg, true).reducedMotion, 'no-preference');
  });

  it('counts distinct frames and warns when nothing moved', () => {
    const still = [frame(0, 2), frame(100, 2), frame(200, 2)];
    const moving = [frame(0, 2), frame(100, 10), frame(200, 18), frame(300, 26)];
    assert.equal(distinctFrames(still), 1);
    assert.equal(distinctFrames([]), 0);
    assert.equal(distinctFrames(moving), 3);
    assert.match(motionWarning({ base: 1, head: 1 })!, /^no motion detected/);
    assert.match(motionWarning({ base: 3, head: 1 })!, /^no motion detected on head/);
    assert.equal(motionWarning({ base: 3, head: 3 }), undefined);
  });

  it('shows motion warnings and skipped routes in the summary and comment', () => {
    const report = sampleReport();
    report.motion[0].warnings = ['no motion detected: the clip has a single frame on both sides (nothing animated during these steps)'];
    report.motion[0].frames = { base: 1, head: 1 };
    report.motionSkipped = ['/about'];
    const summary = autoSummary(report);
    assert.match(summary, /No motion detected in `\/`/);
    assert.match(summary, /Motion not recorded for unchanged routes: `\/about`/);
    const body = renderComment(report, { id: 'default', title: 'UI diff', link: (p) => p });
    assert.match(body, /> ⚠️ no motion detected/);
  });
});
