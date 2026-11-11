# Extensions

The `extensions` input loads two kinds of packages into pi-action:

- **pi extensions** give model **providers**. pi-action uses only the providers that they register. See [Providers](#providers).
- **pi-durable extensions** give **tools and prompt sections** to every conversation. Their tools can ask questions, which pi-action posts on the issue or pull request. See [pi-durable extensions](#pi-durable-extensions).

An extension is code that runs inside pi-action, with all the permissions of the job. Load only extensions that you trust. See [Security](security.md#extensions).

## Declare extensions

Write one extension per line, or separate them with commas. pi-action ignores empty lines and `#` comments. A comment can be a full line, or it can follow a spec after a space. The `#` in a git ref such as `github:owner/repo#v1.0.0` is not a comment, because no space comes before it:

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    extensions: |
      # pi-durable extensions
      github:cv/pit#v0.35.0          # pit's typescript tool
      # pi extensions (providers)
      @acme/pi-provider@1.4.2        # from npm, pinned
      ./.pi/extensions/gateway.ts    # in this repository
```

### Sources

- **npm package spec**: `name`, `name@1.2.3`, `@scope/name@^1`, `npm:name`, or `github:owner/repo#ref`.
- **Path**: a value that starts with `./`, `../`, `/`, or `~/`. pi-action resolves it against the workspace (or the home directory, for `~/`).
- pi-action does not support the `git:` sources of pi. Use the npm form `github:owner/repo#ref`.

### Installation

- pi-action installs npm packages into a new directory in `RUNNER_TEMP`, never into your repository. It runs `npm install --ignore-scripts --legacy-peer-deps --omit=dev`.
- npm does not get the `INPUT_*` variables of the action (`github_token`, `api_key`).
- Lifecycle scripts do not run. Thus, packages that need a build step or native modules do not work.
- pi-action does not install the pi packages of an extension (its `peerDependencies`). Imports of `@earendil-works/pi-ai`, `@earendil-works/pi-durable`, and `@earendil-works/chord` (and their subpaths) get the copies of pi-action. Thus, the extension and pi-action share one instance of each.
- pi-action loads paths where they are. It does not install them.
- pi-action runs TypeScript without a build step, with [jiti](https://github.com/unjs/jiti), as pi does.
- If an extension does not load, the run fails.

## Providers

pi-action finds the entry points of a pi extension as pi does:

1. The `pi.extensions` list in `package.json`.
2. If there is no list: the files in the `extensions/` directory (one level deep).
3. If there is no directory: `index.ts` or `index.js`.

From a pi extension, pi-action uses only `pi.registerProvider()`. Both forms work:

- A complete pi-ai `Provider`.
- A name and a config: `baseUrl`, `api`, `apiKey`, `headers`, `authHeader`, `models`, `streamSimple`, and `refreshModels`. If you register a built-in name with only `baseUrl` or `headers`, the built-in provider uses your gateway and keeps its models.

The `apiKey` of a provider config works as in pi: `$ENV_VAR`, `${ENV_VAR}`, `!command`, or a literal key. The `api_key` input has priority when it is set.

pi-action ignores these parts of a pi extension and writes a warning to the log:

- Tools, commands, event handlers, UI, flags, and all other features of the pi coding agent. The agent keeps the read, write, edit, and bash tools of pi-action.
- `oauth` logins, because they cannot run on a runner. Use an API key.
- Image models and classifier models.

To select a provider from an extension, see [Models](models.md#providers-from-pi-extensions).

## pi-durable extensions

A [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) extension adds its tools and prompt sections to every conversation: comment mode, `pr_number` runs, and direct prompts. An example is the `pit/durable` extension of [pit](https://github.com/cv/pit):

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    extensions: |
      github:cv/pit#v0.35.0   # pit's typescript tool (pit/durable)
```

### Package format

- A package is a pi-durable extension package when its `package.json` has `pi.durable`, a module path. Example: `"pi": { "durable": "./src/durable/index.ts" }`.
- The module exports `createPiDurableExtension(options)`, or a default export with the same signature.
- The function returns a pi-durable `Extension`: `{ name, tools?, sections?, hooks?, wraps?, tasks? }`.
- If a package has `pi.durable` and `pi.extensions`, pi-action loads only the `pi.durable` entry, because its pi extensions need the pi coding agent. pi-action writes this to the log.
- pi-action installs the extensions after its coding tools (read, write, edit, bash). Each extension must have a unique name.

### Host options

`createPiDurableExtension` receives `{ cwd, agentDir, trustProject, ui, log }`:

| Option | Value |
|--------|-------|
| `cwd` | The workspace |
| `agentDir` | `agent_dir`, resolved against the workspace. If `agent_dir` is empty: a new temporary directory in `RUNNER_TEMP` |
| `trustProject` | The `trust_project` input |
| `ui` | `{ ask, notify }`, the GitHub UI (see [Questions on GitHub](#questions-on-github)). Only in `comment` mode on an issue or pull request. Not set in `output` mode or for direct prompts |
| `log` | The log of the action (`info`, `warning`) |

pi-durable extensions run in the process of pi-action. Thus, pi-action also sets `GH_TOKEN` and the git identity in its own environment when it loads such an extension. See [Security](security.md#the-agents-github-token-and-git-identity).

### `trust_project`

`trust_project` (default `false`) tells the extension that it can load and run the configuration of the repository. For pit, this is `.pi/pit.json` and `.pi/functions`.

Anyone who can push a branch or open a pull request can change those files. Set `trust_project: true` only for repositories whose code you already run. Do not set it in workflows that run on pull requests from people you do not trust.

## Questions on GitHub

A tool can ask its user a question with `ui.confirm`, `ui.select`, or `ui.input`. (pit asks with its `ui.*` globals, and also when it promotes a function to the project.) pi-action posts the question as a comment on the issue or pull request, and **the run ends**. An answer starts a new run, which continues the thread.

pi-action does not wait for the answer, because people can take hours or days to answer.

### The sequence

1. The tool calls `ui.ask` of pi-action. pi-action posts the question and returns its URL immediately. pit stops the program (the calls that it made before the question keep their effects) and ends the turn with "Question posted: ...".
2. The run ends quietly. pi-action posts no `pi Response` comment. The log tells which question pi waits for. pi-action saves the thread as usual.
3. A person answers: they tick a box (an `issue_comment` `edited` event), or they reply `/answer ...` (an `issue_comment` `created` event). The answer starts a new run on the same thread.
4. pi-action checks who answered (see [Security](security.md#answers-to-questions)). It edits the question to show `✅ Answered: <answer> by @user`. It adds the answer to the conversation as a message to pi, together with a `ui.answer` entry. The message is `**@user** answered pi's question *<title>* (<url>): <answer>`.
5. pi runs its step again. When the program asks the same question, pit returns the answer and does not ask again. Each answer is used one time. If the program asks the same question later, pi-action asks again.

The workflow must listen to `issue_comment` `edited` events. Its `if:` filter must let these events and `/answer` replies through. Use the workflow of the [quick start](../README.md#quick-start). pi-action ignores edits of other comments.

### Kinds of questions

| Kind | The comment | How to answer | The value pit gets |
|------|-------------|---------------|--------------------|
| `confirm` | Two boxes: `- [ ] Yes` and `- [ ] No` | Tick one box | `true` for Yes, `false` for No |
| `select` | One box for each option (each option on one line) | Tick one box | The text of the option |
| `input` | A request for a reply | Write a comment that starts with `/answer`, for example `/answer release-2.1` | The text after `/answer` |

- For `confirm` and `select`, the first box that you tick is the answer. pi-action ignores ticks on a question that has an answer.
- An `/answer` reply goes to the `input` question that it quotes (GitHub's *Quote reply*). Without a quote, it goes to the oldest open `input` question. pi-action adds 👍 to the reply.
- pi-action never takes a question or an `/answer` reply as an `@pi` request, also when it contains `@pi`.

### Special cases

- **The same question two times.** While a question is open, pi-action does not post it again. pi waits for the open question.
- **A run that GitHub cancelled.** GitHub keeps only one pending run for each concurrency group. When more events for the issue come while a run works, GitHub can cancel the run for your answer. To answer again, untick and tick the box, or reply `/answer` again.
- **Notifications.** `ui.notify` writes to the log and to the job summary, not to comments.
