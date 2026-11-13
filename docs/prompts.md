# Prompts and templates

pi receives three kinds of messages. `prompt_template` changes only the first kind:

| Message | When | Content |
|---------|------|---------|
| **First message** | The first request of a new thread. A direct prompt always has a new thread | The built-in prompt, or your `prompt_template` |
| **Follow-up** | Each later request on the thread: an `@pi` comment, or a `pr_number` run | `**@login** commented (<url>):` and the task. For a review comment: `commented on the diff`. pi-action adds the URL when it has one. Then the [reply reminder](#the-reply) |
| **Answer** | An answer to a question from a pi-durable extension | `**@login** answered pi's question *<title>* (<url>): <answer>` (see [Extensions](extensions.md#questions-on-github)). Then the [reply reminder](#the-reply) |

A follow-up does not repeat the issue or the diff, because the thread already has them. Thus, when a pull request gets new commits, pi does not get a new diff automatically. Ask pi to look at the changes (for example, `@pi review the new commits`): its tools can run `git` and `gh`. See [Durable threads](threads.md).

## The system prompt

pi-action sends the system prompt of pi's coding agent (pi 1.5.2, `buildSystemPromptSections`), in pi's order. The built-in `pi-action` extension makes the sections 1 to 7. Each section is tagged as `<key>…</key>`, except `preamble`:

1. `preamble`: `You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.` A [`SYSTEM.md`](#system-prompt-files) replaces the sections 1 to 3 with its text, as an untagged `preamble`.
2. `tools`: one line for each tool that the model is offered and that has a prompt snippet, then `Additional tools may be available.` If no tool has a snippet: `(none)`.
3. `rules`: pi's rules for the offered tools, then `Be concise in your responses` and `Show file paths clearly when working with files`.
4. `addendum`: the text of [`APPEND_SYSTEM.md`](#system-prompt-files). It is not there when there is no such file.
5. `project_context`: the [context files](#context-files) of the repository. Set `context_files: false` to remove it.
6. `available_skills`: the [skills](skills.md#the-system-prompt) that pi can use. It is not there when no skill is listed.
7. `cwd`: the working directory of the agent, such as `/home/runner/work/xyz/xyz`.
8. The sections of the pi-durable extensions, in the order of `extensions` (for example pit's guidelines). See [Extensions](extensions.md#pi-durable-extensions).

pi-action leaves out pi's `docs` section, because it has no pi documentation. Extensions can change each section with `wrapSection(key, …)` (see [Override tools and sections](extensions.md#override-tools-and-sections)).

### Tools and rules

The `tools` and `rules` sections show the tools that the model is offered: after `exclude_tools`, `model_tools_hidden`, and the wraps of the extensions (see [Tools the model sees](extensions.md#tools-the-model-sees)). With the default tools, they are:

```text
<tools>
- read: Read file contents
- write: Create or overwrite files
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- bash: Execute bash commands (ls, grep, find, etc.)

Additional tools may be available.
</tools>

<rules>
- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed.
- Use write only for new files or complete rewrites.
- Use edit for targeted changes. Batch changes to one file in a single call.
- Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.
- Be concise in your responses
- Show file paths clearly when working with files
</rules>
```

- **Snippets and guidelines.** pi-action has pi's text for `read`, `write`, `edit`, and `bash`, and pit's snippet for `typescript`. pi's bash guideline about `PI_*` variables is not there, because pi-action does not set them. pit's guidelines are in its own `pit_guidelines` section, so `rules` does not repeat them. A tool of an extension can set `promptSnippet` (a string) and `promptGuidelines` (a list of strings), as pi's tools do. These replace pi-action's text for the tool.
- **The bash rule.** `Use bash for file operations like ls, rg, find` is there only when the model has `bash` and no `grep`, `find`, or `ls` tool.
- **pit only.** When pit hides the coding tools, `tools` lists only `typescript`, and `rules` has only pi's two general rules.

### The prompt cache

The tools of a run do not change, and pi-action reads the context files, the system prompt files, and the skills one time for each run. Thus, each section has the same text in all requests of a run, and the prompt cache of the provider stays valid.

A thread from an earlier version of pi-action gets the new sections in its next request. Because the new sections come before the sections that the thread already has, pi-durable removes the sections and adds them again in the new order, one time.

### Context files

pi-action loads context files as pi's coding agent does. In each directory, it loads the first of these files that exists: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`. It skips a directory with one of these names.

1. **Global:** the file in `agent_dir`. Only when `agent_dir` is set.
2. **Workspace:** the file in each directory from the workspace root (`GITHUB_WORKSPACE`) down to the working directory of the agent. Today, the working directory is the workspace root. pi-action never reads files above the workspace.
3. **Nested files** below the working directory (for example `packages/api/AGENTS.md`) are not loaded. The section lists their paths (up to 20, one for each directory) and tells pi to read the one for the directory where it works. pi-action finds them with `git ls-files`, so it ignores the files that git ignores.

The section has pi's layout: one `<project_instructions>` block for each file, with its content trimmed. pi-action's notes come after the files: the nested files, the files cut or left out at the size limit, and the base commit of a pull request from a fork. The section looks like this:

```text
<project_context>
Project-specific instructions and guidelines:

<project_instructions path="/home/runner/work/xyz/xyz/AGENTS.md">
<file contents>
</project_instructions>

More context files: packages/api/AGENTS.md. Read the one for the directory you work in.
</project_context>
```

A thread from an earlier version of pi-action, with the old `# Project Context` layout, gets one `Updated system prompt section "project_context"` in its next run.

- **Size.** `context_files_max_bytes` (default 64 KiB) limits all files together. pi-action cuts the file at the limit, adds a note for pi, leaves out later files, and writes a warning to the log.
- **Text.** pi-action removes invisible characters, as for the issue body (see [Security](security.md#what-pi-action-removes-from-text)). It keeps HTML comments.
- **One read for each run.** pi-action reads the files when the run starts. If pi changes `AGENTS.md` during the run, the system prompt stays the same, and the prompt cache of the provider stays valid. The next run on the thread sends the new content as an update of the section.
- **Pull requests from forks.** pi-action reads the files from the base commit of the pull request, not from the checkout. See [Security](security.md#context-files-from-the-repository).
- **The log.** The setup group shows the files, for example `Context files: AGENTS.md (2.1 KiB)`.

### System prompt files

As in pi's coding agent, two files change the system prompt:

| File | Effect |
|------|--------|
| `SYSTEM.md` | Replaces pi's own sections (`preamble`, `tools`, and `rules`) with one untagged `preamble` that has the text of the file. The other sections stay. Wraps of `tools` and `rules` by extensions then do nothing |
| `APPEND_SYSTEM.md` | Becomes the `addendum` section, after `rules` and before `project_context` |

pi-action finds each file as pi does. It uses the first one of these that exists and is not empty:

1. **Project:** `<working directory>/.pi/SYSTEM.md` (or `APPEND_SYSTEM.md`), **only with `trust_project: true`**, and not on a pull request from a fork. See [Security](security.md#system-prompt-files-from-the-repository).
2. **User:** `<agent_dir>/SYSTEM.md` (or `APPEND_SYSTEM.md`). Only when `agent_dir` is set. On a pull request from a fork, pi-action skips it when `agent_dir` is in the workspace.

- **Size.** `context_files_max_bytes` (default 64 KiB) limits each file. pi-action cuts a file at the limit, and writes a warning to the log.
- **Text.** pi-action removes invisible characters (also a BOM), as for the [context files](#context-files).
- **One read for each run.** If pi changes a file during the run, the system prompt stays the same.
- **Turn it off.** Set `system_prompt_files: false` to load neither file.
- **The log.** The setup group shows the files, for example `System prompt: .pi/SYSTEM.md (1.2 KiB, replaces pi's base prompt)` and `System prompt: appended agent_dir/APPEND_SYSTEM.md (300 B)`. For a project file that it skips, it writes the reason, for example `System prompt: not loading .pi/SYSTEM.md: trust_project is off`.

## The task

The **task** is the text after the first occurrence of the trigger phrase, without spaces at the start and end. The match ignores case. For `@pi please review this`, the task is `please review this`.

Before pi-action finds the task, it removes HTML comments and invisible characters from the text. It does the same to the title and the body of the issue or pull request (see [Security](security.md#what-pi-action-removes-from-text)).

For a `pr_number` run, the task is `prompt`, or `Please review this pull request` when `prompt` is empty. For a direct prompt, the task is `prompt`.

A task that starts with `/<name>` can be a [prompt template](#prompt-templates). A task that starts with `/skill:<name>` uses a [skill](skills.md#use-a-skill-explicitly).

## Prompt templates

When the task starts with `/<name>`, and a prompt template has that name, pi-action replaces the task with the template. This works as in pi's CLI. For example, `@pi /pit-reflect focus` gives pi the text of `pit-reflect.md`, with `focus` as its argument.

pi-action loads templates from these places, in this sequence:

1. The `pi.prompts` files and directories of each package in `extensions`, in the order of the input. This includes packages with a pi-durable extension.
2. `.pi/prompts/*.md` in the repository, **only with `trust_project: true`**. See [Security](security.md#prompt-templates-from-the-repository).
3. `<agent_dir>/prompts/*.md`, when `agent_dir` is set.

The name of a template is its file name without `.md`. When two templates have the same name, the first one wins, and pi-action writes a warning. The log of the setup lists the templates.

pi-action removes the frontmatter of the template (`description`, `argument-hint`), and replaces these variables with the arguments after `/<name>`:

| Variable | Value |
|----------|-------|
| `$1` … `$9` | One argument. Empty when there is no such argument |
| `$ARGUMENTS`, `$@` | All arguments, separated by spaces |
| `${@:N}` | The arguments from argument N |
| `${@:N:L}` | L arguments from argument N |
| `${ARGUMENTS:-default}` | All arguments, or `default` when there are none |

- Spaces separate the arguments. Quotes (`"..."`, `'...'`) keep spaces in one argument.
- pi-action replaces all variables in one pass. A `$1` in an argument stays as it is.
- pi-action expands templates in the [task](#the-task) of the first message (also `{{task}}` in `prompt_template`), of each follow-up, and in `prompt` (for `pr_number` runs and direct prompts). It does not expand answers to questions.
- A `/<name>` that no template has stays as it is.
- The log shows the request as it was typed, for example `▶ Request from @alice: /pit-reflect focus (prompt template from pit)`. The thread keeps the typed text in the `typed` field of the comment entry, and the name in `template`.

## The built-in prompt

For an issue or a pull request, the built-in first message has these parts, in this sequence:

1. `# GitHub Issue #<number>` or `# GitHub Pull Request #<number>`.
2. `## Title` and `## Description`: the title and body of the issue or pull request.
3. Pull requests only: `## Existing PR Review Comments`, when the pull request has review comments.
4. `## Task`: the task.
5. `output_mode: comment` only: `## Your Reply`, which tells pi not to post its reply itself (see [The reply](#the-reply)).
6. `## Important: Artifact and Script Requirements`: an instruction to commit and push all work, because the runner and its files are deleted after the run.
7. Pull requests only: `## PR Diff`, the diff of the pull request.

For a direct prompt, the message has `# Direct pi Task`, the task, and the requirements block.

## The reply

In `output_mode: comment`, pi-action posts pi's final response as a comment. pi's tools have the token as `GH_TOKEN`, so pi can also post comments with `gh`. If pi posted its reply itself, the issue would get the same answer twice. Thus, pi-action tells pi not to do this:

- The built-in first message has a `## Your Reply` section.
- Each follow-up and each answer ends with this reminder: _(pi-action posts your final response as a comment here. Don't also post it with `gh`.)_ Threads that began before this reminder existed get it too.

In `output_mode: output`, the reply goes to the `response` output, and the messages do not have this text. A [custom template](#custom-templates) replaces the `## Your Reply` section too, but follow-ups and answers still get the reminder.

## Custom templates

`prompt_template` replaces the **complete** built-in first message. pi-action does not add the requirements block to your template. If you want pi to commit and push its work, write this in your template.

pi-action uses the built-in prompt when `prompt_template` is empty or has only spaces.

### Variables

| Variable | Value | Example |
|----------|-------|---------|
| `{{type}}` | `issue`, `pull_request`, or `direct` | `issue` |
| `{{type_display}}` | `Issue`, `Pull Request`, or `Direct Task` | `Pull Request` |
| `{{number}}` | Number of the issue or pull request. `0` for a direct prompt | `42` |
| `{{title}}` | Title of the issue or pull request, without HTML comments and invisible characters. `Direct prompt` for a direct prompt | `Fix login bug` |
| `{{body}}` | Body of the issue or pull request, without HTML comments and invisible characters. Empty for a direct prompt | The full description |
| `{{task}}` | The [task](#the-task) | `please review this code` |
| `{{diff}}` | Diff of the pull request. Empty for issues and direct prompts | A unified diff |
| `{{reviewComments}}` | The `## Existing PR Review Comments` section. Empty when there are none, and for issues | A Markdown section |
| `{{trigger_comment}}` | The full text that contains the trigger phrase, after pi-action removes HTML comments and invisible characters. The task, for `pr_number` runs and direct prompts | `@pi please review this code` |

### Rules

- pi-action replaces `{{name}}` with the value of the variable. Names are case-sensitive.
- pi-action does not change unknown variables. For example, `{{author}}` stays `{{author}}`.
- pi-action inserts values as they are, in one pass. If an issue body contains `{{diff}}`, the text `{{diff}}` stays in the message.
- There are no conditions or loops (for example `{{#if}}`). An empty variable gives empty text. Thus, `{{diff}}` in a template for issues is harmless. To use different templates for issues and pull requests, use different workflows.

## Template examples

### Code review

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt_template: |
      # Code review for PR #{{number}}: {{title}}

      ## Description
      {{body}}

      {{reviewComments}}

      ## Request
      {{task}}

      ## Changes
      ```diff
      {{diff}}
      ```

      ## Review guidelines
      - Look for security vulnerabilities.
      - Make sure that tests cover the changes.
      - Make sure that the code follows our style guide.
      - Identify performance problems.
      - Suggest improvements.
```

### Issue triage

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt_template: |
      # {{type_display}} triage: {{title}}

      ## Details
      {{body}}

      ## Request
      {{task}}

      ## Triage guidelines
      - Classify the issue: bug, feature, or enhancement.
      - Estimate the priority and the severity.
      - Identify the components that the issue affects.
      - Suggest labels and assignees.
      - If applicable, give the first troubleshooting steps.
```

### Security review

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt_template: |
      # Security review: {{title}}

      ## Request
      {{task}}

      ## Details
      {{body}}

      ## Changes
      {{diff}}

      ## Checklist
      - Input validation and sanitization
      - Authentication and authorization
      - Encryption and storage of data
      - SQL injection
      - Cross-site scripting (XSS)
      - Cross-site request forgery (CSRF)
      - Vulnerable dependencies
      - Management of secrets
```

### Work that pi must commit

Because a template replaces the requirements block, add your own instruction when pi must change files:

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt_template: |
      # {{type_display}} #{{number}}: {{title}}

      {{body}}

      ## Task
      {{task}}

      ## Requirements
      The runner is deleted after this run. Commit and push all changes before you finish.
```

## Troubleshooting

| Problem | Cause and solution |
|---------|--------------------|
| A variable is not replaced | The name is not correct. Names are case-sensitive: use `{{type_display}}`, not `{{Type_Display}}` |
| pi does not commit its work | A template does not include the requirements block. Add an instruction (see [the example](#work-that-pi-must-commit)) |
| A later comment does not use the template | This is correct. The template is only for the first message of a new thread. Later comments are [follow-ups](#prompts-and-templates) |
| The template has no effect | The template is empty or has only spaces, so pi-action uses the built-in prompt |
