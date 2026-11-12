import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PromptInput } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";

import {
	expandSkill,
	formatSkillsSection,
	loadSkills,
	parseFrontmatter,
	type Skill,
	skillMessage,
	skillsSection,
} from "./skills.ts";
import { createLogger, tempDir, write } from "./test-helpers.ts";
import type { Trigger } from "./triggers.ts";

const trigger = (task: string, overrides: Partial<Trigger> = {}): Trigger => ({
	key: "comment-1",
	source: "comment",
	issueNumber: 1,
	author: { login: "alice", type: "User" },
	text: `@pi ${task}`,
	task,
	createdAt: "2026-01-01T00:00:00Z",
	...overrides,
});

const skillFile = (name: string, description: string, extra = "") =>
	`---\nname: ${name}\ndescription: ${description}\n${extra}---\n# ${name}\n\nRun scripts/bump.sh.\n`;

function skill(dir: string, overrides: Partial<Skill> = {}): Skill {
	const name = overrides.name ?? "release";
	const baseDir = join(dir, name);
	const filePath = write(
		join(baseDir, "SKILL.md"),
		skillFile(name, "Cut a release of xyz"),
	);
	return {
		name,
		description: "Cut a release of xyz",
		filePath,
		baseDir,
		source: "project",
		disableModelInvocation: false,
		...overrides,
	};
}

const warnings = (log: ReturnType<typeof createLogger>): string[] =>
	vi.mocked(log.warning).mock.calls.map(([msg]) => msg);

describe("parseFrontmatter", () => {
	it("reads plain, quoted, continued, and block values, and skips nested maps", () => {
		const fields = parseFrontmatter(
			[
				"---",
				"name: release",
				"description: Cut a release: tag,",
				"  then publish",
				String.raw`quoted: "a \"b\""`,
				"single: 'it''s'",
				"comment: yes # really",
				"folded: >",
				"  one",
				"  two",
				"",
				"  three",
				"literal: |-",
				"  one",
				"    two",
				"metadata:",
				"  author: me",
				"---",
				"body",
			].join("\n"),
		);
		expect(fields).toStrictEqual(
			new Map(
				Object.entries({
					name: "release",
					description: "Cut a release: tag, then publish",
					quoted: 'a "b"',
					single: "it's",
					comment: "yes",
					folded: "one two\nthree",
					literal: "one\n  two",
				}),
			),
		);
	});

	it("is undefined without frontmatter", () => {
		expect(parseFrontmatter("# Just text")).toBeUndefined();
		expect(parseFrontmatter("---\n---\nbody")).toStrictEqual(new Map());
	});
});

describe("loadSkills", () => {
	it("finds skill directories recursively, in order, and the first name wins", () => {
		const root = tempDir();
		const packaged = join(root, "pkg/skills");
		const project = join(root, "repo/.pi/skills");
		write(
			join(packaged, "release/SKILL.md"),
			skillFile("release", "From the package"),
		);
		write(
			join(packaged, "group/changelog/SKILL.md"),
			skillFile("changelog", "Write the changelog"),
		);
		// A skill's own subdirectories are its resources; hidden directories and node_modules are skipped.
		write(join(packaged, "release/nested/SKILL.md"), skillFile("nested", "x"));
		write(join(packaged, ".hidden/secret/SKILL.md"), skillFile("secret", "x"));
		write(join(packaged, "node_modules/dep/SKILL.md"), skillFile("dep", "x"));
		write(
			join(project, "release/SKILL.md"),
			skillFile("release", "From the project"),
		);
		write(
			join(project, "deploy/SKILL.md"),
			skillFile("deploy", "Deploy", "disable-model-invocation: true\n"),
		);
		const file = write(
			join(root, "file/one/SKILL.md"),
			skillFile("one", "A file"),
		);
		const log = createLogger();

		const skills = loadSkills(
			[
				{ source: "xyz-skills", paths: [packaged, join(root, "missing")] },
				{ source: "project", paths: [project] },
				{ source: "agent_dir", paths: [file] },
			],
			log,
		);

		expect(
			[...skills.values()].map((s) => [
				s.name,
				s.source,
				s.disableModelInvocation,
			]),
		).toStrictEqual([
			["changelog", "xyz-skills", false],
			["release", "xyz-skills", false],
			["deploy", "project", true],
			["one", "agent_dir", false],
		]);
		expect(skills.get("release")).toStrictEqual({
			name: "release",
			description: "From the package",
			filePath: join(packaged, "release/SKILL.md"),
			baseDir: join(packaged, "release"),
			source: "xyz-skills",
			disableModelInvocation: false,
		});
		expect(warnings(log)).toStrictEqual([
			"Skill release from project is ignored: xyz-skills has one with that name",
		]);
	});

	it.each([
		["no frontmatter", "bad", "# no frontmatter", "it has no frontmatter"],
		["no name", "bad", "---\ndescription: d\n---\n", "it has no name"],
		[
			"an uppercase name",
			"Bad",
			skillFile("Bad", "d"),
			'its name "Bad" must be at most 64 characters of a-z, 0-9, and single hyphens inside',
		],
		[
			"a double hyphen",
			"a--b",
			skillFile("a--b", "d"),
			'its name "a--b" must be at most 64 characters of a-z, 0-9, and single hyphens inside',
		],
		[
			"a long name",
			"a".repeat(65),
			skillFile("a".repeat(65), "d"),
			`its name "${"a".repeat(65)}" must be at most 64 characters of a-z, 0-9, and single hyphens inside`,
		],
		[
			"another directory name",
			"dir",
			skillFile("other", "d"),
			'its name "other" is not the name of its directory, dir',
		],
		["no description", "bad", "---\nname: bad\n---\n", "it has no description"],
		[
			"a long description",
			"bad",
			skillFile("bad", "d".repeat(1025)),
			"its description is longer than 1024 characters",
		],
	])("skips a skill with %s", (_case, dir, text, reason) => {
		const root = tempDir();
		const file = write(join(root, dir, "SKILL.md"), text);
		const log = createLogger();
		expect(loadSkills([{ source: "project", paths: [root] }], log).size).toBe(
			0,
		);
		expect(warnings(log)).toStrictEqual([
			`Skill ${file} from project is skipped: ${reason}`,
		]);
	});
});

