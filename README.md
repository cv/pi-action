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
      - uses: actions/checkout@v6

      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: '25'

      - name: Run pi-action
        uses: cv/pi-action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Authentication

pi requires authentication with your LLM provider. Prefer provider-specific environment variables because they match pi's normal API-key resolution and avoid copying local pi state into CI:

```yaml
env:
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Common variables include `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, and `OPENROUTER_API_KEY`. For the full list, see pi's provider documentation.

If you prefer configuring credentials through action inputs, use `api_key`. The value is applied only for this action run and is mapped to the selected `provider`:

```yaml
with:
  provider: anthropic
  api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Inputs

All inputs are defined in [`action.yml`](action.yml). Default values are centralized in [`src/defaults.ts`](src/defaults.ts).

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `github_token` | GitHub token for API access (issues, PRs, reactions, comments) | Yes | - |
| `api_key` | LLM provider API key for the selected `provider` (runtime-only; env vars are preferred) | No | - |
| `trigger_phrase` | Phrase to trigger pi | No | `@pi` |
| `allowed_bots` | Comma-separated list of allowed bot usernames | No | - |
| `allowed_users` | Comma-separated GitHub usernames allowed to trigger pi. If set, users must be in this list. | No | - |
| `allowed_associations` | Comma-separated GitHub author associations allowed to trigger pi when `allowed_users` is empty | No | `OWNER,MEMBER` |
| `timeout` | Execution timeout in seconds | No | `1800` |
| `provider` | LLM provider (anthropic, openai, google, etc.) | No | `anthropic` |
| `model` | Model ID | No | `claude-sonnet-4-20250514` |
| `provider_base_url` | Base URL for a single custom provider/model | No | - |
| `provider_api` | API type for a custom provider/model | No | `openai-completions` |
| `provider_api_key` | Provider apiKey config value for custom providers (literal or env var name) | No | - |
| `provider_auth_header` | Add `Authorization: Bearer <key>` for custom provider requests | No | `false` |
| `model_name` | Display name for the custom model | No | - |
| `model_reasoning` | Whether the custom model supports reasoning/thinking | No | `false` |
| `model_input` | Comma-separated custom model input modalities (`text` or `text,image`) | No | `text` |
| `model_context_window` | Context window tokens for the custom model | No | `128000` |
| `model_max_tokens` | Max output tokens for the custom model | No | `16384` |
| `compat_supports_developer_role` | Whether OpenAI-compatible custom provider supports developer role messages | No | - |
| `compat_supports_reasoning_effort` | Whether OpenAI-compatible custom provider supports `reasoning_effort` | No | - |
| `prompt_template` | Custom prompt template with placeholder variables | No | (built-in default) |
| `share_session` | Upload `session.html` and `session.jsonl` as a GitHub Actions artifact and link it in the response comment | No | `true` |
| `output_mode` | `comment` to post on the issue/PR, or `output` to set action outputs only | No | `comment` |
| `prompt` | Direct prompt for the agent (use with `output_mode: output`, or with `pr_number`) | No | - |
| `pr_number` | Pull request number to load explicitly (useful for `workflow_dispatch`) | No | - |

### Examples

#### Restrict who can trigger pi

By default, only repository owners and organization members can trigger pi. To further restrict triggering to specific users:

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    allowed_users: 'alice,bob'
```

To allow outside collaborators too:

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    allowed_associations: 'OWNER,MEMBER,COLLABORATOR'
```

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
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

#### Custom trigger phrase

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    trigger_phrase: '@assistant'
```

#### Single custom provider/model

For one local or internal model, configure the provider/model directly with action inputs instead of committing a pi `models.json` file.

Example: NVIDIA-hosted `openai/openai/gpt-5.5` using the OpenAI Responses API:

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    provider: nvidia
    model: openai/openai/gpt-5.5
    api_key: ${{ secrets.NVIDIA_API_KEY }}
    provider_base_url: https://inference-api.nvidia.com
    provider_api: openai-responses
    model_name: GPT-5.5 (OpenAI)
    model_reasoning: true
    model_input: text,image
    model_context_window: 1050000
    model_max_tokens: 16384
