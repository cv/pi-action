# Skills

A **skill** is a directory with a `SKILL.md` file: instructions for one kind of task, and the scripts and files that go with them. pi-action loads skills as pi's coding agent does, from the [Agent Skills](https://agentskills.io) format:

- The system prompt lists the name, the description, and the location of each skill. When a task matches a description, pi reads the full `SKILL.md`.
- `@pi /skill:<name> <arguments>` puts the skill in the request itself. See [Use a skill explicitly](#use-a-skill-explicitly).

Skills work in comment mode, `pr_number` runs, and direct prompts.

## Where pi-action finds skills

pi-action looks in these places, in this sequence:

1. **Packages.** Each package in `extensions`, then each package in `skills`, in the order of the input: the `pi.skills` list in its `package.json` (files and directories, as `pi.prompts`), or else its `skills/` directory.
2. **The project.** `.pi/skills/` and `.agents/skills/` in the repository, **only with `trust_project: true`**. See [Security](security.md#skills-from-the-repository).
3. **The user.** `<agent_dir>/skills/`, when `agent_dir` is set.

pi-action searches each directory recursively for directories with a `SKILL.md`. It does not search inside a skill (its subdirectories are its files), in hidden directories, or in `node_modules`.

When two skills have the same name, the first one wins, and pi-action writes a warning. The log of the setup lists the skills, for example `Skills: release (project), changelog (xyz-skills)`.

### The `skills` input

`skills` loads packages for their skills only. It has the syntax of [`extensions`](extensions.md#declare-extensions): npm package specs or workspace paths, one per line or comma-separated, with `#` comments. pi-action installs npm packages in the same way, without lifecycle scripts, but it does not run their code. A package in `extensions` gives its skills too, so you do not have to write it in both inputs.

```yaml
- uses: cv/pi-action@v2
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    trust_project: true             # for .pi/skills and .agents/skills
    skills: |
      github:acme/xyz-skills#v1     # "pi": { "skills": ["./skills"] }
```

## Write a skill

```text
xyz/
└── .pi/skills/
    └── release/
        ├── SKILL.md
        └── scripts/bump.sh
```

`SKILL.md` starts with YAML frontmatter:

```markdown
---
name: release
description: Cut a release of xyz. Use it when someone asks for a new version.
---

# Release

1. Run `scripts/bump.sh <version>`.
2. ...
```

| Field | Rule |
|-------|------|
| `name` | Required. At most 64 characters: `a-z`, `0-9`, and single hyphens inside. The same as the name of the directory |
| `description` | Required. At most 1024 characters. Write what the skill does and when to use it: the model chooses skills by their descriptions |
| `disable-model-invocation` | Optional. `true`: the system prompt does not list the skill. It is available only as `/skill:<name>` |

pi-action skips a skill that breaks these rules, and writes a warning with the reason. Write paths in a skill relative to its directory: the model resolves them against it.

## The system prompt

pi-action adds the `available_skills` section to the system prompt. Locations are absolute paths. Package skills are in `RUNNER_TEMP` (`pi-action-extensions-*`), where the coding tools can read them.

```text
<available_skills>
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's SKILL.md in full when the task matches its description.
Resolve relative paths in a skill against its directory.

  <skill>
    <name>release</name>
    <description>Cut a release of xyz. Use it when someone asks for a new version.</description>
    <location>/home/runner/work/xyz/xyz/.pi/skills/release/SKILL.md</location>
  </skill>
</available_skills>
```

- When the model has pit's `typescript` tool and no `read` tool (for example with `model_tools_hidden: read, write, edit, bash`), the second line says `workspace.read` instead of `the read tool`.
- When no skill is listed, the section is not there.
- The section stays the same for the whole run, so the prompt cache stays valid.
- The section comes from pi-action's built-in pi-durable extension, `pi-action`. A pi-durable extension can change it with `wrapSection("available_skills", ...)` (see [Override tools and sections](extensions.md#override-tools-and-sections)).

## Use a skill explicitly

When the [task](prompts.md#the-task) starts with `/skill:<name>`, pi-action replaces it with the skill and the rest of the task:

```text
@pi /skill:release 2.4.0
```

pi gets:

```text
<skill name="release" location="/home/runner/work/xyz/xyz/.pi/skills/release/SKILL.md">
References are relative to /home/runner/work/xyz/xyz/.pi/skills/release.

# Release
...
</skill>

2.4.0
```

- pi-action removes the frontmatter. It does not replace `$1` or other variables, as it does for [prompt templates](prompts.md#prompt-templates).
- This works in the first message (also `{{task}}` in `prompt_template`), in follow-ups, and in `prompt`. It does not work in answers to questions.
- For a name that no skill has, pi-action does not send the request to pi. It replies with an error that lists the skills.
- The log shows the request as it was typed, for example `▶ Request from @alice: /skill:release 2.4.0 (skill from project)`. The thread keeps the typed text in the `typed` field of the comment entry, and the name in `skill`.
