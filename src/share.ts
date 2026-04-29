import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import artifactClient, { type ArtifactClient } from "@actions/artifact";
import type { Session } from "./types.js";

export interface ShareResult {
	artifactName: string;
	artifactUrl: string;
	artifactId?: number;
}

export interface ShareSessionOptions {
	artifactName?: string;
	artifactClient?: Pick<ArtifactClient, "uploadArtifact">;
	runUrl?: string;
}

const GITHUB_REPOSITORY_ENV = "GITHUB_REPOSITORY";
const GITHUB_RUN_ID_ENV = "GITHUB_RUN_ID";
const GITHUB_SERVER_URL_ENV = "GITHUB_SERVER_URL";

function getRunUrl(): string | undefined {
	const serverUrl = process.env[GITHUB_SERVER_URL_ENV] ?? "https://github.com";
	const repository = process.env[GITHUB_REPOSITORY_ENV];
	const runId = process.env[GITHUB_RUN_ID_ENV];
	return repository && runId
		? `${serverUrl}/${repository}/actions/runs/${runId}`
		: undefined;
}

function getArtifactUrl(
	runUrl: string | undefined,
	artifactId: number | undefined,
): string | undefined {
	if (!(runUrl && artifactId)) {
		return runUrl;
	}
	return `${runUrl}/artifacts/${artifactId}`;
}

/**
 * Share a session as a GitHub Actions artifact and return its URL.
 * The artifact contains both HTML and JSONL exports of the pi session.
 */
export async function shareSession(
	session: Session,
	options: ShareSessionOptions = {},
): Promise<ShareResult | null> {
	const artifactName = options.artifactName ?? `pi-session-${Date.now()}`;
	const artifactDir = mkdtempSync(join(tmpdir(), `${artifactName}-`));
	const htmlPath = join(artifactDir, "session.html");
	const jsonlPath = join(artifactDir, "session.jsonl");
	const client = options.artifactClient ?? artifactClient;

	try {
		await session.exportToHtml(htmlPath);
		await session.exportToJsonl(jsonlPath);

		const upload = await client.uploadArtifact(
			artifactName,
			[htmlPath, jsonlPath],
			artifactDir,
		);
		const artifactUrl = getArtifactUrl(
			options.runUrl ?? getRunUrl(),
			upload.id,
		);

		return {
			artifactName,
			...(upload.id === undefined ? {} : { artifactId: upload.id }),
			artifactUrl: artifactUrl ?? artifactName,
		};
	} catch (error) {
		// Log error but don't fail the action
		console.warn("Failed to share session:", error);
		return null;
	} finally {
		rmSync(artifactDir, { recursive: true, force: true });
	}
}
