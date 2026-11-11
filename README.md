# pi-action

pi-action runs a durable [pi](https://github.com/earendil-works/pi) coding agent on your GitHub issues and pull requests. Mention `@pi` in an issue, a pull request, or a comment, and pi does the task and posts its answer as a comment.

Each issue or pull request is one conversation (a **thread**). The thread continues across runs and runners, because pi-action stores it in your repository as git commits on `refs/pi/threads/<number>`. You do not need external storage.

## Features

- **One conversation per issue or pull request.** A later `@pi` comment continues the thread. pi keeps everything it saw and did before. The workflow log shows the git commands that [read the thread](docs/threads.md#read-a-thread). See [Durable threads](docs/threads.md).
- **Made for teams.** Comments that people post while pi works join the running conversation. The next run answers comments that a cancelled or queued run did not answer.
- **Safe by default.** Only repository owners and organization members can start pi. You can change this with allowlists for users, author associations, and bots. See [Security](docs/security.md).
- **Any model.** Use a built-in pi provider, a custom OpenAI- or Anthropic-compatible endpoint, or a provider from a pi extension. See [Models and authentication](docs/models.md).
- **Tools from pi-durable extensions.** Extensions such as [pit](https://github.com/cv/pit) add tools. When a tool asks a question, pi-action posts it on the issue, and an answer starts a new run. See [Extensions](docs/extensions.md).
- **Pull request context.** On a pull request, the first prompt includes the diff and the existing review comments.
- **Automation.** Use `output_mode: output` to get the answer as a step output, with no comments. See [Workflow recipes](docs/workflows.md).
- **Conventional commits.** pi-action installs git hooks that make the agent use [Conventional Commits](https://www.conventionalcommits.org/). See [How it works](docs/how-it-works.md#git-hooks-for-the-agent).

## Quick start

1. Add your LLM provider key as a repository secret, for example `ANTHROPIC_API_KEY`.
2. Create `.github/workflows/pi-assistant.yml` with this content:

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
       # One run per issue or pull request at a time (see docs/threads.md).
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

3. Write a comment that starts with `@pi`, for example `@pi explain what this function does`.

pi adds 👀 to your comment, does the task, and posts a `🤖 pi Response` comment. Then it adds 🚀 to your comment (😕 if the task failed).

The default model is `claude-sonnet-5-5` from `anthropic`. To use a different model, see [Models and authentication](docs/models.md).

## Inputs

Only `github_token` is necessary. All other inputs have a default or are optional. [`action.yml`](action.yml) defines the inputs, and [`src/defaults.ts`](src/defaults.ts) holds the defaults. Tests ([`src/action-docs.test.ts`](src/action-docs.test.ts) and [`src/defaults.test.ts`](src/defaults.test.ts)) make sure that the table below agrees with both files.

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `github_token` | GitHub token for the API (issues, pull requests, reactions, comments). The agent's tools also get it as `GH_TOKEN` (see [Security](docs/security.md#the-agents-github-token-and-git-identity)) | Yes | - |
| `api_key` | API key for the selected `provider`, for this run only. Provider environment variables are the preferred alternative (see [Models](docs/models.md#authentication)) | No | - |
| `trigger_phrase` | Text that starts pi. The match ignores case | No | `@pi` |
| `allowed_bots` | Comma-separated bot logins that can start pi | No | - |
| `allowed_users` | Comma-separated GitHub logins that can start pi. When set, only these users can start pi, and `allowed_associations` has no effect | No | - |
| `allowed_associations` | Comma-separated author associations that can start pi when `allowed_users` is empty | No | `OWNER,MEMBER` |
| `timeout` | Seconds before pi-action stops the run. pi-action saves the thread before it stops | No | `1800` |
| `poll_interval` | Seconds between checks for new comments while pi works | No | `15` |
| `provider` | LLM provider (`anthropic`, `openai`, `google`, a custom name, or a provider from an extension) | No | `anthropic` |
| `model` | Model ID | No | `claude-sonnet-5-5` |
| `provider_base_url` | Base URL of one custom provider and model. Set it to enable the `provider_*` and `model_*` inputs below (see [Models](docs/models.md#a-custom-provider-and-model)) | No | - |
| `provider_api` | API type of the custom provider | No | `openai-completions` |
| `provider_api_key` | Key of the custom provider: a literal key, or the name of an environment variable | No | - |
| `provider_auth_header` | Send `Authorization: Bearer <key>` to the custom provider | No | `false` |
| `model_name` | Display name of the custom model | No | - |
| `model_reasoning` | The custom model supports reasoning (thinking) | No | `false` |
| `model_input` | Comma-separated input types of the custom model (`text` or `text,image`) | No | `text` |
| `model_context_window` | Context window of the custom model, in tokens | No | `128000` |
| `model_max_tokens` | Maximum output tokens of the custom model | No | `16384` |
| `compat_supports_developer_role` | The OpenAI-compatible custom provider supports developer role messages | No | - |
| `compat_supports_reasoning_effort` | The OpenAI-compatible custom provider supports `reasoning_effort` | No | - |
| `compat_force_adaptive_thinking` | Use adaptive thinking for an Anthropic-compatible custom model (`provider_api: anthropic-messages`). Claude Opus 4.6+ and Sonnet 4.6+ need it | No | - |
| `extensions` | pi extensions and pi-durable extensions to load: npm package specs or workspace paths, one per line or comma-separated (see [Extensions](docs/extensions.md)) | No | - |
| `trust_project` | Let pi-durable extensions load and run the configuration of the repository (see [Extensions](docs/extensions.md#trust_project)) | No | `false` |
| `agent_dir` | Agent directory (user-level state) for pi-durable extensions, relative to the workspace | No | (a new temporary directory in `RUNNER_TEMP`) |
| `prompt_template` | Template for the first message of a new thread (see [Prompts](docs/prompts.md#custom-templates)) | No | (built-in prompt) |
| `output_mode` | `comment`: post to the issue or pull request. `output`: set the step outputs only | No | `comment` |
| `prompt` | Task for the agent. Without `pr_number`, it needs `output_mode: output` (see [Workflow recipes](docs/workflows.md#output-mode-and-direct-prompts)) | No | - |
| `pr_number` | Pull request to work on, for events without one (for example `workflow_dispatch`) | No | - |

### How pi-action reads input values

- Lists (`allowed_*`) are comma-separated. pi-action removes spaces around each item. Logins ignore case and a leading `@`. Associations ignore case.
- `extensions` accepts commas and new lines. pi-action ignores empty lines and `#` comments: a full line, or the rest of a line after a spec and a space.
- Boolean inputs accept `true`, `1`, `yes`, `y`, `on` and `false`, `0`, `no`, `n`, `off`, in any case.
- When a number or boolean input has a value that is not valid, pi-action uses the default.
- Any `output_mode` value other than `output` means `comment`.

## Outputs

pi-action sets these outputs only when `output_mode` is `output`:

| Output | Description |
|--------|-------------|
| `response` | The answer of the agent. When the run fails, the error message |
| `success` | `true` or `false` |

## Documentation

| Document | Contents |
|----------|----------|
| [Workflow recipes](docs/workflows.md) | Triggers, allowlists, a custom trigger phrase, output mode, and pull request reviews from `workflow_dispatch` |
| [Models and authentication](docs/models.md) | API keys, built-in providers, a custom provider, and providers from pi extensions |
| [Extensions](docs/extensions.md) | How pi-action loads pi extensions and pi-durable extensions, and how extensions ask questions on GitHub |
| [Prompts and templates](docs/prompts.md) | What pi receives, and how to change it with `prompt_template` |
| [Durable threads](docs/threads.md) | How pi-action stores, continues, reads, and deletes threads |
| [Security](docs/security.md) | Who can start pi, what the agent can access, and what to trust |
| [How it works](docs/how-it-works.md) | The steps of a run, and the git hooks for the agent |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, architecture, tests, and releases |

## License

MIT
