import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findStickyComment, upsertStickyComment, type Comment, type GhClient } from '../../src/github.js';
import { stickyMarker } from '../../src/markdown.js';

class FakeGh implements GhClient {
  comments: Comment[] = [];
  calls: string[] = [];
  private nextId = 100;
  constructor(private readonly login: string | undefined) {}
  async currentLogin() {
    return this.login;
  }
  async listComments() {
    this.calls.push('list');
    return this.comments;
  }
  async createComment(_repo: string, _pr: number, body: string) {
    this.calls.push('create');
    const comment = { id: this.nextId++, login: this.login ?? 'github-actions[bot]', body, url: 'https://github.com/x/y/pull/1#c' };
    this.comments.push(comment);
    return comment;
  }
  async updateComment(_repo: string, id: number, body: string) {
    this.calls.push(`update ${id}`);
    const comment = this.comments.find((c) => c.id === id)!;
    comment.body = body;
    return comment;
  }
}

const body = (text: string, stamp = '2026-11-18 12:00:00 UTC') => `${stickyMarker('default')}\n${text}\n<sub>generated ${stamp}</sub>\n<!-- ui-diff:meta {"createdAt":"${stamp}"} -->`;

describe('sticky PR comment', () => {
  it('creates the comment once and then edits it in place', async () => {
    const gh = new FakeGh('me');
    gh.comments.push({ id: 1, login: 'someone', body: 'LGTM' });
    const first = await upsertStickyComment(gh, { repo: 'x/y', pr: 1, body: body('v1'), existing: await findStickyComment(gh, 'x/y', 1, 'default') });
    assert.equal(first.action, 'created');
    const second = await upsertStickyComment(gh, { repo: 'x/y', pr: 1, body: body('v2'), existing: await findStickyComment(gh, 'x/y', 1, 'default') });
    assert.equal(second.action, 'updated');
    assert.equal(second.comment.id, first.comment.id);
    assert.equal(gh.comments.filter((c) => c.body.includes(stickyMarker('default'))).length, 1);
    assert.match(gh.comments.find((c) => c.id === first.comment.id)!.body, /v2/);
  });

  it('is a no-op when only the timestamp changed', async () => {
    const gh = new FakeGh('me');
    await upsertStickyComment(gh, { repo: 'x/y', pr: 1, body: body('same') });
    const again = await upsertStickyComment(gh, { repo: 'x/y', pr: 1, body: body('same', '2026-11-18 13:00:00 UTC'), existing: await findStickyComment(gh, 'x/y', 1, 'default') });
    assert.equal(again.action, 'unchanged');
    assert.ok(!gh.calls.some((c) => c.startsWith('update')));
  });

  it('prefers the comment written by the current user and ignores other ids', async () => {
    const gh = new FakeGh('me');
    gh.comments.push({ id: 1, login: 'bot', body: body('old bot') }, { id: 2, login: 'me', body: body('mine') }, { id: 3, login: 'me', body: `${stickyMarker('web')}\nother app` });
    const found = await findStickyComment(gh, 'x/y', 1, 'default');
    assert.equal(found?.id, 2);
    assert.equal((await findStickyComment(gh, 'x/y', 1, 'web'))?.id, 3);
    assert.equal(await findStickyComment(gh, 'x/y', 1, 'docs'), undefined);
  });

  it('works without a resolvable login (GitHub Actions token)', async () => {
    const gh = new FakeGh(undefined);
    gh.comments.push({ id: 7, login: 'github-actions[bot]', body: body('ci') });
    assert.equal((await findStickyComment(gh, 'x/y', 1, 'default'))?.id, 7);
  });
});
