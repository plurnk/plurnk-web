import assert from "node:assert/strict";

// {§web-browser-security} Caught exceptions can still produce browser CSP errors.
export default function browserDiagnostics(context) {
    const engine = context.browser()?.browserType().name();
    const diagnostics = [];
    context.on("console", (message) => {
        if (!["error", "warning"].includes(message.type())) return;
        const url = message.location().url;
        if (url === "resource:///modules/FaviconLoader.sys.mjs" && message.text().includes("/favicon.ico")) return;
        const path = URL.canParse(url) ? new URL(url).pathname : url;
        diagnostics.push(`${message.type()} ${path}: ${message.text().split("\n")[0]}`);
    });
    context.on("weberror", (event) => diagnostics.push(`exception: ${event.error().message}`));
    return (expected = []) => {
        const actual = diagnostics.splice(0);
        for (const pattern of expected) {
            const isNetwork = Boolean(/** @type {any} */ (pattern).webkitOptional);
            const optional = Boolean(/** @type {any} */ (pattern).optional);
            const index = actual.findIndex((message) => pattern.test(message));
            if (index === -1 && (optional || engine === "firefox" || (engine === "webkit" && isNetwork))) {
                continue;
            }
            assert.notEqual(index, -1, `Expected browser diagnostic ${pattern}; received ${JSON.stringify(actual)}`);
            actual.splice(index, 1);
            if ((optional || (engine === "webkit" && isNetwork))) {
                for (let next = actual.findIndex((message) => pattern.test(message)); next !== -1; next = actual.findIndex((message) => pattern.test(message))) {
                    actual.splice(next, 1);
                }
            }
        }
        assert.deepEqual(actual, [], "unexpected browser warnings, errors or exceptions");
    };
}

export const httpFailure = (path, status) => new RegExp(
    `^error ${RegExp.escape(path)}: Failed to load resource: the server responded with a status of ${status} \\([^)]+\\)$`, "u",
);

export const networkFailure = (path) => {
    const pattern = path === "/notifications"
        ? `${RegExp.escape(path)}(?:/[^:\\s]*)?`
        : RegExp.escape(path);
    return Object.assign(new RegExp(
        `^error (${pattern}|/assets/[^:\\s]+|): (Failed to load resource:.*|WebSocket connection to .*${pattern}.* failed:.*|Fetch API cannot load .*${pattern} due to access control checks\\.)$`, "u",
    ), { webkitOptional: true, optional: path === "/acp" });
};
