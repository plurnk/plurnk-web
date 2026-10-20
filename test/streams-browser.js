import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics from "./browser-diagnostics.js";

// {§web-worker-streams} Real templates, projection, SDK and management requests; controlled wire evidence.
export default async function verifyStreams(t) {
    const { server, url } = await conversationFixture(new URL("./streams-entry.js", import.meta.url));
    try {
        for (const engine of [chromium, firefox, webkit]) {
            await t.test(engine.name(), async () => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 720 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    const reads = [];
                    let credentials = 0;
                    await page.route("**/auth/token", (route) => {
                        credentials++;
                        return route.fulfill({ json: { token_type: "Bearer", access_token: "stream-fixture-credential" } });
                    });
                    const source = '🐹<script>window.outputExecuted=true</script><img src="/unasked"><form>Not controls</form>';
                    const channel = (content, state = "active") => ({
                        content, state, contentOffset: 0, contentLength: [...content].length, mimetype: "text/stream", weight: 1,
                    });
                    const entry = { entryId: 9, target: "sh:///silent", channels: { stdout: channel(source), stderr: channel("") } };
                    let result = { ok: true, result: { status: 200, entry } };
                    let held;
                    await page.route("**/agui", async (route) => {
                        const request = route.request();
                        assert.equal(request.headers().authorization, "Bearer stream-fixture-credential");
                        const input = request.postDataJSON();
                        reads.push(input);
                        if (held) await held.promise;
                        await route.fulfill({ contentType: "text/event-stream", body: [
                            { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
                            { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId, result: { kind: "entry.read", ...result } },
                        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") });
                    });
                    await page.goto(url);
                    await page.waitForFunction(() => typeof window.presentStreams === "function");
                    const stream = { entryId: 9, workerId: 9, target: "sh:///silent", lifetime: "loop",
                        channels: [{ channel: "stdout", state: "active", mimetype: "text/stream" },
                            { channel: "stderr", state: "active", mimetype: "text/stream" }] };
                    const census = (streams) => page.evaluate((streams) => window.presentStreams(streams), streams);
                    const emit = (value) => page.evaluate((value) => window.streamEvent(value), value);
                    const current = page.locator("#worker-streams [data-open-streams]");
                    const row = current.locator('[data-stream-id="9"]');
                    const output = row.locator("[data-entry-output]");
                    await census([stream]);
                    assert.equal(await current.locator(":scope > li").count(), 1,
                        "a silent executor appears without events or reads");
                    await page.locator("#worker-streams > details:first-child > summary").click();
                    await row.locator(":scope > details > summary").click();
                    assert.deepEqual(await row.locator("[data-text=stream-state]").allTextContents(), ["active", "active"]);
                    assert.deepEqual(await row.locator("[data-text=stream-length]").allTextContents(), ["Not observed", "Not observed"]);
                    assert.equal(credentials, 0, "opening a disclosure never fetches output");
                    await emit({ entryId: 12, workerId: 9, target: "sh:///detached", channel: "stdout", contentLength: 4, state: "closed" });
                    assert.equal(await current.locator(":scope > li").count(), 1, "events cannot add census members");
                    await census([stream, { ...stream, entryId: 12, target: "sh:///detached", lifetime: "detached" }]);
                    assert.equal(await current.locator('[data-stream-id="12"] [data-text=stream-length]').first().textContent(), "4");
                    assert.equal(await current.locator('[data-stream-id="12"] [data-text=stream-state]').first().textContent(), "active",
                        "events do not override channel state");
                    await emit({ entryId: 9, workerId: 9, target: stream.target, channel: "stdout", contentLength: 7, state: "active" });
                    assert.equal(await row.locator("[data-text=stream-length]").first().textContent(), "7");
                    await row.getByRole("button", { name: "Read output", exact: true }).click();
                    await output.locator('[data-output-snapshot]').waitFor();
                    assert.deepEqual(await output.locator("[data-text=output-content]").allTextContents(), [source, ""]);
                    assert.equal(await output.locator("[data-text=output-length]").first().textContent(), String([...source].length));
                    assert.equal(await output.locator("script, img, form").count(), 0);
                    assert.equal(reads.length, 1);
                    assert.deepEqual(reads[0].messages, []);
                    assert.deepEqual(reads[0].tools, []);
                    assert.equal(reads[0].threadId, "7#user");
                    assert.deepEqual(reads[0].forwardedProps, { plurnk: { action: { kind: "entry.read", target: stream.target }, reasoning: "link" } });
                    await page.evaluate(() => { window.outputNode = document.querySelector("[data-output-snapshot]"); });
                    await census([{ ...stream, channels: stream.channels.map((item) => ({ ...item, state: "closed" })) }]);
                    assert.equal(await row.locator(":scope > details").getAttribute("open"), "");
                    assert.equal(await page.evaluate(() => window.outputNode === document.querySelector("[data-output-snapshot]")), true);
                    assert.equal(reads.length, 1, "census changes do not refresh inspected output");

                    const problem = { type: "https://example.test/problems/missing", title: "Entry unavailable", status: 404, detail: "Entry is no longer readable." };
                    result = { ok: true, result: { status: 404, entry: null, problem } };
                    await row.getByRole("button", { name: "Read output", exact: true }).click();
                    await output.locator("[data-output-failure]").waitFor();
                    assert.equal(await output.locator("[data-text=output-error]").textContent(), problem.detail);
                    assert.equal(await output.locator("[data-text=output-content]").first().textContent(), source, "a failed refresh retains its prior snapshot");
                    result = { ok: true, result: { status: 200, entry: { ...entry, channels: { stdout: channel("finished", "closed") } } } };
                    await row.getByRole("button", { name: "Read output", exact: true }).click();
                    await page.waitForFunction(() => document.querySelector("[data-text=output-content]")?.textContent === "finished");
                    assert.equal(credentials, 3, "each explicit request obtains current credentials");
                    await page.evaluate(() => window.resetStreams());
                    assert.deepEqual(await row.locator("[data-text=stream-length]").allTextContents(), ["Not observed", "Not observed"]);
                    assert.equal(await output.locator("[data-text=output-content]").textContent(), "finished", "delivery reset does not erase a labelled snapshot");

                    const conclusion = { entryId: 9, workerId: 9, target: stream.target, scheme: "sh", summary: "Exited 7",
                        subscriptionId: 20, result: { status: 500, exitCode: 7,
                            problem: { ...problem, status: 500, title: "Nonzero exit", detail: "Command exited 7." } } };
                    await emit(conclusion);
                    assert.equal(await current.locator(":scope > li").count(), 1, "a conclusion does not substitute for the census");
                    const outcomes = page.locator("[data-stream-outcomes]");
                    await outcomes.locator(":scope > summary").click();
                    await outcomes.locator("li > details > summary").click();
                    assert.deepEqual(JSON.parse(await outcomes.locator("[data-text=stream-result]").textContent()), conclusion.result);
                    assert.equal(await outcomes.locator("[data-text=stream-problem]").textContent(), "Command exited 7.");
                    await emit(conclusion);
                    assert.equal(await outcomes.locator("ol > li").count(), 1);
                    assert.equal(await outcomes.locator("li > details").getAttribute("open"), "");
                    await page.evaluate(() => window.resetStreams());
                    assert.equal(await outcomes.locator("ol > li").count(), 1, "reconnection retains observed outcomes");
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "literal output stays inside a narrow viewport");

                    held = Promise.withResolvers();
                    const requested = page.waitForRequest("**/agui");
                    const delivered = page.waitForResponse("**/agui");
                    await row.getByRole("button", { name: "Read output", exact: true }).click();
                    await requested;
                    assert.equal(await row.getByRole("button", { name: "Read output", exact: true }).isDisabled(), true);
                    await census([]);
                    held.resolve();
                    await (await delivered).finished();
                    assert.equal(await current.locator(":scope > li").count(), 0, "late inspection cannot resurrect a removed stream");
                    assert.equal(await page.locator("[data-no-streams]").isVisible(), true);
                    assert.equal(reads.length, 4);
                    await census([stream]);
                    await row.locator(":scope > details > summary").click();
                    held = undefined;
                    result = { ok: false, problem };
                    await row.getByRole("button", { name: "Read output", exact: true }).click();
                    await output.locator("[data-output-failure]").waitFor();
                    assert.equal(await output.locator("[data-text=output-error]").textContent(), problem.detail, "management refusal is not an empty snapshot");
                    result = { ok: true, result: { status: 200, entry: { ...entry, channels: { stdout: channel("") } } } };
                    result.result.entry.channels.stdout.contentLength = 1;
                    await row.getByRole("button", { name: "Read output", exact: true }).click();
                    await page.waitForFunction(() => document.querySelector("[data-entry-output]")?.dataset.outputState === "error"
                        && document.querySelector("[data-text=output-error]")?.textContent !== "Entry is no longer readable.");
                    assert.equal(await output.getAttribute("data-output-state"), "error", "an invalid channel suffix is refused by the public validator");
                    assert.equal(await output.locator("[data-output-snapshot]").isVisible(), false);
                    held = Promise.withResolvers();
                    const leaving = page.waitForRequest("**/agui");
                    await row.getByRole("button", { name: "Read output", exact: true }).click();
                    await leaving;
                    await page.evaluate(() => window.leaveStreams());
                    await page.waitForFunction(() => document.querySelector("[data-entry-output]")?.dataset.outputState === "idle");
                    assert.equal(await row.getByRole("button", { name: "Read output", exact: true }).isDisabled(), false);
                    held.resolve();
                    assert.ok(reads.every((input) => input.forwardedProps.plurnk.action.kind === "entry.read"),
                        "aborting output inspection cannot issue a cancellation of daemon work");
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}
