# How it works

A run of pi-action checks the request, opens the thread of the issue or pull request, gives pi all requests that have no answer, posts each answer one time, and saves the thread. The main code is in [`src/run.ts`](../src/run.ts).

## The steps of a run

The action is a composite action ([`action.yml`](../action.yml)). Its steps are:

1. **Node.js.** If the Node.js of the job is older than version 24, the action installs Node.js 24.
2. **Dependencies.** The action installs its runtime npm dependencies (`npm ci --omit=dev --ignore-scripts`) in its own directory.
3. **Git hooks.** The action installs [git hooks for the agent](#git-hooks-for-the-agent) in your checkout.
4. **The run** ([`src/index.ts`](../src/index.ts)). See [The run](#the-run).
5. **Save pi thread state** ([`src/push.ts`](../src/push.ts)). This step has `if: always()`. It pushes the thread if the run did not push all of it, for example after a cancellation, a timeout, or a crash.

## The run

1. **Find the request** ([`src/run-context.ts`](../src/run-context.ts)). The request is `pr_number`, or a direct `prompt`, or the event. An event can be a new issue or pull request, a comment, or an answer to a question. pi-action ignores an event without the trigger phrase, and edits of comments other than questions.
2. **Check the author** ([`src/security.ts`](../src/security.ts)). See [Security](security.md#who-can-start-pi). If the author cannot start pi, the run stops and writes a warning to the log.
3. **Acknowledge.** In `comment` mode, pi-action adds 👀 to the comment, issue, or pull request that started the run.
4. **Load models and extensions** ([`src/models.ts`](../src/models.ts), [`src/extensions.ts`](../src/extensions.ts)). See [Models](models.md) and [Extensions](extensions.md).
5. **Open the thread** ([`src/thread.ts`](../src/thread.ts)). pi-action gets `refs/pi/threads/<number>` and opens the conversation. If an earlier run did not complete its work, pi continues that work.
6. **Collect the requests** ([`src/triggers.ts`](../src/triggers.ts)). In `comment` mode, pi-action collects all `@pi` comments on the thread that have no answer, not only the comment of the event. The first request of a new thread gets the full context of the issue or pull request. Later requests are follow-ups. See [Prompts](prompts.md).
7. **Work** ([`src/conversation.ts`](../src/conversation.ts)). While pi works, pi-action adds new `@pi` comments to the conversation, and pushes the thread after each model response and tool result. At `timeout`, pi-action stops pi and reports the timeout.
8. **Report.** For each request, pi-action posts a `🤖 pi Response` comment (or `❌ pi Error`), and adds 🚀 (or 😕) to the request. If pi gives an empty answer, pi-action asks one time for a summary. In `output` mode, pi-action sets the `response` and `success` outputs and posts nothing.
9. **Save.** pi-action pushes the thread.

When a tool from a pi-durable extension asks a question, the run ends after step 7 without a `pi Response` comment. See [Questions on GitHub](extensions.md#questions-on-github).

## Git hooks for the agent

Before the run, the action installs two git hooks in your checkout ([`scripts/install-agent-hooks.js`](../scripts/install-agent-hooks.js)). The hooks make the commits of the agent follow the conventions of this project. The hooks are small Node.js scripts without dependencies, so they work with all project types.

| Hook | What it does |
|------|--------------|
| `commit-msg` | Rejects a commit message that does not start with `type(scope): subject`. The types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `revert`. The scope is optional. The hook does not accept the `!` breaking-change marker (for example `feat!:`) |
| `prepare-commit-msg` | Adds `Refs #<number>` to the message. The number is the first number in the branch name (`fix/123-login` gives `Refs #123`). The hook does nothing when the message already contains `#<number>`, or when git gives a commit source. Git gives a commit source for `git commit -m` and `-F`, templates, merges, squashes, and amends. Thus, the hook adds the reference only when git opens an editor for the message |

- The action finds the hooks directory with `git rev-parse --git-path hooks`. Thus, it respects `core.hooksPath`.
- The action **never replaces a hook**. If a hook with the same name exists, the action does not install its hook.
- If the workspace is not a git repository, the action does not install hooks.
