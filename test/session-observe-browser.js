import assert from "node:assert/strict";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics from "./browser-diagnostics.js";

function sessionMeta(lifecycle = "idle") {
    return {
        workspace: { id: 7, name: "conversation", projectRoot: null, projectLabel: null, preparation: [], activity: null },
        status: {
            lifecycle,
            model: { alias: null, provider: "fixture", model: "browser", effort: "low", effortSource: "default" },
            loopId: lifecycle === "idle" ? null : 1,
            packetCount: 0,
            waitUntil: null,
            descendants: [],
            inbox: [],
            claimedAt: lifecycle === "running" ? 1000 : null,
            terminatedAt: lifecycle === "completed" ? 2000 : null,
            spend: {
                requests: 0,
                usage: { inputTokens: 0, outputTokens: 0 },
                knownUsage: { inputTokens: 0, outputTokens: 0 },
                costUsd: "0",
                knownCostUsd: "0",
            },
        },
        budget: { contextTokens: null, contextCapacity: null, curationWeight: null, curationBudget: null },
        history: { older: null },
    };
}

// {§web-session-input} {§web-session-status} {§web-session-approval} Real observeSession keyboard and status contracts across engines.
export default async function verifySessionObserve(t) {
    const fixture = await conversationFixture(new URL("../web/app.js", import.meta.url));
    try {
        for (const engine of engines) {
            await t.test(engine.name(), async () => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 390, height: 600 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    fixture.onAcp((input) => {
                        if (input.method === "session/resume") {
                            return {
                                updates: [],
                                result: {
                                    configOptions: [],
                                    availableCommands: [],
                                    _meta: { plurnk: sessionMeta("idle") },
                                },
                            };
                        }
                        return { result: {} };
                    });
                    await page.goto(fixture.url);
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                    const draft = page.getByRole("textbox", { name: "Message", exact: true });
                    const approval = page.getByRole("button", { name: "Automatic approval", exact: true });
                    const statusLine = page.locator("#session-status > [data-status-line]");

                    assert.equal(await statusLine.isVisible(), false, "idle Manual Review session hides unfocused status row");
                    await draft.focus();
                    await draft.fill("Draft stays intact.");
                    assert.equal(await statusLine.isVisible(), true);
                    assert.equal(await approval.getAttribute("aria-pressed"), "false");

                    for (const lifecycle of ["idle", "running", "completed"]) {
                        fixture.push({
                            sessionUpdate: "state_update",
                            state: lifecycle === "running" ? "working" : "idle",
                            _meta: { plurnk: sessionMeta(lifecycle) },
                        });
                        await page.waitForFunction((expected) => document.querySelector("#session-status")?.dataset.lifecycle === expected, lifecycle);
                        await draft.focus();
                        const before = await approval.getAttribute("aria-pressed");
                        await draft.press("Shift+Tab");
                        const expected = before === "true" ? "false" : "true";
                        assert.equal(await approval.getAttribute("aria-pressed"), expected, `${lifecycle}: Shift+Tab in composer toggles YOLO`);
                        assert.equal(await approval.locator('[data-text="yolo-label"]').textContent(), expected === "true" ? "YOLO" : "Review");
                        assert.equal(await page.evaluate(() => document.activeElement?.id), "session-message", `${lifecycle}: composer keeps focus`);
                        assert.equal(await draft.inputValue(), "Draft stays intact.");
                    }

                    // Ended on completed with aria-pressed === "true" (idle->true, running->false, completed->true).
                    assert.equal(await approval.getAttribute("aria-pressed"), "true");
                    await draft.press("Escape");
                    assert.notEqual(await page.evaluate(() => document.activeElement?.id), "session-message", "Escape leaves the composer cleanly");
                    assert.equal(await draft.inputValue(), "Draft stays intact.", "Escape preserves unsent draft");
                    assert.equal(await statusLine.isVisible(), true, "active YOLO keeps status row visible on unfocused completed session");

                    // Outside the composer when not interrupted, Shift+Tab preserves native backward focus traversal without toggling YOLO.
                    const effort = page.getByRole("button", { name: "Effort", exact: true });
                    await effort.focus();
                    assert.equal(await page.evaluate(() => document.activeElement?.id), "session-effort");
                    await page.keyboard.press("Shift+Tab");
                    assert.equal(await page.evaluate(() => document.activeElement?.id), "session-model", "Shift+Tab outside composer moves focus backward");
                    assert.equal(await approval.getAttribute("aria-pressed"), "true", "backward focus navigation does not toggle YOLO");

                    // Toggle YOLO off from composer and verify unfocused completed status hides again.
                    await draft.focus();
                    await draft.press("Shift+Tab");
                    assert.equal(await approval.getAttribute("aria-pressed"), "false");
                    await page.locator("body > header > a").focus();
                    assert.equal(await statusLine.isVisible(), false, "disabling YOLO releases unfocused completed status space");

                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await fixture.server.close(); }
}
