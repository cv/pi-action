# pi-action

A GitHub Action that invokes the [pi coding agent](https://github.com/mariozechner/pi-coding-agent) on issues and pull requests via comment triggers.

## Features

- 🤖 Trigger pi agent with customizable phrases (default: `@pi`)
- 🔒 Security-first: Only allows repo owners, members, and collaborators
- 🤝 Bot allowlist for automation workflows
- 📝 Works on both issues and pull requests
- 🆕 Trigger on issue/PR creation, not just comments
- 🔀 Automatically includes PR diffs for code review tasks
- 📦 Uses the pi SDK directly - no separate installation needed
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
    permissions:
      contents: write
      issues: write
      pull-requests: write

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '25'

      - name: Run pi-action
        uses: cv/pi-action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          pi_auth_json: ${{ secrets.PI_AUTH_JSON }}
```

### Authentication

pi requires authentication with your LLM provider. Set up the `PI_AUTH_JSON` secret in your repository:

1. Run `pi` locally and complete OAuth authentication
2. Copy the contents of `~/.pi/agent/auth.json`
3. Add it as a repository secret named `PI_AUTH_JSON`

Alternatively, you can set provider-specific environment variables (e.g., `ANTHROPIC_API_KEY`).

### Inputs

All inputs are defined in [`action.yml`](action.yml). Default values are centralized in [`src/defaults.ts`](src/defaults.ts).

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `github_token` | GitHub token for API access (issues, PRs, reactions, comments) | Yes | - |
| `gist_token` | GitHub token with gist scope for session sharing (optional) | No | - |
| `pi_auth_json` | Contents of `~/.pi/agent/auth.json` | No | - |
| `trigger_phrase` | Phrase to trigger pi | No | `@pi` |
| `allowed_bots` | Comma-separated list of allowed bot usernames | No | - |
| `timeout` | Execution timeout in seconds | No | `1800` |
| `provider` | LLM provider (anthropic, openai, google, etc.) | No | `anthropic` |
| `model` | Model ID | No | `claude-sonnet-4-20250514` |
| `prompt_template` | Custom prompt template with placeholder variables | No | (built-in default) |
| `share_session` | Include a link to the full session HTML in the response comment | No | `true` |

### Examples

#### Allow Dependabot to trigger pi

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    allowed_bots: 'dependabot[bot],renovate[bot]'
```

#### Use a different model

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    provider: 'openai'
    model: 'gpt-4o'
```

#### Custom trigger phrase

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    trigger_phrase: '@assistant'
```

#### Custom Prompt Template

Customize how GitHub issue/PR context is presented to the pi agent:

```yaml
- uses: cv/pi-action@v1
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

#### Session Sharing

By default, pi-action shares the complete session (including tool executions and agent reasoning) as a secret GitHub gist and includes a link in the response comment. This helps with debugging and provides full transparency of what the agent did.

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    pi_auth_json: ${{ secrets.PI_AUTH_JSON }}
    share_session: true  # Default: true
```

To disable session sharing:

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    pi_auth_json: ${{ secrets.PI_AUTH_JSON }}
    share_session: false  # Disable session links
```

**Session sharing includes:**
- Full conversation history
- All tool executions (file reads, bash commands, edits)
- Agent reasoning and decision process
- Error details when things go wrong

Sessions are uploaded as **secret** (non-public) GitHub gists and are accessible via a viewer at `https://shittycodingagent.ai/session?<gist_id>`.

**Note:** The default `GITHUB_TOKEN` does not have permission to create gists. To enable session sharing, provide a separate Personal Access Token (PAT) with the `gist` scope via the `gist_token` input:

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}  # For issues, PRs, reactions
    gist_token: ${{ secrets.PAT_WITH_GIST_SCOPE }}  # PAT with gist scope only
    pi_auth_json: ${{ secrets.PI_AUTH_JSON }}
    share_session: true
```

This separation follows the principle of least privilege - the PAT only needs `gist` scope, not full repo access.

If gist creation fails (e.g., due to missing permissions), the action will gracefully continue and post the response without a session link.

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
4. **Git hooks are installed** in the target repository to enforce commit conventions (see [`scripts/install-agent-hooks.sh`](scripts/install-agent-hooks.sh))
5. The pi SDK is invoked with the issue/PR context and the task from the trigger (see [`src/agent.ts`](src/agent.ts))
6. **Session is shared** as a secret GitHub gist with a preview URL (if `share_session` is enabled)
7. The response is posted as a new comment with a 🚀 reaction, including the session link

The main orchestration logic is in [`src/run.ts`](src/run.ts), with prompt building in [`src/context.ts`](src/context.ts).

### Git Hooks for the Agent

The action automatically installs **lightweight, standalone git hooks** ([defined in `scripts/install-agent-hooks.sh`](scripts/install-agent-hooks.sh)) in your repository before running the agent. These hooks have no dependencies and work with any language/stack:

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
