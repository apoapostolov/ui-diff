import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createImage, encodePng, fillRect } from '../../src/image.js';
import { encodeSideBySideGif, resample, type RawFrame } from '../../src/motion.js';
import { httpProblem } from '../../src/pipeline.js';
import { fillPort, getFreePort, startServer, waitForUrl } from '../../src/server.js';

describe('dev servers', () => {
  it('finds free ports and fills templates', async () => {
    const port = await getFreePort();
    assert.ok(port > 0);
    assert.equal(fillPort('next dev -p {port} # {port}', 3001), 'next dev -p 3001 # 3001');
  });

  it('starts a server in its own process group and stops all of it', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-server-'));
    const marker = path.join(dir, 'child.pid');
    const script = path.join(dir, 'server.mjs');
    writeFileSync(
      script,
      `import http from 'node:http'; import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
       const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
       writeFileSync(${JSON.stringify(marker)}, String(child.pid));
       http.createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');`,
    );
    const port = await getFreePort();
    const server = await startServer({
      label: 'test',
      command: `"${process.execPath}" server.mjs`,
      cwd: dir,
      port,
      url: `http://127.0.0.1:${port}`,
      readyUrl: `http://127.0.0.1:${port}/`,
      env: process.env,
      logFile: path.join(dir, 'server.log'),
      timeoutMs: 10000,
    });
    const childPid = Number(readFileSync(marker, 'utf8'));
    assert.ok(childPid > 0);
    await server.stop();
    await new Promise((r) => setTimeout(r, 300));
    assert.throws(() => process.kill(childPid, 0));
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a server that never becomes ready', async () => {
    await assert.rejects(waitForUrl('http://127.0.0.1:9/', { timeoutMs: 600, intervalMs: 100 }), /timed out/i);
  });

  it('turns HTTP errors into capture errors', () => {
    assert.equal(httpProblem('base', 200), undefined);
    assert.match(httpProblem('head', 401)!, /configure auth/);
    assert.match(httpProblem('base', 404)!, /route path/);
    assert.equal(httpProblem('head', 500), 'head returned HTTP 500');
  });
});

describe('motion clips', () => {
  const frame = (t: number, color: [number, number, number, number]): RawFrame => {
    const png = createImage(40, 30, [255, 255, 255, 255]);
    fillRect(png, { x: 5, y: 5, width: 10, height: 10 }, color);
    return { t, data: encodePng(png) };
  };

  it('resamples frames on a fixed clock', () => {
    const frames: RawFrame[] = [
      { t: 0, data: Buffer.alloc(0) },
      { t: 250, data: Buffer.alloc(0) },
      { t: 260, data: Buffer.alloc(0) },
      { t: 900, data: Buffer.alloc(0) },
    ];
    assert.deepEqual(resample(frames, 10, 1000), [0, 0, 0, 2, 2, 2, 2, 2, 2, 3]);
    assert.deepEqual(resample([], 10, 1000), []);
  });

  it('encodes a looping side-by-side GIF and merges identical frames', () => {
    const before = [frame(0, [0, 0, 0, 255])];
    const after = [frame(0, [255, 0, 0, 255]), frame(500, [0, 0, 255, 255])];
    const gif = encodeSideBySideGif(before, after, { fps: 10, durationMs: 1000, scale: 1, labels: { before: 'BEFORE', after: 'AFTER' } });
    assert.equal(gif.subarray(0, 6).toString('ascii'), 'GIF89a');
    let graphicControlBlocks = 0;
    for (let i = 0; i + 2 < gif.length; i++) if (gif[i] === 0x21 && gif[i + 1] === 0xf9 && gif[i + 2] === 0x04) graphicControlBlocks++;
    assert.equal(graphicControlBlocks, 2);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-gif-'));
    writeFileSync(path.join(dir, 'a.gif'), gif);
    assert.ok(existsSync(path.join(dir, 'a.gif')));
    rmSync(dir, { recursive: true, force: true });
  });
});
