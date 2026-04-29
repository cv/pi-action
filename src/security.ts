export interface SecurityContext {
	authorAssociation: string;
	authorLogin: string;
	isBot: boolean;
	allowedBots: string[];
	allowedUsers: string[];
	allowedAssociations: string[];
}

function normalizeLogin(login: string): string {
	return login.trim().replace(/^@/, "").toLowerCase();
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
		.replace(/<!--[\s\S]*?-->/g, "") // Remove HTML comments
		.replace(/\u200B|\u200C|\u200D|\uFEFF|\u00AD/g, "") // Remove invisible characters
		.trim();
}
