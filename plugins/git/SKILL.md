# Git Tool — Usage Guide

Run git commands in your workspace. All commands operate on `/workspace` — the same directory where you read and write files.

## ⚠️ Critical: Path Handling

**The git tool runs on the gateway host, NOT inside your sandbox container.**

Your `/workspace` inside the container is a bind mount of the host's `~/.beige/agents/<name>/workspace/`. The git tool executes on the host with that directory as its working directory.

### ✅ DO: Use Relative Paths with -C

The cleanest pattern. `-C <relative-path>` is relative to the workspace root on
the gateway host — the same directory mounted at `/workspace` in the container:

```sh
git -C myrepo status
git -C myrepo add .
git -C myrepo commit -m "feat: add feature"
git -C myrepo push origin main
git -C myrepo log --oneline -10
```

### ❌ DO NOT: Use Absolute Container Paths with -C

```sh
# WRONG — /workspace doesn't exist on the gateway host:
git -C /workspace/myrepo status       # ❌ "cannot change to '/workspace/myrepo'"
git -C /workspace/myrepo push         # ❌ same
```

The gateway host has no `/workspace` directory. Strip the `/workspace/` prefix
and pass only the relative part: `myrepo`, not `/workspace/myrepo`.

### ❌ DO NOT: Use System Git (/usr/bin/git) via exec

The container does not have git installed. The `git` command on your PATH
(`/tools/bin/git`) is the gateway tool wrapper — it must be invoked as a
**tool call**, not via `exec`. Calling it via exec will fail because the
tool-client cannot communicate with the gateway socket from within exec.

## ⚠️ Critical: Always Clone with SSH

**Always use SSH URLs for cloning.** The git tool authenticates via a per-agent SSH key. HTTPS URLs will fail unless an explicit HTTPS token is also configured in `auth.token`.

```sh
# ✅ SSH — always works with default config
git clone git@github.com:myorg/myrepo.git

# ❌ HTTPS — fails unless auth.token is configured
git clone https://github.com/myorg/myrepo.git
```

If you accidentally try to clone via HTTPS with SSH-only auth, the tool will block it immediately and show you the correct SSH URL to use instead.

### Working with Subdirectories

```sh
# Clone creates /workspace/myrepo (relative name "myrepo" on the host)
git clone git@github.com:myorg/myrepo.git myrepo

# All subsequent operations use -C with the relative path:
git -C myrepo status
git -C myrepo add .
git -C myrepo add src/foo.ts
git -C myrepo commit -m "feat: add feature"
git -C myrepo push origin main
git -C myrepo log --oneline -10
```

## Calling Convention

```sh
/tools/bin/git <subcommand> [args...]
```

## Common Workflows

All examples use `-C myrepo` — replace `myrepo` with your repo's directory name
relative to the workspace root (e.g. `keyflare`, `beige-toolkit`, `projects/my-app`).

### Clone a repository

```sh
# Always use SSH URLs:
git clone git@github.com:myorg/myrepo.git myrepo
```

### Check status and stage files

```sh
git -C myrepo status
git -C myrepo add .
git -C myrepo add src/foo.ts tests/foo.test.ts
```

### Commit

```sh
git -C myrepo commit -m "feat: add new feature"
git -C myrepo commit -m "fix: correct edge case in parser"
```

### Push and pull

```sh
git -C myrepo push origin main
git -C myrepo pull
git -C myrepo pull origin main
```

### Branches

```sh
git -C myrepo checkout -b feat/my-feature
git -C myrepo branch -a
git -C myrepo checkout main
```

### View history and diffs

```sh
git -C myrepo log --oneline
git -C myrepo log --oneline -20
git -C myrepo diff
git -C myrepo diff --staged
git -C myrepo show HEAD
```

### Fetch and rebase

```sh
git -C myrepo fetch origin
git -C myrepo rebase origin/main
```

### Stash

```sh
git -C myrepo stash push
git -C myrepo stash pop
git -C myrepo stash list
```

## Permission Errors

When a subcommand is not permitted:

```
Permission denied: subcommand 'push' is not allowed for this agent.
Permitted subcommands: status, diff, log, fetch, pull
```

When force-push is blocked:

```
Permission denied: force-push is not allowed for this agent.
```

When an HTTPS clone is attempted with SSH-only auth:

```
Auth mismatch: cannot clone 'https://github.com/myorg/myrepo.git' because the
remote uses HTTPS but this agent is configured for SSH authentication only.

Use the SSH URL instead:
  git clone git@github.com:myorg/myrepo.git
```

`git config` is always blocked and cannot be enabled.

## Tips

- Always `git status` before committing to confirm what is staged
- Use `git diff --staged` to review exactly what will be committed
- Paths in git output are relative to `/workspace`
- Each call is stateless — git state (branch, index, stash) persists in `/workspace/.git` or `/workspace/<repo>/.git` between calls
