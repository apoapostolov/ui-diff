import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PNG } from 'pngjs';
import { alignRows, shiftedBlocks } from '../../src/align.js';
import { diffPngs } from '../../src/diff.js';
import { createImage, fillRect, type RGBA } from '../../src/image.js';
import { describeCapture, type CaptureResult } from '../../src/report.js';

const WIDTH = 320;
const WHITE: RGBA = [255, 255, 255, 255];
const INK: RGBA = [17, 24, 39, 255];

interface Block {
  height: number;
  color: RGBA;
  /** Seed for the "text" marks, so every section renders differently. */
  seed: number;
}

/** A synthetic page: stacked blocks, each with a row-unique pattern of dark marks (like lines of text). */
function render(blocks: Block[]): PNG {
  const height = blocks.reduce((sum, b) => sum + b.height, 0);
  const png = createImage(WIDTH, height, WHITE);
  let y = 0;
  for (const block of blocks) {
    fillRect(png, { x: 0, y, width: WIDTH, height: block.height }, block.color);
    for (let r = 2; r < block.height - 2; r++) {
      const x = 8 + ((r * 37 + block.seed * 101) % (WIDTH - 40));
      fillRect(png, { x, y: y + r, width: 6 + ((r + block.seed) % 9), height: 1 }, INK);
    }
    y += block.height;
  }
  return png;
}

const header: Block = { height: 48, color: [243, 244, 246, 255], seed: 1 };
const features: Block = { height: 220, color: [255, 255, 255, 255], seed: 3 };
const pricing: Block = { height: 180, color: [239, 246, 255, 255], seed: 4 };
const footer: Block = { height: 60, color: [31, 41, 55, 255], seed: 5 };
const opts = { threshold: 0.1, includeAA: false, minChangedPixels: 1, highlight: '#ff0080' };

describe('scroll-aware diff', () => {
  it('reports sections pushed down by a taller hero as shifted, not changed', () => {
    const before = render([header, { height: 120, color: [219, 234, 254, 255], seed: 2 }, features, pricing, footer]);
    const after = render([header, { height: 200, color: [219, 234, 254, 255], seed: 2 }, features, pricing, footer]);
    const aligned = diffPngs(before, after, opts);
    const plain = diffPngs(before, after, { ...opts, alignShifts: false });

    assert.equal(aligned.changed, true);
    assert.equal(aligned.shifted.length, 1, JSON.stringify(aligned.shifted));
    const [run] = aligned.shifted;
    assert.equal(run.dy, 80);
    assert.ok(run.height >= features.height + pricing.height + footer.height - 4, `shifted run too short: ${run.height}`);

    // Every changed region sits inside the hero (48..248 on the after side).
    for (const r of aligned.regions) assert.ok(r.y >= 40 && r.y + r.height <= 260, `region outside the hero: ${JSON.stringify(r)}`);
    // Only the hero counts: far less than a positional diff, which flags everything below it.
    assert.ok(aligned.changedPixels * 2 < plain.changedPixels, `${aligned.changedPixels} vs ${plain.changedPixels}`);
    assert.ok(aligned.changedPixels <= 200 * WIDTH);
    assert.deepEqual(plain.shifted, []);
  });

  it('keeps unchanged pages at zero and does not invent shifts', () => {
    const page = render([header, features, pricing, footer]);
    const result = diffPngs(page, render([header, features, pricing, footer]), opts);
    assert.equal(result.changed, false);
    assert.equal(result.changedPixels, 0);
    assert.deepEqual(result.shifted, []);
  });

  it('counts removed content and reports what moved up', () => {
    const before = render([header, features, pricing, footer]);
    const after = render([header, pricing, footer]);
    const result = diffPngs(before, after, opts);
    assert.equal(result.changed, true);
    assert.equal(result.removedRows, features.height);
    assert.ok(result.shifted.some((s) => s.dy === -features.height));
    assert.ok(result.regions.some((r) => r.y <= header.height && r.y + r.height >= header.height));
  });

  it('flags a real change inside shifted content', () => {
    const changedPricing: Block = { ...pricing, color: [250, 204, 21, 255] };
    const before = render([header, { height: 100, color: WHITE, seed: 2 }, features, pricing, footer]);
    const after = render([header, { height: 140, color: WHITE, seed: 2 }, features, changedPricing, footer]);
    const result = diffPngs(before, after, opts);
    const pricingTop = header.height + 140 + features.height;
    assert.ok(result.regions.some((r) => r.y <= pricingTop + 10 && r.y + r.height >= pricingTop + pricing.height - 10), JSON.stringify(result.regions));
    assert.ok(result.shifted.some((s) => s.dy === 40));
  });

  it('aligns rows with an LIS over unique anchors and merges equal shifts', () => {
    const before = render([header, features]);
    const after = render([header, { height: 30, color: INK, seed: 9 }, features]);
    const { blocks, source } = alignRows(before, after);
    assert.ok(blocks.some((b) => b.dy === 0 && b.afterY === 0));
    assert.ok(blocks.some((b) => b.dy === 30));
    assert.equal(source[header.height + 30 + 10], header.height + 10);
    assert.deepEqual(
      shiftedBlocks(
        [
          { beforeY: 0, afterY: 10, height: 20, dy: 10 },
          { beforeY: 25, afterY: 35, height: 20, dy: 10 },
          { beforeY: 60, afterY: 60, height: 2, dy: 0 },
        ],
        4,
      ),
      [{ beforeY: 0, afterY: 10, height: 45, dy: 10 }],
    );
  });

  it('describes shifts separately from the changed percentage', () => {
    const capture = {
      id: 'home__desktop__light',
      route: { path: '/', name: 'home', slug: 'home' },
      viewport: 'desktop',
      theme: 'light',
      status: 'changed',
      urls: {},
      diff: { changedPixels: 900, ratio: 0.021, regions: [{ x: 0, y: 48, width: 320, height: 200 }], scale: 1, sizeBefore: [320, 628], sizeAfter: [320, 708], sizeChanged: true, shifted: [{ beforeY: 168, afterY: 248, height: 460, dy: 80 }] },
      images: { focus: [] },
      warnings: [],
      truncated: false,
    } satisfies CaptureResult;
    assert.equal(describeCapture(capture), '2.10% of pixels changed · 1 area · content shifted down 80px (unchanged, not counted) · page height 628 → 708px');
  });
});
