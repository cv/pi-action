// Vendored from github.com/cv/git-backed-pi-durable (1b9ba48).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { GitStorage } from "./index.js";
import { tempRepo } from "./test-repo.js";

const REF = "refs/pi/threads/test";

/** The wrapped MemoryStorage's state, minus the ID counter (minted-but-unused IDs aren't stored, as in JSONL). */
function snapshot(storage: GitStorage): string {
	const memory = (storage as any).memory;
	return JSON.stringify({ state: memory.state, nextSeq: memory.nextSeq }, (_key, value) =>
		value instanceof Map ? [...value] : value instanceof Set ? [...value] : value,
	);
}

let replays = 0;
registerStorageConformance({ describe, expect, it } as any, "GitStorage", async (use) => {
	const repo = tempRepo();
	const storage = await GitStorage.open({ repo: repo.dir, ref: REF });
	try {
		await use(storage);
		// Replay fidelity: whatever the case committed, reopening the ref rebuilds the same state.
		let before: string | undefined;
		try {
			(storage as any).assertUsable();
			before = snapshot(storage);
		} catch {
			before = undefined; // the case closed or poisoned it
		}
		await storage.close(BACKGROUND_CONTEXT);
		if (before !== undefined) {
			const reopened = await GitStorage.open({ repo: repo.dir, ref: REF });
			expect(snapshot(reopened)).toBe(before);
			await reopened.close(BACKGROUND_CONTEXT);
			replays++;
		}
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
		repo.cleanup();
	}
});

describe("replay coverage", () => {
	it("reopened most conformance cases", () => {
		expect(replays).toBeGreaterThan(10);
	});
});
