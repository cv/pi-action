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
- 🧩 Loads model providers from [pi extensions](https://github.com/earendil-works/pi) on npm or in your repository
- 🛠️ Loads [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) extensions (tools for the conversation), and asks their questions on the issue/PR: a ticked box or an `/answer` reply continues the conversation in a new run
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
    types: [created, edited] # edited: a box ticked on a question from a pi-durable extension
  pull_request_review_comment:
    types: [created]

jobs:
  pi-response:
    # @pi requests, /answer replies, and edits of pi's questions (not other edited comments).
    if: >-
      (github.event.action == 'edited' && contains(github.event.comment.body, '<!-- pi-action:question'))
      || (github.event.action != 'edited' && (contains(github.event.comment.body || github.event.issue.body || github.event.pull_request.body || '', '@pi')
      || contains(github.event.comment.body || '', '/answer')))
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

#### The agent's GitHub token and git identity

The agent's tools (`bash`, and the tools of pi-durable extensions) get two things a runner lacks, each only if the workflow hasn't set it:

- **`GH_TOKEN`**, set to `github_token`, so `gh` works. It is left alone when `GH_TOKEN` or `GITHUB_TOKEN` is already in the environment.
- **A git identity** for `git commit`: `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME` `github-actions[bot]` and `GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL` `41898282+github-actions[bot]@users.noreply.github.com`. Each is left alone when it is set, or when git has `user.name` (for the names) or `user.email` (for the emails) configured. To commit as someone else, set those variables in the step's `env` or run `git config user.name/user.email` in an earlier step.

`bash` gets them in its environment only. pi-durable extensions run inside the action, so when there are any, the action sets the variables in its own process environment too (after installing the extensions). The token isn't new to the agent: `actions/checkout` already stores it in the checkout's git credentials, where any tool can read it; this just lets `gh` find it. Give `github_token` only the permissions the agent should have.

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
| `model_max_tokens` | Max output tokens for the custom model (reasoning counts toward it). A response that hits it with no tool call is continued, up to 3 times in a row and within `timeout`; partial text is posted, marked as cut off. If it keeps hitting the limit, pi posts an error that says so: raise this value, up to the provider's limit for the model | No | `16384` |
| `compat_supports_developer_role` | Whether OpenAI-compatible custom provider supports developer role messages | No | - |
| `compat_supports_reasoning_effort` | Whether OpenAI-compatible custom provider supports `reasoning_effort` | No | - |
| `compat_force_adaptive_thinking` | Use adaptive thinking for an Anthropic-compatible custom model (`provider_api: anthropic-messages`); required by Claude Opus 4.6+ and Sonnet 4.6+ | No | - |
| `extensions` | pi extensions whose model providers `provider`/`model` can select, and pi-durable extensions whose tools pi gets: npm package specs or workspace paths, one per line or comma-separated (see [Providers from pi extensions](#providers-from-pi-extensions) and [pi-durable extensions](#pi-durable-extensions)) | No | - |
| `trust_project` | Let pi-durable extensions trust the repository and run its own configuration (see [pi-durable extensions](#pi-durable-extensions)) | No | `false` |
| `agent_dir` | Agent directory (user-level state) for pi-durable extensions, relative to the workspace | No | (a temp dir under `RUNNER_TEMP`) |
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

#### Providers from pi extensions

A provider that ships as a [pi extension](https://github.com/earendil-works/pi) (an extension that calls `pi.registerProvider()`) can be loaded with `extensions`, then selected with `provider` and `model`:

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    extensions: |
      @acme/pi-provider@1.4.2
      ./.pi/extensions/gateway.ts
    provider: acme
    model: acme-large
  env:
    ACME_API_KEY: ${{ secrets.ACME_API_KEY }}
```

- **Sources**: an npm package spec (`name`, `name@1.2.3`, `@scope/name@^1`, `npm:name`, `github:owner/repo#ref`), or a path starting with `./`, `../` or `/`, relative to the workspace. pi's `git:` sources aren't supported; use npm's `github:` form.
- **Installation**: npm packages are installed with `npm install --ignore-scripts --legacy-peer-deps --omit=dev` into a fresh directory under `RUNNER_TEMP`, never into your repository. Lifecycle scripts don't run, so packages that need a build step or native modules won't work. pi's own packages (the `peerDependencies` of a pi package) aren't installed: imports of `@earendil-works/pi-ai` (and its subpaths) get the action's copy, as they get pi's in pi. Paths load in place, with no install.
- **Entry points**: found as pi finds them: the package's `pi.extensions` manifest, else its `extensions/` directory, else `index.ts`/`index.js`. TypeScript runs without a build step (with [jiti](https://github.com/unjs/jiti), as in pi).
- **What is used**: providers only. Both forms of `pi.registerProvider()` work: a complete pi-ai `Provider`, or a name and config (`baseUrl`, `api`, `apiKey`, `headers`, `authHeader`, `models`, `streamSimple`, `refreshModels`). Registering a built-in name with only `baseUrl`/`headers` points that provider at a gateway and keeps its models.
- **Keys**: `apiKey` is read as in pi (`$ENV_VAR`, `${ENV_VAR}`, `!command`, or a literal); the `api_key` input, when set, takes precedence.
- **Not supported**: tools, commands, event handlers, UI, flags, and everything else an extension can do in pi's coding agent are ignored, with a warning in the log; the agent keeps pi-action's read, write, edit and bash tools. OAuth logins (`oauth`) can't run on a runner, so use an API key. Image and classifier models are skipped. An extension that fails to load fails the run.

**Security**: an extension is code that runs inside the action, with the job's permissions and environment: it can read the `github_token`, `api_key` and every secret in the step's `env`, and act on your repository. Load only extensions you trust, pin npm versions (`name@1.2.3`), and prefer reviewing a pinned copy committed to the repository (a path). npm itself runs without the action's `INPUT_*` variables.

#### pi-durable extensions

A package that ships a [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) extension, such as [pit](https://github.com/cv/pit)'s `pit/durable`, adds its tools and prompt sections to every conversation. List it in `extensions` like any other:

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    extensions: |
      github:cv/pit#v0.35.0   # pit's typescript tool (pit/durable)
```

- **Discovery**: a package whose `package.json` has `pi.durable` (a module path, such as `"pi": { "durable": "./src/durable/index.ts" }`) is a pi-durable extension package. Its module exports `createPiDurableExtension(options)` (or a default export with the same signature), which returns a pi-durable `Extension` (`{ name, tools?, sections?, hooks?, wraps?, tasks? }`). A package with both `pi.durable` and `pi.extensions` loads only its pi-durable entry (its pi extensions need pi's coding agent), and says so in the log.
- **Loading**: as for pi extensions (same install, TypeScript without a build step). Imports of `@earendil-works/pi-durable` and `@earendil-works/chord` (and their subpaths) get the action's copies, so the extension shares the host's instances.
- **Host options**: `createPiDurableExtension` receives `{ cwd, agentDir, trustProject, ui, log }`, where `ui` is `{ ask, notify }` (an asynchronous host; see below): the workspace; `agent_dir` (resolved against the workspace) or a fresh temp directory under `RUNNER_TEMP`; `trust_project`; the GitHub UI below, in comment mode on an issue or PR (omitted in output mode and for direct prompts); and the action's log (`info`, `warning`).
- **Installation into the conversation**: the extensions are installed after pi-action's coding tools (read, write, edit, bash), for every conversation: comment mode, `pr_number` runs and direct prompts. Their names must be unique.
- **`trust_project`** (default `false`) tells the extension it may load and run the repository's own configuration (for pit: `.pi/pit.json` and `.pi/functions`). Anyone who can push a branch or open a PR can change those files, so turn it on only for repositories whose code you would run anyway, and never for workflows that run on untrusted PRs.

##### Questions on GitHub

People don't watch issues, so a question may take hours or days to answer, and nothing waits for it. When an extension asks its user something (`ui.confirm`, `ui.select`, `ui.input`; pit's `ui.*` globals, or pit itself, as when it promotes a function to the project), pi-action posts the question as a comment on the issue or PR and **the run ends**:

1. pit asks pi-action's `ui.ask`, which posts the question and returns its URL at once. pit stops the program (calls it made before asking keep their effects) and ends the turn with "Question posted: ...".
2. The run ends quietly: no pi Response comment, and the log says which question pi is waiting for. The thread is saved as usual.
3. Someone answers: ticks a box (an `issue_comment` `edited` event) or replies `/answer ...` (`created`). That starts a new run on the same thread. pi-action checks who answered, edits the question to show `✅ Answered: <answer> by @user`, and adds the answer to the conversation as a message to pi (`**@user** answered pi's question *<title>* (<url>): <answer>`) together with a `ui.answer` entry.
4. pi continues: it runs its step again, and when the program asks the same question, pit returns the answer instead of asking. Each answer is used once; asking the same question again later asks anew.

The workflow must listen to `issue_comment` `edited` events, and its `if:` must let them (and `/answer` replies) through; see the snippet in [Basic Setup](#basic-setup). Edits of other comments are ignored.

- **`confirm` and `select`**: the comment has a task list (`- [ ] Yes`, `- [ ] No`, or one box per option). Tick a box to answer; the first box ticked counts, and later ticks on an answered question are ignored. `confirm` answers `true` for Yes and `false` for No; `select` answers the option (options are shown on one line).
- **`input`**: reply with a comment that starts with `/answer`, such as `/answer release-2.1`. The text after `/answer` is the answer, to the oldest open `input` question, or to the one the reply quotes (GitHub's *Quote reply*). It counts from someone allowed to run pi (`allowed_users`, `allowed_associations`, `allowed_bots`); pi reacts 👍 to it. Questions and `/answer` replies are never `@pi` requests, even when they mention `@pi`.
- **The same question twice**: while a question is open, asking it again doesn't post a second comment; pi waits for the open one.
- **A ticked box whose run was cancelled**: GitHub keeps one pending run per concurrency group, so if more events for the issue arrive while a run works, the answer's run may be cancelled. Untick and tick the box again (or reply `/answer` again) to answer.
- **`notify`**: notifications go to the log and the job summary, not to comments.

**Trust model**: GitHub lets only people with write access to the repository edit someone else's comment, so only they can tick pi-action's boxes. pi-action checks it anyway: a tick counts only when the event's sender has the `write`, `maintain` or `admin` role (`GET /repos/{owner}/{repo}/collaborators/{user}/permission`) and, when `allowed_users` is set, is in it; bots must be in `allowed_bots`. Each question carries a hidden marker (`<!-- pi-action:question <key> <kind> -->`, with pit's key for the question); an edit counts only when the marker and the options are the same before and after it, a box went from unticked to ticked, and the question isn't answered yet. `/answer` replies can come from anyone, so they count only from people allowed to run pi.

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
- **Safety net**: pushes are fast-forward only. If two runs ever race on one thread, the later push is rejected (and logged) instead of overwriting the other's history, and that run stops pushing. Other push failures (a network error, or GitHub answering `[remote rejected] ... (failed)`) are retried after 1, 3 and 10 seconds; if those fail too, the warning is logged and the next turn's push tries again.
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

The agent's tools get `github_token` as `GH_TOKEN` and a `github-actions[bot]` git identity when the workflow sets neither (see [the agent's GitHub token and git identity](#the-agents-github-token-and-git-identity)), so the token's permissions are the agent's. pi extensions loaded with `extensions` run with the job's permissions; see [Providers from pi extensions](#providers-from-pi-extensions). For pi-durable extensions, keep `trust_project` off unless you trust everyone who can change the repository, and see [Questions on GitHub](#questions-on-github) for who can answer their questions.

Input is sanitized to remove:
- HTML comments (potential injection vectors)
- Invisible Unicode characters

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture details, and contribution guidelines.

## License

MIT
