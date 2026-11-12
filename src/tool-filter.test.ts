import { describe, expect, it } from "vitest";

import { createLogger } from "./test-helpers.ts";
import { planTools } from "./tool-filter.ts";

const ALL = ["read", "write", "edit", "bash", "mcp.search", "mcpXsearch"];

describe("planTools", () => {
	it("matches whole names, with * as the only special character", () => {
		const log = createLogger();
		expect(
			planTools({ exclude: ["mcp.*"], hidden: ["ba", "*it*"] }, ALL, ALL, log),
		).toStrictEqual({
			exclude: ["mcp.search"],
			hide: ["write", "edit"],
			offered: ["read", "bash", "mcpXsearch"],
		});
		expect(log.warning).toHaveBeenCalledExactlyOnceWith(
			'model_tools_hidden: "ba" matches no tool',
		);
	});

	it("changes nothing without patterns", () => {
		expect(
			planTools({ exclude: [], hidden: [] }, ALL, ["read"], createLogger()),
		).toStrictEqual({ exclude: [], hide: [], offered: ["read"] });
	});
});
