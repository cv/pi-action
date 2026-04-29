import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "./types.js";

const GITHUB_REPOSITORY_ENV = "GITHUB_REPOSITORY";
const GITHUB_RUN_ID_ENV = "GITHUB_RUN_ID";
const GITHUB_SERVER_URL_ENV = "GITHUB_SERVER_URL";
const RUNNER_TEMP_ENV = "RUNNER_TEMP";

export interface ShareResult {
	artifactName: string;
	artifactUrl: string;
	artifactDir: string;
}

export interface ShareSessionOptions {
	artifactName?: string;
	artifactDir?: string;
	runUrl?: string;
}

function getRunUrl(): string | undefined {
	const serverUrl = process.env[GITHUB_SERVER_URL_ENV] ?? "https://github.com";
	const repository = process.env[GITHUB_REPOSITORY_ENV];
	const runId = process.env[GITHUB_RUN_ID_ENV];
	return repository && runId
		? `${serverUrl}/${repository}/actions/runs/${runId}`
		: undefined;
}

function getArtifactDir(): string {
	return join(process.env[RUNNER_TEMP_ENV] ?? tmpdir(), "pi-action-session");
}

/**
 * Export a session for the composite action's upload-artifact step.
 * The generated artifact directory contains both HTML and JSONL exports.
 */
export async function shareSession(
	session: Session,
	options: ShareSessionOptions = {},
): Promise<ShareResult | null> {
	const artifactName = options.artifactName ?? `pi-session-${Date.now()}`;
	const artifactDir = options.artifactDir ?? getArtifactDir();
	const htmlPath = join(artifactDir, "session.html");
	const jsonlPath = join(artifactDir, "session.jsonl");

	try {
		rmSync(artifactDir, { recursive: true, force: true });
		mkdirSync(artifactDir, { recursive: true });
		await session.exportToHtml(htmlPath);
		await session.exportToJsonl(jsonlPath);

		return {
			artifactName,
			artifactDir,
			artifactUrl: options.runUrl ?? getRunUrl() ?? artifactDir,
		};
	} catch (error) {
		// Log error but don't fail the action
		console.warn("Failed to share session:", error);
		rmSync(artifactDir, { recursive: true, force: true });
		return null;
	}
}
