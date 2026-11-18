import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  aggregateFindings,
  auditSnapshot,
  buildTokenSet,
  categoryFor,
  colorDistance,
  findingKeys,
  parseCssColor,
  parseCssTokens,
  parseJsonTokens,
  toHex,
  toPx,
  type StyledElement,
  type StyleSnapshot,
} from '../../src/tokens.js';

function element(selector: string, styles: Partial<StyledElement['styles']>, extra: Partial<StyledElement> = {}): StyledElement {
  return {
    selector,
    box: { x: 0, y: 0, width: 100, height: 20 },
    text: true,
    styles: {
      color: 'rgb(15, 23, 42)',
      backgroundColor: 'rgba(0, 0, 0, 0)',
      borderColor: [],
      margin: ['0px', '0px', '0px', '0px'],
      padding: ['0px', '0px', '0px', '0px'],
      gap: ['normal', 'normal'],
      radius: ['0px', '0px', '0px', '0px'],
      fontSize: '16px',
      fontWeight: '400',
      fontFamily: 'Inter, sans-serif',
      lineHeight: 'normal',
      ...styles,
    },
    ...extra,
  };
}

const TOKENS = buildTokenSet(
  parseJsonTokens(
    {
      color: { $type: 'color', text: { $value: '#0f172a' }, brand: { $value: '#7c3aed' }, alias: { $value: '{color.brand}' } },
      space: { $type: 'dimension', 2: { $value: '8px' }, 4: { $value: '1rem' } },
      radius: { md: { $value: '8px' }, full: { $value: '9999px' } },
      font: {
        family: { sans: { $type: 'fontFamily', $value: ['Inter', 'sans-serif'] } },
        size: { $type: 'dimension', md: { $value: '16px' } },
        weight: { $type: 'fontWeight', regular: { $value: 400 }, bold: { $value: 'bold' } },
      },
    },
    'tokens.json',
  ),
);

const AUDIT = { properties: ['color', 'background-color', 'border-color', 'spacing', 'radius', 'font-size', 'font-weight', 'font-family'] as const, colorTolerance: 2, pxTolerance: 0.5, allow: [] };

describe('token parsing', () => {
  it('flattens W3C, Style Dictionary and plain token files', () => {
    const w3c = parseJsonTokens({ color: { primary: { $value: '#fff', $type: 'color' } } }, 'a');
    assert.deepEqual(w3c, [{ name: 'color.primary', value: '#fff', type: 'color', source: 'a' }]);
    const sd = parseJsonTokens({ size: { padding: { small: { value: '4px', type: 'dimension' } } } }, 'b');
    assert.equal(sd[0].name, 'size.padding.small');
    assert.equal(sd[0].value, '4px');
    const tw = parseJsonTokens({ fontFamily: { sans: ['Inter', 'system-ui'] }, fontSize: { lg: ['1.125rem', { lineHeight: '1.75rem' }] } }, 'c');
    assert.deepEqual(
      tw.map((t) => [t.name, t.value]),
      [
        ['fontFamily.sans', 'Inter, system-ui'],
        ['fontSize.lg', '1.125rem'],
      ],
    );
    const typography = parseJsonTokens({ heading: { $type: 'typography', $value: { fontFamily: 'Inter', fontSize: '32px', fontWeight: 700 } } }, 'd');
    assert.deepEqual(
      typography.map((t) => t.name),
      ['heading.fontFamily', 'heading.fontSize', 'heading.fontWeight'],
    );
  });

  it('reads CSS custom properties and resolves var() references', () => {
    const raw = parseCssTokens(':root { --blue: #2563eb; /* note */ --brand: var(--blue); --space-4: 1rem; }\n[data-theme=dark] { --bg: var(--missing, #000) }', 'tokens.css');
    const set = buildTokenSet(raw);
    const brand = set.values.find((v) => v.name === '--brand');
    assert.deepEqual(brand?.rgba, [37, 99, 235, 1]);
    assert.equal(set.values.find((v) => v.name === '--space-4')?.px, 16);
    assert.deepEqual(set.values.find((v) => v.name === '--bg')?.rgba, [0, 0, 0, 1]);
  });

  it('classifies tokens by type, name and value', () => {
    assert.equal(categoryFor('font.size.sm', '14px', 'dimension'), 'fontSize');
    assert.equal(categoryFor('--text-lg', '1.125rem'), 'fontSize');
    assert.equal(categoryFor('--font-sans', 'Inter, sans-serif'), 'fontFamily');
    assert.equal(categoryFor('font.weight.bold', '700'), 'fontWeight');
    assert.equal(categoryFor('--radius-md', '8px'), 'radius');
    assert.equal(categoryFor('space.4', '16px', 'dimension'), 'spacing');
    assert.equal(categoryFor('--shadow-md', '0 1px 2px #000'), undefined);
    assert.equal(categoryFor('--leading-tight', '1.25'), 'lineHeight');
    assert.equal(categoryFor('anything', 'oklch(0.6 0.2 260)'), 'color');
  });

  it('parses colors and dimensions', () => {
    assert.deepEqual(parseCssColor('#abc'), [170, 187, 204, 1]);
    assert.deepEqual(parseCssColor('#11223380'), [17, 34, 51, 0.5]);
    assert.deepEqual(parseCssColor('rgb(1 2 3 / 50%)'), [1, 2, 3, 0.5]);
    assert.deepEqual(parseCssColor('hsl(0, 100%, 50%)'), [255, 0, 0, 1]);
    assert.equal(parseCssColor('color-mix(in srgb, red, blue)'), undefined);
    assert.equal(toPx('1.5rem'), 24);
    assert.equal(toPx('auto'), undefined);
    assert.equal(toHex([255, 90, 31, 1]), '#ff5a1f');
    assert.ok(colorDistance([124, 58, 237, 1], [139, 92, 246, 1]) < colorDistance([124, 58, 237, 1], [255, 90, 31, 1]));
  });
});

