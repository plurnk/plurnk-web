import assert from "node:assert/strict";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics from "./browser-diagnostics.js";

// {§web-session-reasoning} Reasoning renders as a prompt-top 💭 Thinking pill and lazy-fetched working disclosure, never a separate streaming panel.
export default async function verifyReasoning(t) {
    const { server, url } = await conversationFixture(new URL("./body-entry.js", import.meta.url));
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
                    await page.waitForFunction(() => typeof window.present === "function");

                    // Empty unstreamed reasoning message renders no transcript row.
                    const emptyAttempt = { id: "attempt", role: "reasoning", content: "" };
                    await page.evaluate((m) => window.present([m]), emptyAttempt);
                    assert.equal(await page.locator("[data-messages] > li").count(), 0, "empty attempt messages are not empty history disclosures");

                    // Streaming reasoning attaches a pulsing 💭 pill on the preceding user prompt.
                    const prompt = { id: "prompt-1", role: "user", content: "Analyze the boundary.", _meta: { plurnk: { loopSeq: 1 } } };
                    const streamingAttempt = {
                        id: "attempt",
                        role: "reasoning",
                        content: "A provisional <script>window.pwned = true</script> hypothesis.",
                        _meta: { plurnk: { sessionName: "session1", loopSeq: 1, turnSeq: 3, coordinate: "1/3", streaming: true } },
                    };
                    await page.evaluate((msgs) => window.present(msgs), [prompt, streamingAttempt]);
                    const promptRow = page.locator('[data-message-id="prompt-1"]');
                    const workDetails = promptRow.locator("[data-prompt-work]");
                    assert.equal(await workDetails.getAttribute("data-work-running"), "true");
                    assert.equal(await workDetails.locator('[data-operation-tally="reasoning"]').textContent(), "1");
                    assert.equal(await workDetails.evaluate((node) => node.open), false);
                    await workDetails.locator(":scope > summary").click();
                    const row = page.locator('[data-message-id="attempt"]');
                    assert.equal(await row.locator(":scope > article > details > summary").textContent(), "Thinking…");
                    assert.equal(await row.locator("summary").getAttribute("aria-label"), "Thinking…");
                    assert.match(await row.locator('summary > [data-plurnk-field="heading"]').evaluate((element) => getComputedStyle(element, "::before").content), /💭/u);
                    assert.equal(await row.locator("script").count(), 0);
                    assert.equal(await page.evaluate(() => window.pwned), undefined);

                    // Linked settled reasoning folds into an on-demand body reference without eager fetching.
                    const linked = {
                        id: "attempt",
                        role: "reasoning",
                        content: "",
                        _meta: {
                            plurnk: {
                                sessionName: "session1",
                                loopSeq: 1,
                                turnSeq: 3,
                                coordinate: "1/3",
                                body: { url: "/acp/7/9/entry?target=reasoning%3A%2F%2Fsession1%2F1%2F3", mimeType: "text/plain" },
                            },
                        },
                    };
                    await page.evaluate((msgs) => { window.messages = msgs; window.present(window.messages); }, [prompt, linked]);
                    assert.equal(await workDetails.getAttribute("data-work-running"), null);
                    assert.equal(await row.locator("[data-body-reference]").count(), 1,
                        "linked reasoning exposes its lazy body reference");
                    assert.equal(await row.locator(":scope > article > details > summary").textContent(), "Thinking");
                    assert.equal(await row.getByRole("article", { name: "Thinking", exact: true }).count(), 1);
                    assert.equal(await row.locator("details").getAttribute("open"), null);
                    assert.equal(credentials, 0);
                    assert.deepEqual(reads, [], "closed reasoning does not fetch");

                    await row.locator("summary").click();
                    await row.locator("[data-body-reference]").scrollIntoViewIfNeeded();
                    await row.locator('[data-body-state="loaded"]').waitFor();
                    assert.equal(await row.locator("[data-body-reference]").textContent(), body);
                    assert.equal(await row.locator("[data-body-reference] form, [data-body-reference] strong").count(), 0,
                        "fetched Markdown and HTML stay literal");
                    assert.equal(credentials, 1);
                    assert.deepEqual(reads, ["Bearer reasoning-test"]);
                    assert.deepEqual(await page.evaluate(() => window.messages), [prompt, linked], "reading never writes reasoning into SDK-owned messages");

                    await page.evaluate(() => {
                        window.loadedBody = document.querySelector("[data-body-reference]");
                        window.present(structuredClone(window.messages));
                    });
                    assert.equal(await row.locator("[data-body-reference]").evaluate((element) => element === window.loadedBody), true);
                    assert.equal(await row.locator("details").evaluate((element) => element.open), true);
                    assert.equal(reads.length, 1);

                    for (const invalidBody of [null, false, {}, { url: "/reasoning" }, { url: 42, mimeType: "text/plain" }]) {
                        await assert.rejects(page.evaluate((invalidBody) => window.present([{
                            id: "invalid", role: "reasoning", content: "", _meta: { plurnk: { body: invalidBody } },
                        }]), invalidBody), /Reasoning body reference must supply its URL and MIME type/u);
                    }
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}
