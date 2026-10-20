import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
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
    '<a id="worker-status" name="location" data-text="message-author" data-bind="href:call-href" data-action="sign-out" href="/auth/logout">Injected binding</a>',
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
        for (const engine of [chromium, firefox, webkit]) {
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
                        status: document.querySelector("#worker-status").outerHTML,
                        templates: [...document.querySelectorAll("body > template")].map((template) => template.outerHTML),
                        body: [...document.body.attributes].map(({ name, value }) => [name, value]),
                        base: document.baseURI,
                        title: document.title,
                    }));
                    const original = await shell();

                    await t.test("all rich-text roles and NOTE bodies share the same admission boundary", async () => {
                        const messages = ["user", "assistant", "reasoning", "system", "developer"].map((role) => ({ id: role, role, content: hostile }));
                        messages.push({ id: "note", role: "assistant", toolCalls: [{
                            id: "note-call", type: "function", function: { name: "NOTE", arguments: JSON.stringify({ body: hostile, aside: injection }) }, metadata: { plurnk: { op: "NOTE" } },
                        }] });
                        await present(messages);
                        const bodies = page.locator("[data-message-body]:has(> p > strong)");
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
                    });

                    await t.test("identity, call arguments, result errors and structured payloads remain literal", async () => {
                        const call = { id: injection, type: "function", function: { name: injection, arguments: hostile } };
                        const messages = [
                            { id: injection, role: "assistant", name: injection, subagentRunId: injection, content: "", toolCalls: [call] },
                            { id: "result", role: "tool", toolCallId: call.id, content: hostile, error: injection },
                            { id: "activity", role: "activity", activityType: injection, content: { html: hostile } },
                            { id: "parts", role: "user", content: [{ type: "text", text: hostile }, { type: "binary", mimeType: "image/svg+xml", url: "https://example.invalid/media.svg" }] },
                        ];
                        await present(messages);
                        assert.equal(await page.locator("[data-call-id]").getAttribute("data-call-name"), injection);
                        assert.equal(await page.locator("[data-call-id] [data-message-body] code").textContent(), hostile);
                        assert.equal(await page.locator("[data-message-id=result] [data-text=message-error]").textContent(), injection);
                        assert.equal(await page.locator("[data-message-id=result] [data-message-body] code").textContent(), hostile);
                        assert.equal(await page.locator("[data-message-id=activity] [data-message-body] code").textContent(), JSON.stringify({ html: hostile }, null, 2));
                        assert.equal(await page.locator("[data-message-id=parts] [data-message-body] strong").textContent(), "Readable evidence",
                            "standard text parts use the role's same sanitized renderer");
                        assert.equal(await page.locator("[data-message-id=parts] [data-message-body] > pre code").textContent(), JSON.stringify(messages[3].content[1], null, 2),
                            "unsupported parts remain exact literal data, not an image or implicit fetch");
                        assert.equal(await page.locator("#worker-conversation script, #worker-conversation img, #worker-conversation form").count(), 0);
                        assert.equal(await page.locator("[data-call-link]").first().evaluate((link) => document.getElementById(decodeURIComponent(new URL(link.href).hash.slice(1)))?.dataset.callId), call.id);
                    });

                    await t.test("streaming and replay cannot activate partial markup or escaped code", async () => {
                        for (const content of ["<img src=", injection, "[script](java", "[script](javascript:alert%281%29)", "```html\n" + hostile, "```html\n" + hostile + "\n```", "**Recovered ordinary text**"]) {
                            await present([{ id: "streamed", role: "assistant", content }]);
                            await present([{ id: "streamed", role: "assistant", content }]);
                            assert.equal(await page.locator("[data-message-body] script, [data-message-body] img, [data-message-body] [data-bind], [data-message-body] [data-text]").count(), 0);
                            assert.deepEqual(await shell(), original);
                        }
                        assert.equal(await page.locator("[data-message-body] strong").textContent(), "Recovered ordinary text");
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
