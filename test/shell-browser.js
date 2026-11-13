import assert from "node:assert/strict";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics from "./browser-diagnostics.js";

// {§web-page-shell} {§web-session-input} Measure real CSS geometry, not a declaration proxy.
export default async function verifyShell(t) {
    const { server, url } = await conversationFixture(new URL("./shell-entry.js", import.meta.url));
    try {
        for (const engine of engines) await t.test(engine.name(), async () => {
            const browser = await engine.launch();
            try {
                const context = await browser.newContext();
                const checkBrowser = browserDiagnostics(context);
                const page = await context.newPage();
                await page.goto(url);
                await page.waitForFunction(() => typeof window.present === "function");
                await page.evaluate(() => window.presentState({ plurnk: {
                    workspace: { id: 7, name: "conversation", projectRoot: null, projectLabel: null, preparation: [], activity: null },
                    status: { lifecycle: "running", model: { alias: "local", provider: "fixture", model: "model", effort: "high", effortSource: "default" },
                        loopId: 1, packetCount: 1, waitUntil: null, descendants: [], inbox: [], claimedAt: 1000, terminatedAt: null,
                        spend: { requests: 1, usage: { inputTokens: 1200, outputTokens: 300 }, knownUsage: { inputTokens: 1200, outputTokens: 300 }, costUsd: "0.003", knownCostUsd: "0.003" } },
                }, budget: { contextTokens: 1200, contextCapacity: 32768, curationWeight: null, curationBudget: null } }, 2000));
                await page.evaluate(() => window.present([{ id: "long", role: "assistant", content: "A readable paragraph.\n\n".repeat(200) }]));
                const draft = page.getByRole("textbox", { name: "Message", exact: true });
                const sameHeight = async () => {
                    const field = await draft.boundingBox();
                    for (const name of ["Stop", "Send"]) {
                        const button = await page.getByRole("button", { name, exact: true }).boundingBox();
                        assert.ok(Math.abs(button.y - field.y) < 1 && Math.abs(button.height - field.height) < 1,
                            `${name} stretches to the textarea's full height`);
                    }
                };
                for (const viewport of [{ width: 320, height: 700 }, { width: 1440, height: 900 }, { width: 390, height: 400 }]) {
                    await page.setViewportSize(viewport);
                    await draft.fill("One line");
                    const before = await draft.boundingBox();
                    const stop = await page.getByRole("button", { name: "Stop", exact: true }).boundingBox();
                    const send = await page.getByRole("button", { name: "Send", exact: true }).boundingBox();
                    const joiningMargin = await page.getByRole("button", { name: "Send", exact: true }).evaluate((button) => parseFloat(getComputedStyle(button).marginInlineStart));
                    assert.ok(stop.x + stop.width <= before.x + 1 && Math.abs(before.x + before.width + joiningMargin - send.x) < 1, "Stop / draft / Send in document and visual order");
                    assert.ok(Math.abs(stop.y + stop.height - before.y - before.height) < 1 && Math.abs(send.y + send.height - before.y - before.height) < 1);
                    await sameHeight();
                    await draft.press("End");
                    await draft.press("Shift+Enter");
                    await draft.pressSequentially("Second line");
                    assert.equal(await draft.inputValue(), "One line\nSecond line", "Shift+Enter grows the multiline draft");
                    const grown = await draft.boundingBox();
                    assert.ok(grown.height > before.height, `${engine.name()}: native textarea grows with content`);
                    await sameHeight();
                    await draft.fill("Many draft lines\n".repeat(50));
                    const bounded = await draft.boundingBox();
                    assert.ok(bounded.height <= viewport.height / 3 + 1, "draft growth is viewport-bounded");
                    assert.equal(await draft.evaluate((element) => element.scrollHeight > element.clientHeight), true);
                    await sameHeight();
                    const header = await page.locator("body > header").boundingBox();
                    const footer = await page.locator("body > footer").boundingBox();
                    const main = await page.locator("main").boundingBox();
                    assert.ok(main.height > 0 && main.y >= header.y + header.height - 1 && main.y + main.height <= footer.y + 1);
                    assert.ok(Math.abs(footer.y + footer.height - viewport.height) < 1, "composer footer remains at the viewport bottom");
                    assert.equal(await page.locator("main").evaluate((element) => {
                        element.scrollTop = element.scrollHeight;
                        return element.scrollTop > 0;
                    }), true);
                    assert.deepEqual(await page.locator("body > header").boundingBox(), header);
                    assert.deepEqual(await page.locator("body > footer").boundingBox(), footer);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true);
                }
                checkBrowser();
            } finally { await browser.close(); }
        });
    } finally { await server.close(); }
}
