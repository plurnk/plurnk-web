import assert from "node:assert/strict";

// {§web-browser-security} Caught exceptions can still produce browser CSP errors.
export default function browserDiagnostics(context) {
    const diagnostics = [];
    context.on("console", (message) => {
        if (!["error", "warning"].includes(message.type())) return;
        const url = message.location().url;
        const path = url ? new URL(url).pathname : "";
        diagnostics.push(`${message.type()} ${path}: ${message.text().split("\n")[0]}`);
    });
    context.on("weberror", (event) => diagnostics.push(`exception: ${event.error().message}`));
    return (expected = []) => {
        const actual = diagnostics.splice(0);
        for (const pattern of expected) {
            const index = actual.findIndex((message) => pattern.test(message));
            assert.notEqual(index, -1, `Expected browser diagnostic ${pattern}; received ${JSON.stringify(actual)}`);
            actual.splice(index, 1);
        }
        assert.deepEqual(actual, [], "unexpected browser warnings, errors or exceptions");
    };
}

export const httpFailure = (path, status) => new RegExp(
    `^error ${RegExp.escape(path)}: Failed to load resource: the server responded with a status of ${status} \\([^)]+\\)$`, "u",
);
