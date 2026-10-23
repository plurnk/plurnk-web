import assert from "node:assert/strict";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics from "./browser-diagnostics.js";

// {§web-worker-streams} Real templates, projection, SDK and management requests; controlled wire evidence.
export default async function verifyStreams(t) {
    const { server, url } = await conversationFixture(new URL("./streams-entry.js", import.meta.url));
    try {
        for (const engine of engines) {
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
                    let held = null;
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
                    await page.waitForFunction(() => typeof window.streamEvent === "function");
                    const emit = (value) => page.evaluate((value) => window.streamEvent(value), value);
                    const outcomes = page.locator("[data-stream-outcomes]");
                    const rows = outcomes.locator(":scope > ul > li");
                    assert.equal(await page.locator("[data-open-streams], #worker-stream, #worker-stream-channel").count(), 0);
                    assert.equal(await outcomes.isVisible(), false, "no empty inventory is displayed");
                    await emit({ entryId: 9, workerId: 9, target: entry.target, channel: "stdout", contentLength: 7, state: "active" });
                    assert.equal(await rows.count(), 0, "channel progress does not create an inventory or an outcome");
                    assert.equal(credentials, 0);

                    const problem = { type: "https://example.test/problems/missing", title: "Entry unavailable", status: 404, detail: "Entry is no longer readable." };
                    const conclusion = { entryId: 9, workerId: 9, target: entry.target, scheme: "sh", summary: "Exited 7",
                        subscriptionId: 20, result: { status: 500, exitCode: 7,
                            problem: { ...problem, status: 500, title: "Nonzero exit", detail: "Command exited 7." } } };
                    await assert.rejects(emit({ ...conclusion, entryId: 0 }), /Stream event has no resource identity/u);
                    await assert.rejects(emit({ ...conclusion, result: { status: "invalid" } }), /invalid operation result/u);
                    assert.equal(await rows.count(), 0, "invalid conclusions do not leave partial rows");
                    await emit(conclusion);
                    const row = rows.first();
                    assert.equal(await outcomes.getAttribute("open"), null);
                    await outcomes.locator(":scope > summary").click();
                    await row.locator(":scope > details > summary").click();
                    assert.equal(await row.getAttribute("data-stream-status"), "500");
                    assert.equal(await row.getAttribute("data-stream-exit-code"), "7");
                    assert.equal(await row.locator("[data-text=stream-summary]").textContent(), "Exited 7");
                    assert.equal(await row.locator("[data-stream-result], [data-stream-evidence]").count(), 0);
                    assert.equal(await row.locator("[data-text=stream-problem]").textContent(), "Command exited 7.");
                    const output = row.locator("[data-entry-output]");
                    assert.equal(credentials, 0, "opening a disclosure never fetches output");
                    await row.getByRole("button", { name: "Read output", exact: true }).click();
                    await output.locator('[data-output-snapshot]').waitFor();
                    assert.deepEqual(await output.locator("[data-output-content]").allTextContents(), [source, ""]);
                    assert.equal(await output.locator('li[data-output-content]').count(), 0, "output text is not copied into attributes");
                    assert.deepEqual(await output.locator("[data-text=output-length]").allTextContents(), [String([...source].length), "0"]);
                    assert.deepEqual(await output.locator("[data-text=output-offset]").allTextContents(), ["0", "0"]);
                    assert.deepEqual(await output.locator("[data-text=output-mime]").allTextContents(), ["text/stream", "text/stream"]);
                    assert.equal(await output.locator("script, img, form").count(), 0);
                    assert.equal(reads.length, 1);
                    assert.deepEqual(reads[0].messages, []);
                    assert.deepEqual(reads[0].tools, []);
                    assert.equal(reads[0].threadId, "7#user");
                    assert.deepEqual(reads[0].forwardedProps, { plurnk: { action: { kind: "entry.read", target: entry.target }, reasoning: "link" } });
                    await page.evaluate(() => { window.outputNode = document.querySelector("[data-output-snapshot]"); });
                    await emit(conclusion);
                    await emit({ entryId: 9, workerId: 9, target: entry.target, channel: "stdout", contentLength: 20, state: "closed" });
                    assert.equal(await rows.count(), 1);
                    assert.equal(await row.locator(":scope > details").getAttribute("open"), "");
                    assert.equal(await page.evaluate(() => window.outputNode === document.querySelector("[data-output-snapshot]")), true);
                    assert.equal(reads.length, 1, "replayed conclusions and progress never refresh inspected output");

                    result = { ok: true, result: { status: 404, entry: null, problem } };
                    await row.getByRole("button", { name: "Read output", exact: true }).click();
                    await output.locator("[data-output-failure]").waitFor();
                    assert.equal(await output.locator("[data-text=output-error]").textContent(), problem.detail);
                    assert.equal(await output.locator("[data-output-content]").first().textContent(), source, "a failed refresh retains its prior snapshot");
                    result = { ok: true, result: { status: 200, entry: { ...entry, channels: { stdout: channel("finished", "closed") } } } };
                    await row.getByRole("button", { name: "Read output", exact: true }).click();
                    await page.waitForFunction(() => document.querySelector("[data-output-content]")?.textContent === "finished");
                    assert.equal(credentials, 3, "each explicit request obtains current credentials");
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "literal output stays inside a narrow viewport");

                    await emit({ ...conclusion, entryId: 12, target: "sh:///second", result: { status: 200 }, summary: "Finished" });
                    const second = rows.nth(1);
                    const secondOutput = second.locator("[data-entry-output]");
                    await second.locator(":scope > details > summary").click();
                    result = { ok: false, problem };
                    await second.getByRole("button", { name: "Read output", exact: true }).click();
                    await secondOutput.locator("[data-output-failure]").waitFor();
                    assert.equal(await secondOutput.locator("[data-text=output-error]").textContent(), problem.detail, "management refusal is not an empty snapshot");
                    result = { ok: true, result: { status: 200, entry: { ...entry, target: "sh:///second", channels: { stdout: channel("") } } } };
                    result.result.entry.channels.stdout.contentLength = 1;
                    await second.getByRole("button", { name: "Read output", exact: true }).click();
                    await page.waitForFunction(() => {
                        const output = document.querySelectorAll("[data-entry-output]")[1];
                        return output?.dataset.outputState === "error"
                            && output.querySelector("[data-text=output-error]")?.textContent !== "Entry is no longer readable.";
                    });
                    assert.equal(await secondOutput.getAttribute("data-output-state"), "error", "an invalid channel suffix is refused by the public validator");
                    assert.equal(await secondOutput.locator("[data-output-snapshot]").isVisible(), false);
                    held = Promise.withResolvers();
                    const leaving = page.waitForRequest("**/agui");
                    await second.getByRole("button", { name: "Read output", exact: true }).click();
                    await leaving;
                    assert.equal(await second.getByRole("button", { name: "Read output", exact: true }).isDisabled(), true);
                    await page.evaluate(() => window.leaveStreams());
                    await page.waitForFunction(() => document.querySelectorAll("[data-entry-output]")[1]?.dataset.outputState === "idle");
                    assert.equal(await second.getByRole("button", { name: "Read output", exact: true }).isDisabled(), false);
                    held.resolve();
                    assert.ok(reads.every((input) => input.forwardedProps.plurnk.action.kind === "entry.read"),
                        "aborting output inspection cannot issue a cancellation of daemon work");
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}
