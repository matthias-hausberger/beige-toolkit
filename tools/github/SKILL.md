# GitHub Tool — Usage Guide

Interact with GitHub using the `gh` CLI. All commands are forwarded verbatim to `gh` running on the gateway host.

## ⚠️ Critical: Path Handling

**The github tool runs on the gateway host, NOT inside your sandbox container.**

Your `/workspace` inside the container is a bind mount of the host's `~/.beige/agents/<name>/workspace/`. The github tool executes on the host with that directory as its working directory.

This matters for commands like `pr create` that read `.git/config` to discover the repository.

### ✅ DO: Use --repo flag for all operations

```sh
# Always specify the repo explicitly:
/tools/bin/github issue list --repo myorg/myrepo
/tools/bin/github pr view 42 --repo myorg/myrepo
/tools/bin/github pr create --repo myorg/myrepo --title "..." --body "..."
```

### ✅ DO: Create PRs from forks when you lack write access

```sh
# Push to your fork first
/tools/bin/git -C repos/myrepo push fork feature-branch

# Create PR from fork to upstream
/tools/bin/github pr create --repo upstream/repo \
  --head your-username:feature-branch \
  --title "feat: add feature" \
  --body "Description"
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
/tools/bin/github repo list

# List repos for an org
/tools/bin/github repo list myorg --limit 50

# View a specific repo
/tools/bin/github repo view myorg/myrepo
```

### Issues

```sh
# List open issues
/tools/bin/github issue list --repo myorg/myrepo

# View a specific issue
/tools/bin/github issue view 42 --repo myorg/myrepo

# Create an issue
/tools/bin/github issue create --repo myorg/myrepo \
  --title "Bug: something is broken" \
  --body "Description of the problem"

# Add a comment to an issue
/tools/bin/github issue comment 42 --repo myorg/myrepo --body "Update on this issue"
```

### Pull Requests

```sh
# List open PRs
/tools/bin/github pr list --repo myorg/myrepo

# View a PR
/tools/bin/github pr view 17 --repo myorg/myrepo

# Create a PR from a branch on the same repo
/tools/bin/github pr create --repo myorg/myrepo \
  --title "feat: add new feature" \
  --body "What this PR does"

# Create a PR from a fork
/tools/bin/github pr create --repo upstream/repo \
  --head my-username:feature-branch \
  --base main \
  --title "feat: add new feature" \
  --body "What this PR does"
```

### Releases

```sh
# List releases
/tools/bin/github release list --repo myorg/myrepo

# View a release
/tools/bin/github release view v1.2.0 --repo myorg/myrepo
```

### Workflow Runs

```sh
# List workflow runs
/tools/bin/github run list --repo myorg/myrepo

# View a specific run
/tools/bin/github run view 12345678 --repo myorg/myrepo
```

### Raw API

```sh
# Make a raw GitHub API call
/tools/bin/github api repos/myorg/myrepo

# POST to the API
/tools/bin/github api repos/myorg/myrepo/issues \
  --method POST \
  --field title="My Issue" \
  --field body="Issue body"
```

> **Note:** `api` is excluded from the default allowed set. If your call fails with a permission error, the `api` subcommand has not been enabled for your agent.

## Typical Workflow: Create a PR

```sh
# 1. Clone the repository
/tools/bin/git clone git@github.com:myorg/myrepo.git repos/myrepo

# 2. Create a branch
/tools/bin/git -C repos/myrepo checkout -b feat/my-feature

# 3. Make changes and commit
# ... edit files ...
/tools/bin/git -C repos/myrepo add .
/tools/bin/git -C repos/myrepo commit -m "feat: implement feature"

# 4. Push the branch
/tools/bin/git -C repos/myrepo push -u origin feat/my-feature

# 5. Create the PR
/tools/bin/github pr create --repo myorg/myrepo \
  --title "feat: implement feature" \
  --body "Description"
```

### Fork Workflow: PR Without Write Access

If you don't have write access to the upstream repo:

```sh
# 1. Clone the upstream repo
/tools/bin/git clone git@github.com:upstream/repo.git repos/repo

# 2. Add your fork as a remote
/tools/bin/git -C repos/repo remote add fork git@github.com:my-username/repo.git

# 3. Create and push a branch to your fork
/tools/bin/git -C repos/repo checkout -b feat/my-feature
/tools/bin/git -C repos/repo add .
/tools/bin/git -C repos/repo commit -m "feat: implement feature"
/tools/bin/git -C repos/repo push fork feat/my-feature

# 4. Create PR from your fork to upstream
/tools/bin/github pr create --repo upstream/repo \
  --head my-username:feat/my-feature \
  --title "feat: implement feature" \
  --body "Description"
```

## Troubleshooting

### "No commits between main and feature-branch"

**Cause:** The branch doesn't exist on the remote yet.

**Fix:** Push the branch first:
```sh
/tools/bin/git -C repos/myrepo push origin feature-branch
```

### "Head sha can't be blank, Base sha can't be blank"

**Cause:** Same as above - branch not pushed to remote.

**Fix:** Push the branch, then create the PR.

### Permission denied on push

**Cause:** Your deploy key doesn't have write access to this repository.

**Fix:** Use the fork workflow (see above) - push to your fork, then create a PR from the fork.

### GraphQL field requires 'read:org' scope

**Cause:** Some gh commands require organization read access.

**Fix:** This is a token scope issue. Request the token to be updated with `read:org` scope, or use a different command that doesn't require it.

## Permission Errors

When a subcommand is not allowed, you will see:

```
Permission denied: subcommand 'api' is not allowed for this agent.
Permitted subcommands: repo, issue, pr
```

If you hit this, use only the subcommands listed in the error message.

`repo delete` is permanently blocked and cannot be enabled.

## Tips

- The tool is stateless — each call spawns a fresh `gh` process.
- Use `--json` for structured output you can parse in scripts.
- Always specify `--repo owner/repo` to avoid ambiguity.
- For creating PRs without write access, use the fork workflow.
- For the full `gh` command reference, see the [gh docs](https://cli.github.com/manual/).
