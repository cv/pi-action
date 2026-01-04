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
          node-version: '20'

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

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `github_token` | GitHub token for API access | Yes | - |
| `pi_auth_json` | Contents of `~/.pi/agent/auth.json` | No | - |
| `trigger_phrase` | Phrase to trigger pi | No | `@pi` |
| `allowed_bots` | Comma-separated list of allowed bot usernames | No | - |
| `timeout` | Execution timeout in seconds | No | `300` |
| `provider` | LLM provider (anthropic, openai, google, etc.) | No | `anthropic` |
| `model` | Model ID | No | `claude-sonnet-4-20250514` |

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
2. The action validates that the author has write access to the repository
3. An 👀 reaction is added to acknowledge the request
4. **Git hooks are installed** in the target repository (husky + commitlint) to enforce commit conventions
5. The pi SDK is invoked with the issue/PR context and the task from the trigger
6. The response is posted as a new comment with a 🚀 reaction

### Git Hooks for the Agent

The action automatically installs **lightweight, standalone git hooks** in your repository before running the agent. These hooks have no dependencies and work with any language/stack:

- **commit-msg**: Enforces [Conventional Commits](https://www.conventionalcommits.org/) format
- **prepare-commit-msg**: Auto-appends issue numbers from branch names

**Important**: These hooks are only installed if no existing hook is present - your existing hooks are never overwritten.

This ensures the agent follows conventional commit format without imposing any tooling requirements on your repository.

## Security

The action only responds to users with write access:
- Repository owners
- Organization members
- Collaborators

Bots are blocked by default unless explicitly added to the `allowed_bots` list.

Input is sanitized to remove:
- HTML comments (potential injection vectors)
- Invisible Unicode characters

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests with coverage
npm test -- --coverage

# Build
npm run build

# Type check
npm run typecheck

# Lint and format
npm run check
```

### Git Hooks

This project uses [Husky](https://typicode.github.io/husky/) to enforce quality checks via git hooks:

| Hook | What it does |
|------|--------------|
| **pre-commit** | Runs tests, type checking, linting, builds, and verifies `dist/` is up to date |
| **commit-msg** | Enforces [Conventional Commits](https://www.conventionalcommits.org/) format |
| **prepare-commit-msg** | Auto-appends issue number from branch name (e.g., `feat/123-description` → `Refs #123`) |
| **pre-push** | Runs full test suite with coverage thresholds (80% lines/functions, 70% branches) |

#### Commit Message Format

Commits must follow the conventional commits format:

```
type(scope?): subject

body?

footer?
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

Examples:
```bash
git commit -m "feat: add webhook support"
git commit -m "fix: handle empty response from API"
git commit -m "docs: update installation instructions"
```

### Architecture

The action is built with TypeScript and uses the pi-coding-agent SDK directly:

- `src/index.ts` - Entry point, wires up dependencies
- `src/run.ts` - Main orchestration logic
- `src/agent.ts` - pi SDK integration
- `src/github.ts` - GitHub API helpers
- `src/context.ts` - Prompt building
- `src/security.ts` - Permission validation and input sanitization

All business logic has 100% test coverage (88% overall including the entry point).

## License

MIT
