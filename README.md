# pi-action

A GitHub Action that runs a durable [pi](https://github.com/earendil-works/pi) coding agent on issues and pull requests, triggered by comments. Each issue or PR is one long-running conversation: follow-up comments continue it, several teammates can talk to it at once, and its full history is stored in your repository as git commits on `refs/pi/threads/<number>`.

## Features

- 🤖 Trigger pi agent with customizable phrases (default: `@pi`)
- 🧵 One durable conversation per issue/PR: later `@pi` comments continue where it left off, on any runner
- 👥 Team-friendly: comments posted while pi works join the running conversation; comments a cancelled or queued run missed are picked up by the next one
- 💾 State in git, no external storage: each step is a commit on `refs/pi/threads/<number>`, pushed at every turn and once more in an `if: always()` step
- 🔒 Security-first: Allows repository owners and organization members by default, with configurable user, association, and bot allowlists
- 🤝 Bot allowlist for automation workflows
- 📝 Works on both issues and pull requests
- 🆕 Trigger on issue/PR creation, not just comments
- 🔀 Automatically includes PR diffs for code review tasks
- 📦 Built on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) - no separate installation needed
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
      - uses: actions/checkout@v6

      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: '24'

      - name: Run pi-action
        uses: cv/pi-action@v2
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
| `timeout` | Seconds before the run is aborted (its thread is still saved) | No | `1800` |
| `poll_interval` | Seconds between checks for new comments while pi works | No | `15` |
| `provider` | LLM provider (anthropic, openai, google, etc.) | No | `anthropic` |
| `model` | Model ID | No | `claude-sonnet-5-5` |
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
| `compat_force_adaptive_thinking` | Use adaptive thinking for an Anthropic-compatible custom model (`provider_api: anthropic-messages`); required by Claude Opus 4.6+ and Sonnet 4.6+ | No | - |
| `prompt_template` | Custom prompt template with placeholder variables | No | (built-in default) |
| `output_mode` | `comment` to post on the issue/PR, or `output` to set action outputs only | No | `comment` |
| `prompt` | Direct prompt for the agent (use with `output_mode: output`, or with `pr_number`) | No | - |
| `pr_number` | Pull request number to load explicitly (useful for `workflow_dispatch`) | No | - |

### Examples

#### Restrict who can trigger pi

By default, only repository owners and organization members can trigger pi. To further restrict triggering to specific users:

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    allowed_users: 'alice,bob'
```

To allow outside collaborators too:

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    allowed_associations: 'OWNER,MEMBER,COLLABORATOR'
```

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
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

#### Custom trigger phrase

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    trigger_phrase: '@assistant'
```

#### Single custom provider/model

For one local or internal model, configure the provider/model directly with action inputs instead of committing a pi `models.json` file.

Example: NVIDIA-hosted `openai/openai/gpt-5.5` using the OpenAI Responses API:

```yaml
- uses: cv/pi-action@v2
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
- uses: cv/pi-action@v2
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
- uses: cv/pi-action@v2
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

#### Explicit PR review mode

Use `pr_number` to review a PR from `workflow_dispatch` or another workflow event that does not include PR payload context:

```yaml
- uses: cv/pi-action@v2
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

#### Reading a thread

A thread's history is its git log. Custom refs aren't fetched by default, so fetch it first:

```bash
git fetch origin 'refs/pi/threads/42:refs/pi/threads/42'
git log --oneline refs/pi/threads/42            # one commit per saved step
git show refs/pi/threads/42:batch.json | jq .   # what the latest step stored
```

Add `git config --add remote.origin.fetch '+refs/pi/*:refs/pi/*'` to fetch every thread on each `git fetch`.

#### Durable threads

Every issue or PR is one pi conversation, stored with [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) as a chain of git commits on `refs/pi/threads/<number>` in your repository (a custom ref: it doesn't show up as a branch). The storage backend is in [`src/storage`](src/storage).

- **Continuity**: a later `@pi` comment continues the same conversation, with everything pi saw and did before, on whatever runner picks it up. `pr_number` runs (e.g. `workflow_dispatch` reviews) join the PR's thread too; direct prompts without an issue or PR run in memory and store nothing.
- **Saved as it goes**: the ref is pushed after every model response and tool result, on cancellation (SIGINT/SIGTERM), and once more by the action's `if: always()` step. A run that was cut off resumes its unfinished work next time. Saving needs `contents: write`; without it the run still works and logs a warning.
- **Teams**: with the `concurrency` group above, runs for one thread never overlap. A run handles every `@pi` comment the thread hasn't answered yet, not just the one that triggered it, so comments whose queued run GitHub cancelled are still answered. Comments posted while pi works join the running conversation (checked every `poll_interval` seconds). Each answer, and each failure, is posted once.
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
2. The action validates the author against configured user, association, and bot allowlists (see [`src/security.ts`](src/security.ts))
3. An 👀 reaction is added to acknowledge the request
4. **Git hooks are installed** in the target repository to enforce commit conventions (see [`scripts/install-agent-hooks.js`](scripts/install-agent-hooks.js))
5. The thread's ref is fetched and its conversation reopened (see [`src/thread.ts`](src/thread.ts)); unfinished work from an earlier run resumes
6. Every unanswered `@pi` comment is submitted: the first one of a new thread with the issue/PR context (see [`src/context.ts`](src/context.ts)), later ones as follow-ups (see [`src/triggers.ts`](src/triggers.ts))
7. While pi works, new comments join the conversation and the ref is pushed at every turn (see [`src/conversation.ts`](src/conversation.ts))
8. Each answer is posted as a comment with a 🚀 reaction on the comments it answers (❌ and 😕 on failure); an empty answer is followed by one request for a summary
9. The thread is pushed; the `if: always()` step pushes again if the run was cut short

The main orchestration logic is in [`src/run.ts`](src/run.ts).

### Git Hooks for the Agent

The action automatically installs **lightweight, self-contained Node.js git hooks** ([defined in `scripts/install-agent-hooks.js`](scripts/install-agent-hooks.js)) in your repository before running the agent. These hooks have no package dependencies and work with any project stack as long as Node.js is available:

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
