#!/usr/bin/env bash
# Status line for Claude Code.
#
# Inside a servant workspace, renders multi-line:
#   <workspace>
#   ▸ <current-repo> ⎇ <branch> · <git-stats> · #PR    (marker = ▸; sits first)
#     <sibling-repo> ⎇ <branch> · <git-stats> · #PR    (computed per worktree)
#   <model> · <used>k/<window>k · <pct>%
#
# Outside any workspace, single line:
#   <repo> ⎇ <branch> · <wt> · <git-stats> · #PR · <model> · <tokens>

input=$(cat)
dir=$(echo "$input" | jq -r '.workspace.current_dir')

# ---------- Servant workspace detection ----------
workspace=""
current_worktree_dir=""
servant_root="$HOME/.ai_servant"
servant_workspaces="$servant_root/workspaces"
if [[ "$dir" == "$servant_workspaces"/* ]]; then
  rest="${dir#$servant_workspaces/}"
  workspace="${rest%%/*}"
  remainder="${rest#$workspace}"
  if [[ "$remainder" == /repos/* ]]; then
    after_repos="${remainder#/repos/}"
    current_worktree_dir="${after_repos%%/*}"
  fi
fi

ws_repos_dir=""
worktree_entries=()
if [ -n "$workspace" ]; then
  ws_repos_dir="$servant_workspaces/$workspace/repos"
  if [ -d "$ws_repos_dir" ]; then
    while IFS= read -r entry; do
      [ -z "$entry" ] && continue
      [[ "$entry" != *__* ]] && continue
      sub="${entry%%__*}"
      br="${entry#${sub}__}"
      [ -z "$sub" ] || [ -z "$br" ] && continue
      is_current="false"
      [ "$entry" = "$current_worktree_dir" ] && is_current="true"
      worktree_entries+=("$sub|$br|$is_current")
    done < <(ls -1 "$ws_repos_dir" 2>/dev/null | sort)
  fi
fi

# ---------- Helpers ----------
cache_dir="/tmp/cc-statusline-cache"
mkdir -p "$cache_dir" 2>/dev/null

# Compute git stats for a path. Sets GIT_BRANCH / GIT_WT / GIT_STATS.
compute_git() {
  local d="$1"
  GIT_BRANCH=$(git -C "$d" branch --show-current 2>/dev/null)
  [ -z "$GIT_BRANCH" ] && GIT_BRANCH="no-git"

  local gd cd_
  gd=$(git -C "$d" rev-parse --git-dir 2>/dev/null)
  cd_=$(git -C "$d" rev-parse --git-common-dir 2>/dev/null)
  GIT_WT=""
  [ -n "$gd" ] && [ "$gd" != "$cd_" ] && GIT_WT="wt"

  local a b s m u st
  a=$(git -C "$d" rev-list --count @{upstream}..HEAD 2>/dev/null || echo 0)
  b=$(git -C "$d" rev-list --count HEAD..@{upstream} 2>/dev/null || echo 0)
  s=$(git -C "$d" diff --cached --numstat 2>/dev/null | wc -l | tr -d ' ')
  m=$(git -C "$d" diff --numstat 2>/dev/null | wc -l | tr -d ' ')
  u=$(git -C "$d" ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')
  st=$(git -C "$d" stash list 2>/dev/null | wc -l | tr -d ' ')
  GIT_STATS=""
  [ "$a"  -gt 0 ] 2>/dev/null && GIT_STATS="${GIT_STATS}↑${a} "
  [ "$b"  -gt 0 ] 2>/dev/null && GIT_STATS="${GIT_STATS}↓${b} "
  [ "$s"  -gt 0 ] 2>/dev/null && GIT_STATS="${GIT_STATS}●${s} "
  [ "$m"  -gt 0 ] 2>/dev/null && GIT_STATS="${GIT_STATS}✎${m} "
  [ "$u"  -gt 0 ] 2>/dev/null && GIT_STATS="${GIT_STATS}+${u} "
  [ "$st" -gt 0 ] 2>/dev/null && GIT_STATS="${GIT_STATS}⚑${st} "
  GIT_STATS="${GIT_STATS% }"
  [ -z "$GIT_STATS" ] && [ "$GIT_BRANCH" != "no-git" ] && GIT_STATS="clean"
}

# Look up a PR number for (repo_key, branch) at dir. Cached + background-refreshed.
# Sets PR.
lookup_pr() {
  local repo_key="$1" br="$2" d="$3"
  PR=""
  [ "$br" = "no-git" ] && return
  command -v gh >/dev/null 2>&1 || return
  local key cf now mt np
  key=$(printf '%s' "${repo_key}-${br}" | tr '/ ' '__')
  cf="$cache_dir/$key"
  [ -f "$cf" ] && PR=$(cat "$cf" 2>/dev/null)
  now=$(date +%s)
  mt=$(stat -f %m "$cf" 2>/dev/null || echo 0)
  if [ ! -f "$cf" ] || [ $((now - mt)) -gt 300 ]; then
    (
      np=$(cd "$d" && gh pr view "$br" --json number -q .number 2>/dev/null)
      printf '%s' "$np" > "$cf"
    ) >/dev/null 2>&1 &
  fi
}

# ---------- Tokens / model ----------
cu=$(echo "$input" | jq -r '.context_window.current_usage')
input_tk=$(echo "$cu" | jq -r '.input_tokens // 0')
output_tk=$(echo "$cu" | jq -r '.output_tokens // 0')
cache_create=$(echo "$cu" | jq -r '.cache_creation_input_tokens // 0')
cache_read=$(echo "$cu" | jq -r '.cache_read_input_tokens // 0')
used=$((input_tk + output_tk + cache_create + cache_read))
window=$(echo "$input" | jq -r '.context_window.context_window_size // 200000')
percent=$(echo "$input" | jq -r '.context_window.used_percentage // 0')
used_k=$((used / 1000))
window_k=$((window / 1000))
model=$(echo "$input" | jq -r '.model.display_name' | awk '{print tolower($1)}')
session_line="${model} · ${used_k}k/${window_k}k · ${percent}%"

# ---------- Render ----------
if [ -n "$workspace" ]; then
  # Multi-line: session header on first line, then one row per worktree.
  printf ' %s' "$session_line"
  if [ ${#worktree_entries[@]} -gt 0 ]; then
    printf '\n'
    render_entry() {
      local sub="$1" br="$2" is_cur="$3"
      local wt_path="$ws_repos_dir/${sub}__${br}"
      local marker="   "
      [ "$is_cur" = "true" ] && marker=" ▸ "
      compute_git "$wt_path"
      lookup_pr "$sub" "$GIT_BRANCH" "$wt_path"
      local line="${marker}${sub} ⎇ ${GIT_BRANCH}"
      [ -n "$GIT_STATS" ] && line="${line} · ${GIT_STATS}"
      [ -n "$PR" ] && line="${line} · #${PR}"
      printf '%s\n' "$line"
    }
    # First pass: current
    for e in "${worktree_entries[@]}"; do
      IFS='|' read -r sub br is_cur <<< "$e"
      [ "$is_cur" = "true" ] || continue
      render_entry "$sub" "$br" "true"
    done
    # Second pass: siblings
    for e in "${worktree_entries[@]}"; do
      IFS='|' read -r sub br is_cur <<< "$e"
      [ "$is_cur" = "true" ] && continue
      render_entry "$sub" "$br" "false"
    done
    # Strip trailing newline from last render_entry — Claude trims trailing whitespace anyway.
  fi
else
  # Outside servant workspace — session on top, repo line below.
  compute_git "$dir"
  remote_url=$(git -C "$dir" remote get-url origin 2>/dev/null)
  if [ -n "$remote_url" ]; then
    repo="${remote_url##*/}"
    repo="${repo%.git}"
  else
    toplevel=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)
    if [ -n "$toplevel" ]; then
      repo=$(basename "$toplevel")
      repo="${repo%%__*}"
    else
      repo=$(basename "$dir")
    fi
  fi
  lookup_pr "$repo" "$GIT_BRANCH" "$dir"

  repo_line=" ${repo} ⎇ ${GIT_BRANCH}"
  [ -n "$GIT_WT" ] && repo_line="${repo_line} · ${GIT_WT}"
  [ -n "$GIT_STATS" ] && repo_line="${repo_line} · ${GIT_STATS}"
  [ -n "$PR" ] && repo_line="${repo_line} · #${PR}"
  printf ' %s\n%s' "$session_line" "$repo_line"
fi
