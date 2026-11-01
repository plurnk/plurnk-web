import assert from "node:assert/strict";
import { engines } from "./engines.js";
import browserDiagnostics from "./browser-diagnostics.js";
import conversationFixture from "./conversation-fixture.js";

const injection = '<img src="/auth/token" onerror="window.contentExecuted=true">';
const hostile = [
    "**Readable evidence**",
    '<script>window.contentExecuted=true</script>',
    '<svg onload="window.contentExecuted=true"><foreignObject><iframe src="/auth/token"></iframe></foreignObject></svg>',
    '<math><mtext><table><mglyph><style><!--</style>' + injection,
    '<style>body{display:none} @import "https://example.invalid/style.css";</style>',
    '<link rel="stylesheet" href="/auth/token"><meta http-equiv="refresh" content="0;url=/auth/logout"><base href="https://example.invalid/">',
    '<form action="/auth/logout" method="post"><button data-action="sign-out">Injected action</button></form>',
    '<input name="__proto__" autofocus onfocus="window.contentExecuted=true">',
    '<iframe srcdoc="<script>parent.contentExecuted=true</script>"></iframe><object data="/auth/token"></object>',
    '<audio src="/auth/token" autoplay></audio><video poster="/auth/token"></video>',
    '<template id="conversation-message"><button>Replacement template</button></template>',
    '<a id="session-status" name="location" data-text="message-author" data-bind="href:call-href" data-action="sign-out" href="/auth/logout">Injected binding</a>',
    '<span data-math="inline">Injected renderer marker</span>',
    '[script](javascript:alert%281%29)',
    '[mixed case](JaVaScRiPt:alert%281%29)',
    '[entity](javascript&#58;alert%281%29)',
    '[tab](jav&#x09;ascript:alert%281%29)',
    '[data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[vbscript](vbscript:msgbox%281%29)',
    '[file](file:///etc/passwd)',
    '![remote image](https://example.invalid/image.svg)',
    '![local image](/auth/token)',
    '[ordinary link](https://example.invalid/evidence)',
    '- [x] Disabled task',
].join("\n\n");

