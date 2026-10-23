import assert from "node:assert/strict";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics from "./browser-diagnostics.js";

// {§web-conversation-surfaces} Exercise real semantic rows and compiled theme CSS.
export const messages = [
    { id: "user", role: "user", content: "Please inspect [the evidence](https://example.com/)." },
    { id: "decorated-user", role: "user", content: "An incoming user message.", metadata: { plurnk: { op: "SEND", origin: "_plurnk" } } },
    { id: "assistant", role: "assistant", content: "I will inspect [the evidence](https://example.com/).", toolCalls: [
        { id: "generic", type: "function", function: { name: "SEND", arguments: "{}" } },
        ...["READ", "NOTE", "SEND"].map((op) => ({ id: op, type: "function", function: { name: op,
            arguments: JSON.stringify({ aside: op === "NOTE" ? "fact" : "Inspect the evidence", body: "Retained **content**.",
                target: { raw: "evidence.txt" } }) }, metadata: { plurnk: { op } } })),
    ] },
    { id: "reply", role: "tool", toolCallId: "delivered", content: "Here is [the answer](https://example.com/).", metadata: { plurnk: { op: "SEND", signal: 200 } } },
    { id: "cancelled", role: "tool", toolCallId: "cancelled", content: "Unable to complete.", metadata: { plurnk: { op: "SEND", signal: 499 } } },
    { id: "result", role: "tool", toolCallId: "unmatched", content: "Literal result." },
    { id: "reasoning", role: "reasoning", content: "Consider the evidence." },
    { id: "system", role: "system", content: "System [content](https://example.com/)." },
    { id: "developer", role: "developer", content: "Developer content." },
];

function luminance(rgb) {
    const linear = rgb.slice(0, 3).map((value) => value / 255)
        .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

export default async function verifySurfaces(t) {
    const { server, url } = await conversationFixture(new URL("./reasoning-entry.js", import.meta.url));
    try {
        for (const engine of engines) await t.test(engine.name(), async () => {
            const browser = await engine.launch();
            try {
                const context = await browser.newContext();
                const checkBrowser = browserDiagnostics(context);
                const page = await context.newPage();
                await page.goto(url);
                await page.waitForFunction(() => typeof window.present === "function");
                await page.evaluate((messages) => {
                    window.present(messages);
                    window.preview.consume({ type: "REASONING_MESSAGE_START", messageId: "live" });
                    window.preview.consume({ type: "CUSTOM", name: "plurnk.reasoning", value: { messageId: "live", delta: "Live working material." } });
                    // Contrast covers inspected working bodies too; hidden content has no painted colors.
                    for (const disclosure of document.querySelectorAll("[data-messages] > li > article > details")) disclosure.open = true;
                }, messages);
                let light;
                for (const colorScheme of ["light", "dark"]) {
                    await page.emulateMedia({ colorScheme });
                    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
                    const colors = await page.evaluate(() => {
                        const canvas = document.createElement("canvas");
                        canvas.width = canvas.height = 1;
                        const ctx = canvas.getContext("2d", { willReadFrequently: true });
                        const rgba = (color) => {
                            ctx.clearRect(0, 0, 1, 1);
                            ctx.fillStyle = color;
                            ctx.fillRect(0, 0, 1, 1);
                            return Array.from(ctx.getImageData(0, 0, 1, 1).data);
                        };
                        const entries = [...document.querySelectorAll("[data-messages] > li, [data-reasoning-preview]")];
                        return Object.fromEntries(entries.map((row) => {
                            const article = row.matches("article") ? row : row.querySelector(":scope > article");
                            const background = rgba(getComputedStyle(article).backgroundColor);
                            return [row.dataset.callId ?? row.dataset.messageId ?? "preview", {
                                background,
                                header: article.querySelector(":scope > header") ? rgba(getComputedStyle(article.querySelector(":scope > header")).backgroundColor) : null,
                                text: [...article.querySelectorAll("p, a, pre, summary, header")].map((element) => {
                                    const style = getComputedStyle(element);
                                    const local = rgba(style.backgroundColor);
                                    return { color: rgba(style.color), background: local[3] === 0 ? background : local, tag: element.tagName };
                                }),
                            }];
                        }).concat([["outside", { background: rgba(getComputedStyle(document.querySelector("#worker-connection")).backgroundColor) }]]));
                    });
                    const { background: user } = colors.user;
                    const { background: reply } = colors.assistant;
                    const { background: working } = colors.reasoning;
                    assert.equal(new Set([user, reply, working].map(JSON.stringify)).size, 3, `${colorScheme}: three distinct backgrounds`);
                    assert.ok(user[1] > user[0] && user[1] > user[2], "user tint is green");
                    assert.deepEqual(colors["decorated-user"].background, user, "SEND metadata never turns a user's prompt into a model reply");
                    for (const id of ["SEND", "reply", "cancelled", "outside"]) assert.deepEqual(colors[id].background, reply, id);
                    for (const id of ["generic", "READ", "NOTE", "result", "system", "developer", "preview"]) assert.deepEqual(colors[id].background, working, id);
                    for (const [id, { background, header, text = [] }] of Object.entries(colors)) {
                        assert.equal(background[3], 255, `${id}: opaque background`);
                        if (header) assert.deepEqual(header, background, `${id}: coordinated header and body`);
                        for (const sample of text) {
                            const values = [luminance(sample.color), luminance(sample.background)].sort((a, b) => a - b);
                            const contrast = (values[1] + 0.05) / (values[0] + 0.05);
                            assert.ok(contrast >= 4.5, `${colorScheme}: ${id} ${sample.tag} contrast ${contrast} must be at least 4.5`);
                        }
                    }
                    if (light) assert.notDeepEqual([user, reply, working], light, "theme responds to browser preference without re-rendering");
                    else light = [user, reply, working];
                }
                checkBrowser();
            } finally { await browser.close(); }
        });
    } finally { await server.close(); }
}
