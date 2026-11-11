/**
 * Response formatting utilities for consistent GitHub comment formatting
 */
function footer(info) {
    const parts = [];
    if (info?.replyTo && info.replyTo.length > 1) {
        parts.push(`↩️ Answers ${info.replyTo.map((login) => `@${login}`).join(", ")}`);
    }
    if (info?.ref) {
        parts.push(`🧵 Thread state: \`${info.ref}\` (\`git fetch origin ${info.ref}\`)`);
    }
    return parts.length > 0 ? `\n\n---\n<sub>${parts.join(" · ")}</sub>` : "";
}
export function formatSuccessComment(response, info) {
    return `### 🤖 pi Response\n\n${response}${footer(info)}`;
}
export function formatErrorComment(error, info) {
    return `### ❌ pi Error\n\nFailed to process request: ${error}${footer(info)}`;
}
