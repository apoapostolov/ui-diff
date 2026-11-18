import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig } from '../../src/config.js';
import { renderComment } from '../../src/markdown.js';
import { autoSummary } from '../../src/report.js';
import { auditSnapshot, buildTokenSet, categoryFor, hasCategory, mappedCategory, parseCssTokens, type StyleSnapshot } from '../../src/tokens.js';
import { sampleReport } from './fixtures.js';

// The tokens file of the QA static site: short names that the old rules did not recognise.
const SHORT_TOKENS = `:root { --c-accent: #0f766e; --c-text: #1f2937; --c-bg: #ffffff;
  --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-6: 24px; --s-8: 32px; --s-12: 48px; --s-16: 64px; --r-2: 8px; --r-full: 9999px;
  --fs-sm: 14px; --fs-md: 16px; --fs-lg: 18px; --fs-2xl: 24px; --fs-5xl: 48px; --fw-bold: 700; --ff-serif: Georgia, serif; --lh-tight: 1.2; }`;

describe('abbreviated token names', () => {
  it('classifies common short prefixes', () => {
    assert.equal(categoryFor('--fs-sm', '14px'), 'fontSize');
    assert.equal(categoryFor('--fw-bold', '700'), 'fontWeight');
    assert.equal(categoryFor('--ff-serif', 'Georgia, serif'), 'fontFamily');
    assert.equal(categoryFor('--lh-tight', '1.2'), 'lineHeight');
    assert.equal(categoryFor('--r-2', '8px'), 'radius');
    assert.equal(categoryFor('--s-4', '16px'), 'spacing');
    assert.equal(categoryFor('sp.4', '16px'), 'spacing');
    assert.equal(categoryFor('--c-accent', '#0f766e'), 'color');
    assert.equal(categoryFor('--icon-s', '16px'), undefined);
  });

  it('lets tokens.categories map names explicitly', () => {
    const categories = { spacing: ['--gx-*'], radius: ['corner.*'], 'font-size': ['type.*'] };
    assert.equal(mappedCategory('--gx-3', categories), 'spacing');
    assert.equal(mappedCategory('corner.md', categories), 'radius');
    assert.equal(mappedCategory('type.body', categories), 'fontSize');
    assert.equal(mappedCategory('--other', categories), undefined);
    const set = buildTokenSet(parseCssTokens(':root { --gx-3: 12px; --odd: 7px }', 't.css'), 16, { spacing: ['--gx-*', '--odd'] });
    assert.deepEqual(
      set.values.map((v) => [v.name, v.category, v.px]),
      [
        ['--gx-3', 'spacing', 12],
        ['--odd', 'spacing', 7],
      ],
    );
  });

  it('audits spacing and type for the QA site, flagging the off-scale 120px hero padding', () => {
    const tokens = buildTokenSet(parseCssTokens(SHORT_TOKENS, 'tokens.css'));
    for (const category of ['color', 'spacing', 'radius', 'fontSize', 'fontWeight', 'fontFamily'] as const) assert.ok(hasCategory(tokens, category), category);
    const snapshot: StyleSnapshot = {
      colors: {},
      elements: [
        {
          selector: 'section.hero',
          box: { x: 0, y: 0, width: 900, height: 300 },
          text: false,
          styles: { color: 'rgb(31, 41, 55)', backgroundColor: 'rgba(0, 0, 0, 0)', borderColor: [], margin: ['0px', '0px', '0px', '0px'], padding: ['120px', '0px', '64px', '0px'], gap: ['normal', 'normal'], radius: ['0px', '0px', '0px', '0px'], fontSize: '16px', fontWeight: '400', fontFamily: 'Georgia, serif', lineHeight: 'normal' },
        },
      ],
    };
    const findings = auditSnapshot(snapshot, tokens, { properties: ['spacing', 'font-size'], colorTolerance: 2, pxTolerance: 0.5, allow: [] });
    assert.deepEqual(
      findings.map((f) => `${f.property} ${f.value}`),
      ['spacing 120px'],
    );
  });

  it('validates tokens.categories keys', () => {
    assert.deepEqual(parseConfig({ tokens: { categories: { spacing: ['--s-*'] } } }, { repoRoot: '/repo' }).tokens.categories, { spacing: ['--s-*'] });
    assert.throws(() => parseConfig({ tokens: { categories: { margins: ['--m-*'] } } }, { repoRoot: '/repo' }), /Invalid configuration/);
  });
});

describe('categories that were not audited', () => {
  it('are stated in the summary and the comment', () => {
    const report = sampleReport();
    report.tokens!.skipped = ['spacing', 'font-size'];
    report.tokens!.findings = [];
    assert.match(autoSummary(report), /no new off-token values in the changed areas\. Not audited \(no tokens of that kind recognized\): spacing, font-size\./);
    const body = renderComment(report, { id: 'default', title: 'UI diff', link: (p) => p });
    assert.match(body, /\*\*Not audited:\*\* spacing, font-size: no tokens of that kind were recognized in `tokens\.json`/);
  });
});
