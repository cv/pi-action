# Security

The agent can do everything that the job can do. It can run commands, read the environment of the step, and use `github_token`. Thus, control two things: **who can start pi**, and **what the job can access**.

pi-action helps with these controls:

- It starts pi only for users and bots in the allowlists. By default: repository owners and organization members.
- It accepts answers to questions only from people who can start pi, or who can edit comments.
- It gives the agent only the GitHub permissions that you give `github_token`.

pi-action does **not** make text from GitHub safe for the model. Prompt injection in an issue, a pull request, or a diff is possible. Give the job only the permissions and secrets that the agent needs.

## Who can start pi

[`src/security.ts`](../src/security.ts) checks the author of each request:

1. A **bot** can start pi only when its login is in `allowed_bots`.
2. A **person** can start pi only when their login is in `allowed_users`, if `allowed_users` is set.
3. If `allowed_users` is empty, a person can start pi only when their author association is in `allowed_associations` (default `OWNER,MEMBER`).

pi-action does not allow collaborators by default. To allow outside collaborators, add `COLLABORATOR` to `allowed_associations`. For examples, see [Workflow recipes](workflows.md#control-who-can-start-pi).

pi-action does the same check for each comment that joins a running conversation, and for each missed comment that a run answers.

## Answers to questions

Questions from pi-durable extensions can get two types of answers. pi-action checks each type differently.

**A ticked box.** On GitHub, only people with write access to the repository can edit comments from other people. Thus, only they can tick the boxes of pi-action. pi-action also checks this itself. A tick counts only when all these conditions are true:

- The sender of the event has the `write`, `maintain`, or `admin` role (from `GET /repos/{owner}/{repo}/collaborators/{user}/permission`). If the check fails, pi-action ignores the tick.
- If `allowed_users` is set, the sender is in it.
- A bot sender is in `allowed_bots`. pi-action does not check the role of bots.
- The hidden marker (`<!-- pi-action:question <key> <kind> -->`) and the options are the same before and after the edit.
- A box changed from not ticked to ticked.
- The question has no answer yet.

**An `/answer` reply.** Anyone can write a comment. Thus, an `/answer` reply counts only when its author can [start pi](#who-can-start-pi).

## The agent's GitHub token and git identity

The tools of the agent (`bash`, and the tools of pi-durable extensions) get two things that a runner does not have. pi-action sets each one only if the workflow did not set it:

| Variable | Value | pi-action does not set it when |
|----------|-------|--------------------------------|
| `GH_TOKEN` | `github_token`, so that `gh` works | `GH_TOKEN` or `GITHUB_TOKEN` is set |
| `GIT_AUTHOR_NAME`, `GIT_COMMITTER_NAME` | `github-actions[bot]` | The variable is set, or git has `user.name` |
| `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_EMAIL` | `41898282+github-actions[bot]@users.noreply.github.com` | The variable is set, or git has `user.email` |

To commit as a different identity, set these variables in the `env` of the step. Or run `git config user.name` and `git config user.email` in an earlier step.

`bash` gets the variables in its environment only. pi-durable extensions run in the process of pi-action. Thus, when you load such an extension, pi-action also sets the variables in its own environment (after it installs the extensions).

The token is not new to the agent. `actions/checkout` already stores it in the git credentials of the checkout, where all tools can read it. `GH_TOKEN` only lets `gh` find it. **Give `github_token` only the permissions that the agent must have.**

## What pi-action removes from text

[`sanitizeInput()`](../src/security.ts) removes HTML comments (`<!-- ... -->`) and invisible characters (zero-width space, zero-width non-joiner, zero-width joiner, byte order mark, soft hyphen). People can use them to hide instructions.

pi-action applies it to:

- The text that contains the trigger phrase: the comment, or the body of an issue or pull request that started pi. This gives the task and `{{trigger_comment}}`.
- The title and the body of the issue or pull request (in the built-in prompt, and in `{{title}}` and `{{body}}`), also for `pr_number` runs.
- `/answer` replies, and the titles of questions.

pi-action does **not** apply it to the diff or to review comments. The model gets this text as it is on GitHub. Also, removing hidden text does not stop prompt injection in visible text.

## Extensions

An extension that you load with `extensions` runs inside pi-action, with the permissions and the environment of the job. It can read `github_token`, `api_key`, and all secrets in the `env` of the step. It can change your repository.

- Load only extensions that you trust.
- Pin npm versions (`name@1.2.3`) or git refs (`github:owner/repo#v1.2.3`).
- Prefer a copy that you reviewed and committed to the repository (a path).
- Keep `trust_project` off, unless you trust all people who can change the repository. See [Extensions](extensions.md#trust_project).

## Prompt templates from the repository

A [prompt template](prompts.md#prompt-templates) becomes the request of the user. Anyone who can push a branch can change the files in `.pi/prompts`. Thus, pi-action loads them only with `trust_project: true`. Without it, pi-action writes `Not loading the prompt templates in .pi/prompts: trust_project is off` to the log. Templates from `extensions` and from `agent_dir` load in all cases.

## Context files from the repository

The context files (`AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, and the other names that pi uses) go into the system prompt (see [Context files](prompts.md#context-files)). The system prompt has more weight for the model than a file that it reads. pi-action reads these files from the checkout, so their content is the content of the checked-out ref:

- **Pull requests from forks** (`pull_request` events whose head is in another repository): pi-action reads the files from the base commit of the pull request (`pull_request.base.sha`), and fetches it if the clone does not have it. If it cannot read the base commit, it loads no workspace files and writes a warning. The author of the fork cannot change the system prompt.
- **Pull requests from branches of the same repository:** pi-action uses the context files of the branch. People who can push a branch can already change the code that your workflow runs.
- pi-action removes invisible characters from the files, but keeps HTML comments, because `AGENTS.md` files use them.
- Set `context_files: false` to load no files.

## System prompt files from the repository

`.pi/SYSTEM.md` replaces pi's base system prompt, and `.pi/APPEND_SYSTEM.md` adds to it (see [System prompt files](prompts.md#system-prompt-files)). Anyone who can push a branch can change these files. Thus, pi-action loads them only with `trust_project: true`. Without it, pi-action writes `System prompt: not loading .pi/SYSTEM.md: trust_project is off` to the log.

- **Pull requests from forks:** pi-action never loads the files of the repository, also with `trust_project: true`, and writes `System prompt: not loading .pi/SYSTEM.md: this pull request comes from a fork`. It also skips the files of `agent_dir` when `agent_dir` is in the workspace.
- The files in `agent_dir` load in all other cases.
- Set `system_prompt_files: false` to load no files.

## Skills from the repository

A [skill](skills.md) is instructions that pi follows, and it can tell pi to run its scripts. Anyone who can push a branch can change the files in `.pi/skills` and `.agents/skills`. Thus, pi-action loads them only with `trust_project: true`. Without it, pi-action writes `Not loading the skills in .pi/skills: trust_project is off` to the log (with the directories that exist). Skills from `extensions`, `skills`, and `agent_dir` load in all cases. Pin the packages, as for [extensions](#extensions).

## Thread contents are visible

pi-action stores the full conversation in `refs/pi/threads/<number>`, also the output of tools. It stores the files that pi leaves uncommitted in `refs/pi/worktrees/<number>`, also untracked files that git does not ignore. All people who can read the repository can read these refs. The workflow log shows the arguments of each tool call and the last 30 lines of its output (see [The workflow log](how-it-works.md#the-workflow-log)); GitHub masks registered secrets in the log, but not in the refs. pi-action stops the runner from running workflow commands (such as `::error::` or `::add-mask::`) in the text of pi and in the output of tools. Keep secrets away from the agent, as for all CI jobs. Make git ignore files with secrets, or list them in `worktree_snapshot_exclude`. See [Durable threads](threads.md#read-a-thread) and [Working-tree continuity](threads.md#working-tree-continuity).
