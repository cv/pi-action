// A pi-action run inside a pi-action run (the agent's tools ran src/index.ts) works on the same thread refs as the run
// around it, and breaks that run: its storage finds its local ref moved. So a run marks its own environment, which
// every tool and child process inherits, and a run that finds the mark stops before it does anything.

/** Set to the process ID of the run while pi-action runs. */
export const RUNNING_ENV = "PI_ACTION_RUNNING";

type Env = Record<string, string | undefined>;

/** Why this process must not run: it runs inside a pi-action run. Undefined outside one. */
export function nestedRun(env: Readonly<Env>): string | undefined {
	const outer = env[RUNNING_ENV];
	if (outer === undefined || outer === "") {
		return undefined;
	}
	return `pi-action is already running in this job (${RUNNING_ENV}=${outer}). A run started from the agent's tools would change the thread of the run around it, so this one does nothing`;
}

/** Marks `env` (the process environment) as inside this run; when it already is, returns why the run must stop. */
export function claimRun(
	env: Env,
	pid: number = process.pid,
): string | undefined {
	const nested = nestedRun(env);
	if (nested === undefined) {
		env[RUNNING_ENV] = String(pid);
	}
	return nested;
}
