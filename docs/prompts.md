# Prompts and templates

pi receives three kinds of messages. `prompt_template` changes only the first kind:

| Message | When | Content |
|---------|------|---------|
| **First message** | The first request of a new thread. A direct prompt always has a new thread | The built-in prompt, or your `prompt_template` |
| **Follow-up** | Each later request on the thread: an `@pi` comment, or a `pr_number` run | `**@login** commented (<url>):` and the task. For a review comment: `commented on the diff`. pi-action adds the URL when it has one. Then the [reply reminder](#the-reply) |
| **Answer** | An answer to a question from a pi-durable extension | `**@login** answered pi's question *<title>* (<url>): <answer>` (see [Extensions](extensions.md#questions-on-github)). Then the [reply reminder](#the-reply) |

A follow-up does not repeat the issue or the diff, because the thread already has them. Thus, when a pull request gets new commits, pi does not get a new diff automatically. Ask pi to look at the changes (for example, `@pi review the new commits`): its tools can run `git` and `gh`. See [Durable threads](threads.md).

## The task

The **task** is the text after the first occurrence of the trigger phrase, without spaces at the start and end. The match ignores case. For `@pi please review this`, the task is `please review this`.

Before pi-action finds the task, it removes HTML comments and invisible characters from the text. It does the same to the title and the body of the issue or pull request (see [Security](security.md#what-pi-action-removes-from-text)).

For a `pr_number` run, the task is `prompt`, or `Please review this pull request` when `prompt` is empty. For a direct prompt, the task is `prompt`.

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