describe("formatSkillsSection", () => {
	it("lists the skills the model may use, escaped, with absolute locations", () => {
		const dir = tempDir();
		const skills = new Map([
			["release", skill(dir, { description: 'Cut <a> release & "tag"' })],
			["deploy", skill(dir, { name: "deploy", disableModelInvocation: true })],
		]);
		expect(formatSkillsSection(skills, "the read tool")).toBe(
			[
				"The following skills provide specialized instructions for specific tasks.",
				"Use the read tool to load a skill's SKILL.md in full when the task matches its description.",
				"Resolve relative paths in a skill against its directory.",
				"",
				"  <skill>",
				"    <name>release</name>",
				"    <description>Cut &lt;a&gt; release &amp; &quot;tag&quot;</description>",
				`    <location>${join(dir, "release/SKILL.md")}</location>`,
				"  </skill>",
			].join("\n"),
		);
	});

	it("is undefined when no skill is listed", () => {
		const dir = tempDir();
		expect(formatSkillsSection(new Map(), "the read tool")).toBeUndefined();
		const hidden = skill(dir, { disableModelInvocation: true });
		expect(
			formatSkillsSection(new Map([["release", hidden]]), "the read tool"),
		).toBeUndefined();
	});
});

describe("skillsSection", () => {
	const inputWith = (tools: string[]) =>
		({
			agent: { tools: tools.map((name) => ({ name })) },
		}) as unknown as PromptInput;
	const render = async (tools: string[]) => {
		const skills = new Map([["release", skill(tempDir())]]);
		return skillsSection(skills).render(inputWith(tools), BACKGROUND_CONTEXT);
	};

	it("names the read tool, or workspace.read when pit's typescript tool is the way to read", async () => {
		await expect(render(["read", "bash", "typescript"])).resolves.toContain(
			"Use the read tool to load",
		);
		await expect(render(["typescript"])).resolves.toContain(
			"Use workspace.read to load",
		);
		await expect(render(["bash"])).resolves.toContain(
			"Use the read tool to load",
		);
	});

	it("renders the same text every time", async () => {
		const skills = new Map([["release", skill(tempDir())]]);
		const section = skillsSection(skills);
		const input = { agent: { tools: [] } } as unknown as PromptInput;
		const rendered = async () => section.render(input, BACKGROUND_CONTEXT);
		const first = await rendered();
		skills.clear();
		await expect(rendered()).resolves.toBe(first);
		expect(first).toContain("<name>release</name>");
		expect(section.key).toBe("available_skills");
	});
});

describe("expandSkill", () => {
	it("puts the skill's instructions in the task, then the arguments", () => {
		const dir = tempDir();
		const release = skill(dir);
		const skills = new Map([["release", release]]);

		const expanded = expandSkill(trigger("/skill:release 2.4.0 now"), skills);

		expect(expanded.task).toBe(
			`<skill name="release" location="${release.filePath}">\nReferences are relative to ${release.baseDir}.\n\n# release\n\nRun scripts/bump.sh.\n</skill>\n\n2.4.0 now`,
		);
		expect(expanded.skill).toStrictEqual({
			name: "release",
			source: "project",
			typed: "/skill:release 2.4.0 now",
		});
		expect(skillMessage(release, "")).toBe(expanded.task.split("\n\n2.4.0")[0]);
	});

	it("rejects an unknown skill with the names there are", () => {
		const skills = new Map([["release", skill(tempDir())]]);
		expect(expandSkill(trigger("/skill:relase"), skills).rejected).toBe(
			"There is no skill named `relase`. Skills: `release`. See https://github.com/cv/pi-action/blob/main/docs/skills.md",
		);
		expect(expandSkill(trigger("/skill:"), new Map()).rejected).toBe(
			"There is no skill named ``. No skills are loaded. See https://github.com/cv/pi-action/blob/main/docs/skills.md",
		);
	});

	it("leaves other tasks and answers as they are", () => {
		const skills = new Map([["release", skill(tempDir())]]);
		const plain = trigger("/release now");
		expect(expandSkill(plain, skills)).toBe(plain);
		const answer = trigger("/skill:release", {
			answer: {
				key: "k",
				kind: "input",
				answer: "/skill:release",
				by: "alice",
				url: "u",
				title: "t",
			},
		});
		expect(expandSkill(answer, skills)).toBe(answer);
	});
});
