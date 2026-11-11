// Git hooks (e.g. the pre-commit test run) export GIT_DIR, GIT_INDEX_FILE and
// friends. Tests create their own scratch repositories, so drop anything that
// would point their git subprocesses back at this checkout.
for (const name of Object.keys(process.env)) {
	if (name.startsWith("GIT_")) {
		delete process.env[name];
	}
}

// CI runners have no global git identity; tests that run `git commit` need one.
process.env.GIT_AUTHOR_NAME = "pi-action tests";
process.env.GIT_AUTHOR_EMAIL = "tests@pi-action.invalid";
process.env.GIT_COMMITTER_NAME = "pi-action tests";
process.env.GIT_COMMITTER_EMAIL = "tests@pi-action.invalid";
