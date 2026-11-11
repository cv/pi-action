# pi-action

pi-action runs a durable [pi](https://github.com/earendil-works/pi) coding agent on your GitHub issues and pull requests. Mention `@pi` in an issue, a pull request, or a comment, and pi does the task and posts its answer as a comment.

Each issue or pull request is one conversation (a **thread**). The thread continues across runs and runners, because pi-action stores it in your repository as git commits on `refs/pi/threads/<number>`. You do not need external storage.

## Features

- **One conversation per issue or pull request.** A later `@pi` comment continues the thread. pi keeps everything it saw and did before. See [Durable threads](docs/threads.md).
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

## Documentation

| Document | Contents |
|----------|----------|
| [Inputs and outputs](docs/inputs.md) | The reference for all action inputs and outputs, with their defaults |
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
