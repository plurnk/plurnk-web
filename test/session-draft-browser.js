import assert from "node:assert/strict";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics from "./browser-diagnostics.js";

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

// {§web-session-input} {§web-document} Tab-ephemeral sessionStorage preserves only unsent prompt drafts.
export default async function verifySessionDrafts(t) {
    const fixture = await conversationFixture(new URL("../web/app.js", import.meta.url));
    try {
        for (const engine of engines) {
            await t.test(engine.name(), async () => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 700 } });
                    const checkBrowser = browserDiagnostics(context);
                    /** @type {any[]} */
                    const prompts = [];
                    /** @type {{ id: string, text: string }[]} */
                    let acceptedMessages = [];
                    /** @type {PromiseWithResolvers<void> | null} */
                    let holdPrompt = null;
                    fixture.onAcp(async (input) => {
                        if (input.method === "session/resume") {
                            return {
                                updates: acceptedMessages.map(({ id, text }) => ({
                                    sessionUpdate: "user_message_chunk",
                                    messageId: id,
                                    content: { type: "text", text },
                                })),
                                result: {
                                    configOptions: [],
                                    availableCommands: [],
                                    _meta: { plurnk: basePlurnkMeta() },
                                },
                            };
                        }
                        if (input.method === "session/prompt") {
                            prompts.push(input);
                            if (holdPrompt) await holdPrompt.promise;
                            const id = input.params._meta.plurnk.messageId;
                            const text = input.params.prompt[0].text;
                            acceptedMessages.push({ id, text });
                            return {
                                updates: [{
                                    sessionUpdate: "user_message_chunk",
                                    messageId: id,
                                    content: { type: "text", text },
                                }],
                                result: { stopReason: "end_turn", messageId: id },
                            };
                        }
                        return { result: {} };
                    });

                    const page = await context.newPage();
                    await page.goto(fixture.url);
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                    const field = page.getByRole("textbox", { name: "Message", exact: true });
                    const send = page.getByRole("button", { name: "Send", exact: true });
                    assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]), [[], []]);

                    await field.fill("First line of unsent draft.\nSecond line survives reload.");
                    assert.deepEqual(
                        await page.evaluate(() => [Object.keys(localStorage), Object.entries(sessionStorage)]),
                        [[], [["plurnk:draft:7#user", "First line of unsent draft.\nSecond line survives reload."]]],
                    );

                    const otherTab = await context.newPage();
                    await otherTab.goto(fixture.url);
                    await otherTab.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                    assert.equal(await otherTab.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "", "draft storage is tab-ephemeral");
                    await otherTab.close();

                    await page.reload();
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                    assert.equal(await field.inputValue(), "First line of unsent draft.\nSecond line survives reload.");
                    assert.equal(prompts.length, 0, "restoring an unsent draft never auto-submits it");

                    await field.fill("/env set SECRET_TOKEN=top-secret");
                    assert.deepEqual(
                        await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]),
                        [[], []],
                        "client management commands and secrets never enter sessionStorage",
                    );
                    await field.fill("/yolo");
                    assert.deepEqual(await page.evaluate(() => Object.keys(sessionStorage)), [], "approval posture commands never enter sessionStorage");

                    await field.fill("   \n  ");
                    assert.deepEqual(await page.evaluate(() => Object.keys(sessionStorage)), [], "blank whitespace removes any stored draft");

                    await field.fill("Deliver this confirmed prompt.");
                    assert.equal(await page.evaluate(() => sessionStorage.getItem("plurnk:draft:7#user")), "Deliver this confirmed prompt.");
                    await send.click();
                    await page.waitForFunction(() => /** @type {HTMLTextAreaElement | null} */ (document.querySelector("#session-message"))?.value === ""
                        && document.querySelector("#session-status")?.dataset.connection === "connected");
                    assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]), [[], []]);
                    assert.equal(prompts.length, 1);

                    holdPrompt = Promise.withResolvers();
                    await field.fill("In-flight prompt.");
                    await send.click();
                    await page.getByText("Sending…", { exact: true }).waitFor();
                    await field.fill("Newer draft typed while in flight.");
                    assert.equal(await page.evaluate(() => sessionStorage.getItem("plurnk:draft:7#user")), "Newer draft typed while in flight.");
                    holdPrompt.resolve();
                    holdPrompt = null;
                    await page.getByText("In-flight prompt.", { exact: true }).waitFor();
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                    assert.equal(await field.inputValue(), "Newer draft typed while in flight.");
                    assert.equal(await page.evaluate(() => sessionStorage.getItem("plurnk:draft:7#user")), "Newer draft typed while in flight.");
                    await field.fill("");
                    assert.deepEqual(await page.evaluate(() => Object.keys(sessionStorage)), []);
                    checkBrowser();

                    const deniedContext = await browser.newContext({ viewport: { width: 320, height: 700 } });
                    const checkDenied = browserDiagnostics(deniedContext);
                    try {
                        await deniedContext.addInitScript(() => {
                            for (const name of ["localStorage", "sessionStorage"]) {
                                Object.defineProperty(window, name, {
                                    configurable: true,
                                    get() {
                                        throw new DOMException("Storage disabled", "SecurityError");
                                    },
                                });
                            }
                        });
                        acceptedMessages = [];
                        const deniedPage = await deniedContext.newPage();
                        await deniedPage.goto(fixture.url);
                        await deniedPage.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                        const deniedField = deniedPage.getByRole("textbox", { name: "Message", exact: true });
                        await deniedField.fill("Works with storage disabled.");
                        await deniedPage.getByRole("button", { name: "Send", exact: true }).click();
                        await deniedPage.waitForFunction(() => /** @type {HTMLTextAreaElement | null} */ (document.querySelector("#session-message"))?.value === "");
                        checkDenied();
                    } finally {
                        await deniedContext.close();
                    }
                } finally {
                    await browser.close();
                }
            });
        }
    } finally {
        await fixture.server.close();
    }
}
