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
                            if (held) await held.promise;
                            await route.fulfill({ contentType: "text/html", body: source });
                        }
                    });
                    await page.goto(url);
                    await page.waitForFunction(() => typeof window.presentActivity === "function");
                    const receive = (event) => page.evaluate((event) => window.presentActivity(event), event);
                    const activity = page.locator("#worker-activity");
                    const rows = activity.locator(":scope > ol > li");
                    assert.equal(await activity.isVisible(), false);
                    await receive({ type: "CUSTOM", name: "another.extension", value: null });
                    assert.equal(await rows.count(), 0);
                    const ambient = { type: "CUSTOM", name: "plurnk.ambient", value: {
                        id: 17, worker_id: 9, loop_seq: 1, turn_seq: 2, sequence: 3, at: "2026-10-20T12:00:00Z",
                        origin: "_plurnk", op: "READ", source: null, state: "resolved", status_rx: 200,
                        tx: { body: "Literal request" }, rx: { status: 200 }, attrs: {},
                        body: { url: new URL("/agui/7/9/log/1/2/3/READ", url).href, mimeType: "text/html" },
                    } };
                    await receive(ambient);
                    await activity.locator(":scope > summary").click();
                    const row = rows.first();
                    await row.locator(":scope > details > summary").click();
                    assert.equal(await row.locator("[data-text=activity-worker]").textContent(), "9");
                    assert.equal(await row.locator("[data-text=activity-coordinate]").textContent(), "1/2/3");
                    assert.equal(await row.locator("[data-text=activity-state]").textContent(), "resolved");
                    assert.equal(await row.locator("[data-text=activity-status]").textContent(), "200");
                    assert.deepEqual(JSON.parse(await row.locator("[data-text=activity-evidence]").textContent()), ambient.value);
                    assert.equal(reads.length, 0);
                    assert.equal(credentials, 0, "projection and disclosures neither fetch nor obtain credentials");
                    const body = row.locator("[data-activity-body] [data-body-reference]");
                    await body.getByRole("button", { name: "Read body", exact: true }).click();
                    await body.locator("[data-body-content]").waitFor();
                    assert.equal(await body.locator("[data-text=body-content]").textContent(), source);
                    await page.evaluate(() => { window.bodyNode = document.querySelector("#worker-activity [data-body-content]"); });
                    await receive(structuredClone(ambient));
                    assert.equal(await rows.count(), 1);
                    assert.equal(await row.locator(":scope > details").getAttribute("open"), "");
                    assert.equal(await page.evaluate(() => window.bodyNode === document.querySelector("#worker-activity [data-body-content]")), true);
                    await receive({ ...ambient, value: { ...ambient.value, state: "failed", status_rx: 409, source: "message://child/1" } });
                    assert.equal(await rows.count(), 1, "a row update is not a new event history");
                    assert.equal(await row.locator("[data-text=activity-state]").textContent(), "failed");
                    assert.equal(await row.locator("[data-text=activity-source]").textContent(), "message://child/1");
                    assert.equal(await page.evaluate(() => window.bodyNode === document.querySelector("#worker-activity [data-body-content]")), true);
                    assert.equal(reads.length, 1);

                    await receive({ ...ambient, value: { ...ambient.value, id: 18, attrs: { kind: "emission" } } });
                    assert.equal(await rows.count(), 1, "an emission announcement duplicates already-rendered operations");
                    await receive({ ...ambient, value: { ...ambient.value, id: 19, op: null, origin: "model", attrs: { kind: "emissionAttempt" },
                        body: undefined, tx: source, status_rx: 400, state: "failed" } });
                    assert.equal(await rows.nth(1).locator("[data-text=activity-operation]").textContent(), "Rejected emission");
                    await receive({ ...ambient, subagentRunId: "ops://child/7", value: { ...ambient.value, worker_id: 12,
                        reasoning: { url: new URL("/agui/7/12/reasoning/1/2", url).href, mimeType: "text/plain" } } });
                    const child = rows.nth(2);
                    await child.locator(":scope > details > summary").click();
                    assert.equal(await child.locator("[data-text=activity-worker]").textContent(), "12");
                    assert.equal(await child.locator("[data-text=activity-attribution]").textContent(), "ops://child/7");
                    assert.equal(await child.locator("[data-activity-reasoning] [data-text=body-address]").textContent(),
                        new URL("/agui/7/12/reasoning/1/2", url).href);
                    assert.equal(reads.length, 1, "foreign reasoning is not automatically fetched");

                    const outside = { type: "CUSTOM", name: "plurnk.outside", value: { coordinate: "user-1-2", text: source, tokens: 21 } };
                    await receive(outside);
                    await receive(outside);
                    const prose = rows.nth(3);
                    await prose.locator(":scope > details > summary").click();
                    assert.equal(await prose.locator("[data-text=activity-text]").textContent(), source);
                    assert.equal(await prose.locator("[data-text=activity-tokens]").textContent(), "21");
                    await receive({ ...outside, value: { ...outside.value, text: "Changed evidence", tokens: 3 } });
                    assert.equal(await rows.count(), 4);
                    assert.equal(await prose.locator("[data-text=activity-text]").textContent(), "Changed evidence");
                    assert.equal(await prose.locator(":scope > details").getAttribute("open"), "");
                    assert.equal(await activity.locator("img, script, form, a").count(), 0);
                    assert.equal(await page.locator("[data-messages] > li").count(), 0);
                    assert.equal(await page.locator("#worker-status").getAttribute("data-connection"), "initial");
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                    for (const value of [{}, { ...ambient.value, worker_id: 0 }, { ...ambient.value, sequence: NaN },
                        { ...ambient.value, body: { url: 123 } }, { ...ambient.value, source: {} }]) {
                        await assert.rejects(receive({ ...ambient, value }), /Ambient/u);
                    }
                    for (const value of [{}, { ...outside.value, tokens: -1 }, { ...outside.value, text: {} }]) {
                        await assert.rejects(receive({ ...outside, value }), /Outside/u);
                    }
                    assert.equal(await rows.count(), 4, "invalid evidence does not mutate the valid view");

                    const setBody = (address) => receive({ ...ambient, value: { ...ambient.value, body: { url: address } } });
                    await setBody("https://elsewhere.invalid/body");
                    await body.getByRole("button", { name: "Read body", exact: true }).click();
                    await body.locator("[data-body-failure]").waitFor();
                    assert.equal(await body.locator("[data-text=body-error]").textContent(), "Body address must be on this daemon's origin.");
                    assert.equal(credentials, 1);
                    await setBody(new URL("/agui/failed", url).href);
                    await body.getByRole("button", { name: "Read body", exact: true }).click();
                    await body.locator("[data-body-failure]").waitFor();
                    assert.equal(await body.locator("[data-text=body-error]").textContent(), "Body request failed (404).");
                    checkBrowser(engine === firefox ? [] : [httpFailure("/agui/failed", 404)]);
                    await body.getByRole("button", { name: "Read body", exact: true }).click();
                    await body.locator("[data-body-content]").waitFor();
                    assert.equal(await body.locator("[data-text=body-content]").textContent(), source);

                    held = Promise.withResolvers();
                    await setBody(new URL("/agui/held", url).href);
                    const requested = page.waitForRequest("**/agui/held");
                    const delivered = page.waitForResponse("**/agui/held");
                    await body.getByRole("button", { name: "Read body", exact: true }).click();
                    await requested;
                    assert.equal(await body.getByRole("button", { name: "Read body", exact: true }).isDisabled(), true);
                    await setBody(new URL("/agui/replaced", url).href);
                    held.resolve();
                    await (await delivered).finished();
                    assert.equal(await body.locator("[data-body-content]").isVisible(), false, "a late read cannot populate a different reference");
                    assert.equal(await body.locator("[data-text=body-address]").textContent(), new URL("/agui/replaced", url).href);
                    held = Promise.withResolvers();
                    const leaving = page.waitForRequest("**/agui/replaced");
                    await body.getByRole("button", { name: "Read body", exact: true }).click();
                    await leaving;
                    await page.evaluate(() => window.leaveActivity());
                    await body.locator('[data-body-loading]').waitFor({ state: "hidden" });
                    assert.equal(await body.getAttribute("data-body-state"), "idle");
                    held.resolve();
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}
