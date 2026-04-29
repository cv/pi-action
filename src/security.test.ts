import { describe, expect, it } from "vitest";
import { sanitizeInput, validatePermissions } from "./security.js";

function createSecurityContext(
	overrides: Parameters<typeof validatePermissions>[0],
): Parameters<typeof validatePermissions>[0] {
	return overrides;
}

describe("validatePermissions", () => {
	const defaultAssociations = ["OWNER", "MEMBER"];

	it("allows OWNER", () => {
		expect(
			validatePermissions(
				createSecurityContext({
					authorAssociation: "OWNER",
					authorLogin: "user",
					isBot: false,
					allowedBots: [],
					allowedUsers: [],
					allowedAssociations: defaultAssociations,
				}),
			),
		).toBe(true);
	});

	it("allows MEMBER", () => {
		expect(
			validatePermissions(
				createSecurityContext({
					authorAssociation: "MEMBER",
					authorLogin: "user",
					isBot: false,
					allowedBots: [],
					allowedUsers: [],
					allowedAssociations: defaultAssociations,
				}),
			),
		).toBe(true);
	});

	it("denies COLLABORATOR by default", () => {
		expect(
			validatePermissions(
				createSecurityContext({
					authorAssociation: "COLLABORATOR",
					authorLogin: "user",
					isBot: false,
					allowedBots: [],
					allowedUsers: [],
					allowedAssociations: defaultAssociations,
				}),
			),
		).toBe(false);
	});

	it("allows COLLABORATOR when configured", () => {
		expect(
			validatePermissions(
				createSecurityContext({
					authorAssociation: "COLLABORATOR",
					authorLogin: "user",
					isBot: false,
					allowedBots: [],
					allowedUsers: [],
					allowedAssociations: ["OWNER", "MEMBER", "COLLABORATOR"],
				}),
			),
		).toBe(true);
	});

	it("denies CONTRIBUTOR", () => {
		expect(
			validatePermissions(
				createSecurityContext({
					authorAssociation: "CONTRIBUTOR",
					authorLogin: "user",
					isBot: false,
					allowedBots: [],
					allowedUsers: [],
					allowedAssociations: defaultAssociations,
				}),
			),
		).toBe(false);
	});

	it("denies NONE", () => {
		expect(
			validatePermissions(
				createSecurityContext({
					authorAssociation: "NONE",
					authorLogin: "user",
					isBot: false,
					allowedBots: [],
					allowedUsers: [],
					allowedAssociations: defaultAssociations,
				}),
			),
		).toBe(false);
	});

	it("allows bots in allowlist", () => {
		expect(
			validatePermissions(
				createSecurityContext({
					authorAssociation: "NONE",
					authorLogin: "dependabot[bot]",
					isBot: true,
					allowedBots: ["dependabot[bot]", "renovate[bot]"],
					allowedUsers: [],
					allowedAssociations: defaultAssociations,
				}),
			),
		).toBe(true);
	});

	it("denies bots not in allowlist", () => {
		expect(
			validatePermissions(
				createSecurityContext({
					authorAssociation: "NONE",
					authorLogin: "evil-bot",
					isBot: true,
					allowedBots: ["dependabot[bot]"],
					allowedUsers: [],
					allowedAssociations: defaultAssociations,
				}),
			),
		).toBe(false);
	});

	it("allows explicit users regardless of association", () => {
		expect(
			validatePermissions(
				createSecurityContext({
					authorAssociation: "NONE",
					authorLogin: "Cv",
					isBot: false,
					allowedBots: [],
					allowedUsers: ["@cv"],
					allowedAssociations: ["OWNER"],
				}),
			),
		).toBe(true);
	});

	it("denies owners not present in explicit user allowlist", () => {
		expect(
			validatePermissions(
				createSecurityContext({
					authorAssociation: "OWNER",
					authorLogin: "not-allowed",
					isBot: false,
					allowedBots: [],
					allowedUsers: ["cv"],
					allowedAssociations: defaultAssociations,
				}),
			),
		).toBe(false);
	});

	it("respects tightened allowed associations", () => {
		expect(
			validatePermissions(
				createSecurityContext({
					authorAssociation: "MEMBER",
					authorLogin: "user",
					isBot: false,
					allowedBots: [],
					allowedUsers: [],
					allowedAssociations: ["OWNER"],
				}),
			),
		).toBe(false);
	});

	it("normalizes bot allowlist entries", () => {
		expect(
			validatePermissions(
				createSecurityContext({
					authorAssociation: "NONE",
					authorLogin: "dependabot[bot]",
					isBot: true,
					allowedBots: ["@Dependabot[bot]"],
					allowedUsers: [],
					allowedAssociations: defaultAssociations,
				}),
			),
		).toBe(true);
	});
});

describe("sanitizeInput", () => {
	it("removes HTML comments", () => {
		expect(sanitizeInput("before<!-- hidden -->after")).toBe("beforeafter");
	});

	it("removes multiline HTML comments", () => {
		expect(sanitizeInput("before<!-- \nhidden\n -->after")).toBe("beforeafter");
	});

	it("removes invisible characters", () => {
		expect(sanitizeInput("hello\u200Bworld")).toBe("helloworld");
		expect(sanitizeInput("hello\u200Cworld")).toBe("helloworld");
		expect(sanitizeInput("hello\u200Dworld")).toBe("helloworld");
		expect(sanitizeInput("hello\uFEFFworld")).toBe("helloworld");
		expect(sanitizeInput("hello\u00ADworld")).toBe("helloworld");
	});

	it("trims whitespace", () => {
		expect(sanitizeInput("  hello  ")).toBe("hello");
	});

	it("preserves normal content", () => {
		expect(sanitizeInput("@pi please review this code")).toBe(
			"@pi please review this code",
		);
	});
});
