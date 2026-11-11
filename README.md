# pi-action

A GitHub Action that runs a durable [pi](https://github.com/earendil-works/pi) coding agent on issues and pull requests, triggered by comments. Each issue or PR is one long-running conversation: follow-up comments continue it, several teammates can talk to it at once, and its full history is stored in your repository as git commits on `refs/pi/threads/<number>`.

## Features

- 🤖 Trigger pi agent with customizable phrases (default: `@pi`)
- 🧵 One durable conversation per issue/PR: later `@pi` comments continue where it left off, on any runner
- 👥 Team-friendly: comments posted while pi works join the running conversation; comments a cancelled or queued run missed are picked up by the next one
- 💾 State in git, no external storage: each step is a commit on `refs/pi/threads/<number>`, pushed at every turn and once more in an `if: always()` step
- 🔒 Security-first: Only allows repo owners, members, and collaborators
- 🤝 Bot allowlist for automation workflows
- 📝 Works on both issues and pull requests (including review comments)
- 🆕 Trigger on issue/PR creation, not just comments
- 🔀 Automatically includes PR diffs for code review tasks
- 🔌 Any pi provider, plus custom providers from your `models.json`
- 🪝 Auto-installs git hooks to enforce commit conventions for the agent

## Usage

### Basic Setup

Create `.github/workflows/pi-assistant.yml`:

```yaml
name: pi Assistant

on:
  issues:
    types: [opened]
  pull_request:
    types: [opened]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  pi-response:
    if: contains(github.event.comment.body || github.event.issue.body || github.event.pull_request.body || '', '@pi')
    runs-on: ubuntu-latest
    # One run per issue/PR at a time (see "Durable threads" below).
    concurrency:
      group: pi-${{ github.event.issue.number || github.event.pull_request.number }}
      cancel-in-progress: false
    permissions:
      contents: write       # push code and refs/pi/threads/*
      issues: write
      pull-requests: write

    steps:
      - uses: actions/checkout@v4   # keep persist-credentials (the default): pi pushes its thread ref

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '24'        # 22.19 or newer

      - name: Run pi-action
        uses: cv/pi-action@v2
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          pi_auth_json: ${{ secrets.PI_AUTH_JSON }}
```

### Authentication

pi requires authentication with your LLM provider. Either:

- **`pi_auth_json`**: run `pi` locally, log in, and store the contents of `~/.pi/agent/auth.json` as a repository secret (`PI_AUTH_JSON`). OAuth tokens refreshed during a run are not written back to the secret.
- **Environment variables**: set provider variables such as `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` on the step.
- **`models_json`** for custom providers: the contents of `~/.pi/agent/models.json`. Providers using the `anthropic-messages`, `openai-completions`, or `openai-responses` APIs are supported; `apiKey` may be a literal key, an environment variable name, or a `!command`.

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    models_json: ${{ secrets.PI_MODELS_JSON }}
    provider: 'inference.nvidia'
    model: 'aws/anthropic/bedrock-claude-opus-5-5'
```

### Inputs

All inputs are defined in [`action.yml`](action.yml). Default values are centralized in [`src/defaults.ts`](src/defaults.ts).

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `github_token` | GitHub token for API access (issues, PRs, reactions, comments) | Yes | - |
| `pi_auth_json` | Contents of `~/.pi/agent/auth.json` | No | - |
| `models_json` | Contents of `~/.pi/agent/models.json` (custom providers) | No | - |
| `trigger_phrase` | Phrase to trigger pi | No | `@pi` |
| `allowed_bots` | Comma-separated list of allowed bot usernames | No | - |
| `timeout` | Seconds before the run is aborted (its thread is still saved) | No | `1800` |
| `provider` | LLM provider (anthropic, openai, google, openrouter, a `models_json` provider, …) | No | `anthropic` |
| `model` | Model ID | No | `claude-sonnet-5-5` |
| `prompt_template` | Custom template for the first message of a thread | No | (built-in default) |
| `poll_interval` | Seconds between checks for new comments while pi works | No | `15` |
| `gist_token`, `share_session` | Deprecated and ignored (sessions live in git now) | No | - |

### Examples

#### Allow Dependabot to trigger pi

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    allowed_bots: 'dependabot[bot],renovate[bot]'
```

#### Use a different model

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    provider: 'openai'
    model: 'gpt-4o'
```

#### Custom trigger phrase

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    trigger_phrase: '@assistant'
```

#### Custom Prompt Template

Customize how GitHub issue/PR context is presented to the pi agent:

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt_template: |
      # Code Review for {{type_display}} #{{number}}
      
      **Title:** {{title}}
      **Task:** {{task}}
      
      ## Description
      {{body}}
      
      ## Changes
      ```diff
      {{diff}}
      ```
      
      ## Review Guidelines
      - Check for security vulnerabilities
      - Verify test coverage
      - Follow our coding standards
```

**Template Variables:**
- `{{type}}` - Context type (`issue` or `pull_request`)
- `{{type_display}}` - Human-readable type (`Issue` or `Pull Request`)
- `{{number}}` - Issue/PR number
- `{{title}}` - Issue/PR title
- `{{body}}` - Issue/PR description
- `{{task}}` - Extracted task (text after trigger phrase)
- `{{diff}}` - PR diff (empty for issues)
- `{{trigger_comment}}` - Full trigger comment text

See [examples/prompt-templates.md](examples/prompt-templates.md) for more template examples.

#### Durable threads

Every issue or PR is one pi conversation, stored with [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) as a chain of git commits on `refs/pi/threads/<number>` in your repository (a custom ref: it doesn't show up as a branch).

- **Continuity**: a later `@pi` comment continues the same conversation, with everything pi saw and did before, on whatever runner picks it up.
- **Saved as it goes**: the ref is pushed after every model response and tool result, on cancellation (SIGINT/SIGTERM), and once more by the action's `if: always()` step. A run that was cut off resumes its unfinished work next time.
- **Teams**: with the `concurrency` group above, runs for one thread never overlap. A run handles every `@pi` comment the thread hasn't answered yet, not just the one that triggered it, so comments whose queued run GitHub cancelled are still answered. Comments posted while pi works join the running conversation (checked every `poll_interval` seconds). Each comment is answered once, and failures are reported once.
- **Safety net**: pushes are fast-forward only. If two runs ever race on one thread, the later push is rejected (and logged) instead of overwriting the other's history.
- **Inspecting a thread**:

  ```bash
  git fetch origin 'refs/pi/threads/*:refs/pi/threads/*'
  git log --oneline refs/pi/threads/42          # one commit per stored step
  git show refs/pi/threads/42:batch.json | jq   # the newest step's records
  ```

  Anyone who can read the repository can read these refs, including tool output. Keep secrets out of the agent's reach as you would for any CI job.
- **Pruning**: `git gc` won't shrink a thread (its history is reachable). Delete a finished thread with `git push origin :refs/pi/threads/42`.

#### Comments only (no issue/PR creation triggers)

If you only want to trigger on comments, not when issues/PRs are created:

```yaml
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  pi-response:
    if: contains(github.event.comment.body, '@pi')
```

## How It Works

1. When a comment or issue/PR containing the trigger phrase is posted, the action is triggered
2. The action validates that the author has write access to the repository (see [`src/security.ts`](src/security.ts))
3. An 👀 reaction is added to acknowledge the request
4. **Git hooks are installed** in the target repository to enforce commit conventions (see [action.yml](action.yml))
5. The thread's ref is fetched and its conversation reopened (see [`src/thread.ts`](src/thread.ts)); unfinished work from an earlier run resumes
6. Every unanswered `@pi` comment is submitted: the first one of a new thread with the issue/PR context (see [`src/context.ts`](src/context.ts)), later ones as follow-ups (see [`src/triggers.ts`](src/triggers.ts))
7. While pi works, new comments join the conversation; the ref is pushed at every turn
8. Each answer is posted as a comment with a 🚀 reaction on the comments it answers (❌ and 😕 on failure)
9. The thread is closed and pushed; the `if: always()` step pushes again if the run was cut short

The main orchestration logic is in [`src/run.ts`](src/run.ts). The git storage backend is vendored from [cv/git-backed-pi-durable](https://github.com/cv/git-backed-pi-durable) in [`src/vendor`](src/vendor).

### Git Hooks for the Agent

The action automatically installs **lightweight, standalone git hooks** ([defined in action.yml](action.yml#L44-L107)) in your repository before running the agent. These hooks have no dependencies and work with any language/stack:

- **commit-msg**: Enforces [Conventional Commits](https://www.conventionalcommits.org/) format
- **prepare-commit-msg**: Auto-appends issue numbers from branch names

**Important**: These hooks are only installed if no existing hook is present - your existing hooks are never overwritten.

This ensures the agent follows conventional commit format without imposing any tooling requirements on your repository.

## Security

The action only responds to users with write access (see [`src/security.ts`](src/security.ts)):
- Repository owners
- Organization members
- Collaborators

Bots are blocked by default unless explicitly added to the `allowed_bots` list.

Input is sanitized to remove:
- HTML comments (potential injection vectors)
- Invisible Unicode characters

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture details, and contribution guidelines.

## License

MIT
