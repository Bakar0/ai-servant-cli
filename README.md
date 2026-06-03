# ai-servant-cli

CLI that enhances developer and coding-agent workflows.

```bash
bun install
```

## Layout

```
~/.ai_servant/
├── config.json                 search roots, scan depth
├── .cache/repo-discovery.json  cached repo discovery
└── workspaces/<workspace>/
    └── repos/<repo>/<branch>/  git worktree of your local clone
```

Override the root with `AI_SERVANT_ROOT` (handy for tests).

## Commands

```bash
# Open a new terminal tab in a workspace, running a coding agent.
servant spawn --workspace my-task

# Pick local repo(s) and create a worktree of <branch> for each.
# First run prompts for search roots (defaults: ~/private, ~/code).
servant repo add [repo-hint] --workspace my-task --branch topic/x

servant repo list --workspace my-task
servant repo rm <repo>@<branch> --workspace my-task
```

Run any command with `--help` for full flag list.

## Picker (fzf)

`repo add` opens an [fzf](https://github.com/junegunn/fzf) picker:

- Type to filter · ↑/↓ to move · Esc to cancel
- **Enter** to confirm — with no marks, the highlighted row; with marks, all marked rows
- **Tab** toggles a row (multi-select) · **Ctrl-A** toggles all

One worktree is created per selected repo, all on the same `--branch` name.

If fzf isn't installed, you'll see a numbered fallback with a hint:

```bash
brew install fzf
```
