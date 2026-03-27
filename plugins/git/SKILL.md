# Git Tool — Usage Guide

Run git commands in your workspace. All commands operate on `/workspace` — the same directory where you read and write files.

## ⚠️ Critical: Path Handling

**The git tool runs on the gateway host, NOT inside your sandbox container.**

Your `/workspace` inside the container is a bind mount of the host's `~/.beige/agents/<name>/workspace/`. The git tool executes on the host with that directory as its working directory.

### ✅ DO: Use Relative Paths

```sh
# All of these work correctly:
git status
git add src/foo.ts
git commit -m "feat: add feature"
git diff myrepo/src/main.ts
git log myrepo
```

Relative paths are resolved from `/workspace` (the workspace root).

### ❌ DO NOT: Use Absolute Container Paths

```sh
# These will FAIL because /workspace/... doesn't exist on the host:
git status /workspace/myrepo          # ❌ WRONG
git add /workspace/myrepo/src/foo.ts  # ❌ WRONG
git -C /workspace/myrepo status       # ❌ WRONG
```

The host has no `/workspace` directory — that path only exists inside your container.

### Working with Subdirectories

If you cloned a repo into a subdirectory:

```sh
# Clone creates /workspace/myrepo
git clone https://github.com/myorg/myrepo.git myrepo

# Now work relative to workspace root:
git -C myrepo status          # ✅ Works
git status myrepo             # ✅ Works (inside myrepo)
git add myrepo/src/foo.ts     # ✅ Works
```

## Calling Convention

```sh
/tools/bin/git <subcommand> [args...]
```

## Common Workflows

### Clone a repository

```sh
# Clone into current directory (workspace must be empty or use .)
git clone https://github.com/myorg/myrepo.git .

# Clone into a subdirectory
git clone https://github.com/myorg/myrepo.git myrepo
```

### Check status and stage files

```sh
git status
git add .
git add src/foo.ts tests/foo.test.ts
```

### Commit

```sh
git commit -m "feat: add new feature"
git commit -m "fix: correct edge case in parser"
```

### Push and pull

```sh
git push origin main
git pull
git pull origin main
```

### Branches

```sh
git checkout -b feat/my-feature
git branch -a
git checkout main
```

### View history and diffs

```sh
git log --oneline
git log --oneline -20
git diff
git diff --staged
git show HEAD
```

### Fetch and rebase

```sh
git fetch origin
git rebase origin/main
```

### Stash

```sh
git stash push
git stash pop
git stash list
```

## Permission Errors

When a subcommand is not permitted:

```
Permission denied: subcommand 'push' is not allowed for this agent.
Permitted subcommands: status, diff, log, fetch, pull
```

Use only the subcommands listed.

When a remote URL is not in the allowed list:

```
Permission denied: remote 'https://github.com/other/repo' does not match any allowed remote pattern.
Allowed patterns: github.com/myorg/*
```

When force-push is blocked:

```
Permission denied: force-push is not allowed for this agent.
```

`git config` is always blocked and cannot be enabled.

## Tips

- Always `git status` before committing to confirm what is staged
- Use `git diff --staged` to review exactly what will be committed
- Paths in git output are relative to `/workspace`
- Each call is stateless — git state (branch, index, stash) persists in `/workspace/.git` or `/workspace/<repo>/.git` between calls
