#!/usr/bin/env bash
# Installs the ui-diff skill for Claude Code, Cursor and/or Codex.
#
#   ./install.sh --claude                 # ~/.claude/skills/ui-diff (Cursor reads this folder too)
#   ./install.sh --cursor --codex         # ~/.cursor/skills/ui-diff and ~/.agents/skills/ui-diff
#   ./install.sh --claude --project ~/src/app   # copy into ~/src/app/.claude/skills/ui-diff (commit it)
#   ./install.sh --claude --uninstall
#
# User installs are symlinks to this clone (git pull updates every agent); project installs are
# copies without node_modules/dist, so they can be committed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/skills/ui-diff"
agents=()
project=""
mode="auto"

usage() {
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  echo
  echo "Options: --claude --cursor --codex --all  --project <dir>  --copy  --uninstall"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --claude | --cursor | --codex) agents+=("${1#--}") ;;
    --all) agents+=(claude cursor codex) ;;
    --project)
      project="$(cd "$2" && pwd)"
      shift
      ;;
    --copy) mode="copy" ;;
    --uninstall) mode="uninstall" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if [[ ${#agents[@]} -eq 0 ]]; then
  usage >&2
  exit 1
fi
[[ "$mode" == "auto" ]] && mode=$([[ -n "$project" ]] && echo copy || echo link)

skills_dir() {
  local root="${project:-$HOME}"
  case "$1" in
    claude) echo "$root/.claude/skills" ;;
    cursor) echo "$root/.cursor/skills" ;;
    codex) echo "$root/.agents/skills" ;;
  esac
}

for agent in "${agents[@]}"; do
  dest="$(skills_dir "$agent")/ui-diff"
  if [[ "$mode" == "uninstall" ]]; then
    if [[ -L "$dest" ]] || [[ -f "$dest/SKILL.md" && "$(sed -n '2p' "$dest/SKILL.md")" == "name: ui-diff" ]]; then
      rm -rf "$dest"
      echo "removed $dest"
    fi
    continue
  fi
  if [[ -e "$dest" && ! -L "$dest" ]]; then
    if [[ "$mode" == "link" ]]; then
      echo "skipping $dest: a folder already exists (remove it or use --copy to refresh it)" >&2
      continue
    fi
    rm -rf "$dest"
  fi
  mkdir -p "$(dirname "$dest")"
  if [[ "$mode" == "link" ]]; then
    ln -sfn "$src" "$dest"
    echo "linked $dest -> $src"
  else
    mkdir -p "$dest"
    (cd "$src" && tar --exclude=node_modules --exclude=dist --exclude=test -cf - .) | (cd "$dest" && tar -xf -)
    echo "copied skill to $dest"
  fi
done

if [[ "$mode" == "link" ]]; then
  echo "installing dependencies in $src"
  (cd "$src" && npm install --no-audit --no-fund --loglevel=error)
  echo "done. Chromium is downloaded on the first capture (or run: npx --prefix \"$src\" playwright install chromium)."
fi
