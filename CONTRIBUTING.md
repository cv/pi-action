# Contributing to pi-action

To contribute, make a branch, change the code and its tests, and open a pull request. `npm run check` must pass: CI runs it on each pull request. This page tells you how to set up, what the checks do, and where the code is.

For how the action works for users, see the [documentation](README.md#documentation).

## Set up

You need Node.js 24 or later, and npm.

```bash
git clone https://github.com/cv/pi-action.git
cd pi-action
npm install        # also installs the git hooks of this repository
```

## Commands

| Command | What it does |
|---------|--------------|
| `npm test` | Runs the tests one time |
| `npm run test:watch` | Runs the tests when files change |
| `npm run coverage` | Runs the tests and checks the coverage thresholds |
| `npm run build` | Type-checks the production code (no output files) |
| `npm run typecheck` | Type-checks the production code, then all code with the tests |
| `npm run lint` | oxlint, the oxfmt format check, and actionlint for the workflows |
| `npm run analyze` | knip (unused code and dependencies) and jscpd (duplicate code) |
| `npm run check` | All of the above: `typecheck`, `lint`, `coverage`, and `analyze`. CI runs this command |
| `npm run fix` | Applies safe format and lint fixes |

## Git hooks of this repository

`npm install` installs the hooks with [prek](https://github.com/j178/prek). [`.pre-commit-config.yaml`](.pre-commit-config.yaml) configures them.

| Hook | What it does |
|------|--------------|
| `pre-commit` | Runs `npm test` and `npm run lint` |
| `commit-msg` | Checks the message with commitlint ([`commitlint.config.js`](commitlint.config.js)) |
| `prepare-commit-msg` | Adds `Refs #<number>` from the branch name, with [`scripts/prepare-commit-msg.js`](scripts/prepare-commit-msg.js). For example, `feat/123-description` gives `Refs #123`. Git skips this when you use `git commit -m` or `-F` (see [the agent's hooks](docs/how-it-works.md#git-hooks-for-the-agent), which work the same way) |
| `pre-push` | Runs `npm run coverage` |

These hooks are for development of pi-action. The action installs different hooks for the agent in the repositories of users. See [How it works](docs/how-it-works.md#git-hooks-for-the-agent).

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
type(scope): subject

body

footer
```

- The scope, the body, and the footer are optional.
- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- Write the type in lowercase. Do not end the subject with a period. Keep the first line at 100 characters or less.

```bash
git commit -m "feat: add webhook support"
git commit -m "fix(agent): handle empty response from API"
git commit -m "docs: update installation instructions"
```

### Branch names

Use names such as `feat/123-description` or `fix/456-bug-name`. The number links the commits to the issue.

## Architecture

pi-action is TypeScript on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) and [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai). Each issue or pull request is a durable conversation, stored as git commits on `refs/pi/threads/<number>`. For the steps of a run, see [How it works](docs/how-it-works.md).

### Design rules

- **One file has side effects.** [`src/index.ts`](src/index.ts) reads the environment and creates the GitHub client. All other code gets its dependencies as parameters (`ActionDependencies` in [`src/run.ts`](src/run.ts)), so tests can replace them.
- **No build step.** Node.js runs the TypeScript directly (type stripping). There is no `dist/`. Thus, imports use `.ts` extensions, and the code uses only erasable syntax (no enums, namespaces, or parameter properties). `erasableSyntaxOnly` in [`tsconfig.json`](tsconfig.json) enforces this.
- **Values from outside are `unknown`.** Check JSON, GitHub payloads, and git output before you use them. Do not cast them.

### Source files

| File | Contents |
|------|----------|
| [`src/index.ts`](src/index.ts) | Entry point: creates the dependencies and calls `run()` |
| [`src/run.ts`](src/run.ts) | Orchestration of a run |
| [`src/run-context.ts`](src/run-context.ts) | What a run works on: an event, `pr_number`, or a direct prompt |
| [`src/inputs.ts`](src/inputs.ts) | Reads the action inputs into `ActionInputs`, with the defaults for empty or invalid values |
| [`src/defaults.ts`](src/defaults.ts) | The default values of the inputs |
| [`src/security.ts`](src/security.ts) | The allowlist check (`validatePermissions()`) and `sanitizeInput()` |
| [`src/github.ts`](src/github.ts) | `extractTriggerInfo()` for webhook payloads, and the `GitHubClient` interface |
| [`src/triggers.ts`](src/triggers.ts) | Finds the `@pi` comments that a thread must answer |
| [`src/context.ts`](src/context.ts) | The task, the built-in prompt, templates, and follow-up messages |
| [`src/formatting.ts`](src/formatting.ts) | The comments that pi-action posts, and review comments as prompt context |
| [`src/thread.ts`](src/thread.ts) | One issue or pull request as a durable pi conversation in git |
| [`src/conversation.ts`](src/conversation.ts) | Submits requests, waits within the timeout, and delivers each result one time |
| [`src/models.ts`](src/models.ts) | The built-in providers, with the `api_key` input as an in-memory credential |
| [`src/custom-provider.ts`](src/custom-provider.ts) | The custom provider from the `provider_*` and `model_*` inputs |
| [`src/extensions.ts`](src/extensions.ts) | The `extensions` input: npm installation, entry points, loading with jiti, and the `pi` object |
| [`src/extension-provider.ts`](src/extension-provider.ts) | Changes `pi.registerProvider(name, config)` into a pi-ai provider |
| [`src/durable-extensions.ts`](src/durable-extensions.ts) | Creates the pi-durable extensions (`pi.durable`) with the host options of the run |
| [`src/github-ui.ts`](src/github-ui.ts) | Questions (`ui.ask`) as GitHub comments, and `ui.notify` in the job summary |
| [`src/answers.ts`](src/answers.ts) | Answers from the event (a ticked box or an `/answer` reply), checked and changed into a `ui.answer` submission |
| [`src/tool-env.ts`](src/tool-env.ts) | `GH_TOKEN` and the `github-actions[bot]` git identity for the tools of the agent |
| [`src/push.ts`](src/push.ts) | The `if: always()` step that pushes thread state that the run did not push |
| [`src/storage/git.ts`](src/storage/git.ts) | Git objects in the process, and compare-and-swap ref updates |
| [`src/storage/git-storage.ts`](src/storage/git-storage.ts) | `GitStorage`: a pi-durable `Storage` whose log is a chain of commits on one ref |
| [`src/storage/sync.ts`](src/storage/sync.ts) | `GitSync`: fetches a thread ref, and pushes it (fast-forward only) at turn boundaries |
| [`src/types.ts`](src/types.ts) | Shared types |
| [`src/utils.ts`](src/utils.ts) | Small helpers |
| [`src/test-helpers.ts`](src/test-helpers.ts) | Test fixtures: inputs, a fake GitHub client, faux models, and scratch git repositories |
| [`src/test-setup.ts`](src/test-setup.ts) | Removes `GIT_*` variables (for example from a git hook) and sets a git identity for the tests |
| [`scripts/install-agent-hooks.js`](scripts/install-agent-hooks.js) | Installs the git hooks for the agent |
| [`scripts/prepare-commit-msg.js`](scripts/prepare-commit-msg.js) | The `prepare-commit-msg` hook of this repository |
| [`scripts/lint-actions.mjs`](scripts/lint-actions.mjs) | Runs actionlint on `.github/workflows` |

[`action.yml`](action.yml) defines the inputs, the outputs, and the steps of the composite action.

## Tests

The tests use [Vitest](https://vitest.dev/). They are next to the code (`src/**/*.test.ts`, `scripts/**/*.test.js`).

- **No network, real git.** The tests use the faux provider of pi-ai instead of a real model, and a fake GitHub client from [`src/test-helpers.ts`](src/test-helpers.ts). They run git in scratch repositories, with a bare repository as the remote.
- **Extension fixtures** are in [`test/fixtures/extensions/`](test/fixtures/extensions/):
  - [`echo-provider`](test/fixtures/extensions/echo-provider/) registers a provider on the faux provider of pi-ai. It tests the `extensions` input end to end.
  - [`durable-ask`](test/fixtures/extensions/durable-ask/) is a pi-durable extension package. Its tool asks two questions as pit does: `ui.ask`, then `ui.answer` entries in later runs.
- **Documentation tests.** [`src/action-docs.test.ts`](src/action-docs.test.ts) and [`src/defaults.test.ts`](src/defaults.test.ts) compare [`docs/inputs.md`](docs/inputs.md) with `action.yml` and `src/defaults.ts`. [`src/docs.test.ts`](src/docs.test.ts) checks the links in all Markdown files, the template variables in [`docs/prompts.md`](docs/prompts.md), and the `extensions:` examples.
- **Coverage thresholds** ([`vitest.config.ts`](vitest.config.ts)): statements 90%, lines 90%, functions 90%, branches 85%. `npm run coverage` and the `pre-push` hook enforce them.

## Code style

- TypeScript with all strict compiler options (see [`tsconfig.json`](tsconfig.json)), and only erasable syntax.
- [oxlint](https://oxc.rs/docs/guide/usage/linter) with type-aware rules (see [`.oxlintrc.json`](.oxlintrc.json)). All rule categories are errors, except the experimental `nursery` category. From `nursery`, only `typescript/no-unnecessary-condition` is on. The config groups the rules that are off, with the reason. Warnings fail the build. An `oxlint-disable` comment that does not suppress anything also fails the build.
- To turn off a rule for one line, write `oxlint-disable-next-line <rule> -- <reason>`. Always give the reason.
- [oxfmt](https://oxc.rs/docs/guide/usage/formatter) formats the code and JSON, and sorts imports (see [`.oxfmtrc.json`](.oxfmtrc.json)). Format Markdown and YAML by hand.

### Documentation style

- Put the main point first, then the details (the pyramid principle).
- Use short sentences, the active voice, and the imperative for instructions ([ASD-STE100](https://www.asd-ste100.org/) where it applies).
- Write each fact in one place, and link to it from other places.
- Make sure that each claim agrees with the code. If possible, add a test.

## CI workflows

| Workflow | What it does |
|----------|--------------|
| [`ci.yml`](.github/workflows/ci.yml) | Runs `npm run check` on pushes and pull requests to `main` |
| [`pi-assistant.yml`](.github/workflows/pi-assistant.yml) | Uses the action of this checkout to answer `@pi` requests in this repository |
| [`pi-direct-dogfood.yml`](.github/workflows/pi-direct-dogfood.yml) | `workflow_dispatch`: runs a direct prompt in `output` mode |
| [`pi-pr-review-dogfood.yml`](.github/workflows/pi-pr-review-dogfood.yml) | `workflow_dispatch`: reviews a pull request with `pr_number` in `output` mode |

## Releases

1. Make sure that `npm run check` passes on `main`.
2. Change `version` in `package.json`. Commit with the message `chore: release X.Y.Z`.
3. Tag the commit `vX.Y.Z`.
4. Move the major tag (`v2`) to the same commit. Users refer to the action as `cv/pi-action@v2`.

## Pull requests

1. Make a branch with a descriptive name, such as `feat/123-description`.
2. Write tests for new behavior.
3. Make sure that all hooks and `npm run check` pass.
4. Use Conventional Commits.
5. Keep the change small: one feature or one fix in each pull request.
6. Update the documentation when you add features or change behavior.

## Questions

Open an issue or start a discussion in the repository.
