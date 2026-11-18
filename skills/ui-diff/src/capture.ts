import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium, devices, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';
import { collectFocusOrder, runAxe, type AxeViolation, type FocusStop } from './a11y.js';
import { applyAuth, type ResolvedAuth } from './auth.js';
import type { ResolvedConfig, ResolvedRoute, ThemeConfig, ViewportConfig } from './config.js';
import { DEV_OVERLAY_SELECTORS, freezeAnimations, hideCss, initScript, pageHeight, scrollThrough, waitForFontsAndImages } from './determinism.js';
import { exec } from './exec.js';
import { log, redact, UiDiffError } from './log.js';
import type { SideName } from './sides.js';
import { runSteps } from './steps.js';
import type { StyleSnapshot } from './tokens.js';

export interface CaptureTarget {
  id: string;
  side: SideName;
  route: ResolvedRoute;
  viewport: ViewportConfig;
  theme: ThemeConfig;
  url: string;
  file: string;
  styles?: { file: string; extraColors: string[] };
  a11y?: boolean;
  focusOrder?: boolean;
}

export interface CaptureRecord {
  id: string;
  side: SideName;
  ok: boolean;
  file?: string;
  width?: number;
  height?: number;
  httpStatus?: number;
  error?: string;
  consoleErrors: string[];
  pageErrors: string[];
  truncated: boolean;
  stable: boolean;
  attempts: number;
  stylesFile?: string;
  axe?: AxeViolation[];
  focusOrder?: FocusStop[];
  durationMs: number;
}

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export function withQuery(url: string, params: Record<string, string> | undefined): string {
  if (!params || Object.keys(params).length === 0) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export function routeUrl(root: string, routePath: string, params?: Record<string, string>): string {
  return withQuery(new URL(routePath.replace(/^\/+/, ''), `${root.replace(/\/$/, '')}/`).toString(), params);
}

export function contextOptions(viewport: ViewportConfig, theme: ThemeConfig | undefined, cfg: ResolvedConfig, motion = false): BrowserContextOptions {
  const device = viewport.device ? devices[viewport.device] : undefined;
  if (viewport.device && !device) throw new UiDiffError(`Unknown Playwright device "${viewport.device}" in viewport ${viewport.name}`);
  const isMobile = viewport.isMobile ?? device?.isMobile ?? false;
  return {
    viewport: { width: viewport.width ?? device!.viewport.width, height: viewport.height ?? device!.viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor ?? device?.deviceScaleFactor ?? 1,
    isMobile,
    hasTouch: viewport.hasTouch ?? device?.hasTouch ?? false,
    userAgent: viewport.userAgent ?? device?.userAgent ?? (isMobile ? MOBILE_UA : undefined),
    colorScheme: theme?.colorScheme ?? 'light',
    reducedMotion: motion || !cfg.capture.disableAnimations ? 'no-preference' : 'reduce',
    locale: cfg.capture.locale,
    timezoneId: cfg.capture.timezoneId,
    serviceWorkers: 'block',
    bypassCSP: true,
  };
}

const require = createRequire(import.meta.url);

/** Installs Playwright's Chromium on first use unless a system browser channel is configured. */
export async function ensureBrowser(): Promise<void> {
  if (process.env.UI_DIFF_BROWSER_CHANNEL || process.env.UI_DIFF_CHROMIUM_PATH) return;
  if (existsSync(chromium.executablePath())) return;
  log.step('installing Playwright Chromium (first run only)');
  const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
  await exec(process.execPath, [cli, 'install', 'chromium'], { timeoutMs: 10 * 60 * 1000 });
}

export async function launchBrowser(): Promise<Browser> {
  await ensureBrowser();
  return chromium.launch({
    headless: true,
    channel: process.env.UI_DIFF_BROWSER_CHANNEL || undefined,
    executablePath: process.env.UI_DIFF_CHROMIUM_PATH || undefined,
    args: ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb', '--hide-scrollbars', '--disable-skia-runtime-opts'],
  });
}

export interface SessionOptions {
  cfg: ResolvedConfig;
  auth?: ResolvedAuth;
  /** Instant used when capture.fixedTime is "run-start". */
  runStart: Date;
}

export class CaptureSession {
  constructor(
    private readonly browser: Browser,
    private readonly opts: SessionOptions,
  ) {}

  async newContext(viewport: ViewportConfig, theme: ThemeConfig | undefined, extra: Partial<BrowserContextOptions> = {}, motion = false): Promise<BrowserContext> {
    const { cfg } = this.opts;
    // Motion clips always run with prefers-reduced-motion: no-preference; static captures may stay reduced.
    const context = await this.browser.newContext({ ...contextOptions(viewport, theme, cfg, motion), ...extra, ...(motion ? { reducedMotion: 'no-preference' as const } : {}) });
    const fixed = cfg.capture.fixedTime;
    if (fixed && !motion) {
      const instant = fixed === 'run-start' ? this.opts.runStart : new Date(fixed);
      if (Number.isNaN(instant.getTime())) throw new UiDiffError(`capture.fixedTime is not a valid date: ${fixed}`);
      await context.clock.setFixedTime(instant);
    }
    await context.addInitScript({ content: initScript({ stableRandom: cfg.capture.stableRandom, localStorage: theme?.localStorage }) });
    await applyAuth(context, this.opts.auth);
    context.setDefaultTimeout(cfg.capture.timeoutMs);
    return context;
  }

  /** Navigates and brings the page to a settled, deterministic state. */
  async openAndSettle(page: Page, url: string, route: ResolvedRoute, opts: { freeze: boolean; fullPage: boolean }): Promise<number | undefined> {
    const { cfg } = this.opts;
    const response = await page.goto(url, { waitUntil: cfg.capture.waitUntil, timeout: cfg.capture.timeoutMs });
    if (cfg.capture.networkIdleTimeoutMs > 0) {
      await page.waitForLoadState('networkidle', { timeout: cfg.capture.networkIdleTimeoutMs }).catch(() => undefined);
    }
    if (route.waitFor) await page.locator(route.waitFor).first().waitFor({ state: 'visible', timeout: cfg.capture.timeoutMs });
    if (opts.freeze) await freezeAnimations(page);
    if (cfg.capture.waitForFonts) await waitForFontsAndImages(page, 8000);
    if (route.actions.length) await runSteps(page, route.actions, cfg.capture.timeoutMs);
    if (opts.fullPage && cfg.capture.scrollToLoad) {
      await scrollThrough(page, cfg.capture.maxHeight);
      if (cfg.capture.waitForFonts) await waitForFontsAndImages(page, 5000);
    }
    if (opts.freeze) await freezeAnimations(page);
    if (!route.actions.some((a) => 'scroll' in a)) await page.evaluate(() => window.scrollTo(0, 0));
    if (cfg.capture.settleMs) await page.waitForTimeout(cfg.capture.settleMs);
    return response?.status();
  }

  async screenshot(page: Page, route: ResolvedRoute, fullPage: boolean): Promise<{ buffer: Buffer; stable: boolean; attempts: number; truncated: boolean }> {
    const { cfg } = this.opts;
    const masks = [...cfg.capture.mask, ...route.mask];
    const hidden = [...cfg.capture.hide, ...route.hide, ...(cfg.capture.hideDevOverlays ? DEV_OVERLAY_SELECTORS : [])];
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    let truncated = false;
    let clip: { x: number; y: number; width: number; height: number } | undefined;
    if (fullPage) {
      const height = await pageHeight(page);
      if (height > cfg.capture.maxHeight) {
        truncated = true;
        clip = { x: 0, y: 0, width: viewport.width, height: cfg.capture.maxHeight };
      }
    }
    const shoot = () =>
      page.screenshot({
        fullPage,
        clip,
        animations: cfg.capture.disableAnimations ? 'disabled' : 'allow',
        caret: 'hide',
        scale: 'device',
        mask: masks.map((s) => page.locator(s)),
        maskColor: cfg.capture.maskColor,
        style: hideCss(hidden),
        timeout: cfg.capture.timeoutMs,
      });
    const wanted = cfg.capture.stableShots;
    let previous = await shoot();
    let attempts = 1;
    let streak = 1;
    while (streak < wanted && attempts < wanted + 3) {
      await page.waitForTimeout(120 * attempts);
      const next = await shoot();
      attempts++;
      streak = next.equals(previous) ? streak + 1 : 1;
      previous = next;
    }
    return { buffer: previous, stable: streak >= wanted, attempts, truncated };
  }

  async capture(target: CaptureTarget): Promise<CaptureRecord> {
    const { cfg } = this.opts;
    const started = Date.now();
    const record: CaptureRecord = { id: target.id, side: target.side, ok: false, consoleErrors: [], pageErrors: [], truncated: false, stable: false, attempts: 0, durationMs: 0 };
    const fullPage = target.route.fullPage ?? cfg.capture.fullPage;
    let context: BrowserContext | undefined;
    try {
      context = await this.newContext(target.viewport, target.theme);
      const page = await context.newPage();
      page.on('console', (msg) => {
        if (msg.type() === 'error' && record.consoleErrors.length < 10) record.consoleErrors.push(redact(msg.text()).slice(0, 300));
      });
      page.on('pageerror', (error) => {
        if (record.pageErrors.length < 10) record.pageErrors.push(redact(error.message).slice(0, 300));
      });
      record.httpStatus = await this.openAndSettle(page, target.url, target.route, { freeze: cfg.capture.disableAnimations, fullPage });
      const shot = await this.screenshot(page, target.route, fullPage);
      mkdirSync(path.dirname(target.file), { recursive: true });
      writeFileSync(target.file, shot.buffer);
      Object.assign(record, { file: target.file, stable: shot.stable, attempts: shot.attempts, truncated: shot.truncated });
      if (target.styles) {
        const snapshot = await page.evaluate(
          ({ max, ignore, extra }) => {
            const helpers = (window as unknown as { __uiDiff: { snapshotStyles(m: number, i: string[]): unknown[]; normalizeColors(l: string[]): Record<string, unknown> } }).__uiDiff;
            const elements = helpers.snapshotStyles(max, ignore) as Array<{ styles: { color: string; backgroundColor: string; borderColor: string[] } }>;
            const colors = new Set<string>(extra);
            for (const el of elements) {
              colors.add(el.styles.color);
              colors.add(el.styles.backgroundColor);
              for (const c of el.styles.borderColor) colors.add(c);
            }
            return { elements, colors: helpers.normalizeColors([...colors]) };
          },
          { max: cfg.tokens.maxElements, ignore: cfg.tokens.ignoreSelectors, extra: target.styles.extraColors },
        );
        mkdirSync(path.dirname(target.styles.file), { recursive: true });
        writeFileSync(target.styles.file, JSON.stringify(snapshot as StyleSnapshot));
        record.stylesFile = target.styles.file;
      }
      if (target.a11y) record.axe = await runAxe(page, { tags: cfg.a11y.tags, rules: cfg.a11y.rules });
      if (target.focusOrder) record.focusOrder = await collectFocusOrder(page, cfg.a11y.maxTabStops);
      record.ok = true;
    } catch (error) {
      record.error = redact((error as Error).message.split('\n')[0]);
    } finally {
      await context?.close().catch(() => undefined);
      record.durationMs = Date.now() - started;
    }
    return record;
  }
}
