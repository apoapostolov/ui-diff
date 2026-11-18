import path from 'node:path';

/**
 * A small, best-effort import graph: finds which entry files (pages, configured route files)
 * transitively import a changed file. Handles relative imports, aliases (incl. tsconfig `paths`),
 * workspace packages, CSS @import/url(), HTML href/src and plain asset mentions.
 */

export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro', '.mdx', '.css', '.scss', '.sass', '.less', '.html', '.htm'];
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro', '.mdx', '.css', '.scss', '.sass', '.less', '.json'];
const ASSET_RE = /\.(?:svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf)$/i;

export function isSourceFile(file: string): boolean {
  return SOURCE_EXTENSIONS.includes(path.posix.extname(file).toLowerCase());
}

export function isAssetFile(file: string): boolean {
  return ASSET_RE.test(file);
}

export function extractSpecifiers(source: string, file: string): string[] {
  const specs = new Set<string>();
  const add = (s: string | undefined) => {
    if (s && !/^(?:https?:|data:|mailto:|#)/.test(s)) specs.add(s.split(/[?#]/)[0]);
  };
  const ext = path.posix.extname(file).toLowerCase();
  const patterns: RegExp[] = [];
  if (['.css', '.scss', '.sass', '.less'].includes(ext)) {
    patterns.push(/@(?:import|use|forward)\s+(?:url\(\s*)?['"]?([^'")\s;]+)['"]?/g, /url\(\s*['"]?([^'")]+)['"]?\s*\)/g);
  } else if (ext === '.html' || ext === '.htm') {
    patterns.push(/\b(?:href|src)\s*=\s*["']([^"']+)["']/g);
  } else {
    patterns.push(
      /\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]/g,
      /\bexport\s+(?:type\s+)?[\w*{}\s,$]+?\s+from\s+['"]([^'"]+)['"]/g,
      /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
      /@(?:import|use)\s+['"]([^'"]+)['"]/g,
      /\b(?:href|src)\s*=\s*["']([^"'{}]+)["']/g,
    );
  }
  for (const re of patterns) {
    for (const match of source.matchAll(re)) add(match[1]);
  }
  return [...specs];
}

export interface ResolveContext {
  files: Set<string>;
  /** Alias prefix (e.g. "@/") → repo-relative directory (e.g. "apps/web/src/"). */
  aliases: Record<string, string>;
  /** Workspace package name → repo-relative directory. */
  packages: Record<string, string>;
  /** Repo-relative directories that serve as web roots for absolute URLs like "/styles.css". */
  webRoots: string[];
}

function tryCandidates(base: string, files: Set<string>): string | undefined {
  const normalized = path.posix.normalize(base).replace(/^\.\//, '');
  if (normalized.startsWith('..')) return undefined;
  if (files.has(normalized)) return normalized;
  const ext = path.posix.extname(normalized);
  if (ext === '.js' || ext === '.mjs' || ext === '.jsx') {
    const stem = normalized.slice(0, -ext.length);
    for (const alt of ['.ts', '.tsx', '.mts']) if (files.has(stem + alt)) return stem + alt;
  }
  for (const e of RESOLVE_EXTENSIONS) if (files.has(normalized + e)) return normalized + e;
  for (const e of RESOLVE_EXTENSIONS) if (files.has(`${normalized}/index${e}`)) return `${normalized}/index${e}`;
  const dir = path.posix.dirname(normalized);
  const partial = `${dir === '.' ? '' : `${dir}/`}_${path.posix.basename(normalized)}`;
  for (const e of ['.scss', '.sass']) if (files.has(partial + e)) return partial + e;
  return undefined;
}

export function resolveSpecifier(spec: string, fromFile: string, ctx: ResolveContext): string | undefined {
  const fromExt = path.posix.extname(fromFile).toLowerCase();
  const urlRelative = ['.html', '.htm', '.css', '.scss', '.sass', '.less'].includes(fromExt);
  const looksRelative =
    spec.startsWith('./') || spec.startsWith('../') || (urlRelative && !spec.startsWith('/') && !spec.startsWith('~') && !/^[a-z][a-z0-9+.-]*:/i.test(spec));
  if (looksRelative) {
    const hit = tryCandidates(path.posix.join(path.posix.dirname(fromFile), spec), ctx.files);
    if (hit || spec.startsWith('.')) return hit;
  }
  if (spec.startsWith('/')) {
    for (const root of ctx.webRoots) {
      const hit = tryCandidates(path.posix.join(root, spec.slice(1)), ctx.files);
      if (hit) return hit;
    }
    return undefined;
  }
  const aliasKeys = Object.keys(ctx.aliases).sort((a, b) => b.length - a.length);
  for (const key of aliasKeys) {
    if (spec === key.replace(/\/$/, '') || spec.startsWith(key)) {
      const rest = spec === key.replace(/\/$/, '') ? '' : spec.slice(key.length);
      const hit = tryCandidates(path.posix.join(ctx.aliases[key], rest), ctx.files);
      if (hit) return hit;
    }
  }
  const pkgNames = Object.keys(ctx.packages).sort((a, b) => b.length - a.length);
  for (const name of pkgNames) {
    if (spec === name || spec.startsWith(`${name}/`)) {
      const dir = ctx.packages[name];
      const rest = spec === name ? '' : spec.slice(name.length + 1);
      const candidates = rest ? [path.posix.join(dir, rest), path.posix.join(dir, 'src', rest)] : [path.posix.join(dir, 'src/index'), path.posix.join(dir, 'index')];
      for (const c of candidates) {
        const hit = tryCandidates(c, ctx.files);
        if (hit) return hit;
      }
    }
  }
  return undefined;
}

export function buildReverseGraph(contents: Map<string, string>, ctx: ResolveContext): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>();
  for (const [file, source] of contents) {
    for (const spec of extractSpecifiers(source, file)) {
      const target = resolveSpecifier(spec, file, ctx);
      if (!target || target === file) continue;
      let importers = reverse.get(target);
      if (!importers) reverse.set(target, (importers = new Set()));
      importers.add(file);
    }
  }
  return reverse;
}

/** Adds edges for assets that are referenced by basename (e.g. `logo.svg` in a JSX string). */
export function addAssetMentions(reverse: Map<string, Set<string>>, contents: Map<string, string>, assets: string[]): void {
  for (const asset of assets) {
    const base = path.posix.basename(asset);
    if (base.length < 5) continue;
    for (const [file, source] of contents) {
      if (source.includes(base)) {
        let importers = reverse.get(asset);
        if (!importers) reverse.set(asset, (importers = new Set()));
        importers.add(file);
      }
    }
  }
}

/** Walks importers from `start` until entry files are reached. Returns entry → import chain. */
export function findEntries(
  start: string,
  reverse: Map<string, Set<string>>,
  isEntry: (file: string) => boolean,
  maxDepth = 12,
): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const queue: Array<{ file: string; chain: string[] }> = [{ file: start, chain: [start] }];
  const seen = new Set<string>([start]);
  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    if (chain.length > maxDepth) continue;
    for (const importer of reverse.get(file) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      const next = [...chain, importer];
      if (isEntry(importer)) found.set(importer, next);
      queue.push({ file: importer, chain: next });
    }
  }
  return found;
}

function stripJsonComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1');
}

/** Turns tsconfig/jsconfig `paths` into alias prefixes. Only `prefix/*` and exact patterns are supported. */
export function aliasesFromTsconfig(text: string, configDirRel: string): Record<string, string> {
  const aliases: Record<string, string> = {};
  let parsed: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch {
    return aliases;
  }
  const baseUrl = parsed.compilerOptions?.baseUrl ?? '.';
  const base = path.posix.normalize(path.posix.join(configDirRel || '.', baseUrl));
  for (const [key, targets] of Object.entries(parsed.compilerOptions?.paths ?? {})) {
    const target = targets?.[0];
    if (!target) continue;
    const from = key.replace(/\*$/, '');
    const to = path.posix.normalize(path.posix.join(base, target.replace(/\*$/, '')));
    aliases[from] = key.endsWith('*') ? `${to.replace(/\/$/, '')}/` : to;
  }
  return aliases;
}
