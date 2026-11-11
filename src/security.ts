import type { GitHubUser } from "./types.ts";

/** Who may run pi, from the allowed_* inputs. */
export interface Allowlists {
	allowedBots: string[];
	allowedUsers: string[];
	allowedAssociations: string[];
}

const LEADING_AT_PATTERN = /^@/u;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/gu;
const INVISIBLE_CHARACTERS_PATTERN = /\u200B|\u200C|\u200D|\uFEFF|\u00AD/gu;

const normalizeLogin = (login: string): string =>
	login.trim().replace(LEADING_AT_PATTERN, "").toLowerCase();

const normalizeAssociation = (association: string): string =>
	association.trim().toUpperCase();

function includesLogin(logins: string[], login: string): boolean {
	const normalized = normalizeLogin(login);
	return logins.some((allowed) => normalizeLogin(allowed) === normalized);
}

/**
 * Bots must be in allowed_bots. People must be in allowed_users when it is set, and otherwise have one of the
 * allowed_associations.
 */
export function validatePermissions(
	author: GitHubUser,
	association: string,
	allow: Allowlists,
): boolean {
	if (author.type === "Bot") {
		return includesLogin(allow.allowedBots, author.login);
	}
	if (allow.allowedUsers.length > 0) {
		return includesLogin(allow.allowedUsers, author.login);
	}
	return allow.allowedAssociations
		.map(normalizeAssociation)
		.includes(normalizeAssociation(association));
}

/** Drop HTML comments and invisible characters, which can hide instructions. */
export function sanitizeInput(text: string): string {
	return text
		.replaceAll(HTML_COMMENT_PATTERN, "")
		.replaceAll(INVISIBLE_CHARACTERS_PATTERN, "")
		.trim();
}
