import pixelmatch from 'pixelmatch';
import type { PNG } from 'pngjs';
import { clampBox, COLORS, composeRow, crop, fadeToGray, intersects, padTo, parseHexColor, resizeToWidth, strokeRect, unionBox, type Box, type RGBA } from './image.js';

export interface DiffOptions {
  threshold: number;
  includeAA: boolean;
  minChangedPixels: number;
  highlight: string;
  /** Device pixel ratio of the screenshots; region sizes scale with it. */
  scale?: number;
}

export interface DiffOutcome {
  width: number;
  height: number;
  changedPixels: number;
  ratio: number;
  changed: boolean;
  sizeChanged: boolean;
  before: { width: number; height: number };
  after: { width: number; height: number };
  regions: Box[];
  /** Padded inputs (same size) — used to cut aligned crops. */
  paddedBefore: PNG;
  paddedAfter: PNG;
  diffImage: PNG;
}

function area(b: Box): number {
  return b.width * b.height;
}

/** Merges boxes that touch or sit within `gap` px of each other. */
export function mergeBoxes(input: Box[], gap: number): Box[] {
  let boxes = input.slice();
  let merged = true;
  while (merged) {
    merged = false;
    const next: Box[] = [];
    for (const box of boxes) {
      const hit = next.findIndex((other) => intersects(box, other, gap));
      if (hit >= 0) {
        next[hit] = unionBox(next[hit], box);
        merged = true;
      } else {
        next.push(box);
      }
    }
    boxes = next;
  }
  return boxes;
}

/** Groups changed pixels into rectangles: a coarse grid, 8-connected components, then proximity merging. */
export function findRegions(mask: Uint8Array, width: number, height: number, cell = 8, gap = 24): Box[] {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const hot = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const rowOffset = ((y / cell) | 0) * cols;
    const base = y * width;
    for (let x = 0; x < width; x++) if (mask[base + x]) hot[rowOffset + ((x / cell) | 0)] = 1;
  }
  const seen = new Uint8Array(cols * rows);
  const boxes: Box[] = [];
  const stack: number[] = [];
  for (let start = 0; start < hot.length; start++) {
    if (!hot[start] || seen[start]) continue;
    let minC = cols;
    let maxC = -1;
    let minR = rows;
    let maxR = -1;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const idx = stack.pop()!;
      const r = (idx / cols) | 0;
      const c = idx - r * cols;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      for (let dr = -1; dr <= 1; dr++) {
        const nr = r + dr;
        if (nr < 0 || nr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const nc = c + dc;
          if (nc < 0 || nc >= cols) continue;
          const n = nr * cols + nc;
          if (hot[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    boxes.push(clampBox({ x: minC * cell, y: minR * cell, width: (maxC - minC + 1) * cell, height: (maxR - minR + 1) * cell }, width, height));
  }
  return mergeBoxes(boxes, gap).sort((a, b) => area(b) - area(a));
}

export function diffPngs(before: PNG, after: PNG, opts: DiffOptions): DiffOutcome {
  const scale = opts.scale ?? 1;
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const a = padTo(before, width, height, COLORS.pad);
  const b = padTo(after, width, height, COLORS.pad);
  const maskOut = new Uint8Array(width * height * 4);
  const changedPixels = pixelmatch(a.data, b.data, maskOut, width, height, {
    threshold: opts.threshold,
    includeAA: opts.includeAA,
    diffMask: true,
    diffColor: [255, 0, 0],
  });
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = maskOut[i * 4 + 3] > 0 ? 1 : 0;
  const sizeChanged = before.width !== after.width || before.height !== after.height;
  const changed = changedPixels >= Math.max(1, opts.minChangedPixels) || sizeChanged;
  const regions = changed ? findRegions(mask, width, height, Math.round(8 * scale), Math.round(24 * scale)) : [];

  const highlight: RGBA = parseHexColor(opts.highlight);
  const diffImage = fadeToGray(b, 0.28);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    diffImage.data[o] = highlight[0];
    diffImage.data[o + 1] = highlight[1];
    diffImage.data[o + 2] = highlight[2];
    diffImage.data[o + 3] = 255;
  }
  const stroke = Math.max(2, Math.round(2 * scale));
  for (const region of regions) strokeRect(diffImage, region, highlight, stroke);

  return {
    width,
    height,
    changedPixels,
    ratio: changedPixels / (width * height),
    changed,
    sizeChanged,
    before: { width: before.width, height: before.height },
    after: { width: after.width, height: after.height },
    regions,
    paddedBefore: a,
    paddedAfter: b,
    diffImage,
  };
}

/**
 * Picks up to `max` crop boxes around the largest changed regions, padded and grown to a
 * readable minimum size. Returns [] when the change covers most of the page anyway.
 */
export function focusBoxes(regions: Box[], width: number, height: number, opts: { max: number; padding: number; scale: number }): Box[] {
  if (opts.max === 0 || regions.length === 0) return [];
  const minW = Math.min(width, Math.round(420 * opts.scale));
  const minH = Math.min(height, Math.round(220 * opts.scale));
  const grown = regions.map((r) => {
    let box = { x: r.x - opts.padding, y: r.y - opts.padding, width: r.width + 2 * opts.padding, height: r.height + 2 * opts.padding };
    if (box.width < minW) box = { ...box, x: box.x - (minW - box.width) / 2, width: minW };
    if (box.height < minH) box = { ...box, y: box.y - (minH - box.height) / 2, height: minH };
    if (box.x < 0) box.x = 0;
    if (box.y < 0) box.y = 0;
    if (box.x + box.width > width) box.x = Math.max(0, width - box.width);
    if (box.y + box.height > height) box.y = Math.max(0, height - box.height);
    return clampBox(box, width, height);
  });
  const merged = mergeBoxes(grown, 0).sort((a, b) => area(b) - area(a));
  const picked = merged.slice(0, opts.max);
  if (picked.length === 1 && area(picked[0]) > 0.7 * width * height) return [];
  return picked;
}

export function composeCompare(
  diff: DiffOutcome,
  labels: { before: string; after: string; diff: string },
  opts: { box?: Box; maxWidth?: number; upscaleBelow?: number },
): PNG {
  let before = diff.paddedBefore;
  let after = diff.paddedAfter;
  let overlay = diff.diffImage;
  if (opts.box) {
    before = crop(before, opts.box);
    after = crop(after, opts.box);
    overlay = crop(overlay, opts.box);
  }
  if (opts.upscaleBelow && before.width < opts.upscaleBelow) {
    const target = Math.min(opts.upscaleBelow, before.width * 2);
    before = resizeToWidth(before, target);
    after = resizeToWidth(after, target);
    overlay = resizeToWidth(overlay, target);
  }
  return composeRow(
    [
      { image: before, label: labels.before, accent: COLORS.before },
      { image: after, label: labels.after, accent: COLORS.after },
      { image: overlay, label: labels.diff, accent: COLORS.diff },
    ],
    { maxWidth: opts.maxWidth },
  );
}
