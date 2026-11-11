# Workflow recipes

This page shows how to start pi-action from different events, and how to control who can start it. Start with the workflow in the [quick start](../README.md#quick-start). Then change it with the recipes below. For all inputs, see [Inputs](../README.md#inputs).

## The parts of the standard workflow

The quick-start workflow has four parts. Each part has a purpose:

- **Events.** `issues` and `pull_request` (`opened`) start pi from a new issue or pull request. `issue_comment` and `pull_request_review_comment` (`created`) start pi from a comment. `issue_comment` `edited` delivers an answer to a question from a [pi-durable extension](extensions.md#questions-on-github).
- **The `if:` filter.** The filter starts the job only for text that contains `@pi`, for `/answer` replies, and for edits of pi's questions. Other events do not use a runner. pi-action does the full checks again, so the filter only saves runner time.
- **`concurrency`.** One group per issue or pull request, with `cancel-in-progress: false`. Runs on one thread do not overlap. See [Durable threads](threads.md#teams-and-concurrent-runs).
- **`permissions`.** `contents: write` lets the agent push code and lets pi-action save the thread. `issues: write` and `pull-requests: write` let pi-action post comments and reactions.

## Control who can start pi

By default, only repository owners and organization members can start pi (`allowed_associations: OWNER,MEMBER`). For the full rules, see [Security](security.md#who-can-start-pi).

To allow only some users, set `allowed_users`. When it is set, pi-action ignores `allowed_associations`:

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    allowed_users: 'alice,bob'
```

To also allow outside collaborators, add `COLLABORATOR`:

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    allowed_associations: 'OWNER,MEMBER,COLLABORATOR'
```

To allow bots such as Dependabot or Renovate, add their logins to `allowed_bots`. pi-action ignores bots that are not in this list:

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    allowed_bots: 'dependabot[bot],renovate[bot]'
```

## Use a different trigger phrase

Set `trigger_phrase`. Also change `'@pi'` in the `if:` filter of the job, because the filter runs before pi-action:

```yaml
jobs:
  pi-response:
    if: >-
      (github.event.action == 'edited' && contains(github.event.comment.body, '<!-- pi-action:question'))
      || (github.event.action != 'edited' && (contains(github.event.comment.body || github.event.issue.body || github.event.pull_request.body || '', '@assistant')
      || contains(github.event.comment.body || '', '/answer')))
    # ...
    steps:
      - uses: actions/checkout@v6
      - uses: cv/pi-action@v2
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          trigger_phrase: '@assistant'
```

## Start pi from comments only

To ignore new issues and pull requests, remove the `issues` and `pull_request` events:

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

This filter does not let through answers to questions from pi-durable extensions. If you use such extensions, keep `edited` in the `issue_comment` types, and keep the full `if:` filter of the quick start.

## Output mode and direct prompts

Use `output_mode: output` with `prompt` to run pi in an automation workflow. pi-action posts no comments and adds no reactions. The answer is in the `response` output:

```yaml
- uses: cv/pi-action@v2
  id: pi
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    output_mode: output
    prompt: Generate release notes for the current checkout
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

- run: echo "$PI_RESPONSE"
  env:
    PI_RESPONSE: ${{ steps.pi.outputs.response }}
```

Pass the output through an environment variable, as above. Do not put `${{ steps.pi.outputs.response }}` directly in a `run:` script: the text of the answer could then run as shell code.

A prompt without `pr_number` is a **direct prompt**. It has no issue or pull request, so pi-action keeps the conversation in memory and stores no thread. A direct prompt needs `output_mode: output`; in `comment` mode the step fails.

`output_mode: output` also works with the comment events of the standard workflow. Then pi-action answers only the comment of the event, sets the outputs, and stores the thread as usual.

## Review a pull request from `workflow_dispatch`

Use `pr_number` when the event has no pull request, for example `workflow_dispatch`. pi-action loads the title, description, diff, and review comments of the pull request. The run continues the [thread](threads.md) of that pull request:

```yaml
on:
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request to review
        required: true

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: write       # save the thread of the pull request
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v6
      - uses: cv/pi-action@v2
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          pr_number: ${{ github.event.inputs.pr_number }}
          prompt: Review this pull request. Find bugs and test gaps.
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

- Without `prompt`, the task is `Please review this pull request`.
- The diff and the description go into the first message of a new thread only. When the thread of the pull request exists, the run sends only the task as a [follow-up](prompts.md). pi can get the new diff with its tools.
- In `comment` mode (the default), pi-action posts the answer on the pull request. It adds no reactions, because no comment started the run.
- With `output_mode: output`, pi-action sets the outputs and posts nothing.
- `pr_number` has priority over the event: pi-action works on that pull request, whatever the event is.
