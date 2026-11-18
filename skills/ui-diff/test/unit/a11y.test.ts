import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { categorize, diffFocusOrder, diffViolations, orderJumps, type AxeViolation, type FocusStop } from '../../src/a11y.js';

function violation(id: string, nodes: Array<[string, string]>): AxeViolation {
  return { id, impact: 'serious', help: id, helpUrl: `https://x/${id}`, tags: [], nodes: nodes.map(([target, html]) => ({ target, html, summary: '' })) };
}

function stop(name: string, role: string, x: number, y: number, selector = `${role}.${name.replace(/\W/g, '')}`): FocusStop {
  return { name, role, selector, box: { x, y, width: 80, height: 24 } };
}

describe('axe delta', () => {
  it('reports only new and fixed issues', () => {
    const base = [violation('image-alt', [['img.hero', '<img class="hero">']]), violation('color-contrast', [['.muted', '<p class="muted">']])];
    const head = [violation('color-contrast', [['.muted', '<p class="muted">'], ['.badge', '<span class="badge">']]), violation('label', [['#email', '<input id="email">']])];
    const delta = diffViolations(base, head);
    assert.deepEqual(delta.added.map((i) => `${i.rule} ${i.target}`).sort(), ['color-contrast .badge', 'label #email']);
    assert.deepEqual(delta.fixed.map((i) => `${i.rule} ${i.target}`), ['image-alt img.hero']);
    assert.equal(delta.added.find((i) => i.rule === 'label')?.category, 'labels');
  });

  it('matches nodes by HTML when selectors shift', () => {
    const base = [violation('color-contrast', [['div:nth-child(2) > p', '<p class="note">Hi</p>']])];
    const head = [violation('color-contrast', [['div:nth-child(3) > p', '<p class="note">Hi</p>']])];
    assert.deepEqual(diffViolations(base, head), { added: [], fixed: [] });
  });

  it('categorizes rules', () => {
    assert.equal(categorize('color-contrast'), 'contrast');
    assert.equal(categorize('button-name'), 'labels');
    assert.equal(categorize('tabindex'), 'focus');
    assert.equal(categorize('region'), 'other');
  });
});

describe('focus order delta', () => {
  const logo = stop('Acme', 'link', 20, 20);
  const nav = stop('Pricing', 'link', 600, 20);
  const cta = stop('Start', 'link', 20, 300);
  const email = stop('Work email', 'textbox', 20, 900, '#email');

  it('detects nothing when the sequence is unchanged', () => {
    const delta = diffFocusOrder([logo, nav, cta], [logo, nav, cta]);
    assert.equal(delta.changed, false);
  });

  it('finds added stops, reordering, renamed controls and reading-order jumps', () => {
    const renamedEmail = { ...email, name: 'you@company.com' };
    const tab = stop('Yearly', 'tab', 300, 600);
    const delta = diffFocusOrder([logo, nav, cta, email], [renamedEmail, logo, nav, cta, tab]);
    assert.equal(delta.changed, true);
    assert.equal(delta.reordered, true);
    assert.deepEqual(delta.added, ['tab "Yearly"']);
    assert.deepEqual(delta.removed, []);
    assert.deepEqual(delta.renamed, ['textbox "Work email" → "you@company.com"']);
    assert.deepEqual(delta.newOrderJumps, ['textbox "you@company.com" → link "Acme"']);
  });

  it('treats a left jump on the same line as against reading order', () => {
    assert.deepEqual(orderJumps([nav, logo]), ['link "Pricing" → link "Acme"']);
    assert.deepEqual(orderJumps([logo, nav, cta]), []);
  });
});
