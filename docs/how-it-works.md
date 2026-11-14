# How it works

A run of pi-action checks the request, opens the thread of the issue or pull request, gives pi all requests that have no answer, posts each answer one time, and saves the thread. The main code is in [`src/run.ts`](../src/run.ts).

## The steps of a run

The action is a composite action ([`action.yml`](../action.yml)). Its steps are:

1. **Node.js.** If the Node.js of the job is older than version 24, the action installs Node.js 24.
2. **Dependencies.** The action installs its runtime npm dependencies (`npm ci --omit=dev --ignore-scripts`) in its own directory.
3. **The run** ([`src/index.ts`](../src/index.ts)). See [The run](#the-run).
4. **Save pi thread state** ([`src/push.ts`](../src/push.ts)). This step has `if: always()`. It pushes the thread (and its working-tree snapshots) if the run did not push all of it, for example after a cancellation, a timeout, or a crash.

The action does not change your checkout before the run. In particular, it installs no git hooks: pi follows the conventions of your repository. See [Commit conventions](#commit-conventions).

## The run

1. **Find the request** ([`src/run-context.ts`](../src/run-context.ts)). The request is `pr_number`, or a direct `prompt`, or the event. An event can be a new issue or pull request, a comment, or an answer to a question. pi-action ignores an event without the trigger phrase, and edits of comments other than questions.
2. **Check the author** ([`src/security.ts`](../src/security.ts)). See [Security](security.md#who-can-start-pi). If the author cannot start pi, the run stops and writes a warning to the log.
3. **Acknowledge.** In `comment` mode, pi-action adds 👀 to the comment, issue, or pull request that started the run.
4. **Load models, extensions, and context files** ([`src/models.ts`](../src/models.ts), [`src/extensions.ts`](../src/extensions.ts), [`src/context-files.ts`](../src/context-files.ts)). See [Models](models.md), [Extensions](extensions.md), and [The system prompt](prompts.md#the-system-prompt). pi-action reads the context files (`AGENTS.md` and the other names that pi uses) one time for each run. The system prompt is pi's: what pi is, its tools, its rules, the context files, the skills, and the working directory ([`src/builtin-extension.ts`](../src/builtin-extension.ts)).
5. **Open the thread** ([`src/thread.ts`](../src/thread.ts)). pi-action gets `refs/pi/threads/<number>` and `refs/pi/worktrees/<number>` into local refs under `refs/pi-action/` (see [Protection against conflicts](threads.md#protection-against-conflicts)), opens the conversation, and restores the files that the earlier run left uncommitted (see [Working-tree continuity](threads.md#working-tree-continuity)). If an earlier run did not complete its work, pi continues that work.
6. **Collect the requests** ([`src/triggers.ts`](../src/triggers.ts)). In `comment` mode, pi-action collects all `@pi` comments on the thread that have no answer, not only the comment of the event. The first request of a new thread gets the full context of the issue or pull request. Later requests are follow-ups. See [Prompts](prompts.md).
7. **Work** ([`src/conversation.ts`](../src/conversation.ts)). While pi works, pi-action adds new `@pi` comments to the conversation, and saves the working tree and pushes the thread after each model response and tool result. At `timeout`, pi-action stops pi and reports the timeout.
8. **Report.** For each request, pi-action posts a `🤖 pi Response` comment (or `❌ pi Error`), and adds 🚀 (or 😕) to the request. If pi gives an empty answer, pi-action asks one time for a summary. If a response hits the output token limit (`max_tokens`) without a tool call, pi-action asks pi to continue, up to 3 times in a row and within `timeout`, and then posts an error. In `output` mode, pi-action sets the `response` and `success` outputs and posts nothing.
9. **Save.** pi-action pushes the thread, and writes the git commands that read the thread to the job summary. See [Read a thread](threads.md#read-a-thread).

When a tool from a pi-durable extension asks a question, the run ends after step 7 without a `pi Response` comment. See [Questions on GitHub](extensions.md#questions-on-github).

## The workflow log

The log of the `Run pi-action` step shows what pi does while it works, one line for each step. Click a line with a `▸` to see its details. A run that answers one comment looks like this:

```text
▸ Setup
🤖 nvidia/aws/anthropic/bedrock-claude-opus-5-5 · thinking medium · tools: read, write, edit, bash, typescript · extensions: pit (typescript)
▸ 🧵 Thread refs/pi/threads/46: continuing, started 2026-11-12 07:11 UTC
▶ Request from @cv (https://github.com/o/r/issues/46#issuecomment-1): Ready to write a PR?
💬 I'll look at the existing sessions first.
🔧 bash: git log --oneline -5
▸   ↳ ✓ 0.1s · 5 lines
🔧 edit: src/run.ts (2 edits)
▸   ↳ ✓ 0.0s · 1 line
🔧 Read the run tests
▸   ↳ ✓ 0.1s · 412 lines
▸ 💬 I opened PR #48, which ...
✅ Replied: https://github.com/o/r/issues/46#issuecomment-2 (24 model responses · 23 tool calls · 6m40s · 2.1M tokens in, 31k out)
🧵 refs/pi/threads/46 is at 4325d9a
```

| Line | What it shows | Details (`▸`) |
|------|---------------|---------------|
| `Setup` | | The extensions, prompt templates, and [skills](skills.md) that pi-action loaded, and the variables that the tools of pi get |
| `🤖` | The model, its thinking level (see [Thinking](models.md#thinking)), the tools that it gets (see [Tools the model sees](extensions.md#tools-the-model-sees)), and the pi-durable extensions with their tools | |
| `🧵 Thread` | The thread ref, and if the thread is new or continues | The git commands that read the thread ([Read a thread](threads.md#read-a-thread)) |
| `▶` | A request that pi gets: who asked, where, and its first line. For a [prompt template](prompts.md#prompt-templates) or a [skill](skills.md#use-a-skill-explicitly), the line as typed and where it comes from | |
| `💬` | The text of a model response (its first line, if it is longer) | The full text |
| `🔧` | A tool call, when it starts. For a call with a label, such as a pit program with `// @pit: {"label": "..."}` as its first line, only the label. For other calls, the tool and its main argument (the command or the path). For a script of more than one line, the first line and the number of other lines
| `↳ ✓` or `↳ ✗ failed` | The end of a tool call: how long it took, and how many lines of output it gave | The arguments (a pit program without its `// @pit:` line, and long JSON values indented), and the last 30 lines of output |
| `✅ Replied` or `❌ Reported the error` | The comment, and totals for the reply: model responses, tool calls, time, tokens, and cost if the provider reports it | |
| `🧵 … is at` | The commit of the thread ref after the last push | |

pi-action writes each push of the thread and each snapshot of the working tree as debug messages. To see them, [enable step debug logging](https://docs.github.com/en/actions/how-tos/monitor-workflows/enable-debug-logging) and run the job again. Warnings and errors always show.

## Commit conventions

pi-action installs no git hooks and does not check commit messages. pi follows the conventions of your repository:

- Your own git hooks (for example from husky, lefthook, or prek) run when pi commits, if your workflow installs them before pi-action.
- Write your commit format in `AGENTS.md`. pi-action puts it into the system prompt (see [The system prompt](prompts.md#the-system-prompt)). pi reads other files, such as `CONTRIBUTING.md`, with its tools; link to them from `AGENTS.md`.
- To enforce a commit format, check it in your repository, for example with a CI job. pi can skip hooks with `git commit --no-verify`, so only a check outside the checkout enforces a format.
