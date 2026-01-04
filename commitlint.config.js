export default {
	extends: ["@commitlint/config-conventional"],
	rules: {
		// Enforce lowercase for type
		"type-case": [2, "always", "lower-case"],
		// Allowed types
		"type-enum": [
			2,
			"always",
			[
				"feat", // New feature
				"fix", // Bug fix
				"docs", // Documentation only
				"style", // Formatting, no code change
				"refactor", // Code change that neither fixes a bug nor adds a feature
				"perf", // Performance improvement
				"test", // Adding or updating tests
				"build", // Build system or dependencies
				"ci", // CI configuration
				"chore", // Other changes that don't modify src or test
				"revert", // Revert a previous commit
			],
		],
		// Subject should not be empty
		"subject-empty": [2, "never"],
		// Subject should not end with period
		"subject-full-stop": [2, "never", "."],
		// Header should be 100 chars or less
		"header-max-length": [2, "always", 100],
	},
};
