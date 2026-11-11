// The environment the agent's tools get on a runner: a token for gh, and a git identity for `git commit`.
import { execFile } from "node:child_process";

type Env = Readonly<Record<string, string | undefined>>;

/** The identity GitHub Actions commits as (the `github-actions[bot]` user). */
export const ACTIONS_BOT = {
	name: "github-actions[bot]",
	email: "41898282+github-actions[bot]@users.noreply.github.com",
} as const;

/** Reads one git config key in `cwd`; resolves undefined when it is unset. */
type GitConfigReader = (
	cwd: string,
	key: string,
	env: Env,
) => Promise<string | undefined>;

const readGitConfig: GitConfigReader = async (cwd, key, env) =>
	new Promise((resolve) => {
		execFile("git", ["config", "--get", key], { cwd, env }, (error, stdout) => {
			resolve(error ? undefined : stdout.trim() || undefined);
		});
	});

export interface ToolEnvOptions {
	/** The `github_token` input. */
	token: string | undefined;
	/** The workspace, whose git config may already have an identity. */
	cwd: string;
	/** The action's environment. */
	env: Env;
	/** Default: `git config --get` in `cwd` with `env`. */
	readConfig?: GitConfigReader | undefined;
}

const set = (value: string | undefined): boolean =>
	value !== undefined && value !== "";

/**
 * What the agent's tools need and the runner lacks, without overriding anything the workflow set: `GH_TOKEN` (the
 * `github_token` input) unless `GH_TOKEN` or `GITHUB_TOKEN` is set, and `GIT_AUTHOR_*`/`GIT_COMMITTER_*` as
 * `github-actions[bot]`, each unless it is set or git has `user.name` (or `user.email`) configured.
 */
export async function toolEnv(
	options: ToolEnvOptions,
): Promise<Record<string, string>> {
	const { token, cwd, env } = options;
	const readConfig = options.readConfig ?? readGitConfig;
	const vars: Record<string, string> = {};
	if (set(token) && !set(env["GH_TOKEN"]) && !set(env["GITHUB_TOKEN"])) {
		vars["GH_TOKEN"] = token ?? "";
	}
	const [name, email] = await Promise.all([
		readConfig(cwd, "user.name", env),
		readConfig(cwd, "user.email", env),
	]);
	for (const role of ["AUTHOR", "COMMITTER"]) {
		if (name === undefined && !set(env[`GIT_${role}_NAME`])) {
			vars[`GIT_${role}_NAME`] = ACTIONS_BOT.name;
		}
		if (email === undefined && !set(env[`GIT_${role}_EMAIL`])) {
			vars[`GIT_${role}_EMAIL`] = ACTIONS_BOT.email;
		}
	}
	return vars;
}
