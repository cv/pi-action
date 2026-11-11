import { describe, expect, it } from "vitest";

import { sanitizeInput, validatePermissions } from "./security.ts";

const DEFAULT = {
	allowedBots: [],
	allowedUsers: [],
	allowedAssociations: ["OWNER", "MEMBER"],
};
const person = (login = "user") => ({ login, type: "User" as const });
const bot = (login: string) => ({ login, type: "Bot" as const });

describe("validatePermissions", () => {
	it.each([
		["OWNER", true],
		["MEMBER", true],
		["COLLABORATOR", false],
		["CONTRIBUTOR", false],
		["NONE", false],
		[" member ", true],
	])("by default, %s is allowed: %s", (association, allowed) => {
		expect(validatePermissions(person(), association, DEFAULT)).toBe(allowed);
	});

	it("allows the configured associations only", () => {
		const collaborators = {
			...DEFAULT,
			allowedAssociations: ["OWNER", "MEMBER", "COLLABORATOR"],
		};
		expect(validatePermissions(person(), "COLLABORATOR", collaborators)).toBe(
			true,
		);
		const ownersOnly = { ...DEFAULT, allowedAssociations: ["owner"] };
		expect(validatePermissions(person(), "OWNER", ownersOnly)).toBe(true);
		expect(validatePermissions(person(), "MEMBER", ownersOnly)).toBe(false);
	});

	it("allows bots in allowed_bots only, whatever their association", () => {
		const allow = { ...DEFAULT, allowedBots: [" @Dependabot[bot] "] };
		expect(validatePermissions(bot("dependabot[bot]"), "NONE", allow)).toBe(
			true,
		);
		expect(validatePermissions(bot("evil[bot]"), "OWNER", allow)).toBe(false);
	});

	it("allows exactly the allowed_users when set, regardless of association", () => {
		const allow = { ...DEFAULT, allowedUsers: ["@Alice"] };
		expect(validatePermissions(person("alice"), "NONE", allow)).toBe(true);
		expect(validatePermissions(person("bob"), "OWNER", allow)).toBe(false);
	});
});

describe("sanitizeInput", () => {
	it.each([
		["Hello <!-- hidden --> world", "Hello  world"],
		["a<!--\nmulti\nline\n-->b", "ab"],
		["in\u200Bvis\u200C\u200D\uFEFFi\u00ADble", "invisible"],
		["  padded  ", "padded"],
		["@pi fix **this** in `code`", "@pi fix **this** in `code`"],
	])("sanitizes %o", (input, output) => {
		expect(sanitizeInput(input)).toBe(output);
	});
});
