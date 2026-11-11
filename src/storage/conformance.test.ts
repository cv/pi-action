import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	registerStorageConformance,
	type StorageConformanceRunner,
} from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { tempRepo } from "../test-helpers.js";
import { GitStorage } from "./git-storage.js";

const REF = "refs/pi/threads/test";

/** The wrapped MemoryStorage's state, minus the ID counter (minted-but-unused IDs aren't stored, as in JSONL). */
function snapshot(storage: GitStorage): string {
	const { memory } = storage as unknown as {
		memory: { state: unknown; nextSeq: number };
	};
	return JSON.stringify(
		{ state: memory.state, nextSeq: memory.nextSeq },
		(_key, value) =>
			value instanceof Map || value instanceof Set ? [...value] : value,
	);
}

const replays: { before: string; after: string }[] = [];
registerStorageConformance(
	{ describe, expect, it } as unknown as StorageConformanceRunner,
	"GitStorage",
	async (use) => {
		const repo = tempRepo();
		const storage = await GitStorage.open({ repo: repo.dir, ref: REF });
		try {
			await use(storage);
			// Replay fidelity: whatever the case committed, reopening the ref rebuilds the same state.
			let before: string | undefined;
			try {
				(storage as unknown as { assertUsable(): void }).assertUsable();
				before = snapshot(storage);
			} catch {
				before = undefined; // the case closed or poisoned it
			}
			await storage.close(BACKGROUND_CONTEXT);
			if (before !== undefined) {
				const reopened = await GitStorage.open({ repo: repo.dir, ref: REF });
				replays.push({ before, after: snapshot(reopened) });
				await reopened.close(BACKGROUND_CONTEXT);
			}
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
			repo.cleanup();
		}
	},
);

describe("replay coverage", () => {
	it("reopened most conformance cases", () => {
		expect(replays.length).toBeGreaterThan(10);
		expect(replays.filter(({ before, after }) => before !== after)).toEqual([]);
	});
});
