# Inputs and outputs

This page is the reference for the inputs and outputs of pi-action. Only `github_token` is necessary. All other inputs have a default or are optional.

[`action.yml`](../action.yml) defines the inputs. [`src/defaults.ts`](../src/defaults.ts) holds the defaults. Tests ([`src/action-docs.test.ts`](../src/action-docs.test.ts) and [`src/defaults.test.ts`](../src/defaults.test.ts)) make sure that the table below agrees with both files.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `github_token` | GitHub token for the API (issues, pull requests, reactions, comments). The agent's tools also get it as `GH_TOKEN` (see [Security](security.md#the-agents-github-token-and-git-identity)) | Yes | - |
| `api_key` | API key for the selected `provider`, for this run only. Provider environment variables are the preferred alternative (see [Models](models.md#authentication)) | No | - |
| `trigger_phrase` | Text that starts pi. The match ignores case | No | `@pi` |
| `allowed_bots` | Comma-separated bot logins that can start pi | No | - |
| `allowed_users` | Comma-separated GitHub logins that can start pi. When set, only these users can start pi, and `allowed_associations` has no effect | No | - |
| `allowed_associations` | Comma-separated author associations that can start pi when `allowed_users` is empty | No | `OWNER,MEMBER` |
| `timeout` | Seconds before pi-action stops the run. pi-action saves the thread before it stops | No | `1800` |
| `poll_interval` | Seconds between checks for new comments while pi works | No | `15` |
| `provider` | LLM provider (`anthropic`, `openai`, `google`, a custom name, or a provider from an extension) | No | `anthropic` |
| `model` | Model ID | No | `claude-sonnet-5-5` |
| `provider_base_url` | Base URL of one custom provider and model. Set it to enable the `provider_*` and `model_*` inputs below (see [Models](models.md#a-custom-provider-and-model)) | No | - |
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
| `extensions` | pi extensions and pi-durable extensions to load: npm package specs or workspace paths, one per line or comma-separated (see [Extensions](extensions.md)) | No | - |
| `trust_project` | Let pi-durable extensions load and run the configuration of the repository (see [Extensions](extensions.md#trust_project)) | No | `false` |
| `agent_dir` | Agent directory (user-level state) for pi-durable extensions, relative to the workspace | No | (a new temporary directory in `RUNNER_TEMP`) |
| `prompt_template` | Template for the first message of a new thread (see [Prompts](prompts.md#custom-templates)) | No | (built-in prompt) |
| `output_mode` | `comment`: post to the issue or pull request. `output`: set the step outputs only | No | `comment` |
| `prompt` | Task for the agent. Without `pr_number`, it needs `output_mode: output` (see [Workflow recipes](workflows.md#output-mode-and-direct-prompts)) | No | - |
| `pr_number` | Pull request to work on, for events without one (for example `workflow_dispatch`) | No | - |

### How pi-action reads input values

- Lists (`allowed_*`) are comma-separated. pi-action removes spaces around each item. Logins ignore case and a leading `@`. Associations ignore case.
- `extensions` accepts commas and new lines. pi-action ignores empty lines and lines that start with `#`.
- Boolean inputs accept `true`, `1`, `yes`, `y`, `on` and `false`, `0`, `no`, `n`, `off`, in any case.
- When a number or boolean input has a value that is not valid, pi-action uses the default.
- Any `output_mode` value other than `output` means `comment`.

## Outputs

pi-action sets these outputs only when `output_mode` is `output`:

| Output | Description |
|--------|-------------|
| `response` | The answer of the agent. When the run fails, the error message |
| `success` | `true` or `false` |