```

Example: local Ollama/LM Studio/vLLM-style endpoint on a self-hosted runner:

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    provider: spark
    model: huggingface.co/unsloth/gemma-4-26b-a4b-it-gguf:Q8_0
    provider_base_url: http://192.168.1.16:12434/v1
    provider_api: openai-completions
    provider_api_key: spark
    model_name: Gemma 4 26B-A4B IT Q8 (Spark)
    model_context_window: 128000
    model_max_tokens: 16384
```

`provider_api_key` can be a literal key or the name of an environment variable. If you use the action-level `api_key` input, `provider_api_key` is not required. For local servers that ignore authentication, set `provider_api_key` to any dummy value.

**Note:** `localhost` or LAN URLs are resolved from the GitHub runner. Use a self-hosted runner or a reachable internal endpoint for local models.

#### Output mode and direct prompts

Use `output_mode: output` with `prompt` when you want pi-action to run in automation workflows without posting comments or reactions:

```yaml
- uses: cv/pi-action@v1
  id: pi
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    output_mode: output
    prompt: Generate release notes for the current checkout
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

- run: echo "${{ steps.pi.outputs.response }}"
```

The action sets these outputs in output mode:
- `response`
- `success`
- `share_url` (workflow run URL containing the session artifact, when session sharing succeeds)

#### Explicit PR review mode

Use `pr_number` to review a PR from `workflow_dispatch` or another workflow event that does not include PR payload context:

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    output_mode: output
    pr_number: ${{ github.event.inputs.pr_number }}
    prompt: Please review this PR
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
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

By default, pi-action uploads the complete session (including tool executions and agent reasoning) as a GitHub Actions artifact and includes a link in the response comment. This helps with debugging and provides full transparency of what the agent did.

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    share_session: true  # Default: true
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

To disable session sharing:

```yaml
- uses: cv/pi-action@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    share_session: false  # Disable session links
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

**Session sharing includes:**
- Full conversation history
- All tool executions (file reads, bash commands, edits)
- Agent reasoning and decision process
- Error details when things go wrong

Sessions are uploaded as workflow artifacts containing both `session.html` and `session.jsonl`. Artifacts inherit the workflow run's repository visibility and retention settings, and require no extra PAT beyond the standard `GITHUB_TOKEN`.

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
6. **Session is shared** as a GitHub Actions artifact with both HTML and JSONL exports (if `share_session` is enabled)
7. The response is posted as a new comment with a 🚀 reaction, including the session artifact link

The main orchestration logic is in [`src/run.ts`](src/run.ts), with prompt building in [`src/context.ts`](src/context.ts).

### Git Hooks for the Agent

The action automatically installs **lightweight, standalone git hooks** ([defined in `scripts/install-agent-hooks.sh`](scripts/install-agent-hooks.sh)) in your repository before running the agent. These hooks have no dependencies and work with any language/stack:

- **commit-msg**: Enforces [Conventional Commits](https://www.conventionalcommits.org/) format
- **prepare-commit-msg**: Auto-appends issue numbers from branch names

**Important**: These hooks are only installed if no existing hook is present - your existing hooks are never overwritten.

This ensures the agent follows conventional commit format without imposing any tooling requirements on your repository.

## Security

The action only responds to authorized users (see [`src/security.ts`](src/security.ts)):
- Repository owners and organization members by default (`allowed_associations: OWNER,MEMBER`)
- Explicit usernames in `allowed_users`, when configured
- Bots explicitly added to `allowed_bots`

Collaborators are not allowed by default. Add `COLLABORATOR` to `allowed_associations` if you want outside collaborators to trigger pi.

Input is sanitized to remove:
- HTML comments (potential injection vectors)
- Invisible Unicode characters

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture details, and contribution guidelines.

## License

MIT
