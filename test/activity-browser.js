import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics, { httpFailure } from "./browser-diagnostics.js";

// {§web-worker-activity} Real OTM templates and the shared authenticated body reader.
export default async function verifyActivity(t) {
    const { server, url } = await conversationFixture(new URL("./activity-entry.js", import.meta.url));
    try {
        for (const engine of [chromium, firefox, webkit]) {
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
                    await page.route("**/agui/**", async (route) => {
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
                    const activity = page.locator("#worker-activity");
                    const rows = activity.locator(":scope > ul > li");
                    assert.equal(await activity.isVisible(), false);
                    await receive({ type: "CUSTOM", name: "another.extension", value: null });
                    assert.equal(await rows.count(), 0);
                    const ambient = { type: "CUSTOM", name: "plurnk.ambient", value: {
                        id: 17, worker_id: 9, loop_seq: 1, turn_seq: 2, sequence: 3, at: "2026-10-20T12:00:00Z",
                        origin: "_plurnk", op: "READ", source: null, state: "resolved", status_rx: 200,
                        tx: { target: { raw: "evidence.html" }, aside: "Inspect evidence" },
                        rx: { status: 200, range: { unit: "line", total: 2, requested: [1, -1], returned: [1, 2] } }, attrs: {},
                        body: { url: new URL("/agui/7/9/log/1/2/3/READ", url).href, mimeType: "text/html" },
                    } };
                    await receive(ambient);
                    assert.equal(reads.length, 0);
                    assert.equal(credentials, 0, "a closed activity disclosure loads nothing");
                    await activity.locator(":scope > summary").click();
                    const row = rows.first();
                    assert.equal(await row.getAttribute("data-plurnk-worker"), "9");
                    assert.equal(await row.getAttribute("data-plurnk-coordinate"), "1/2/3");
                    assert.equal(await row.getAttribute("data-plurnk-state"), "resolved");
                    assert.equal(await row.getAttribute("data-plurnk-status"), "200");
                    assert.equal(await row.getByRole("article", { name: "READ · Worker 9 · 1/2/3 · resolved · 200", exact: true }).count(), 1);
                    assert.equal(await row.locator("details, dl").count(), 0);
                    assert.equal(await row.getAttribute("data-activity-evidence"), null);
                    assert.equal(await row.getAttribute("data-activity-key"), null);
                    assert.equal(await row.locator("article > header").innerText(), "Inspect evidence");
                    assert.equal(await row.locator("article > p").innerText(), "(evidence.html) {2}");
                    assert.equal(await row.locator("[data-body-reference]").count(), 0, "ambient READ uses the same summary without fetching readback");
                    await page.evaluate(() => { window.summaryNode = document.querySelector("#worker-activity article > p"); });
                    await receive(structuredClone(ambient));
                    assert.equal(await rows.count(), 1);
                    assert.equal(await row.locator("article > pre").count(), 0);
                    assert.equal(await row.locator("button, div, section").count(), 0);
                    assert.equal(await page.evaluate(() => window.summaryNode === document.querySelector("#worker-activity article > p")), true);
                    await receive({ ...ambient, value: { ...ambient.value, state: "failed", status_rx: 409, source: "message://child/1" } });
                    assert.equal(await rows.count(), 1, "a row update is not a new event history");
                    assert.equal(await row.getAttribute("data-plurnk-state"), "failed");
                    assert.equal(await row.getAttribute("data-plurnk-source"), null);
                    assert.equal(await page.evaluate(() => window.summaryNode === document.querySelector("#worker-activity article > p")), true);
                    assert.equal(reads.length, 0);

                    await receive({ ...ambient, value: { ...ambient.value, id: 18, attrs: { kind: "emission" } } });
                    assert.equal(await rows.count(), 1, "an emission announcement duplicates already-rendered operations");
                    await receive({ ...ambient, value: { ...ambient.value, id: 19, op: null, origin: "model", attrs: { kind: "emissionAttempt" },
                        body: undefined, tx: source, status_rx: 400, state: "failed" } });
                    assert.match(await rows.nth(1).locator("article").getAttribute("aria-label"), /^Rejected emission/u);
                    assert.equal(await rows.nth(1).innerText(), "");
                    await receive({ ...ambient, subagentRunId: "ops://child/7", value: { ...ambient.value, worker_id: 12,
                        reasoning: { url: new URL("/agui/7/12/reasoning/1/2", url).href, mimeType: "text/plain" } } });
                    const child = rows.nth(2);
                    assert.equal(await child.getAttribute("data-plurnk-worker"), "12");
                    assert.equal(await child.getAttribute("data-subagent-run-id"), "ops://child/7");
                    assert.equal(await child.locator("details > summary").textContent(), "Reasoning");
                    assert.equal(reads.some((url) => url.includes("/reasoning/")), false, "closed foreign reasoning is not fetched");
                    await child.locator("details > summary").click();
                    const body = child.locator("[data-body-reference]");
                    await body.scrollIntoViewIfNeeded();
                    await child.locator('[data-body-state="loaded"]').waitFor();
                    assert.equal(await body.textContent(), source);

                    const outside = { type: "CUSTOM", name: "plurnk.outside", value: { coordinate: "user-1-2", text: source, tokens: 21 } };
                    await receive(outside);
                    await receive(outside);
                    const prose = rows.nth(3);
                    assert.equal(await prose.locator("article > pre").textContent(), source);
                    assert.equal(await prose.getAttribute("data-plurnk-tokens"), null);
                    assert.equal(await prose.getAttribute("data-activity-text"), null);
                    assert.equal(await prose.getByRole("article", { name: "Outside operations", exact: true }).count(), 1);
                    await receive({ ...outside, value: { ...outside.value, text: "Changed evidence", tokens: 3 } });
                    assert.equal(await rows.count(), 4);
                    assert.equal(await prose.locator("article > pre").textContent(), "Changed evidence");
                    assert.equal(await activity.locator("img, script, form, a").count(), 0);
                    assert.equal(await page.locator("[data-messages] > li").count(), 0);
                    assert.equal(await page.locator("#worker-status").getAttribute("data-connection"), "initial");
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                    for (const value of [{}, { ...ambient.value, worker_id: 0 }, { ...ambient.value, sequence: NaN },
                        { ...ambient.value, reasoning: { url: 123 } }, { ...ambient.value, source: {} }]) {
                        await assert.rejects(receive({ ...ambient, value }), /Ambient/u);
                    }
                    for (const value of [{}, { ...outside.value, tokens: -1 }, { ...outside.value, text: {} }]) {
                        await assert.rejects(receive({ ...outside, value }), /Outside/u);
                    }
                    assert.equal(await rows.count(), 4, "invalid evidence does not mutate the valid view");

                    const setBody = async (address) => {
                        await receive({ ...ambient, subagentRunId: "ops://child/7", value: { ...ambient.value, worker_id: 12, reasoning: { url: address } } });
                        await child.locator("details").evaluate((element) => { element.open = true; });
                        await body.scrollIntoViewIfNeeded();
                    };
                    const beforeCredentials = credentials;
                    await setBody("https://elsewhere.invalid/body");
                    await child.locator('[data-body-state="error"]').waitFor();
                    assert.equal(await body.textContent(), "Body address must be on this daemon's origin.");
                    assert.equal(credentials, beforeCredentials);
                    await setBody(new URL("/agui/failed", url).href);
                    await child.locator('[data-body-state="error"]').waitFor();
                    assert.equal(await body.textContent(), "Body request failed (404).");
                    checkBrowser(engine === firefox ? [] : [httpFailure("/agui/failed", 404)]);
                    await child.getByRole("button", { name: "Retry", exact: true }).click();
                    await child.locator('[data-body-state="loaded"]').waitFor();
                    assert.equal(await body.textContent(), source);

                    held = Promise.withResolvers();
                    const requested = page.waitForRequest("**/agui/held");
                    const delivered = page.waitForResponse("**/agui/held");
                    await setBody(new URL("/agui/held", url).href);
                    await requested;
                    assert.equal(await body.getAttribute("aria-busy"), "true");
                    await setBody(new URL("/agui/replaced", url).href);
                    await child.locator('[data-body-state="loaded"]').waitFor();
                    held.resolve();
                    await (await delivered).finished();
                    assert.equal(await body.textContent(), "Replacement content", "a late read cannot populate a different reference");
                    held = Promise.withResolvers();
                    const leaving = page.waitForRequest("**/agui/depart");
                    await setBody(new URL("/agui/depart", url).href);
                    await leaving;
                    await page.evaluate(() => window.leaveActivity());
                    await child.locator('[data-body-state="error"]').waitFor();
                    assert.equal(await body.getAttribute("aria-busy"), null);
                    held.resolve();
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}
