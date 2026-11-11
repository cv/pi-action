# Contributing to pi-action

This document covers development setup, architecture details, and contribution guidelines for pi-action.

## Development Setup

### Prerequisites

- Node.js 20+
- npm

### Getting Started

```bash
# Clone the repository
git clone https://github.com/cv/pi-action.git
cd pi-action

# Install dependencies (also sets up git hooks)
npm install

# Run tests
npm test

# Run tests with coverage
npm test -- --coverage

# Build
npm run build

# Type check
npm run typecheck

# Lint and format
npm run check
```

## Git Hooks

This project uses [Husky](https://typicode.github.io/husky/) to enforce quality checks via git hooks. Hooks are automatically installed when you run `npm install`. See the [`.husky/`](.husky/) directory for hook scripts.

| Hook | What it does |
|------|--------------|
| [**pre-commit**](.husky/pre-commit) | Runs tests, type checking, linting, builds, and verifies `dist/` is up to date |
| [**commit-msg**](.husky/commit-msg) | Enforces [Conventional Commits](https://www.conventionalcommits.org/) format via commitlint |
| [**prepare-commit-msg**](.husky/prepare-commit-msg) | Auto-appends issue number from branch name (e.g., `feat/123-description` → `Refs #123`) |
| [**pre-push**](.husky/pre-push) | Runs full test suite with coverage thresholds (80% lines/functions, 70% branches) |

### Commit Message Format

Commits must follow the conventional commits format:

```
type(scope?): subject

body?

footer?
```

**Allowed types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

**Examples:**
```bash
git commit -m "feat: add webhook support"
git commit -m "fix(agent): handle empty response from API"
git commit -m "docs: update installation instructions"
```

### Branch Naming

Use branch names like `feat/123-description` or `fix/456-bug-name` to automatically link commits to issues via the `prepare-commit-msg` hook.

## Architecture

The action is built with TypeScript on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) and [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai). Each issue/PR is a durable conversation whose storage is a chain of git commits on `refs/pi/threads/<number>` (the backend is vendored from [cv/git-backed-pi-durable](https://github.com/cv/git-backed-pi-durable) in `src/vendor/`; edit it there and copy it over).

### Source Files

| File | Description |
|------|-------------|
| [`src/index.ts`](src/index.ts) | Entry point - wires up dependencies and runs the action |
| [`src/run.ts`](src/run.ts) | Main orchestration logic |
| [`src/thread.ts`](src/thread.ts) | One issue/PR as a durable pi conversation stored in git |
| [`src/triggers.ts`](src/triggers.ts) | Finding the `@pi` comments a thread still has to answer |
| [`src/models.ts`](src/models.ts) | Providers, credentials (`pi_auth_json`) and custom providers (`models_json`) |
| [`src/push.ts`](src/push.ts) | The `if: always()` step that pushes unsaved thread state |
| [`src/vendor/git-backed-pi-durable`](src/vendor/git-backed-pi-durable) | Git storage backend for pi-durable (vendored) |
| [`src/github.ts`](src/github.ts) | GitHub API client helpers |
| [`src/context.ts`](src/context.ts) | Prompt building and trigger extraction |
| [`src/security.ts`](src/security.ts) | Permission validation and input sanitization |
| [`src/formatting.ts`](src/formatting.ts) | Response formatting utilities |
| [`src/types.ts`](src/types.ts) | TypeScript type definitions |
| [`src/defaults.ts`](src/defaults.ts) | Centralized default values |
| [`src/utils.ts`](src/utils.ts) | General utility functions |
| [`src/test-helpers.ts`](src/test-helpers.ts) | Shared test utilities |

### Key Components

#### [`index.ts`](src/index.ts)
Entry point that reads GitHub Actions inputs, creates dependencies, and invokes `run()`. This is the only file with side effects (reading environment, calling APIs).

#### [`run.ts`](src/run.ts)
Main orchestration that:
1. Extracts trigger information from the GitHub payload and validates permissions
2. Sets up models and credentials
3. Opens the thread (fetching `refs/pi/threads/<number>`)
4. Submits every unanswered `@pi` comment, then polls for new ones while pi works
5. Posts each answer (or failure) once, and aborts at the timeout
6. Closes and pushes the thread

#### [`thread.ts`](src/thread.ts)
Wraps a pi-durable `Harness` on `GitStorage`:
- Fetches the thread ref, opens the conversation, resumes unfinished work
- Pushes the ref at every turn boundary (`GitSync`, fast-forward only)
- Submits comments with their GitHub ID as `requestId`, so each is answered once
- Records which results were posted, so a restarted run doesn't post them twice

#### [`github.ts`](src/github.ts)
Provides a clean interface to GitHub APIs:
- `extractTriggerInfo()`: Parses GitHub webhook payloads
- `GitHubClient`: Interface for reactions, comments, and PR diffs
- `addReaction()`: Helper to add reactions to comments or issues

#### [`context.ts`](src/context.ts)
Handles prompt construction:
- `hasTrigger()`: Checks if text contains the trigger phrase
- `extractTask()`: Extracts the task from trigger text
- `buildPrompt()`: Constructs the full prompt with context
- `renderTemplate()`: Renders custom prompt templates

#### [`security.ts`](src/security.ts)
Permission and input validation:
- `validatePermissions()`: Checks if user has write access or is an allowed bot
- `sanitizeInput()`: Removes HTML comments and invisible Unicode characters

### Action Configuration

The [`action.yml`](action.yml) file defines:
- Input parameters
- A composite action that:
  1. Installs npm dependencies
  2. Installs standalone git hooks for conventional commits
  3. Runs the action (`dist/index.js`)
  4. Pushes unsaved thread state in an `if: always()` step (`dist/push.js`)

### Testing

Tests use [Vitest](https://vitest.dev/) and are colocated with source files (`*.test.ts`).

**Running tests:**
```bash
npm test                    # Run once
npm run test:watch          # Watch mode
npm test -- --coverage      # With coverage report
```

**Test philosophy:**
- All business logic has near-100% test coverage
- Tests use dependency injection for easy mocking
- Mock the pi SDK to test agent integration without real API calls
- Use [`test-helpers.ts`](src/test-helpers.ts) for common mock factories

**Coverage thresholds (enforced by pre-push hook):**
- Lines: 80%
- Functions: 80%
- Branches: 70%

### Building

```bash
npm run build
```

This compiles TypeScript to `dist/`. The `dist/` directory is committed to the repository (required for GitHub Actions).

**Important:** The pre-commit hook verifies `dist/` is up to date. If you modify source files, you must rebuild and commit the changes to `dist/`.

## CI/CD

### GitHub Actions Workflows

- [**CI (`ci.yml`)**](.github/workflows/ci.yml): Runs on push/PR to main - type checking, linting, tests, build verification
- [**pi Assistant (`pi-assistant.yml`)**](.github/workflows/pi-assistant.yml): Dogfooding - uses the action from this repo to respond to `@pi` triggers

### Release Process

1. Ensure all tests pass and coverage thresholds are met
2. Update version in `package.json`
3. Create a new release/tag (e.g., `v1.0.1`)
4. Users reference the action via `cv/pi-action@v1`

## Code Style

- TypeScript with strict mode (see [`tsconfig.json`](tsconfig.json))
- [Biome](https://biomejs.dev/) for formatting and linting (see [`biome.json`](biome.json))
- No semicolons, tabs for indentation
- Prefer explicit types over inference for function signatures
- Use discriminated unions for result types (see [`AgentResult` in `types.ts`](src/types.ts))

## Pull Request Guidelines

1. **Create a branch** with a descriptive name: `feat/123-description` or `fix/456-bug-name`
2. **Write tests** for any new functionality
3. **Ensure all hooks pass** - tests, type checking, linting, coverage
4. **Follow conventional commits** for your commit messages
5. **Keep changes focused** - one feature/fix per PR
6. **Update documentation** if adding new features or changing behavior

## Questions?

Open an issue or start a discussion on the repository.
