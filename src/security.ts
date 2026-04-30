export interface SecurityContext {
	authorAssociation: string;
	authorLogin: string;
	isBot: boolean;
	allowedBots: string[];
	allowedUsers: string[];
	allowedAssociations: string[];
}

const LEADING_AT_PATTERN = /^@/u;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/gu;
const INVISIBLE_CHARACTERS_PATTERN = /\u200B|\u200C|\u200D|\uFEFF|\u00AD/gu;

function normalizeLogin(login: string): string {
	return login.trim().replace(LEADING_AT_PATTERN, "").toLowerCase();
}

function normalizeAssociation(association: string): string {
	return association.trim().toUpperCase();
}

function includesNormalizedLogin(logins: string[], login: string): boolean {
	const normalizedLogin = normalizeLogin(login);
	return logins.some(
		(allowedLogin) => normalizeLogin(allowedLogin) === normalizedLogin,
	);
}

export function validatePermissions(ctx: SecurityContext): boolean {
	if (ctx.isBot) {
		return includesNormalizedLogin(ctx.allowedBots, ctx.authorLogin);
	}
	if (ctx.allowedUsers.length > 0) {
		return includesNormalizedLogin(ctx.allowedUsers, ctx.authorLogin);
	}
	const normalizedAssociation = normalizeAssociation(ctx.authorAssociation);
	return ctx.allowedAssociations
		.map(normalizeAssociation)
		.includes(normalizedAssociation);
}

export function sanitizeInput(text: string): string {
	return text
		.replace(HTML_COMMENT_PATTERN, "") // Remove HTML comments
		.replace(INVISIBLE_CHARACTERS_PATTERN, "") // Remove invisible characters
		.trim();
}
