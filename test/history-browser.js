import assert from "node:assert/strict";
import { firefox } from "playwright";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics, { httpFailure } from "./browser-diagnostics.js";

const message = (id, content = id) => ({ id, role: "user", content });
const userChunk = (id, text = id) => ({ sessionUpdate: "user_message_chunk", messageId: id, content: { type: "text", text } });
const snapshot = (messages, older) => ({
    updates: messages.map((m) => userChunk(m.id, m.content)),
    result: { _meta: { plurnk: { history: { older } } } },
});

export default async function verifyHistory(t) {
    const fixture = await conversationFixture(new URL("./history-entry.js", import.meta.url));
    try {
        for (const engine of engines) {
            await t.test(engine.name(), async () => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 390, height: 700 } });
                    const check = browserDiagnostics(context);
                    const page = await context.newPage();
                    const requests = [];
                    const reads = [];
                    const pages = new Map();
                    let events = [];
                    let credentials = 0;
                    await page.route("**/auth/token", (route) => {
                        credentials++;
                        return route.fulfill({ json: { token_type: "Bearer", access_token: "history-test" } });
                    });
                    await page.route("**/history/**", async (route) => {
                        const address = new URL(route.request().url());
                        reads.push(address.pathname + address.search);
                        assert.equal(route.request().headers().authorization, "Bearer history-test");
                        const value = pages.get(address.pathname);
                        if (typeof value === "function") await value(route);
                        else await route.fulfill({ json: value });
                    });
                    fixture.onAcp((input) => {
                        requests.push(input);
                        const { updates = events, result = {} } = Array.isArray(events) ? { updates: events } : events;
                        return { updates, result, closeStream: true };
                    });
                    await page.goto(fixture.url);
                    await page.waitForFunction(() => typeof window.run === "function");
                    const run = () => page.evaluate(() => window.run());
                    const ids = () => page.locator("[data-messages] > [data-message-id]").evaluateAll((rows) => rows.map((row) => row.dataset.messageId));
                    const atBottom = () => page.evaluate(() => {
                        const main = document.querySelector("main");
                        return Math.abs(main.scrollHeight - main.clientHeight - main.scrollTop) <= 1;
                    });
                    const settled = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                    const older = "/history/old?opaque=%2F%23%25";
                    const live = [message("current", "Current text.\n\n".repeat(35)), message("tail", "Newest text.")];
                    const old = [message("old", "Old text.\n\n".repeat(35)), message("current", "Stale current text.")];
                    pages.set("/history/old", { final: true, messages: old, older: null });
                    events = snapshot(live, older);
                    await run();
                    await settled();
                    assert.equal(await atBottom(), true, "first attachment follows the live tail");
                    assert.deepEqual(reads, [], "history is not prefetched");
                    const current = page.locator('[data-message-id="current"]');
                    await page.getByRole("button", { name: "Load previous loop" }).scrollIntoViewIfNeeded();
                    await settled();
                    const anchor = await current.boundingBox();
                    await page.evaluate(() => {
                        window.saved = document.querySelector('[data-message-id="current"] article p');
                        const range = document.createRange(); range.selectNodeContents(window.saved);
                        getSelection().removeAllRanges(); getSelection().addRange(range);
                        document.querySelector('[data-history-boundary] form').requestSubmit();
                    });
                    await page.locator('[data-message-id="old"]').waitFor({ state: "attached" });
                    await settled();
                    assert.deepEqual(await ids(), ["old", "current", "tail"]);
                    assert.deepEqual(reads, [older], "opaque URL including escaped query is followed unchanged");
                    assert.equal(credentials, 1);
                    assert.ok(Math.abs((await current.boundingBox()).y - anchor.y) <= 1, "prepending retains the visible message coordinate");
                    assert.equal(await page.evaluate(() => window.saved === document.querySelector('[data-message-id="current"] article p')), true);
                    assert.equal(await page.evaluate(() => getSelection().toString()), "Current text.");
                    await run();
                    assert.equal(requests.at(-1).params.messages, undefined, "actual SDK request excludes fetched history");
                    assert.deepEqual(reads, [older], "final pages never refetch on replay");

                    // Read away from the tail while a snapshot removes the visible material.
                    events = snapshot([message("next", "Next text.\n\n".repeat(20))], "/history/current");
                    const before = await current.boundingBox();
                    await run();
                    await settled();
                    assert.ok((await ids()).includes("current"));
                    assert.ok(Math.abs((await current.boundingBox()).y - before.y) <= 1, "advancement cannot yank the page being read");
                    await page.locator("main").evaluate((main) => { main.scrollTop = main.scrollHeight; });
                    await settled();
                    assert.deepEqual(await ids(), ["old", "current", "next"], "returning to the tail releases displaced live-only material, not explicit pages");
                    assert.equal(await atBottom(), true);
                    assert.equal(await page.getByRole("button", { name: "Load previous loop" }).count(), 1, "the reconnect gap is marked between retained and live content");

                    // Fresh component state, non-final page and late result through the real SDK.
                    await page.reload();
                    await page.waitForFunction(() => typeof window.run === "function");
                    const call = { id: "call-message", role: "assistant", toolCalls: [{ id: "call", type: "function",
                        function: { name: "READ", arguments: JSON.stringify({ target: { raw: "evidence.txt" } }) }, metadata: { plurnk: { op: "READ" } } }] };
                    pages.set("/history/call", { final: false, messages: [call], older: null });
                    events = snapshot([message("now")], "/history/call");
                    await run();
                    await page.getByRole("button", { name: "Load previous loop" }).click();
                    await page.locator('[data-call-id="call"]').waitFor();
                    const result = { id: "receipt", role: "tool", toolCallId: "call", content: '{"status":200,"path":"evidence.txt","range":{"returned":[1,2]}}' };
                    events = [{ sessionUpdate: "tool_call_update", toolCallId: result.toolCallId, status: "completed", rawOutput: result.content, _meta: { plurnk: { messageId: result.id } } }];
                    await run();
                    assert.deepEqual(await ids(), ["call-message", "now"], "immediate late result completes its original operation row exactly once");
                    assert.equal(await page.locator('[data-call-id="call"] [data-plurnk-field="count"]').textContent(), "{2}");
                    const readCount = reads.length;
                    pages.set("/history/call", (route) => route.fulfill({ status: 503, json: { title: "Unavailable" } }));
                    events = snapshot([message("now")], "/history/call");
                    await run();
                    await page.getByRole("alert").filter({ hasText: "Read request failed (503)." }).waitFor();
                    assert.equal(await page.locator('[data-call-id="call"] [data-plurnk-field="count"]').textContent(), "{2}", "failed revalidation cannot hide a confirmed result");
                    check(engine !== firefox ? [httpFailure("/history/call", 503)] : []);
                    pages.set("/history/call", { final: true, messages: [call, result], older: null });
                    await page.getByRole("button", { name: "Load previous loop" }).click();
                    await page.waitForFunction(() => !document.querySelector('[data-history-boundary] [aria-busy="true"]'));
                    await settled();
                    assert.equal(reads.length, readCount + 2, "non-final page revalidates on snapshot, then only on explicit retry after failure");
                    await run();
                    assert.equal(reads.length, readCount + 2, "newly final page stops revalidation");
                    assert.deepEqual(await ids(), ["call-message", "now"]);
                    assert.ok(!JSON.stringify(requests.at(-1)).includes("call-message"));

                    await page.reload();
                    await page.waitForFunction(() => typeof window.run === "function");
                    pages.set("/history/failure", (route) => route.fulfill({ status: 503, json: { title: "Unavailable" } }));
                    events = snapshot([message("retained")], "/history/failure");
                    await run();
                    await page.getByRole("button", { name: "Load previous loop" }).click();
                    await page.getByRole("alert").filter({ hasText: "Read request failed (503)." }).waitFor();
                    assert.deepEqual(await ids(), ["retained"]);
                    check(engine !== firefox ? [httpFailure("/history/failure", 503)] : []);
                    pages.set("/history/failure", { final: true, messages: [message("retried")], older: null });
                    await page.getByRole("button", { name: "Load previous loop" }).click();
                    await page.locator('[data-message-id="retried"]').waitFor();
                    assert.deepEqual(await ids(), ["retried", "retained"]);

                    // A stale read cannot reinsert an abandoned page after an advancing snapshot.
                    const held = Promise.withResolvers();
                    const started = Promise.withResolvers();
                    pages.set("/history/held", async (route) => {
                        started.resolve(); await held.promise;
                        await route.fulfill({ json: { final: true, messages: [message("abandoned")], older: null } });
                    });
                    events = snapshot([message("new-window")], "/history/held");
                    await run();
                    await page.getByRole("button", { name: "Load previous loop" }).click();
                    await started.promise;
                    events = snapshot([message("last-window")], null);
                    await run();
                    held.resolve();
                    await settled();
                    assert.ok(!(await ids()).includes("abandoned"));
                    check();
                } finally { await browser.close(); }
            });
        }
    } finally { await fixture.server.close(); }
}
