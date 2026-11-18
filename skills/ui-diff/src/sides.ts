import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSafePreviewUrl, sanitizeUrl } from './auth.js';
import type { ResolvedConfig } from './config.js';
import { addWorktree, removeWorktree, revParse, shortSha, snapshotWorkingTree, untrackedFiles } from './git.js';
import { log, UiDiffError } from './log.js';
import { fillPort, getFreePort, runLogged, startServer, type RunningServer } from './server.js';

export type SideName = 'base' | 'head';

export interface Side {
  name: SideName;
  /** Human label, e.g. "main @ 1a2b3c4" or a sanitized preview URL. */
  label: string;
  mode: 'worktree' | 'url';
  sha?: string;
  shortSha?: string;
  ref?: string;
  /** Root URL to which route paths are appended (no trailing slash). */
  url: string;
  dir?: string;
  includesUncommitted?: boolean;
  server?: RunningServer;
}

export interface SideRequest {
  name: SideName;
  ref?: string;
  /** Ref name shown to reviewers (e.g. "origin/main" while `ref` is its merge-base sha). */
  displayRef?: string;
  url?: string;
  workingTree?: boolean;
}

const LOCKFILES: Array<{ file: string; command: string }> = [
  { file: 'pnpm-lock.yaml', command: 'pnpm install --frozen-lockfile --prefer-offline' },
  { file: 'yarn.lock', command: 'yarn install --frozen-lockfile' },
  { file: 'bun.lock', command: 'bun install --frozen-lockfile' },
  { file: 'bun.lockb', command: 'bun install --frozen-lockfile' },
  { file: 'package-lock.json', command: 'npm ci --prefer-offline --no-audit --no-fund' },
  { file: 'npm-shrinkwrap.json', command: 'npm ci --prefer-offline --no-audit --no-fund' },
];

/** Cache directories that must not be shared between base and head checkouts. */
const UNSHARED_ENTRIES = new Set(['.cache', '.vite', '.vite-temp', '.turbo', '.next', '.parcel-cache', '.astro']);

function findUp(start: string, stop: string, predicate: (dir: string) => boolean): string | undefined {
  let dir = start;
  for (;;) {
    if (predicate(dir)) return dir;
    if (dir === stop || dir === path.dirname(dir)) return undefined;
    dir = path.dirname(dir);
  }
}

function sameFile(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * Gives a worktree access to the main checkout's installed packages without sharing caches:
 * node_modules becomes a real directory whose entries are symlinks.
 */
export function linkNodeModules(fromDir: string, toDir: string): boolean {
  const source = path.join(fromDir, 'node_modules');
  const target = path.join(toDir, 'node_modules');
  if (!existsSync(source) || existsSync(target)) return false;
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source)) {
    if (UNSHARED_ENTRIES.has(entry)) continue;
    symlinkSync(path.join(source, entry), path.join(target, entry));
  }
  return true;
}

interface InstallPlan {
  kind: 'none' | 'link' | 'command';
  command?: string;
  dir?: string;
  reason: string;
}

export function planInstall(cfg: ResolvedConfig, worktreeRoot: string): InstallPlan {
  const appDir = path.join(worktreeRoot, cfg.dirRel, cfg.cwd);
  if (cfg.install === false) return { kind: 'none', reason: 'install disabled' };
  if (typeof cfg.install === 'string' && cfg.install !== 'auto') return { kind: 'command', command: cfg.install, dir: appDir, reason: 'install command from config' };
  const pkgDir = findUp(appDir, worktreeRoot, (d) => existsSync(path.join(d, 'package.json')));
  if (!pkgDir) return { kind: 'none', reason: 'no package.json' };
  const lockDir = findUp(pkgDir, worktreeRoot, (d) => LOCKFILES.some((l) => existsSync(path.join(d, l.file))));
  if (!lockDir) return { kind: 'command', command: 'npm install --no-audit --no-fund', dir: pkgDir, reason: 'no lockfile' };
  const lock = LOCKFILES.find((l) => existsSync(path.join(lockDir, l.file)))!;
  const rel = path.relative(worktreeRoot, lockDir);
  const mainLockDir = path.join(cfg.repoRoot, rel);
  if (sameFile(path.join(lockDir, lock.file), path.join(mainLockDir, lock.file)) && existsSync(path.join(mainLockDir, 'node_modules'))) {
    return { kind: 'link', dir: lockDir, reason: `${lock.file} matches your checkout` };
  }
  return { kind: 'command', command: lock.command, dir: lockDir, reason: `${lock.file} differs from your checkout` };
}

function linkAll(cfg: ResolvedConfig, worktreeRoot: string, lockDir: string): void {
  const rel = path.relative(worktreeRoot, lockDir);
  linkNodeModules(path.join(cfg.repoRoot, rel), lockDir);
  const appDir = path.join(worktreeRoot, cfg.dirRel, cfg.cwd);
  if (appDir !== lockDir) linkNodeModules(path.join(cfg.repoRoot, cfg.dirRel, cfg.cwd), appDir);
}

function unlinkAll(worktreeRoot: string, cfg: ResolvedConfig, lockDir: string): void {
  for (const dir of new Set([lockDir, path.join(worktreeRoot, cfg.dirRel, cfg.cwd)])) {
    const nm = path.join(dir, 'node_modules');
    if (existsSync(nm) && lstatSync(nm).isDirectory()) rmSync(nm, { recursive: true, force: true });
  }
}

