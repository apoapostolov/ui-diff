import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { log, UiDiffError } from './log.js';

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export function fillPort(template: string, port: number): string {
  return template.replace(/\{port\}/g, String(port));
}

export interface RunningServer {
  label: string;
  port: number;
  url: string;
  logFile: string;
  stop(): Promise<void>;
}

const running = new Set<ChildProcess>();

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** Stops every server started by this process (used on SIGINT / fatal errors). */
export function killAllServers(): void {
  for (const child of running) killGroup(child, 'SIGKILL');
  running.clear();
}

function tail(file: string, lines = 25): string {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

export async function waitForUrl(
  url: string,
  opts: { timeoutMs: number; isAlive?: () => boolean; headers?: Record<string, string>; intervalMs?: number },
): Promise<number> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (opts.isAlive && !opts.isAlive()) throw new UiDiffError(`Server exited before ${url} became ready`);
    try {
      const response = await fetch(url, { headers: opts.headers, redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (response.status < 500) return response.status;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 400));
  }
  throw new UiDiffError(`Timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for ${url} (${lastError})`);
}

/** Runs a shell command to completion, streaming output to a log file. */
export function runLogged(command: string, opts: { cwd: string; env: NodeJS.ProcessEnv; logFile: string; label: string }): Promise<void> {
  mkdirSync(path.dirname(opts.logFile), { recursive: true });
  const fd = openSync(opts.logFile, 'a');
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd: opts.cwd, env: opts.env, shell: true, stdio: ['ignore', fd, fd], detached: process.platform !== 'win32' });
    running.add(child);
    child.on('error', (error) => {
      running.delete(child);
      closeSync(fd);
      reject(error);
    });
    child.on('close', (code) => {
      running.delete(child);
      closeSync(fd);
      if (code === 0) resolve();
      else reject(new UiDiffError(`${opts.label} failed (exit ${code}): ${command}\n${tail(opts.logFile)}`, { hint: `Full log: ${opts.logFile}` }));
    });
  });
}

export async function startServer(opts: {
  label: string;
  command: string;
  cwd: string;
  port: number;
  url: string;
  readyUrl: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
  timeoutMs: number;
}): Promise<RunningServer> {
  mkdirSync(path.dirname(opts.logFile), { recursive: true });
  const fd = openSync(opts.logFile, 'a');
  const command = fillPort(opts.command, opts.port);
  log.debug(`${opts.label}: ${command} (cwd ${opts.cwd})`);
  const child = spawn(command, {
    cwd: opts.cwd,
    env: { ...opts.env, PORT: String(opts.port), BROWSER: 'none', FORCE_COLOR: '0' },
    shell: true,
    stdio: ['ignore', fd, fd],
    detached: process.platform !== 'win32',
  });
  closeSync(fd);
  running.add(child);
  let exited = false;
  child.on('exit', () => {
    exited = true;
    running.delete(child);
  });
  const stop = async () => {
    if (exited) return;
    killGroup(child, 'SIGTERM');
    const deadline = Date.now() + 5000;
    while (!exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (!exited) killGroup(child, 'SIGKILL');
    running.delete(child);
  };
  try {
    await waitForUrl(opts.readyUrl, { timeoutMs: opts.timeoutMs, isAlive: () => !exited });
  } catch (error) {
    await stop();
    throw new UiDiffError(`${opts.label} server did not start: ${(error as Error).message}\n${tail(opts.logFile)}`, {
      hint: `Check startCommand/baseUrl in ui-diff.config.json. Full log: ${opts.logFile}`,
    });
  }
  return { label: opts.label, port: opts.port, url: opts.url, logFile: opts.logFile, stop };
}
