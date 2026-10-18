import assert from "node:assert/strict";
import test from "node:test";
import { chromium, firefox, webkit } from "playwright";
import browserDiagnostics from "./browser-diagnostics.js";
import conversationFixture from "./conversation-fixture.js";
import { verifyMath, verifyUnavailableMath } from "./math-browser.js";
import verifyContentSecurity from "./content-security-browser.js";
import { verifyMermaid, verifyUnavailableMermaid } from "./mermaid-browser.js";
import verifyApproval from "./approval-browser.js";
import verifyInteractions from "./interaction-browser.js";

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
                            "```text\nflowchart LR\n A --> B\n```",
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

                    await t.test("{§web-conversation-content} standard fences preserve nested examples without repairing malformed prose", async () => {
                        const valid = [
                            "````markdown", "# Literal heading", "```mermaid", "flowchart LR", " A --> B", "```", "Literal tail.", "````",
                            "", "## Visible heading", "", "| Unicode | Value |", "| --- | --- |", "| e\u0301 | 日本語 🐹 |", "",
                            "> Quoted **evidence**.", "", "- [x] complete", "- [ ] pending", "", "<kbd>Ctrl</kbd>",
                        ].join("\n");
                        await present([{ id: "markup", role: "assistant", content: valid }]);
                        const content = row("markup").locator("[data-message-body]");
                        assert.equal(await content.locator("h1").count(), 0);
                        assert.equal(await content.locator("h2").innerText(), "Visible heading");
                        assert.equal(await content.locator("pre code").textContent(), "# Literal heading\n```mermaid\nflowchart LR\n A --> B\n```\nLiteral tail.\n");
                        assert.equal(await content.locator("figure table").count(), 1);
                        assert.deepEqual(await content.locator("td").allTextContents(), ["e\u0301", "日本語 🐹"]);
                        assert.equal(await content.locator("blockquote strong").innerText(), "evidence");
                        assert.equal(await content.locator("input:disabled").count(), 2);
                        assert.match(await content.textContent(), /<kbd>Ctrl<\/kbd>/u);
                        assert.equal(await content.locator("kbd, svg").count(), 0);

                        const malformed = valid.replaceAll("````", "```");
                        await present([{ id: "markup", role: "assistant", content: malformed }]);
                        assert.equal(await content.locator("h2, table").count(), 0, "the model's closing fence opened a new code block; do not guess where it intended to close");
                        assert.equal(await content.locator("pre code").count(), 2);
                        assert.match(await content.locator("pre code").last().textContent(), /## Visible heading/u);
                        assert.match(await content.locator("pre code").last().textContent(), /日本語 🐹/u);
                    });

                    await t.test("{§web-working-notes} NOTE is collapsed working material, retaining the call and result", async () => {
                        const argumentsText = JSON.stringify({ aside: "idea", body: "A **provisional hypothesis**, not an answer.\n\n<script>window.pwned = true</script>" });
                        const call = { id: "note-call", type: "function", function: { name: "NOTE", arguments: argumentsText }, metadata: { plurnk: { op: "NOTE" } } };
                        const note = { id: "note", role: "assistant", content: "", subagentRunId: "child-run", toolCalls: [call] };
                        const result = { id: "note-result", role: "tool", toolCallId: call.id, content: "**Literal receipt**", error: "Note storage failed" };
                        await present([note, result]);
                        const item = row("note").locator("[data-call-id=note-call]");
                        assert.equal(await item.locator(":scope > details").getAttribute("open"), null);
                        assert.equal(await item.locator("summary").first().innerText(), "NOTE idea");
                        assert.equal(await item.locator("[data-message-body]").isVisible(), false);
                        assert.equal(await row("note").getAttribute("data-message-role"), "assistant");
                        assert.equal(await row("note").locator("[data-text=message-attribution]").innerText(), "Subagent child-run");
                        await item.locator("summary").first().click();
                        assert.equal(await item.locator("[data-message-body] strong").innerText(), "provisional hypothesis");
                        assert.equal(await item.locator("script").count(), 0);
                        assert.equal(await item.locator("[data-text=call-arguments]").textContent(), argumentsText);
                        assert.equal(await item.locator("details details").getAttribute("open"), null);
                        assert.equal(await row("note-result").locator("[data-message-body] code").textContent(), "**Literal receipt**");
                        assert.equal(await row("note-result").locator("[data-text=message-error]").textContent(), "Note storage failed");
                        assert.equal(await row("note-result").locator("[data-call-link] a").evaluate((link) => {
                            return document.getElementById(decodeURIComponent(new URL(link.href).hash.slice(1)))?.dataset.callId;
                        }), call.id);
                        await item.locator("[data-message-body] strong").evaluate((element) => {
                            window.noteText = element.firstChild;
                            const range = document.createRange();
                            range.selectNodeContents(element);
                            getSelection().removeAllRanges();
                            getSelection().addRange(range);
                        });
                        await present(structuredClone([note, result]));
                        assert.equal(await item.locator("[data-message-body] strong").evaluate((element) => element.firstChild === window.noteText), true);
                        assert.equal(await page.evaluate(() => getSelection().toString()), "provisional hypothesis");
                        assert.equal(await item.locator(":scope > details").evaluate((element) => element.open), true);
                        assert.deepEqual(await ids(), [note.id, result.id]);
                    });

                    await t.test("{§web-working-notes} argument streaming is literal until complete, never repaired or guessed", async () => {
                        const display = async (argumentsText, metadata = { plurnk: { op: "NOTE" } }, name = "NOTE") => {
                            await present([{ id: "streamed-note", role: "assistant", toolCalls: [{ id: "streamed-call", type: "function", function: { name, arguments: argumentsText }, metadata }] }]);
                        };
                        const item = row("streamed-note").locator("[data-call-id=streamed-call]");
                        await display('{"body":"**unfinished');
                        await item.locator("summary").click();
                        for (const argumentsText of ['{"body":"**unfinished', "null", "[]", '{"body":42}', '{"body":{"raw":"**not a string**"}}', '{"body":"text","aside":[]}']) {
                            await display(argumentsText);
                            assert.equal(await item.locator("[data-message-body]").count(), 0);
                            assert.equal(await item.locator("[data-text=call-arguments]").textContent(), argumentsText);
                            assert.equal(await item.locator(":scope > details").evaluate((element) => element.open), true);
                        }
                        const complete = '{"body":"**Now complete**","aside":"fact"}';
                        await display(complete);
                        assert.equal(await item.locator("[data-message-body] strong").innerText(), "Now complete");
                        assert.equal(await item.locator(":scope > details").evaluate((element) => element.open), true);
                        for (const [metadata, name] of [[{}, "NOTE"], [{ plurnk: { op: "error" } }, "NOTE"], [{ plurnk: { op: "NOTE" } }, "lookup"]]) {
                            await display(complete, metadata, name);
                            assert.equal(await item.locator("[data-message-body]").count(), 0);
                            assert.equal(await item.locator("[data-text=call-arguments]").textContent(), complete);
                        }
                        await display('{"body":"","aside":null}');
                        assert.equal(await item.locator("[data-message-body]").textContent(), "");
                        assert.equal(await item.locator("summary").first().innerText(), "NOTE");
                    });
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
});

// One browser-test entry point owns browser lifetimes; checks retain cold documents.
test("{§web-math-content} {§web-content-reflow} math through the real conversation outlet", { timeout: 60_000 }, verifyMath);
test("{§web-math-content} a missing math chunk preserves source, reports failure and leaves ordinary messages usable", verifyUnavailableMath);
test("{§web-conversation-content} {§web-browser-security} adversarial content across roles, streaming and replay", { timeout: 60_000 }, verifyContentSecurity);
test("{§web-diagram-content} {§web-content-reflow} static Mermaid images through the real conversation outlet", { timeout: 60_000 }, verifyMermaid);
test("{§web-diagram-content} a missing diagram chunk preserves source and ordinary messages", verifyUnavailableMermaid);
test("{§web-worker-approval} native review controls project complete SDK interrupt sets", { timeout: 60_000 }, verifyApproval);
test("{§web-worker-questions} native and JSON answers preserve the full response contract", { timeout: 60_000 }, verifyInteractions);