// {§web-conversation-content} Exercise the compiled projection and its real CSP together.
export default async function verifyContentSecurity(t) {
    const { server, url } = await conversationFixture();
    try {
        for (const engine of engines) {
            await t.test(engine.name(), async (t) => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext();
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    const unexpectedRequests = [];
                    await context.route("**/*", (route) => {
                        const request = new URL(route.request().url());
                        if (request.origin === new URL(url).origin && (request.href === url || request.pathname === "/manifest.webmanifest" || /^\/(?:assets|icons)\//u.test(request.pathname))) return route.continue();
                        unexpectedRequests.push(request.href);
                        return route.abort();
                    });
                    await page.goto(url);
                    await page.waitForFunction(() => typeof window.present === "function");
                    const present = (messages) => page.evaluate((messages) => window.present(messages), messages);
                    const shell = () => page.evaluate(() => ({
                        header: document.querySelector("body > header").outerHTML,
                        status: document.querySelector("#session-status").outerHTML,
                        templates: [...document.querySelectorAll("body > template")].map((template) => template.outerHTML),
                        body: [...document.body.attributes].map(({ name, value }) => [name, value]),
                        base: document.baseURI,
                        title: document.title,
                    }));
                    const original = await shell();

                    await t.test("rich messages and SEND share the sanitizer; NOTE and reasoning remain literal", async () => {
                        const messages = ["user", "assistant", "system", "developer"].map((role) => ({ id: role, role, content: hostile }));
                        messages.push({ id: "send", role: "assistant", toolCalls: [{
                            toolCallId: "send-call", name: "SEND", rawInput: { body: hostile }, _meta: { plurnk: { op: "SEND" } },
                        }] }, { id: "reply", role: "tool", toolCallId: "child-work", content: hostile, _meta: { plurnk: { op: "SEND" } } },
                        { id: "note", role: "assistant", toolCalls: [{ toolCallId: "note-call",
                            name: "NOTE", rawInput: { body: hostile, aside: injection }, _meta: { plurnk: { op: "NOTE" } } }] },
                        { id: "reasoning", role: "reasoning", content: hostile });
                        await present(messages);
                        const bodies = page.locator("[data-messages] article:has(> details > p > strong)");
                        assert.equal(await bodies.count(), 6);
                        for (const body of await bodies.all()) {
                            assert.equal(await body.locator("strong").textContent(), "Readable evidence");
                            assert.match(await body.textContent(), /Injected binding/u);
                            assert.equal(await body.locator("script, style, link, meta, base, img, svg, math, iframe, object, embed, audio, video, form, button, template, [id], [name], [class], [style], [data-text], [data-bind], [data-action], [data-math], [onerror], [autofocus]").count(), 0);
                            assert.equal(await body.locator("input").count(), 1);
                            assert.equal(await body.locator("input:disabled").count(), 1);
                            assert.deepEqual(await body.locator("a[href]").evaluateAll((links) => links.map((link) => link.getAttribute("href"))), ["https://example.invalid/image.svg", "/auth/token", "https://example.invalid/evidence"]);
                            assert.equal(await body.locator("a:not([href])").count(), 7);
                            // A stripped executable URL remains inert even when the user activates its label.
                            await body.locator("a:not([href])").evaluateAll((links) => links.forEach((link) => link.click()));
                        }
                        assert.equal(await page.locator("[data-plurnk-note]").getAttribute("data-plurnk-note"), injection);
                        for (const id of ["note", "reasoning"]) {
                            const body = page.locator(`[data-message-id="${id}"]`).locator("article > details > pre");
                            assert.equal(await body.textContent(), hostile);
                            assert.equal(await body.locator("*").count(), 0, "literal content never enters an HTML parser");
                        }
                    });

                    await t.test("identity and errors remain literal; unrecognized payloads are not rendered", async () => {
                        const call = { toolCallId: injection, name: injection, rawInput: { html: hostile } };
                        const messages = [
                            { id: injection, role: "assistant", name: injection, subagentRunId: injection, content: "", toolCalls: [call] },
                            { id: "result", role: "tool", toolCallId: call.toolCallId, content: hostile, error: injection },
                            { id: "activity", role: "activity", activityType: injection, content: { html: hostile } },
                            { id: "parts", role: "user", content: [{ type: "text", text: hostile }, { type: "binary", mimeType: "image/svg+xml", url: "https://example.invalid/media.svg" }] },
                        ];
                        await present(messages);
                        assert.equal(await page.locator("[data-call-id] article").getAttribute("aria-label"), [injection, injection, `Subagent ${injection}`].join(" · "));
                        assert.equal(await page.locator("[data-call-id] article").textContent(), "");
                        assert.equal(await page.locator('[data-message-id=result] summary > [data-plurnk-field="outcome"]').textContent(), injection);
                        assert.equal(await page.locator("[data-message-id=result] article > details > pre").textContent(), hostile);
                        assert.equal(await page.locator("[data-message-id=activity] article").textContent(), "");
                        assert.equal(await page.locator("[data-message-id=parts] article strong").textContent(), "Readable evidence",
                            "standard text parts use the role's same sanitized renderer");
                        assert.equal(await page.locator("[data-message-id=parts] article > details > pre").count(), 0,
                            "unsupported parts stay in JavaScript, not a metadata dump or implicit fetch");
                        assert.equal(await page.locator("#session-conversation script, #session-conversation img, #session-conversation form").count(), 0);
                        assert.equal(await page.locator("[data-message-id=result]").getAttribute("data-tool-call-id"), call.toolCallId);
                    });

                    await t.test("streaming and replay cannot activate partial markup or escaped code", async () => {
                        for (const content of ["<img src=", injection, "[script](java", "[script](javascript:alert%281%29)", "```html\n" + hostile, "```html\n" + hostile + "\n```", "**Recovered ordinary text**"]) {
                            await present([{ id: "streamed", role: "assistant", content }]);
                            await present([{ id: "streamed", role: "assistant", content }]);
                            assert.equal(await page.locator("[data-messages]").locator("article script, article img, article [data-bind], article [data-text]").count(), 0);
                            assert.deepEqual(await shell(), original);
                        }
                        assert.equal(await page.locator("[data-messages] article strong").textContent(), "Recovered ordinary text");
                    });

                    assert.deepEqual(await shell(), original, "rendering cannot alter the surrounding application document");
                    assert.equal(page.url(), url);
                    assert.equal(await page.evaluate(() => window.contentExecuted), undefined);
                    assert.deepEqual(unexpectedRequests, [], "content cannot even attempt a resource or credential request");
                    assert.equal(context.pages().length, 1, "content cannot open another browsing context");
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}
