import assert from "node:assert/strict";
import test from "node:test";
import { chromium, firefox, webkit } from "playwright";
import browserDiagnostics from "./browser-diagnostics.js";
import conversationFixture from "./conversation-fixture.js";

const messages = [
    { id: "question", role: "user", content: "Please inspect **the evidence**." },
    { id: "thought", role: "reasoning", content: "First I will inspect the file." },
    { id: "operations", role: "assistant", content: "", toolCalls: [
        { id: "call/one#%", type: "function", function: { name: "READ", arguments: '{"path":"witness.txt"}' } },
        { id: "call-two", type: "function", function: { name: "READ", arguments: '{"path":"missing.txt"}' } },
    ] },
    { id: "evidence", role: "tool", toolCallId: "call/one#%", content: "cobalt heron\n".repeat(40) },
    { id: "failure", role: "tool", toolCallId: "call-two", content: "Partial result", error: "Entry not found" },
    { id: "answer", role: "assistant", content: "The file contains **cobalt heron**." },
];

test("{§web-worker-conversation} {§web-conversation-content} native conversation projection", { timeout: 60_000 }, async (t) => {
    const { server, url } = await conversationFixture();
    try {
        for (const engine of [chromium, firefox, webkit]) {
            await t.test(engine.name(), async (t) => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 420, height: 700 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    await page.goto(url);
                    await page.waitForFunction(() => typeof window.present === "function");
                    const present = (messages) => page.evaluate((messages) => window.present(messages), messages);
                    const ids = () => page.locator("[data-messages] > li").evaluateAll((rows) => rows.map((row) => row.dataset.messageId));
                    const row = (id) => page.locator(`[data-message-id="${id}"]`);

                    await t.test("roles, exact calls and results retain SDK order and native disclosure structure", async () => {
                        await present(messages);
                        assert.deepEqual(await ids(), messages.map(({ id }) => id));
                        assert.equal(await row("question").locator("article [data-message-body] strong").innerText(), "the evidence");
                        assert.equal(await row("thought").locator(":scope > details").getAttribute("open"), null);
                        assert.equal(await row("operations").locator("[data-calls] > li").count(), 2);
                        assert.equal(await row("operations").locator("[data-text=call-arguments]").first().textContent(), '{"path":"witness.txt"}');
                        assert.equal(await row("failure").locator("[data-text=message-error]").textContent(), "Entry not found");
                        assert.equal(await row("failure").locator("[data-message-body] code").textContent(), "Partial result");
                        assert.equal(await row("evidence").locator("[data-call-link] a").evaluate((link) => {
                            return document.getElementById(decodeURIComponent(new URL(link.href).hash.slice(1)))?.dataset.callId;
                        }), "call/one#%");
                        assert.equal(await page.locator("#worker-conversation form, #worker-conversation textarea, #worker-conversation [contenteditable]").count(), 0);
                        assert.equal(await page.locator("[data-empty-conversation]").isVisible(), false);
                    });

                    await t.test("streaming and reconnect snapshots preserve open details, focus, unchanged body selection and scroll", async () => {
                        await present(messages);
                        await row("thought").locator("summary").click();
                        await page.evaluate(() => {
                            window.savedRow = document.querySelector('[data-message-id="thought"]');
                            window.savedBody = document.querySelector('[data-message-id="question"] [data-message-body]');
                            const node = window.savedBody.querySelector("strong").firstChild;
                            const range = document.createRange();
                            range.selectNodeContents(node);
                            getSelection().removeAllRanges();
                            getSelection().addRange(range);
                        });
                        assert.equal(await page.evaluate(() => getSelection().toString()), "the evidence");
                        const focused = await page.evaluate(() => document.activeElement?.outerHTML);
                        const beforeScroll = await page.evaluate(() => scrollY);
                        const updated = messages.map((message) => message.id === "thought" ? { ...message, content: `${message.content} Now I have evidence.` } : message);
                        await present(updated);
                        await present(structuredClone(updated));
                        assert.equal(await page.evaluate(() => window.savedRow === document.querySelector('[data-message-id="thought"]')), true);
                        assert.equal(await page.evaluate(() => window.savedBody === document.querySelector('[data-message-id="question"] [data-message-body]')), true);
                        assert.equal(await row("thought").locator("details").evaluate((details) => details.open), true);
                        assert.equal(await page.evaluate(() => document.activeElement?.outerHTML), focused);
                        assert.equal(await page.evaluate(() => getSelection().toString()), "the evidence");
                        assert.equal(await page.evaluate(() => scrollY), beforeScroll);
                        assert.match(await row("thought").locator("[data-message-body]").textContent(), /Now I have evidence\./u);
                    });

                    await t.test("snapshots replace membership and order instead of maintaining another history", async () => {
                        const revised = [messages[5], messages[0], { id: "new", role: "assistant", content: "New answer" }];
                        await present(revised);
                        assert.deepEqual(await ids(), ["answer", "question", "new"]);
                        assert.equal(await page.locator("[data-call-id]").count(), 0);
                        await assert.rejects(present([messages[0], messages[0]]), /Conversation has duplicate message identities\./u);
                        assert.deepEqual(await ids(), ["answer", "question", "new"], "a rejected snapshot leaves the existing conversation intact");
                        await present([]);
                        assert.deepEqual(await ids(), []);
                        assert.equal(await page.locator("[data-empty-conversation]").isVisible(), true);
                    });

                    await t.test("other standard roles and non-text content remain inspectable", async () => {
                        const other = [
                            { id: "system", role: "system", content: "System evidence" },
                            { id: "developer", role: "developer", content: "Developer evidence" },
                            { id: "activity", role: "activity", activityType: "progress", content: { percent: 25 } },
                            { id: "parts", role: "user", content: [{ type: "text", text: "First" }, { type: "binary", mimeType: "image/png", url: "https://example.invalid/untrusted.png" }] },
                            { id: "child", role: "assistant", subagentRunId: "child-run", content: "Child answer" },
                            { id: "orphan", role: "tool", toolCallId: "not-in-snapshot", content: "Still inspectable" },
                        ];
                        await present(other);
                        assert.deepEqual(await ids(), other.map(({ id }) => id));
                        assert.equal(await row("activity").locator("summary").innerText(), "progress");
                        assert.equal(await row("activity").locator("code").textContent(), JSON.stringify({ percent: 25 }, null, 2));
                        assert.equal(await row("parts").locator("code").textContent(), JSON.stringify(other[3].content, null, 2));
                        assert.equal(await row("child").locator("[data-text=message-attribution]").innerText(), "Subagent child-run");
                        assert.equal(await row("orphan").locator("[data-call-link]").isVisible(), false);
                    });

                    await t.test("Markdown cannot create controls, bindings, executable links or automatic media requests", async () => {
                        const requests = [];
                        page.on("request", (request) => requests.push(request.url()));
                        const hostile = [
                            "# Heading", "**Strong** and *emphasis*", "- [x] completed", "- [ ] incomplete",
                            "| Name | Value |\n| --- | --- |\n| File | cobalt |",
                            "```mermaid\nflowchart LR\n A --> B\n```",
                            '<script>window.pwned = true</script>', '<div data-text="connection-label" id="worker-status" onclick="alert(1)">HTML remains text</div>',
                            '<form action="/auth/logout"><button>Injected sign out</button></form>',
                            '[unsafe](javascript:alert%281%29)', '![image](https://example.invalid/image.png "Image")',
                            '[evidence](https://example.com/evidence)',
                        ].join("\n\n");
                        await present([{ id: "hostile", role: "assistant", content: hostile }, { id: "literal", role: "tool", toolCallId: "unknown", content: hostile }]);
                        const rich = row("hostile").locator("[data-message-body]");
                        assert.equal(await rich.locator("h1").innerText(), "Heading");
                        assert.equal(await rich.locator("strong").innerText(), "Strong");
                        assert.equal(await rich.locator("table").count(), 1);
                        assert.match(await rich.locator("pre code").textContent(), /flowchart LR/u);
                        assert.match(await rich.textContent(), /<script>window\.pwned = true<\/script>/u);
                        assert.equal(await rich.locator('script, style, img, iframe, form, button, [id], [class], [style], [data-text], [data-bind], [onclick]').count(), 0);
                        assert.equal(await rich.locator("input").count(), 2);
                        assert.equal(await rich.locator("input:disabled").count(), 2);
                        assert.equal(await rich.getByRole("link", { name: "image" }).getAttribute("href"), "https://example.invalid/image.png");
                        assert.equal(await rich.getByRole("link", { name: "evidence" }).getAttribute("href"), "https://example.com/evidence");
                        assert.equal(await rich.locator('a[href^="javascript:"]').count(), 0);
                        assert.equal(await row("literal").locator("code").textContent(), hostile);
                        assert.equal(await page.evaluate(() => window.pwned), undefined);
                        assert.deepEqual(requests, [], "rendering content does not fetch its links or images");
                    });

                    await t.test("unchanged OTM tool arguments preserve native text selection", async () => {
                        await present(messages);
                        await row("operations").locator("summary").first().click();
                        const before = await page.evaluate(() => {
                            const text = document.querySelector("[data-text=call-arguments]").firstChild;
                            const range = document.createRange();
                            range.selectNodeContents(text);
                            getSelection().removeAllRanges();
                            getSelection().addRange(range);
                            window.selectedArgument = text;
                            window.selectedCall = text.parentElement.closest("li");
                            return getSelection().toString();
                        });
                        assert.equal(before, '{"path":"witness.txt"}');
                        await present([...messages, { id: "later", role: "reasoning", content: "Another message" }]);
                        assert.deepEqual(await page.evaluate(() => ({
                            sameText: window.selectedArgument === document.querySelector("[data-text=call-arguments]").firstChild,
                            sameCall: window.selectedCall === document.querySelector("[data-text=call-arguments]").closest("li"),
                            text: document.querySelector("[data-text=call-arguments]").textContent,
                        })), { sameText: true, sameCall: true, text: before },
                            "unchanged argument text retains its DOM node");
                        assert.equal(await page.evaluate(() => getSelection().toString()), before,
                            "Unchanged OTM projections must preserve selection; upstream https://repo.possumtech.com/possumtech/on_the_money.js/issues/11");
                    });
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
});
