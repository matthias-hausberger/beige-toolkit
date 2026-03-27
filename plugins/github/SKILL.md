# GitHub Tool — Usage Guide

Interact with GitHub using the `gh` CLI. All commands are forwarded verbatim to `gh` running on the gateway host.

## ⚠️ Critical: Path Handling

**The github tool runs on the gateway host, NOT inside your sandbox container.**

Your `/workspace` inside the container is a bind mount of the host's `~/.beige/agents/<name>/workspace/`. The github tool executes on the host with that directory as its working directory.

This matters for commands like `pr create` that read `.git/config` to discover the repository.

### ✅ DO: Run gh from within your cloned repo

```sh
# First, clone a repo into your workspace
git clone https://github.com/myorg/myrepo.git myrepo

# Now gh commands work without --repo flag:
cd myrepo && gh pr list           # ✅ Works (gh reads .git/config)
gh pr create --title "..." --body "..."  # ✅ Works if run from repo root
```

### ✅ DO: Use --repo flag for cross-repo operations

```sh
# When NOT inside a git repo, or working with a different repo:
gh issue list --repo myorg/myrepo
gh pr view 42 --repo myorg/myrepo
gh pr create --repo myorg/myrepo --title "..." --body "..."
```

### ❌ DO NOT: Use absolute container paths

```sh
# These will FAIL because /workspace/... doesn't exist on the host:
gh pr create -R /workspace/myrepo  # ❌ WRONG (path doesn't exist on host)
```

## Calling Convention

```sh
/tools/bin/github <subcommand> [args...]
```

Interactive prompts are disabled — always pass all required flags explicitly.
Output format flags (`--json`, `--jq`, `--template`) work as normal.

## Examples

### Repositories

```sh
# List your repositories
gh repo list

# List repos for an org
gh repo list myorg --limit 50

# View a specific repo
gh repo view myorg/myrepo
```

### Issues

```sh
# List open issues
gh issue list --repo myorg/myrepo

# View a specific issue
gh issue view 42 --repo myorg/myrepo

# Create an issue
gh issue create --repo myorg/myrepo \
  --title "Bug: something is broken" \
  --body "Description of the problem"
```

### Pull Requests

```sh
# List open PRs
gh pr list --repo myorg/myrepo

# View a PR
gh pr view 17 --repo myorg/myrepo

# Create a PR (from within a cloned repo)
gh pr create --title "feat: add new feature" --body "What this PR does"

# Create a PR (explicit repo)
gh pr create --repo myorg/myrepo --title "feat: add new feature" --body "What this PR does"

# Checkout a PR locally
gh pr checkout 17
```

### Releases

```sh
# List releases
gh release list --repo myorg/myrepo

# View a release
gh release view v1.2.0 --repo myorg/myrepo
```

### Workflow Runs

```sh
# List workflow runs
gh run list --repo myorg/myrepo

# View a specific run
gh run view 12345678 --repo myorg/myrepo
```

### Raw API

```sh
# Make a raw GitHub API call (requires explicit opt-in via allowedCommands)
gh api repos/myorg/myrepo

# POST to the API
gh api --method POST repos/myorg/myrepo/issues -f title="Bug" -f body="Description"
```

## Typical Workflow: Create a PR

```sh
# 1. Clone the repository
git clone https://github.com/myorg/myrepo.git myrepo

# 2. Create a branch
git -C myrepo checkout -b feat/my-feature

# 3. Make changes and commit
# ... edit files ...
git -C myrepo add .
git -C myrepo commit -m "feat: implement feature"

# 4. Push the branch
git -C myrepo push -u origin feat/my-feature

# 5. Create the PR (gh reads repo from .git/config)
gh pr create --repo myorg/myrepo --title "feat: implement feature" --body "Description"
```

## Permission Errors

When a subcommand is not permitted:

```
Permission denied: subcommand 'api' is not allowed for this agent.
Permitted subcommands: repo, issue, pr
```

`repo delete` is permanently blocked and cannot be enabled.

## Tips

- Use `--repo owner/repo` when working across multiple repositories
- For `pr create` without `--repo`, ensure you're working in a cloned git repo
- The `api` subcommand is blocked by default — request opt-in via `allowedCommands`
- For the full `gh` command reference, see the [gh docs](https://cli.github.com/manual/)
