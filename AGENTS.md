# Notes for agents

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you change this repository. In particular:

- **Commits.** Use Conventional Commits, as in [Commit messages](CONTRIBUTING.md#commit-messages). The `commitlint` job in [`ci.yml`](.github/workflows/ci.yml) checks every commit of a pull request with [`commitlint.config.js`](commitlint.config.js). `git commit --no-verify` does not skip it.
- **Checks.** Run `npm run check` before you push. CI runs the same command.
- **Docs.** Update the documentation when you change behavior. Follow the [documentation style](CONTRIBUTING.md#documentation-style).
