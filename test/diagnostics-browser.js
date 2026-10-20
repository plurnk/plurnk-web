import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import browserDiagnostics from "./browser-diagnostics.js";
import conversationFixture from "./conversation-fixture.js";

// {§web-worker-diagnostics} Real templates and public validators; no diagnostic HTML supplied by the test.
export default async function verifyDiagnostics(t) {
    const { server, url } = await conversationFixture(new URL("./diagnostics-entry.js", import.meta.url));
    try {
        for (const engine of [chromium, firefox, webkit]) {
            await t.test(engine.name(), async () => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext();
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    await page.goto(url);
                    await page.waitForFunction(() => typeof window.presentDiagnostic === "function");
                    const receive = (event) => page.evaluate((event) => window.presentDiagnostic(event), event);
                    const list = page.locator("#worker-diagnostics");
                    const rows = list.locator("ol > li");
                    assert.equal(await list.isVisible(), false);
                    await receive({ type: "CUSTOM", name: "another.extension", value: null });
                    assert.equal(await rows.count(), 0);
                    const notice = { type: "CUSTOM", name: "plurnk.notice", value: {
                        source: "engine:provider", kind: "provider_unavailable", level: "warn",
                        message: '<img src="/probe" onerror="alert(1)"> Retrying.',
                        position: { type: "log-coordinate", coordinate: "log:///1/2/3" },
                    } };
                    await receive(notice);
                    assert.equal(await list.isVisible(), true);
                    assert.equal(await rows.first().getByRole("article", { name: "Warning · engine:provider:provider_unavailable", exact: true }).count(), 1);
                    assert.equal(await rows.first().locator('[data-text="diagnostic-message"]').textContent(), notice.value.message);
                    assert.equal(await rows.first().getAttribute("data-diagnostic-level"), "warn");
                    assert.equal(await rows.first().locator("header, details, code").count(), 0);
                    assert.equal(await rows.first().getAttribute("data-diagnostic-details"), null);
                    await rows.first().evaluate((element) => { window.retainedDiagnostic = element; });
                    await receive(structuredClone(notice));
                    assert.equal(await rows.count(), 1, "reconnection replay is not another claimed occurrence");
                    assert.equal(await rows.first().evaluate((element) => element === window.retainedDiagnostic), true);
                    await receive({ ...notice, value: { ...notice.value, message: "Retrying in 10s." } });
                    await receive({ ...notice, subagentRunId: "ops://child/7" });
                    assert.equal(await rows.count(), 3, "changed facts and different producers retain their own evidence");
                    assert.equal(await rows.nth(2).getAttribute("data-subagent-run-id"), "ops://child/7");
                    for (const level of ["info", "error"]) await receive({ ...notice, value: { source: "fixture", kind: level, level } });
                    const problem = { type: "CUSTOM", name: "plurnk.problem", value: {
                        type: "https://problems.plurnk.xyz/fixture/unavailable", title: "Catalog unavailable", status: 503,
                        detail: "Configured catalog is unavailable.", recovery: "Check the model configuration.", retryable: false,
                    } };
                    await receive(problem);
                    assert.equal(await rows.last().getByRole("article", { name: `Error · ${problem.value.title}`, exact: true }).count(), 1);
                    assert.equal(await rows.last().locator('[data-text="diagnostic-recovery"]').textContent(), problem.value.recovery);
                    assert.equal(await list.locator("img, script, form, a").count(), 0, "diagnostic data cannot create actions or network requests");
                    assert.equal(await page.locator("[data-messages] > li").count(), 0, "diagnostics never fabricate conversation messages");
                    assert.equal(await page.locator("#worker-status").getAttribute("data-connection"), "initial", "severity does not drive lifecycle");
                    await assert.rejects(receive({ ...notice, value: { source: "broken" } }), /invalid Notice/u);
                    await assert.rejects(receive({ ...problem, value: { title: "broken" } }), /invalid RFC 9457 Problem Details/u);
                    assert.equal(await rows.count(), 6, "invalid data cannot displace valid diagnostics");
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}
