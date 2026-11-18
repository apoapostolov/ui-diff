# Examples

## `sample-site/`

A tiny static landing page used to verify ui-diff end to end inside this repository. It is
committed twice:

| Commit | Side | What it contains |
|---|---|---|
| `0e9c856` | base | Blue CTA, two pricing cards, labelled newsletter field, chart image without alt text |
| `2ff383f` | head | Violet pill CTA with hover lift, Monthly/Yearly toggle, highlighted Pro plan with an off-token badge, `?hero=1..4` variants, alt text added, newsletter label removed and `tabindex="1"` |

`serve.mjs` is a zero-dependency static server (`node serve.mjs --port 4173`). With
`SAMPLE_PREVIEW_TOKEN` set it requires an `x-preview-token` header or `preview_token` cookie,
which is how the protected-preview path was tested. `ui-diff.config.json` enables every extra:
dark theme via `?theme=dark`, variants, a motion script, the token audit against `tokens.json`
(W3C format; `tokens.css` holds the same tokens as CSS variables) and the accessibility delta.
The footer shows a frozen clock, a seeded random tip and a masked live counter.

Reproduce from the repository root (if the branch was squash-merged, fetch the original commits
first with `git fetch origin pull/1/head`):

```bash
SKILL=skills/ui-diff
CFG=examples/sample-site/ui-diff.config.json

node $SKILL/bin/ui-diff.mjs detect --config $CFG --base 0e9c856 --head 2ff383f
node $SKILL/bin/ui-diff.mjs run    --config $CFG --base 0e9c856 --head 2ff383f
# write .ui-diff/summary.md (docs/example/comment.md shows the one used here), then:
node $SKILL/bin/ui-diff.mjs render --config $CFG --output docs/example/comment.md --copy-images
node $SKILL/bin/ui-diff.mjs publish --config $CFG --pr 1 --dry-run     # nothing is pushed or posted

# determinism check: the same commit on both sides → every capture unchanged
node $SKILL/bin/ui-diff.mjs run --config $CFG --base 2ff383f --head 2ff383f --all-routes

# real upload path against a throwaway local remote, without posting a comment
git init --bare /tmp/assets.git
node $SKILL/bin/ui-diff.mjs publish --config $CFG --pr 1 --remote /tmp/assets.git \
  --link-base https://github.com/OWNER/REPO/raw/ui-diff-assets --no-comment --assume-private
```

## `workflows/ui-diff.yml`

GitHub Actions workflow for an app repository: runs ui-diff on every PR push and updates the
sticky comment with the automatic summary. See the comments in the file.
