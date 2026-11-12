import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics, { httpFailure, networkFailure } from "./browser-diagnostics.js";

const basePlurnkMeta = () => ({
    workspace: { id: 7, name: "conversation", projectRoot: null, projectLabel: null, preparation: [], activity: null },
    status: {
        lifecycle: "idle",
        model: null,
        loopId: null,
        packetCount: 0,
        waitUntil: null,
        descendants: [],
        inbox: [],
        claimedAt: null,
        terminatedAt: null,
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
});

// {§web-session-observer} {§web-page-shell} Passive observation streams auto-recover without retrying mutations or 4xx refusals.
export default async function verifySessionReconnect(t) {
    const fixture = await conversationFixture(new URL("../web/app.js", import.meta.url));
    try {
        for (const engine of engines) {
            await t.test(engine.name(), async () => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 700 } });
                    const checkBrowser = browserDiagnostics(context);
                    let resumeCount = 0;
                    let promptCount = 0;
                    let closeNextResume = false;
                    fixture.onAcp(async (input) => {
                        if (input.method === "session/resume") {
                            resumeCount += 1;
                            const closeStream = closeNextResume;
                            closeNextResume = false;
                            return {
                                result: {
                                    configOptions: [],
                                    availableCommands: [],
                                    _meta: { plurnk: basePlurnkMeta() },
                                },
                                closeStream,
                            };
                        }
                        if (input.method === "session/prompt") {
                            promptCount += 1;
                            const id = input.params._meta.plurnk.messageId;
                            return {
                                updates: [{
                                    sessionUpdate: "user_message_chunk",
                                    messageId: id,
                                    content: { type: "text", text: input.params.prompt[0].text },
                                }],
                                result: { stopReason: "end_turn", messageId: id },
                            };
                        }
                        return { result: {} };
                    });

                    const page = await context.newPage();

                    /** @type {((route: import("playwright").Route) => Promise<unknown> | unknown) | null} */
                    let acpIntercept = null;
                    await page.route("**/acp", (route) => acpIntercept ? acpIntercept(route) : route.continue());

                    // 1. Transient passive stream closure + 503 restart recovers automatically via backoff without overwriting initial diagnostic
                    let failWith503 = false;
                    acpIntercept = (route) => {
                        if (failWith503) {
                            failWith503 = false;
                            return route.fulfill({
                                status: 503,
                                contentType: "application/problem+json",
                                body: JSON.stringify({
                                    type: "https://problems.plurnk.xyz/http/service-stopping",
                                    title: "Service Unavailable",
                                    status: 503,
                                    detail: "Restarting service.",
                                }),
                            });
                        }
                        return route.continue();
                    };

                    closeNextResume = true;
                    await page.goto(fixture.url);
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "disconnected");
                    failWith503 = true;
                    assert.equal(await page.locator("header [data-connection-indicator]").isVisible(), true);
                    assert.equal(await page.getByRole("button", { name: "Reconnect", exact: true }).isVisible(), true);
                    const initialDetail = await page.locator("#session-connection").innerText();
                    assert.match(initialDetail, /Delivery ended without a session outcome\./u);

                    // First passive retry hits 503 (~1.5s), preserves initial diagnostic without flicker; online event then recovers immediately
                    await delay(2200);
                    assert.equal(await page.evaluate(() => document.querySelector("#session-status")?.dataset.connection), "disconnected");
                    assert.equal(await page.locator("#session-connection").innerText(), initialDetail, "failed background probe preserves initial disconnect cause");
                    acpIntercept = null;
                    await page.evaluate(() => window.dispatchEvent(new Event("online")));
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected", undefined, { timeout: 1000 });
                    assert.equal(await page.locator("header [data-connection-indicator]").isVisible(), false);
                    assert.equal(resumeCount, 2);
                    checkBrowser([httpFailure("/acp", 503)]);

                    // 2. Automatic timer-driven backoff recovers without user interaction
                    closeNextResume = true;
                    await page.reload();
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "disconnected");
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected", undefined, { timeout: 4000 });
                    assert.equal(resumeCount, 4);
                    checkBrowser();

                    // 3. Deterministic 404 refusal enters disconnected and stops automatic retries
                    acpIntercept = (route) => route.fulfill({
                        status: 404,
                        contentType: "application/problem+json",
                        body: JSON.stringify({
                            type: "https://problems.plurnk.xyz/acp/session-not-found",
                            title: "Not Found",
                            status: 404,
                            detail: "Session no longer exists.",
                        }),
                    });
                    await page.reload();
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "disconnected");
                    assert.match(await page.locator("#session-connection").innerText(), /Session no longer exists\./u);
                    acpIntercept = null;
                    await page.evaluate(() => window.dispatchEvent(new Event("online")));
                    await delay(2200);
                    assert.equal(await page.evaluate(() => document.querySelector("#session-status")?.dataset.connection), "disconnected", "404 refusal never auto-retries");
                    checkBrowser([httpFailure("/acp", 404)]);

                    // Manual Reconnect recovers from deterministic refusal once cleared
                    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");

                    // 4. Failed mutating prompt submission never auto-reconnects or auto-retries
                    let abortPrompt = true;
                    acpIntercept = (route) => {
                        if (abortPrompt && route.request().postDataJSON()?.method === "session/prompt") {
                            abortPrompt = false;
                            return route.abort("failed");
                        }
                        return route.continue();
                    };
                    const field = page.getByRole("textbox", { name: "Message", exact: true });
                    await field.fill("Mutating prompt must not auto-retry.");
                    await page.getByRole("button", { name: "Send", exact: true }).click();
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "disconnected");
                    assert.match(await page.locator('[aria-label="Message feedback"] [role="alert"]').innerText(), /delivery is unconfirmed/u);
                    const resumesAfterPromptFailure = resumeCount;
                    await page.evaluate(() => window.dispatchEvent(new Event("online")));
                    await delay(2200);
                    assert.equal(await page.evaluate(() => document.querySelector("#session-status")?.dataset.connection), "disconnected", "unconfirmed prompt blocks passive auto-reconnect");
                    assert.equal(resumeCount, resumesAfterPromptFailure);
                    assert.equal(promptCount, 0);
                    checkBrowser([networkFailure("/acp")]);

                    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                    await field.fill("");
                    checkBrowser();
                } finally {
                    await browser.close();
                }
            });
        }
    } finally {
        await fixture.server.close();
    }
}
