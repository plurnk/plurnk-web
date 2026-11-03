import assert from "node:assert/strict";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics from "./browser-diagnostics.js";

export default async function verifyReasoning(t) {
    const { server, url } = await conversationFixture(new URL("./reasoning-entry.js", import.meta.url));
    try {
        for (const engine of engines) {
            await t.test(engine.name(), async () => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 700 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    let credentials = 0;
                    const reads = [];
                    const body = '<form data-text="reasoning-text">Full **reasoning** 🐹</form>';
                    await page.route("**/auth/token", (route) => {
                        credentials++;
                        return route.fulfill({ json: { token_type: "Bearer", access_token: "reasoning-test" } });
                    });
                    await page.route("**/acp/7/9/entry?target=*", (route) => {
                        reads.push(route.request().headers().authorization);
                        return route.fulfill({ contentType: "text/plain", body });
                    });
                    await page.goto(url);
                    await page.waitForFunction(() => typeof window.present === "function" && window.preview);
                    const consume = (event) => page.evaluate((event) => window.preview.consume(event), event);
                    const preview = page.locator("[data-reasoning-preview]");
                    const text = preview.locator("pre");
                    const delta = (messageId, delta, meta) => consume({
                        sessionUpdate: "agent_thought_chunk", messageId, content: { type: "text", text: delta },
                        ...(meta ? { _meta: meta } : {}),
                    });
                    const endAttempt = (messageId, meta) => consume({
                        sessionUpdate: "agent_thought_chunk", messageId,
                        content: { type: "resource_link", uri: "/acp/7/9/entry?target=reasoning%3A%2F%2Fuser%2F1%2F3", name: "reasoning" },
                        ...(meta ? { _meta: meta } : {}),
                    });
                    const message = { id: "attempt", role: "reasoning", content: "" };
                    await page.evaluate((message) => window.present([message]), message);
                    assert.equal(await page.locator("[data-messages] > li").count(), 0, "empty attempt messages are not empty history disclosures");
                    assert.equal(await preview.isVisible(), false);
                    await delta(message.id, "", { plurnk: { sessionName: "user", loopSeq: 1, turnSeq: 3, coordinate: "1/3" } });
                    assert.equal(await preview.locator("header").textContent(), "user > Loop 1 > Turn 3");
                    await delta(message.id, "", { plurnk: { loopSeq: 1, turnSeq: 3, coordinate: "1/3" } });
                    assert.equal(await preview.locator("header").textContent(), "Loop 1 > Turn 3");
                    await delta(message.id, "", { plurnk: { sessionName: "user", loopSeq: 1, turnSeq: 3, coordinate: "1/3" } });
                    await delta(message.id, "A provisional ");
                    await delta(message.id, "hypothesis.");
                    assert.equal(await preview.isVisible(), true);
                    assert.equal(await preview.evaluate((element) => element.tagName), "ARTICLE");
                    assert.match(await preview.locator(":scope > header").evaluate((element) => getComputedStyle(element, "::before").content), /💭/u);
                    assert.equal(await text.textContent(), "A provisional hypothesis.");
                    assert.equal(await preview.getAttribute("data-reasoning-text"), null, "the preview body is not an attribute mirror");
                    assert.equal(await page.locator("[data-messages] > li").count(), 0);
                    const tail = "🐹\n".repeat(40);
                    await delta(message.id, tail);
                    assert.equal(await text.textContent(), Array.from(tail).slice(-64).join(""), "retain the configured tail without splitting code points");
                    assert.equal(await preview.evaluate((element) => {
                        const pre = element.querySelector("pre");
                        return pre.getBoundingClientRect().height <= innerHeight / 3 + 1
                            && document.documentElement.scrollWidth <= innerWidth;
                    }), true, "the bounded preview fits within one third of the viewport without widening the page");
                    await endAttempt(message.id);
                    assert.equal(await text.textContent(), "");
                    assert.equal(await preview.isVisible(), false);
                    const linked = {
                        ...message,
                        _meta: {
                            plurnk: {
                                sessionName: "user",
                                loopSeq: 1,
                                turnSeq: 3,
                                coordinate: "1/3",
                                body: { url: "/acp/7/9/entry?target=reasoning%3A%2F%2Fuser%2F1%2F3", mimeType: "text/plain" },
                            },
                        },
                    };
                    await page.evaluate((message) => { window.messages = [message]; window.present(window.messages); }, linked);
                    assert.equal(await page.locator('[data-message-id="attempt"] [data-body-reference]').count(), 1,
                        "late metadata on an empty SDK reasoning message must expose its body");
                    const row = page.locator('[data-message-id="attempt"]');
                    assert.equal(await page.locator("[data-operations] > details").evaluate((node) => node.open), false);
                    await page.locator("[data-operations] > details > summary").click();
                    assert.equal(await row.locator(":scope > article > details > summary").textContent(), "user > Loop 1 > Turn 3");
                    assert.equal(await row.getByRole("article", { name: "Reasoning", exact: true }).count(), 1);
                    assert.equal(await row.locator("summary").getAttribute("aria-label"), "Reasoning · user > Loop 1 > Turn 3");
                    assert.match(await row.locator('summary > [data-plurnk-field="heading"]').evaluate((element) => getComputedStyle(element, "::before").content), /💭/u);
                    assert.equal(await row.locator("details").getAttribute("open"), null);
                    assert.equal(credentials, 0);
                    assert.deepEqual(reads, [], "closed reasoning does not fetch");
                    await row.locator("summary").click();
                    await row.locator("[data-body-reference]").scrollIntoViewIfNeeded();
                    await row.locator('[data-body-state="loaded"]').waitFor();
                    assert.equal(await row.locator('[data-body-reference]').textContent(), body);
                    assert.equal(await row.locator("[data-body-reference] form, [data-body-reference] strong").count(), 0,
                        "fetched Markdown and HTML stay literal");
                    assert.equal(credentials, 1);
                    assert.deepEqual(reads, ["Bearer reasoning-test"]);
                    assert.deepEqual(await page.evaluate(() => window.messages), [linked], "reading never writes reasoning into SDK-owned messages");
                    await page.evaluate(() => {
                        window.loadedBody = document.querySelector("[data-body-reference]");
                        window.present(structuredClone(window.messages));
                    });
                    assert.equal(await row.locator("[data-body-reference]").evaluate((element) => element === window.loadedBody), true);
                    assert.equal(await row.locator("details").evaluate((element) => element.open), true);
                    assert.equal(reads.length, 1);
                    assert.equal(await preview.isVisible(), false, "replay does not reconstruct previews");

                    await delta("next", "<script>window.pwned = true</script>");
                    await endAttempt(linked.id, linked._meta);
                    assert.equal(await text.textContent(), "<script>window.pwned = true</script>", "late link folding cannot clear a newer attempt");
                    assert.equal(await preview.locator("script").count(), 0);
                    assert.equal(await page.evaluate(() => window.pwned), undefined);
                    await delta("replacement", "new attempt");
                    assert.equal(await text.textContent(), "new attempt", "attempts do not accumulate each other's text");
                    await assert.rejects(delta("", "stale"), /Reasoning preview must name its active message/u);
                    await assert.rejects(consume({ sessionUpdate: "agent_thought_chunk", messageId: "replacement", content: { type: "text", text: 42 } }),
                        /Reasoning preview must name its active message/u);
                    assert.equal(await text.textContent(), "new attempt");
                    for (const state of ["idle", "running"]) {
                        await consume({ sessionUpdate: "state_update", state });
                        assert.equal(await text.textContent(), "", state);
                        assert.equal(await preview.isVisible(), false);
                        await delta("replacement", "new attempt");
                    }
                    await page.evaluate(() => window.preview.clear());
                    assert.equal(await text.textContent(), "", "delivery teardown releases the retained tail");
                    assert.deepEqual(await page.evaluate(() => window.messages), [linked]);
                    for (const body of [null, false, {}, { url: "/reasoning" }, { url: 42, mimeType: "text/plain" }]) {
                        await assert.rejects(page.evaluate((body) => window.present([{
                            id: "invalid", role: "reasoning", content: "", _meta: { plurnk: { body } },
                        }]), body), /Reasoning body reference must supply its URL and MIME type/u);
                    }
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}
