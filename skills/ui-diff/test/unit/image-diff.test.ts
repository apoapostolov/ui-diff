import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { composeCompare, diffPngs, findRegions, focusBoxes, mergeBoxes } from '../../src/diff.js';
import { drawText, fitText, measureText } from '../../src/font.js';
import { blit, composeRow, createImage, crop, fillRect, padTo, resizeToWidth, type RGBA } from '../../src/image.js';

const WHITE: RGBA = [255, 255, 255, 255];
const BLUE: RGBA = [37, 99, 235, 255];

function page(width: number, height: number, boxes: Array<{ x: number; y: number; width: number; height: number; color: RGBA }> = []) {
  const png = createImage(width, height, WHITE);
  for (const b of boxes) fillRect(png, b, b.color);
  return png;
}

const opts = { threshold: 0.1, includeAA: false, minChangedPixels: 1, highlight: '#ff0080' };

describe('diff', () => {
  it('reports no change for identical images', () => {
    const a = page(200, 100, [{ x: 10, y: 10, width: 50, height: 20, color: BLUE }]);
    const b = page(200, 100, [{ x: 10, y: 10, width: 50, height: 20, color: BLUE }]);
    const result = diffPngs(a, b, opts);
    assert.equal(result.changedPixels, 0);
    assert.equal(result.changed, false);
    assert.deepEqual(result.regions, []);
  });

  it('finds the changed region and highlights it', () => {
    const a = page(300, 200, [{ x: 20, y: 20, width: 40, height: 20, color: BLUE }]);
    const b = page(300, 200, [{ x: 20, y: 20, width: 40, height: 20, color: BLUE }, { x: 200, y: 120, width: 30, height: 30, color: BLUE }]);
    const result = diffPngs(a, b, opts);
    assert.equal(result.changed, true);
    assert.equal(result.changedPixels, 900);
    assert.equal(result.regions.length, 1);
    const [r] = result.regions;
    assert.ok(r.x <= 200 && r.y <= 120 && r.x + r.width >= 230 && r.y + r.height >= 150);
    const i = (130 * 300 + 210) * 4;
    assert.deepEqual([...result.diffImage.data.subarray(i, i + 3)], [255, 0, 128]);
  });

  it('pads images of different size and flags the size change', () => {
    const a = page(100, 100);
    const b = page(100, 140);
    const result = diffPngs(a, b, opts);
    assert.equal(result.sizeChanged, true);
    assert.equal(result.changed, true);
    assert.equal(result.height, 140);
    assert.deepEqual(result.before, { width: 100, height: 100 });
  });

  it('ignores changes below minChangedPixels', () => {
    const a = page(100, 100);
    const b = page(100, 100, [{ x: 5, y: 5, width: 2, height: 2, color: BLUE }]);
    assert.equal(diffPngs(a, b, { ...opts, minChangedPixels: 10 }).changed, false);
  });

  it('groups nearby pixels into regions and merges close boxes', () => {
    const mask = new Uint8Array(100 * 100);
    mask[10 * 100 + 10] = 1;
    mask[12 * 100 + 14] = 1;
    mask[90 * 100 + 90] = 1;
    const regions = findRegions(mask, 100, 100, 4, 4);
    assert.equal(regions.length, 2);
    assert.deepEqual(mergeBoxes([{ x: 0, y: 0, width: 10, height: 10 }, { x: 12, y: 0, width: 10, height: 10 }], 4), [{ x: 0, y: 0, width: 22, height: 10 }]);
  });

  it('chooses readable focus crops and skips them when the change covers the page', () => {
    const boxes = focusBoxes([{ x: 500, y: 500, width: 20, height: 10 }], 1280, 2000, { max: 2, padding: 32, scale: 1 });
    assert.equal(boxes.length, 1);
    assert.ok(boxes[0].width >= 420 && boxes[0].height >= 220);
    assert.deepEqual(focusBoxes([{ x: 0, y: 0, width: 1200, height: 1900 }], 1280, 2000, { max: 2, padding: 32, scale: 1 }), []);
  });

  it('composes before | after | diff with labels', () => {
    const a = page(300, 200);
    const b = page(300, 220, [{ x: 10, y: 10, width: 50, height: 50, color: BLUE }]);
    const result = diffPngs(a, b, opts);
    const full = composeCompare(result, { before: 'BEFORE', after: 'AFTER', diff: 'DIFF' }, {});
    assert.ok(full.width > 900);
    assert.ok(full.height > 220);
    const capped = composeCompare(result, { before: 'B', after: 'A', diff: 'D' }, { maxWidth: 600 });
    assert.equal(capped.width, 600);
    const zoom = composeCompare(result, { before: 'B', after: 'A', diff: 'D' }, { box: { x: 0, y: 0, width: 100, height: 80 }, upscaleBelow: 180 });
    assert.ok(zoom.width > 3 * 180);
  });
});

describe('image helpers', () => {
  it('clips blits and crops at the edges', () => {
    const src = page(10, 10, [{ x: 0, y: 0, width: 10, height: 10, color: BLUE }]);
    const dst = page(10, 10);
    blit(src, dst, 5, 5);
    assert.deepEqual([...dst.data.subarray(0, 4)], WHITE);
    assert.deepEqual([...dst.data.subarray((9 * 10 + 9) * 4, (9 * 10 + 9) * 4 + 4)], BLUE);
    blit(src, dst, -20, -20);
    const piece = crop(src, { x: 8, y: 8, width: 5, height: 5 });
    assert.equal(piece.width, 5);
    assert.deepEqual([...piece.data.subarray((4 * 5 + 4) * 4, (4 * 5 + 4) * 4 + 4)], WHITE);
    assert.equal(padTo(src, 12, 14, WHITE).height, 14);
  });

  it('resizes by area averaging and nearest neighbour', () => {
    const src = page(4, 2, [{ x: 0, y: 0, width: 2, height: 2, color: [0, 0, 0, 255] }]);
    const half = resizeToWidth(src, 2);
    assert.equal(half.height, 1);
    assert.deepEqual([...half.data.subarray(0, 4)], [0, 0, 0, 255]);
    assert.deepEqual([...half.data.subarray(4, 8)], WHITE);
    assert.equal(resizeToWidth(src, 8).height, 4);
  });

  it('measures, fits and draws bitmap text', () => {
    assert.equal(measureText('AB', 2), 22);
    assert.equal(fitText('BEFORE 1A2B3C4', 2, 60).endsWith('...'), true);
    const png = page(40, 20);
    drawText(png, 'I', 0, 0, 1, [0, 0, 0, 255]);
    assert.deepEqual([...png.data.subarray((0 * 40 + 1) * 4, (0 * 40 + 1) * 4 + 3)], [0, 0, 0]);
    const row = composeRow([{ image: page(100, 50), label: 'A', accent: BLUE }, { image: page(100, 80), label: 'B', accent: BLUE }], { gap: 10, padding: 10, scale: 2 });
    assert.equal(row.width, 10 + 100 + 10 + 100 + 10);
  });
});
