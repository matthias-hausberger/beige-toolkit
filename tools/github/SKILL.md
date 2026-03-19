# GitHub Tool — Usage Guide

Interact with GitHub using the `gh` CLI. All commands are forwarded verbatim to `gh` running on the gateway host.

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
```

### Pull Requests

```sh
# List open PRs
/tools/bin/github pr list --repo myorg/myrepo

# View a PR
/tools/bin/github pr view 17 --repo myorg/myrepo

# Create a PR
/tools/bin/github pr create --repo myorg/myrepo \
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

## Permission Errors

When a subcommand is not allowed, you will see:

```
Permission denied: subcommand 'repo' is not allowed for this agent.
Permitted subcommands: issue, pr
```

If you hit this, use only the subcommands listed in the error message.

## Tips

- The tool is stateless — each call spawns a fresh `gh` process.
- Use `--json` for structured output you can parse in scripts.
- Always specify `--repo owner/repo` when working across multiple repositories.
- For the full `gh` command reference, see the [gh docs](https://cli.github.com/manual/).
