import assert from "node:assert/strict";
import { firefox } from "playwright";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics, { httpFailure } from "./browser-diagnostics.js";

// {§web-session-activity} Real OTM templates and the shared authenticated body reader.
export default async function verifyActivity(t) {
    const { server, url } = await conversationFixture(new URL("./activity-entry.js", import.meta.url));
    try {
        for (const engine of engines) {
            await t.test(engine.name(), async () => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 720 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    let credentials = 0;
                    const reads = [];
                    const source = '<script>window.activityExecuted=true</script><img src="/unasked"><form>Not controls</form>';
                    let fail = true;
                    let held;
                    await page.route("**/auth/token", (route) => {
                        credentials++;
                        return route.fulfill({ json: { token_type: "Bearer", access_token: "activity-fixture-credential" } });
                    });
                    await page.route("**/acp/**", async (route) => {
                        reads.push(route.request().url());
                        assert.equal(route.request().headers().authorization, "Bearer activity-fixture-credential");
                        if (route.request().url().endsWith("/failed") && fail) {
                            fail = false;
                            await route.fulfill({ status: 404, body: "Missing" });
                        } else {
                            if (/\/(held|depart)$/u.test(route.request().url())) await held.promise;
                            await route.fulfill({ contentType: "text/html", body: route.request().url().endsWith("/replaced") ? "Replacement content" : source });
                        }
                    });
                    await page.goto(url);
                    await page.waitForFunction(() => typeof window.presentActivity === "function");
                    const receive = (event) => page.evaluate((event) => window.presentActivity(event), event);
                    const activity = page.locator("#session-activity");
                    const rows = activity.locator(":scope > ul > li");
                    assert.equal(await activity.isVisible(), false);
                    await receive({ sessionUpdate: "another.extension", value: null });
                    assert.equal(await rows.count(), 0);
                    const ambient = {
                        sessionUpdate: "tool_call_update", toolCallId: "1/2/3", status: "completed",
                        rawInput: { target: { raw: "evidence.html" }, aside: "Inspect evidence" },
                        rawOutput: { status: 200, range: { unit: "line", total: 2, requested: [1, -1], returned: [1, 2] } },
                        _meta: { plurnk: {
                            id: 17, sessionId: 9, loopSeq: 1, turnSeq: 2, sequence: 3, coordinate: "1/2/3",
                            origin: "_plurnk", op: "READ", source: null, state: "resolved", status: 200, attrs: {},
                            body: { url: new URL("/acp/7/9/entry?target=log%3A%2F%2F%2F1%2F2%2F3%2FREAD", url).href, mimeType: "text/html" },
                        } },
                    };
                    await receive(ambient);
                    assert.equal(reads.length, 0);
                    assert.equal(credentials, 0, "a closed activity disclosure loads nothing");
                    await activity.locator(":scope > summary").click();
                    const row = rows.first();
                    assert.equal(await row.getAttribute("data-plurnk-session"), "9");
                    assert.equal(await row.getAttribute("data-plurnk-coordinate"), "1/2/3");
                    assert.equal(await row.getAttribute("data-plurnk-state"), "resolved");
                    assert.equal(await row.getAttribute("data-plurnk-status"), "200");
                    assert.equal(await row.getByRole("article", { name: "READ · Session 9 · 1/2/3 · resolved · 200", exact: true }).count(), 1);
                    assert.equal(await row.locator("details, dl").count(), 0);
                    assert.equal(await row.getAttribute("data-activity-evidence"), null);
                    assert.equal(await row.getAttribute("data-activity-key"), null);
                    assert.equal(await row.locator('[data-plurnk-field="heading"]').innerText(), "Inspect evidence");
                    assert.equal(await row.locator("[data-plurnk-operands]").innerText(), "(evidence.html) {2}");
                    assert.equal(await row.locator("[data-body-reference]").count(), 0, "ambient READ uses the same summary without fetching readback");
                    await page.evaluate(() => { window.summaryNode = document.querySelector("#session-activity [data-plurnk-operands]"); });
                    await receive(structuredClone(ambient));
                    assert.equal(await rows.count(), 1);
                    assert.equal(await row.locator("article > details > pre").count(), 0);
                    assert.equal(await row.locator("button, div, section").count(), 0);
                    assert.equal(await page.evaluate(() => window.summaryNode === document.querySelector("#session-activity [data-plurnk-operands]")), true);
                    await receive({ ...ambient, _meta: { plurnk: { ...ambient._meta.plurnk, state: "failed", status: 409, source: "message://child/1" } } });
                    assert.equal(await rows.count(), 1, "a row update is not a new event history");
                    assert.equal(await row.getAttribute("data-plurnk-state"), "failed");
                    assert.equal(await row.getAttribute("data-plurnk-source"), null);
                    assert.equal(await page.evaluate(() => window.summaryNode === document.querySelector("#session-activity [data-plurnk-operands]")), true);
                    assert.equal(reads.length, 0);

                    await receive({ ...ambient, _meta: { plurnk: { ...ambient._meta.plurnk, id: 18, attrs: { kind: "emission" } } } });
                    assert.equal(await rows.count(), 1, "an emission announcement duplicates already-rendered operations");
                    await receive({ ...ambient, rawInput: source, _meta: { plurnk: { ...ambient._meta.plurnk, id: 19, op: null, origin: "model", attrs: { kind: "emissionAttempt" },
                        body: undefined, status: 400, state: "failed" } } });
                    assert.match(await rows.nth(1).locator("article").getAttribute("aria-label"), /^Rejected emission/u);
                    assert.equal(await rows.nth(1).innerText(), "");
                    await receive({ ...ambient, _meta: { plurnk: { ...ambient._meta.plurnk, subagentRunId: "ops://child/7", sessionId: 12,
                        reasoning: { url: new URL("/acp/7/12/entry?target=reasoning%3A%2F%2Fchild%2F1%2F2", url).href, mimeType: "text/plain" } } } });
                    const child = rows.nth(2);
                    assert.equal(await child.getAttribute("data-plurnk-session"), "12");
                    assert.equal(await child.getAttribute("data-subagent-run-id"), "ops://child/7");
                    assert.equal(await child.locator("details > details > summary").textContent(), "Reasoning");
                    assert.equal(reads.some((url) => new URL(url).searchParams.get("target")?.startsWith("reasoning:")), false, "closed foreign reasoning is not fetched");
                    await child.locator("article > details > summary").click();
                    await child.locator("details > details > summary").click();
                    const body = child.locator("[data-body-reference]");
                    await body.scrollIntoViewIfNeeded();
                    await child.locator('[data-body-state="loaded"]').waitFor();
                    assert.equal(await body.textContent(), source);

                    const outside = { sessionUpdate: "agent_message_chunk", messageId: "user-1-2", content: { type: "text", text: source },
                        _meta: { plurnk: { op: "outside-", outside: { coordinate: "user-1-2", tokens: 21 } } } };
                    await receive(outside);
                    await receive(outside);
                    const prose = rows.nth(3);
                    assert.equal(await prose.locator("article > details > pre").textContent(), source);
                    assert.equal(await prose.getAttribute("data-plurnk-tokens"), null);
                    assert.equal(await prose.getAttribute("data-activity-text"), null);
                    assert.equal(await prose.getByRole("article", { name: "Outside operations", exact: true }).count(), 1);
                    await receive({ ...outside, content: { type: "text", text: "Changed evidence" }, _meta: { plurnk: { op: "outside-", outside: { coordinate: "user-1-2", tokens: 3 } } } });
                    assert.equal(await rows.count(), 4);
                    assert.equal(await prose.locator("article > details > pre").textContent(), "Changed evidence");
                    assert.equal(await activity.locator("img, script, form, a").count(), 0);
                    assert.equal(await page.locator("[data-messages] > li").count(), 0);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                    for (const row of [{}, { ...ambient._meta.plurnk, sessionId: 0, body: undefined }, { ...ambient._meta.plurnk, sequence: NaN },
                        { ...ambient._meta.plurnk, reasoning: { url: 123 } }, { ...ambient._meta.plurnk, source: {} }]) {
                        await assert.rejects(receive({ ...ambient, _meta: { plurnk: row } }), /Ambient/u);
                    }
                    for (const [content, meta] of [
                        [{ type: "text", text: source }, { op: "outside-", outside: {} }],
                        [{ type: "text", text: source }, { op: "outside-", outside: { coordinate: "user-1-2", tokens: -1 } }],
                        [{ type: "text", text: {} }, { op: "outside-", outside: { coordinate: "user-1-2", tokens: 21 } }],
                    ]) {
                        await assert.rejects(receive({ sessionUpdate: "agent_message_chunk", messageId: "user-1-2", content, _meta: { plurnk: meta } }), /Outside/u);
                    }
                    assert.equal(await rows.count(), 4, "invalid evidence does not mutate the valid view");

                    const setBody = async (address) => {
                        await receive({ ...ambient, _meta: { plurnk: { ...ambient._meta.plurnk, subagentRunId: "ops://child/7", sessionId: 12, reasoning: { url: address } } } });
                        await child.locator("details > details").evaluate((element) => { element.open = true; });
                        await body.scrollIntoViewIfNeeded();
                    };
                    const beforeCredentials = credentials;
                    await setBody("https://elsewhere.invalid/body");
                    await child.locator('[data-body-state="error"]').waitFor();
                    assert.equal(await body.textContent(), "Read address must be on this daemon's origin.");
                    assert.equal(credentials, beforeCredentials);
                    await setBody(new URL("/acp/failed", url).href);
                    await child.locator('[data-body-state="error"]').waitFor();
                    assert.equal(await body.textContent(), "Read request failed (404).");
                    checkBrowser(engine === firefox ? [] : [httpFailure("/acp/failed", 404)]);
                    await child.getByRole("button", { name: "Retry", exact: true }).click();
                    await child.locator('[data-body-state="loaded"]').waitFor();
                    assert.equal(await body.textContent(), source);

                    held = Promise.withResolvers();
                    const requested = page.waitForRequest("**/acp/held");
                    const delivered = page.waitForResponse("**/acp/held");
                    await setBody(new URL("/acp/held", url).href);
                    await requested;
                    assert.equal(await body.getAttribute("aria-busy"), "true");
                    await setBody(new URL("/acp/replaced", url).href);
                    await child.locator('[data-body-state="loaded"]').waitFor();
                    held.resolve();
                    await (await delivered).finished();
                    assert.equal(await body.textContent(), "Replacement content", "a late read cannot populate a different reference");
                    held = Promise.withResolvers();
                    const leaving = page.waitForRequest("**/acp/depart");
                    await setBody(new URL("/acp/depart", url).href);
                    await leaving;
                    await page.evaluate(() => window.leaveActivity());
                    // {§web-result-bodies} A read the page abandoned is not a failure: it rests, and reads again when asked.
                    await child.locator('[data-body-state="idle"]').waitFor({ state: "attached" });
                    assert.equal(await body.getAttribute("aria-busy"), null);
                    assert.equal(await body.getAttribute("role"), null, "no alert");
                    assert.equal(await child.getByRole("button", { name: "Read", exact: true }).count(), 1);
                    held.resolve();
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}
