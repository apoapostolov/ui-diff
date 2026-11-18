import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { isStylexTokenSource, parseStylexTokens } from '../../src/stylex.js';
import { auditSnapshot, buildTokenSet, detectTokenFiles, loadTokenFiles, type StyleSnapshot } from '../../src/tokens.js';

const TOKENS = `import * as stylex from '@stylexjs/stylex';

// Brand colours
const DARK = '@media (prefers-color-scheme: dark)';

export const colors = stylex.defineVars({
  accent: '#2563eb',
  'accent-hover': "#1d4ed8",
  surface: { default: '#ffffff', [DARK]: '#0b0f19' },
  ink: { default: 'rgb(17, 24, 39)', '@media (prefers-color-scheme: dark)': '#f9fafb' },
  muted: \`#6b7280\`,
  /* computed values are skipped, never executed */
  computed: someFunction('#000'),
  templated: \`\${base}px\`,
});

export const spacing = stylex.defineVars({
  xs: '4px',
  sm: '8px',
  md: 16,
  lg: '1.5rem',
});

const radiiValues = { sm: '4px', full: '9999px' } as const;
export const radii = stylex.defineVars(radiiValues);

export const fonts = defineConsts({ fontFamilyBody: 'Inter, system-ui, sans-serif', fontWeightMedium: 500 });

export const highContrast = stylex.createTheme(colors, { accent: '#1e40af', surface: '#000000' });
`;

describe('StyleX tokens', () => {
  it('reads defineVars/defineConsts/createTheme literals statically', () => {
    const tokens = parseStylexTokens(TOKENS, 'tokens.stylex.ts');
    const byName = Object.fromEntries(tokens.map((t) => [t.name, t.value]));
    assert.equal(byName['colors.accent'], '#2563eb');
    assert.equal(byName['colors.accent-hover'], '#1d4ed8');
    assert.equal(byName['colors.surface'], '#ffffff');
    assert.equal(byName['colors.ink'], 'rgb(17, 24, 39)');
    assert.equal(byName['colors.ink[@media (prefers-color-scheme: dark)]'], '#f9fafb');
    assert.equal(byName['colors.muted'], '#6b7280');
    assert.equal(byName['spacing.md'], '16');
    assert.equal(byName['spacing.lg'], '1.5rem');
    assert.equal(byName['radii.full'], '9999px');
    assert.equal(byName['fonts.fontWeightMedium'], '500');
    assert.equal(byName['highContrast.accent'], '#1e40af');
    assert.ok(!('colors.computed' in byName));
    assert.ok(!('colors.templated' in byName));
    // computed keys resolve through top-level string constants
    assert.equal(byName['colors.surface[@media (prefers-color-scheme: dark)]'], '#0b0f19');
  });

  it('builds a token set that audits like JSON tokens', () => {
    const set = buildTokenSet(parseStylexTokens(TOKENS, 'tokens.stylex.ts'));
    const cats = (category: string) => set.values.filter((v) => v.category === category).map((v) => v.px ?? v.raw);
    assert.deepEqual(cats('spacing').sort(), [16, 24, 4, 8].sort());
    assert.deepEqual(cats('radius').sort(), [4, 9999].sort());
    assert.ok(set.values.some((v) => v.category === 'color' && v.raw === '#2563eb'));
    assert.ok(set.values.some((v) => v.category === 'fontFamily' && v.family === 'inter'));
    assert.ok(set.values.some((v) => v.category === 'fontWeight' && v.weight === 500));

    const snapshot: StyleSnapshot = {
      elements: [
        {
          selector: 'a.cta',
          box: { x: 0, y: 0, width: 100, height: 20 },
          text: true,
          styles: { color: '#2563eb', backgroundColor: '#ff5a1f', borderColor: [], margin: ['0px', '0px', '0px', '0px'], padding: ['8px', '7px', '8px', '7px'], gap: ['normal', 'normal'], radius: ['4px', '4px', '4px', '4px'], fontSize: '16px', fontWeight: '500', fontFamily: 'Inter, sans-serif', lineHeight: 'normal' },
        },
      ],
      colors: { '#2563eb': [37, 99, 235, 1], '#ff5a1f': [255, 90, 31, 1] },
    };
    const findings = auditSnapshot(snapshot, set, { properties: ['color', 'background-color', 'spacing', 'radius'], colorTolerance: 2, pxTolerance: 0.5, allow: [] });
    const values = findings.map((f) => `${f.property} ${f.value}`);
    assert.ok(values.includes('background-color #ff5a1f'), values.join());
    assert.ok(values.includes('spacing 7px'), values.join());
    assert.ok(!values.some((v) => v.startsWith('color ')), values.join());
    assert.ok(!values.some((v) => v.startsWith('radius')), values.join());
  });

  it('loads *.stylex.ts through loadTokenFiles and auto-detects token files', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-diff-stylex-'));
    try {
      mkdirSync(path.join(dir, 'src/theme'), { recursive: true });
      mkdirSync(path.join(dir, 'src/components'), { recursive: true });
      mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
      writeFileSync(path.join(dir, 'src/theme/tokens.stylex.ts'), TOKENS);
      writeFileSync(path.join(dir, 'src/components/button.stylex.ts'), "import * as stylex from '@stylexjs/stylex';\nexport const styles = stylex.create({ base: { color: 'red' } });\n");
      writeFileSync(path.join(dir, 'src/theme/tokens.json'), '{"color":{"brand":{"$value":"#2563eb"}}}');
      writeFileSync(path.join(dir, 'node_modules/pkg/tokens.json'), '{}');
      const files = ['src/theme/tokens.stylex.ts', 'src/components/button.stylex.ts', 'src/theme/tokens.json', 'node_modules/pkg/tokens.json', 'src/app.tsx'];
      assert.deepEqual(detectTokenFiles(dir, files), ['src/theme/tokens.stylex.ts', 'src/theme/tokens.json']);
      const raw = loadTokenFiles([path.join(dir, 'src/theme/tokens.stylex.ts')]);
      assert.ok(raw.some((t) => t.name === 'colors.accent'));
      assert.throws(() => loadTokenFiles([path.join(dir, 'src/components/button.stylex.ts')]), /No StyleX tokens/);
      assert.equal(isStylexTokenSource(TOKENS), true);
      assert.equal(isStylexTokenSource('stylex.create({})'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