describe('token audit', () => {
  it('flags off-token values with the nearest token', () => {
    const snapshot: StyleSnapshot = {
      colors: {},
      elements: [
        element('.ok', { color: 'rgb(15, 23, 42)', padding: ['8px', '16px', '8px', '16px'], radius: ['8px', '8px', '8px', '8px'] }),
        element('.badge', { backgroundColor: 'rgb(255, 90, 31)', padding: ['3px', '9px', '3px', '9px'], fontSize: '13px', fontWeight: '600', fontFamily: 'Georgia, serif' }),
        element('.pill', { radius: ['9999px', '9999px', '9999px', '9999px'], color: 'rgb(124, 58, 236)' }),
      ],
    };
    const findings = auditSnapshot(snapshot, TOKENS, { ...AUDIT, properties: [...AUDIT.properties] });
    const summary = findings.map((f) => `${f.selector} ${f.property} ${f.value}`);
    assert.deepEqual(summary.sort(), [
      '.badge background-color #ff5a1f',
      '.badge font-family georgia',
      '.badge font-size 13px',
      '.badge font-weight 600',
      '.badge spacing 3px',
      '.badge spacing 9px',
    ]);
    assert.equal(findings.find((f) => f.value === '9px')?.nearest, 'space.2 (8px)');
    assert.equal(findings.find((f) => f.value === '#ff5a1f')?.nearest, undefined);
  });

  it('skips auto-centering margins, transparent colors and elements outside changed regions', () => {
    const snapshot: StyleSnapshot = {
      colors: { 'oklch(0.5 0.2 300)': [124, 58, 237, 1] },
      elements: [
        element('.container', { margin: ['0px', '120px', '0px', '120px'] }, { autoMarginX: true }),
        element('.far', { padding: ['5px', '5px', '5px', '5px'] }, { box: { x: 0, y: 900, width: 50, height: 50 } }),
        element('.violet', { color: 'oklch(0.5 0.2 300)' }),
      ],
    };
    assert.deepEqual(auditSnapshot(snapshot, TOKENS, { ...AUDIT, properties: [...AUDIT.properties], regions: [{ x: 0, y: 0, width: 500, height: 300 }] }), []);
    assert.equal(auditSnapshot(snapshot, TOKENS, { ...AUDIT, properties: [...AUDIT.properties] }).length, 1);
  });

  it('honours allow-listed values and spacing units', () => {
    const snapshot: StyleSnapshot = { colors: {}, elements: [element('.a', { padding: ['1px', '12px', '1px', '12px'] })] };
    const unit = buildTokenSet([{ name: '--spacing', value: '4px', source: 'x' }]);
    const findings = auditSnapshot(snapshot, unit, { ...AUDIT, properties: ['spacing'], allow: ['1px'] });
    assert.deepEqual(findings, []);
  });

  it('aggregates findings and marks values that base did not use', () => {
    const base = [{ property: 'spacing' as const, value: '14px', selector: '.cta' }];
    const head = [
      { property: 'spacing' as const, value: '14px', selector: '.cta' },
      { property: 'spacing' as const, value: '9px', selector: '.badge' },
      { property: 'spacing' as const, value: '9px', selector: '.chip' },
    ];
    const rows = aggregateFindings([
      { capture: '/ desktop', findings: head, baseValues: findingKeys(base) },
      { capture: '/ mobile', findings: [head[1]], baseValues: findingKeys(base) },
    ]);
    assert.deepEqual(
      rows.map((r) => [r.value, r.isNew, r.count, r.captures.length]),
      [
        ['9px', true, 2, 2],
        ['14px', false, 1, 1],
      ],
    );
  });
});
