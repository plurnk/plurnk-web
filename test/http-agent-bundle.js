import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "vite";

export default async function httpAgentBundle() {
    const [{ output }] = await build({
        configFile: false, logLevel: "warn",
        build: { write: false, lib: { entry: fileURLToPath(new URL("./http-agent-entry.js", import.meta.url)), formats: ["es"] } },
    });
    const chunks = output.filter(({ type }) => type === "chunk");
    assert.equal(chunks.length, 1, "the test SDK has one self-contained browser entry");
    // Only the test SDK bundle is injected; /acp and /auth always reach the daemon.
    return (tab, base) => tab.route(new URL("/__test__/http-agent.js", base).href, (route) => route.fulfill({
        contentType: "text/javascript", body: chunks[0].code,
    }));
}