export class SideManager {
  private tmpRoot?: string;
  private readonly worktrees: string[] = [];
  readonly sides: Side[] = [];

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly opts: { outDir: string; keepWorktrees?: boolean },
  ) {}

  private tmp(): string {
    if (!this.tmpRoot) this.tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-'));
    return this.tmpRoot;
  }

  async prepare(request: SideRequest): Promise<Side> {
    const side = request.url ? this.fromUrl(request) : await this.fromWorktree(request);
    this.sides.push(side);
    return side;
  }

  private fromUrl(request: SideRequest): Side {
    const url = assertSafePreviewUrl(request.url!, `${request.name} URL`);
    const root = url.toString().replace(/\/$/, '');
    return { name: request.name, label: sanitizeUrl(root), mode: 'url', url: root };
  }

  private async fromWorktree(request: SideRequest): Promise<Side> {
    const { cfg } = this;
    if (!cfg.startCommand) {
      throw new UiDiffError('No startCommand configured, so ui-diff cannot run the app locally', {
        hint: 'Add "startCommand" (with {port}) to ui-diff.config.json, or pass --base-url/--head-url for deployed previews. `ui-diff init` can suggest one.',
      });
    }
    let sha: string;
    let includesUncommitted = false;
    if (request.workingTree) {
      sha = await snapshotWorkingTree(cfg.repoRoot);
      includesUncommitted = sha !== (await revParse('HEAD', cfg.repoRoot));
    } else {
      sha = await revParse(request.ref ?? 'HEAD', cfg.repoRoot);
    }
    const dir = path.join(this.tmp(), request.name);
    log.step(`${request.name}: checking out ${sha.slice(0, 7)} into a temporary worktree`);
    await addWorktree(cfg.repoRoot, dir, sha);
    this.worktrees.push(dir);

    if (request.workingTree) {
      for (const file of await untrackedFiles(cfg.repoRoot)) {
        const from = path.join(cfg.repoRoot, file);
        const to = path.join(dir, file);
        mkdirSync(path.dirname(to), { recursive: true });
        try {
          copyFileSync(from, to);
        } catch {
          // unreadable or vanished
        }
      }
    }
    for (const rel of cfg.copyFiles) {
      const from = path.join(cfg.dir, rel);
      const to = path.join(dir, cfg.dirRel, rel);
      if (existsSync(from) && !existsSync(to)) {
        mkdirSync(path.dirname(to), { recursive: true });
        copyFileSync(from, to);
        log.debug(`${request.name}: copied ${rel}`);
      }
    }

    const logDir = path.join(this.opts.outDir, 'logs');
    const env = { ...process.env, ...cfg.env };
    const appDir = path.join(dir, cfg.dirRel, cfg.cwd);
    const plan = planInstall(cfg, dir);
    if (plan.kind === 'link') {
      log.step(`${request.name}: reusing installed dependencies (${plan.reason})`);
      linkAll(cfg, dir, plan.dir!);
    } else if (plan.kind === 'command') {
      log.step(`${request.name}: installing dependencies (${plan.reason}): ${plan.command}`);
      await runLogged(plan.command!, { cwd: plan.dir!, env, logFile: path.join(logDir, `install-${request.name}.log`), label: `${request.name} install` });
    }
    if (cfg.buildCommand) {
      log.step(`${request.name}: building`);
      await runLogged(cfg.buildCommand, { cwd: appDir, env, logFile: path.join(logDir, `build-${request.name}.log`), label: `${request.name} build` });
    }

    const start = async (): Promise<RunningServer> => {
      const port = await getFreePort();
      const url = fillPort(cfg.baseUrl, port).replace(/\/$/, '');
      return startServer({
        label: request.name,
        command: cfg.startCommand!,
        cwd: appDir,
        port,
        url,
        readyUrl: url + (cfg.readyPath.startsWith('/') ? cfg.readyPath : `/${cfg.readyPath}`),
        env,
        logFile: path.join(logDir, `server-${request.name}.log`),
        timeoutMs: cfg.startTimeoutMs,
      });
    };
    log.step(`${request.name}: starting server`);
    let server: RunningServer;
    try {
      server = await start();
    } catch (error) {
      if (plan.kind !== 'link') throw error;
      log.warn(`${request.name}: server failed with linked dependencies, retrying with a clean install`);
      unlinkAll(dir, cfg, plan.dir!);
      const fallback = planInstall({ ...cfg, install: 'auto' }, dir);
      const lock = LOCKFILES.find((l) => existsSync(path.join(plan.dir!, l.file)));
      await runLogged(lock?.command ?? fallback.command ?? 'npm install', {
        cwd: plan.dir!,
        env,
        logFile: path.join(logDir, `install-${request.name}.log`),
        label: `${request.name} install`,
      });
      server = await start();
    }
    const short = await shortSha(sha, cfg.repoRoot);
    const display = request.workingTree ? 'working tree' : (request.displayRef ?? request.ref);
    const plain = !display || display === sha || display === short || /^[0-9a-f]{7,40}$/i.test(display);
    return {
      name: request.name,
      label: plain ? short : `${display.replace(/^origin\//, '')} @ ${short}`,
      mode: 'worktree',
      sha,
      shortSha: short,
      ref: request.ref,
      url: server.url,
      dir,
      includesUncommitted,
      server,
    };
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.sides.map((s) => s.server?.stop()));
    if (this.opts.keepWorktrees) {
      if (this.worktrees.length) log.info(`kept worktrees: ${this.worktrees.join(', ')}`);
      return;
    }
    for (const dir of this.worktrees) await removeWorktree(this.cfg.repoRoot, dir);
    if (this.tmpRoot) rmSync(this.tmpRoot, { recursive: true, force: true });
  }
}
