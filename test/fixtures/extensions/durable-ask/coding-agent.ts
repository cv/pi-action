/**
 * The package's pi coding-agent extension. pi-action never loads it (the package has a pi-durable entry), which
 * matters: it needs pi's coding agent, which pi-action doesn't have.
 */
// oxlint-disable-next-line import/no-unassigned-import -- importing it is the point: it fails outside pi
import "@earendil-works/pi-coding-agent";

// oxlint-disable-next-line import/no-default-export -- pi loads an extension's default export
export default function codingAgentExtension(): void {
	throw new Error("the coding-agent entry must not be loaded by pi-action");
}
