import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLinter } from "actionlint";

const WORKFLOW_DIR = ".github/workflows";
const WORKFLOW_EXTENSION_PATTERN = /\.ya?ml$/;

const lint = await createLinter();
const workflowFiles = (await readdir(WORKFLOW_DIR))
	.filter((fileName) => WORKFLOW_EXTENSION_PATTERN.test(fileName))
	.map((fileName) => join(WORKFLOW_DIR, fileName));

let hasErrors = false;

for (const workflowFile of workflowFiles) {
	const workflow = await readFile(workflowFile, "utf-8");
	const results = lint(workflow, workflowFile);
	for (const result of results) {
		hasErrors = true;
		process.stderr.write(
			`${result.file}:${result.line}:${result.column}: ${result.message} [${result.kind}]\n`,
		);
	}
}

if (hasErrors) {
	process.exitCode = 1;
}
