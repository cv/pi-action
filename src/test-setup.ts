// Git hooks (e.g. the pre-commit test run) export GIT_DIR, GIT_INDEX_FILE and
// friends. Tests create their own scratch repositories, so drop anything that
// would point their git subprocesses back at this checkout.
for (const name of Object.keys(process.env)) {
	if (name.startsWith("GIT_")) {
		delete process.env[name];
	}
}
