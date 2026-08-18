# Contributing to pi-action

This document covers development setup, architecture details, and contribution guidelines for pi-action.

## Development Setup

### Prerequisites

- Node.js 25+
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
npm run coverage

# Build
npm run build

# Type check
npm run typecheck

# Lint and format check
npm run check

# Apply safe lint/format fixes
npm run fix
```

## Git Hooks

This project uses [prek](https://github.com/j178/prek) to enforce quality checks via git hooks. Hooks are configured in [`.pre-commit-config.yaml`](.pre-commit-config.yaml) and are automatically installed when you run `npm install`.

| Hook | What it does |
|------|--------------|
| **pre-commit** | Runs tests, type checking, and linting |
| **commit-msg** | Enforces [Conventional Commits](https://www.conventionalcommits.org/) format via commitlint |
| **prepare-commit-msg** | Auto-appends issue number from branch name via [`scripts/prepare-commit-msg.sh`](scripts/prepare-commit-msg.sh) (e.g., `feat/123-description` → `Refs #123`) |
| **pre-push** | Runs full test suite with coverage thresholds from [`vitest.config.ts`](vitest.config.ts) |

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

The action is built with TypeScript and uses the [pi-coding-agent SDK](https://github.com/mariozechner/pi-coding-agent) directly.

### Source Files

| File | Description |
|------|-------------|
| [`src/index.ts`](src/index.ts) | Entry point - wires up dependencies and runs the action |
| [`src/run.ts`](src/run.ts) | Main orchestration logic |
| [`src/agent.ts`](src/agent.ts) | pi SDK integration |
| [`src/github.ts`](src/github.ts) | GitHub API client helpers |
| [`src/inputs.ts`](src/inputs.ts) | GitHub Actions input parsing helpers |
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

#### [`inputs.ts`](src/inputs.ts)
Pure helpers for parsing GitHub Actions inputs (CSV allowlists, booleans, and positive integer timeouts). Kept separate from `index.ts` so input behavior can be unit tested without loading the GitHub Actions runtime.

#### [`run.ts`](src/run.ts)
Main orchestration that:
1. Uses provider credentials from environment variables or the runtime-only `api_key` input
2. Extracts trigger information from the GitHub payload
3. Validates permissions
4. Builds the pi context/prompt
5. Runs the agent
6. Posts results as comments

#### [`agent.ts`](src/agent.ts)
Wraps the pi SDK to:
- Discover or use provided auth/model registry
- Create an agent session with appropriate settings
- Subscribe to streaming responses
- Handle timeouts (using [`withTimeout`](src/utils.ts) utility)
- Return success/error results

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
- `validatePermissions()`: Checks the author against configured user, association, and bot allowlists
- `sanitizeInput()`: Removes HTML comments and invisible Unicode characters

### Action Configuration

The [`action.yml`](action.yml) file defines:
- Input parameters
- A composite action that:
  1. Installs npm dependencies
  2. Installs standalone git hooks for conventional commits (see [`scripts/install-agent-hooks.sh`](scripts/install-agent-hooks.sh))
  3. Runs the TypeScript entrypoint via `tsx`

### Testing

Tests use [Vitest](https://vitest.dev/) and are colocated with source files (`*.test.ts`).

**Running tests:**
```bash
npm test                    # Run once
npm run test:watch          # Watch mode
npm run coverage            # With coverage report
```

**Test philosophy:**
- All business logic has near-100% test coverage
- Tests use dependency injection for easy mocking
- Mock the pi SDK to test agent integration without real API calls
- Use [`test-helpers.ts`](src/test-helpers.ts) for common mock factories

**Coverage thresholds (enforced by pre-push hook):**
- Statements: 90%
- Lines: 90%
- Functions: 90%
- Branches: 85%

Thresholds and production coverage includes are configured in [`vitest.config.ts`](vitest.config.ts).

### Building

```bash
npm run build
```

This verifies the TypeScript production entrypoint without emitting JavaScript. The action runs TypeScript directly with `tsx`, so generated `dist/` artifacts are not committed.

## CI/CD

### GitHub Actions Workflows

- [**CI (`ci.yml`)**](.github/workflows/ci.yml): Runs on push/PR to main - type checking, linting, and tests
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
