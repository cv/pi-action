import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubClient } from "./github.js";
import type { Session } from "./types.js";

export interface ShareResult {
	gistUrl: string;
	previewUrl: string;
}

/**
 * Share a session as an HTML gist and return the preview URL.
 * The session is exported to HTML, uploaded as a secret gist, and a preview URL is returned.
 *
 * @param session The agent session to share
 * @param githubClient The GitHub client for gist creation
 * @param description Optional description for the gist
 * @returns ShareResult with URLs, or null if sharing fails
 */
export async function shareSession(
	session: Session,
	githubClient: GitHubClient,
	description = "pi-action session",
): Promise<ShareResult | null> {
	const tmpFile = join(tmpdir(), `pi-session-${Date.now()}.html`);

	try {
		// Export session to HTML
		await session.exportToHtml(tmpFile);

		// Read the HTML content
		const htmlContent = readFileSync(tmpFile, "utf-8");

		// Create secret gist
		const gistUrl = await githubClient.createGist(
			htmlContent,
			"session.html",
			description,
			false, // secret gist
		);

		// Extract gist ID from URL (should be a proper GitHub gist URL)
		const gistIdMatch = gistUrl.match(/github\.com\/[^/]+\/([a-f0-9]+)$/);
		if (!gistIdMatch) {
			return null;
		}
		const gistId = gistIdMatch[1];

		return {
			gistUrl,
			previewUrl: `https://shittycodingagent.ai/session?${gistId}`,
		};
	} catch (error) {
		// Log error but don't fail the action
		console.warn("Failed to share session:", error);
		return null;
	} finally {
		// Clean up temp file
		try {
			unlinkSync(tmpFile);
		} catch {
			// Ignore cleanup errors
		}
	}
}
