import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts", "scripts/**/*.test.js"],
		setupFiles: ["src/test-setup.ts"],
		coverage: {
			provider: "v8",
			all: true,
			include: ["src/**/*.ts"],
			exclude: [
				"src/**/*.test.ts",
				"src/index.ts",
				"src/test-helpers.ts",
				"src/test-setup.ts",
			],
			thresholds: {
				statements: 90,
				branches: 85,
				functions: 90,
				lines: 90,
			},
		},
	},
});
