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
import verifyFootnotes from "./footnotes-browser.js";
import verifyDiagnostics from "./diagnostics-browser.js";
import verifyStatus from "./status-browser.js";
import verifyBodies from "./body-browser.js";
import verifyReasoning from "./reasoning-browser.js";
import verifyStreams from "./streams-browser.js";
import verifyActivity from "./activity-browser.js";
import verifyCommands from "./commands-browser.js";
import verifySemanticContent from "./semantic-browser.js";

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

                    await t.test("{§web-working-notes} semantic entries expose content and accessible identity, not protocol envelopes", async () => {
                        const source = [{ id: "notebook", role: "assistant", subagentRunId: "child-run", toolCalls:
                            ["fact", "idea", "plan", "note", "custom"].map((aside, index) => ({
                                id: `note-${index}`, type: "function", function: { name: "NOTE", arguments: JSON.stringify({ aside, body: `A **${aside}**.` }) },
                                metadata: { plurnk: { op: "NOTE", coordinate: `1/2/${index}`, worker: 9, state: "resolved", status: 200,
                                    attrs: { privateFixtureMarker: "not-a-presentation-field" } } },
                            })),
                        }];
                        await present(source);
                        const entries = page.locator("[data-messages] > li");
                        assert.equal(await entries.count(), 5, "each call is one entry; its message is not an extra envelope");
                        for (const [index, category] of ["fact", "idea", "plan", "note", "custom"].entries()) {
                            const entry = entries.nth(index);
                            assert.equal(await entry.getAttribute("data-message-id"), "notebook");
                            assert.equal(await entry.getAttribute("data-message-role"), "assistant");
                            assert.equal(await entry.getAttribute("data-call-id"), `note-${index}`);
                            assert.equal(await entry.getAttribute("data-plurnk-type"), "NOTE");
                            assert.equal(await entry.getAttribute("data-plurnk-note"), category);
                            assert.equal(await entry.getAttribute("data-plurnk-worker"), "9");
                            assert.equal(await entry.getAttribute("data-plurnk-status"), "200");
                            assert.equal(await entry.getAttribute("data-plurnk-state"), "resolved");
                            assert.deepEqual(await entry.locator(":scope > *").evaluateAll((elements) => elements.map(({ tagName }) => tagName)), ["ARTICLE"]);
                            assert.equal(await entry.getByRole("article", { name: `NOTE · ${category} · Subagent child-run`, exact: true }).count(), 1);
                            assert.equal(await entry.locator(":scope > article > pre").textContent(), `A **${category}**.`);
                            assert.equal(await entry.locator("header").textContent(), category === "custom" ? "custom" : "", "only an uncategorized aside needs visible text");
                            assert.equal(await entry.locator("details, section, div, ul, li, [data-plurnk-operands]").count(), 0);
                            assert.equal(await entry.getAttribute("data-call-arguments"), null);
                        }
                        const snapshot = await entries.first().ariaSnapshot();
                        assert.match(snapshot, /article "NOTE · fact · Subagent child-run"/u);
                        assert.match(snapshot, /A \*\*fact\*\*\./u, "accessible naming preserves the literal body in the accessibility tree");
                        assert.doesNotMatch(await page.locator("[data-messages]").innerHTML(), /not-a-presentation-field/u);
                        await present([]);
                    });

                    await t.test("empty history requires a supplied empty collection, not an empty rendered list", async () => {
                        await page.reload();
                        await page.waitForFunction(() => typeof window.present === "function");
                        const empty = page.getByText("No messages.", { exact: true });
                        assert.equal(await empty.isVisible(), false, "history is unknown before its first SDK projection");
                        await present([]);
                        assert.equal(await empty.isVisible(), true, "a supplied empty collection confirms empty history");
                        await present([{ id: "pending-reasoning", role: "reasoning", content: "" }]);
                        assert.deepEqual(await ids(), [], "a live reasoning placeholder has no transcript body");
                        assert.equal(await empty.isVisible(), false, "unrendered working material is not an empty history");
                        await present([{ id: "answer", role: "assistant", content: "Confirmed answer." }]);
                        assert.equal(await row("answer").locator("article p").textContent(), "Confirmed answer.");
                        assert.equal(await empty.isVisible(), false);
                        await present([]);
                        assert.equal(await empty.isVisible(), true, "a later empty snapshot clears the conversation");
                    });

                    await t.test("roles, exact calls and results retain SDK order in direct semantic entries", async () => {
                        await present(messages);
                        assert.deepEqual(await ids(), ["question", "thought", "operations", "operations", "evidence", "failure", "answer"]);
                        assert.equal(await row("question").locator("article strong").innerText(), "the evidence");
                        assert.equal(await row("thought").locator(":scope > details").getAttribute("open"), null);
                        assert.equal(await row("operations").count(), 2);
                        assert.deepEqual(await row("operations").evaluateAll((rows) => rows.map((row) => row.dataset.callId)), ["call/one#%", "call-two"]);
                        assert.deepEqual(await row("operations").locator("article").allTextContents(), ["", ""], "opaque calls do not become argument dumps");
                        assert.equal(await row("failure").locator("p[data-message-error]").textContent(), "Entry not found");
                        assert.equal(await row("failure").locator("article > pre").textContent(), "Partial result");
                        assert.equal(await row("evidence").getAttribute("data-tool-call-id"), "call/one#%");
                        assert.equal(await row("evidence").locator("a").count(), 0);
                        assert.equal(await page.locator("#worker-conversation form, #worker-conversation textarea, #worker-conversation [contenteditable]").count(), 0);
                        assert.equal(await page.locator("[data-empty-conversation]").isVisible(), false);
                    });

                    await t.test("streaming and reconnect snapshots preserve open details, focus, unchanged body selection and scroll", async () => {
                        await present(messages);
                        await row("thought").locator("summary").click();
                        await page.evaluate(() => {
                            window.savedRow = document.querySelector('[data-message-id="thought"]');
                            window.savedBody = document.querySelector('[data-message-id="question"] article');
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
                        assert.equal(await page.evaluate(() => window.savedBody === document.querySelector('[data-message-id="question"] article')), true);
                        assert.equal(await row("thought").locator("details").evaluate((details) => details.open), true);
                        assert.equal(await page.evaluate(() => document.activeElement?.outerHTML), focused);
                        assert.equal(await page.evaluate(() => getSelection().toString()), "the evidence");
                        assert.equal(await page.evaluate(() => scrollY), beforeScroll);
                        assert.match(await row("thought").locator("article").textContent(), /Now I have evidence\./u);
                    });

                    await t.test("call identities stay exact without inventing fragment navigation", async () => {
                        const calls = ["call/a", "call%2Fa"].map((id) => ({
                            id, type: "function", function: { name: "READ", arguments: '{"path":"evidence.txt"}' },
                        }));
                        await present([{ id: "operations", role: "assistant", content: "", toolCalls: calls },
                            ...calls.map(({ id }, index) => ({ id: `result-${index}`, role: "tool", toolCallId: id, content: "Evidence" }))]);
                        for (const [index, call] of calls.entries()) {
                            const result = row(`result-${index}`);
                            assert.equal(await result.getAttribute("data-tool-call-id"), call.id);
                            assert.equal(await result.locator("a").count(), 0);
                        }
                    });

                    await t.test("mixed content and calls preserve their order, identity and supplied metadata across snapshots", async () => {
                        const call = (id) => ({ id, type: "function", function: { name: "lookup", arguments: "{}" } });
                        const message = { id: "mixed", role: "assistant", content: "First the explanation.", toolCalls: [call("one"), call("two")],
                            metadata: { plurnk: { op: "SEND", status: 200, address: "message://user/example" } } };
                        await present([message]);
                        const entries = page.locator("[data-messages] > li");
                        assert.deepEqual(await entries.evaluateAll((rows) => rows.map((row) => [row.dataset.messageId, row.dataset.callId ?? null])),
                            [["mixed", null], ["mixed", "one"], ["mixed", "two"]]);
                        assert.equal(await entries.first().getAttribute("data-plurnk-type"), "SEND");
                        assert.equal(await entries.nth(1).getAttribute("data-plurnk-type"), null, "a call does not inherit unrelated message metadata");
                        await entries.nth(2).evaluate((element) => { window.retainedCall = element; });
                        await present([{ ...message, content: "", metadata: {}, toolCalls: [call("two")] }]);
                        assert.equal(await entries.count(), 1);
                        assert.equal(await entries.first().evaluate((element) => element === window.retainedCall), true);
                        assert.equal(await entries.first().getAttribute("data-plurnk-type"), null);
                        await assert.rejects(present([{ ...message, toolCalls: [call("two"), call("two")] }]), /Conversation has duplicate call identities\./u);
                        assert.equal(await entries.count(), 1, "invalid identity cannot partially replace valid content");
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

                    await t.test("standard text is readable; unmapped structured payloads remain in JavaScript", async () => {
                        const other = [
                            { id: "system", role: "system", content: "System evidence" },
                            { id: "developer", role: "developer", content: "Developer evidence" },
                            { id: "activity", role: "activity", activityType: "progress", content: { percent: 25 } },
                            { id: "parts", role: "user", content: [{ type: "text", text: "First" }, { type: "binary", mimeType: "image/png", url: "https://example.invalid/untrusted.png" }] },
                            { id: "child", role: "assistant", subagentRunId: "child-run", content: "Child answer" },
                            { id: "orphan", role: "tool", toolCallId: "not-in-snapshot", content: "Still inspectable", error: "" },
                        ];
                        await present(other);
                        assert.deepEqual(await ids(), other.map(({ id }) => id));
                        assert.equal(await row("activity").getByRole("article", { name: "progress", exact: true }).count(), 1);
                        assert.equal(await row("activity").locator("article").textContent(), "");
                        assert.equal(await row("parts").locator("article > p").textContent(), "First");
                        assert.deepEqual(await row("parts").locator("article > *").evaluateAll((elements) => elements.map(({ tagName }) => tagName)), ["P"]);
                        assert.equal(await row("child").getAttribute("data-subagent-run-id"), "child-run");
                        assert.equal(await row("child").getByRole("article", { name: "Assistant · Subagent child-run", exact: true }).count(), 1);
                        assert.equal(await row("orphan").locator("a").count(), 0);
                        assert.equal(await row("orphan").getAttribute("data-message-error"), null, "an empty error field is not an error state");
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
                        const rich = row("hostile").locator("article");
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
                        assert.equal(await row("literal").locator("article > pre").textContent(), hostile);
                        assert.equal(await page.evaluate(() => window.pwned), undefined);
                        assert.deepEqual(requests, [], "rendering content does not fetch its links or images");
                    });

                    await t.test("unchanged operation bodies preserve native text selection", async () => {
                        const source = [{ id: "edit", role: "assistant", toolCalls: [{ id: "edit-call", type: "function",
                            function: { name: "EDIT", arguments: '{"body":"Replacement text"}' }, metadata: { plurnk: { op: "EDIT" } } }] }];
                        await present(source);
                        const before = await page.evaluate(() => {
                            const text = document.querySelector("[data-call-id] article > pre").firstChild;
                            const range = document.createRange();
                            range.selectNodeContents(text);
                            getSelection().removeAllRanges();
                            getSelection().addRange(range);
                            window.selectedArgument = text;
                            window.selectedCall = text.parentElement.closest("li");
                            return getSelection().toString();
                        });
                        assert.equal(before, "Replacement text");
                        await present([...source, { id: "later", role: "reasoning", content: "Another message" }]);
                        assert.deepEqual(await page.evaluate(() => ({
                            sameText: window.selectedArgument === document.querySelector("[data-call-id] article > pre").firstChild,
                            sameCall: window.selectedCall === document.querySelector("[data-call-id] article > pre").closest("li"),
                            text: document.querySelector("[data-call-id] article > pre").textContent,
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
                        const content = row("markup").locator("article");
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

                    await t.test("{§web-working-notes} NOTE retains call/result identity and selected content without an arguments copy", async () => {
                        const body = "A **provisional hypothesis**, not an answer.\n\n<script>window.pwned = true</script>";
                        const argumentsText = JSON.stringify({ aside: "idea", body });
                        const call = { id: "note-call", type: "function", function: { name: "NOTE", arguments: argumentsText }, metadata: { plurnk: { op: "NOTE" } } };
                        const note = { id: "note", role: "assistant", content: "", subagentRunId: "child-run", toolCalls: [call] };
                        const result = { id: "note-result", role: "tool", toolCallId: call.id,
                            content: '{"status":500,"problem":{"title":"Note storage failed","detail":"The note could not be persisted."}}', error: "Note storage failed" };
                        await present([note, result]);
                        const item = row("note");
                        assert.equal(await item.getAttribute("data-call-id"), "note-call");
                        assert.equal(await item.getAttribute("data-plurnk-note"), "idea");
                        assert.equal(await item.getByRole("article", { name: "NOTE · idea · Subagent child-run", exact: true }).count(), 1);
                        assert.equal(await item.locator("article").isVisible(), true);
                        assert.equal(await row("note").getAttribute("data-message-role"), "assistant");
                        assert.equal(await row("note").getAttribute("data-subagent-run-id"), "child-run");
                        assert.equal(await item.locator("article > pre").textContent(), body);
                        assert.equal(await item.locator("script").count(), 0);
                        assert.equal(await item.locator("details, [data-text=call-arguments]").count(), 0);
                        assert.equal(await item.getAttribute("data-call-arguments"), null);
                        assert.equal(await item.locator('[data-plurnk-field="outcome"]').textContent(), "Note storage failed — The note could not be persisted.");
                        assert.equal(await item.getAttribute("data-plurnk-status"), "500");
                        assert.equal(await row("note-result").count(), 0, "the call's receipt is its summary, not another body");
                        await item.locator("article > pre").evaluate((element) => {
                            window.noteText = element.firstChild;
                            const range = document.createRange();
                            range.selectNodeContents(element);
                            getSelection().removeAllRanges();
                            getSelection().addRange(range);
                        });
                        await present(structuredClone([note, result]));
                        assert.equal(await item.locator("article > pre").evaluate((element) => element.firstChild === window.noteText), true);
                        assert.equal(await page.evaluate(() => getSelection().toString()), body);
                        assert.equal(await item.locator(":scope > article").count(), 1);
                        assert.deepEqual(await ids(), [note.id]);
                    });

                    await t.test("{§web-working-notes} incomplete arguments are not content and are never repaired or guessed", async () => {
                        const display = async (argumentsText, metadata = { plurnk: { op: "NOTE" } }, name = "NOTE") => {
                            await present([{ id: "streamed-note", role: "assistant", toolCalls: [{ id: "streamed-call", type: "function", function: { name, arguments: argumentsText }, metadata }] }]);
                        };
                        const item = row("streamed-note");
                        await display('{"body":"**unfinished');
                        await item.evaluate((element) => { window.streamedCall = element; });
                        for (const argumentsText of ['{"body":"**unfinished', "null", "[]", '{"body":42}', '{"body":{"raw":"**not a string**"}}']) {
                            await display(argumentsText);
                            assert.equal(await item.getAttribute("data-plurnk-note"), null);
                            assert.equal(await item.locator("article > pre, article > p").count(), 0);
                            assert.equal(await item.evaluate((element) => element === window.streamedCall), true);
                        }
                        const complete = '{"body":"**Now complete**","aside":"fact"}';
                        await display(complete);
                        assert.equal(await item.locator("article > pre").textContent(), "**Now complete**");
                        assert.equal(await item.getAttribute("data-plurnk-note"), "fact");
                        assert.equal(await item.evaluate((element) => element === window.streamedCall), true);
                        for (const [metadata, name] of [[{}, "NOTE"], [{ plurnk: { op: "error" } }, "NOTE"], [{ plurnk: { op: "NOTE" } }, "lookup"]]) {
                            await display(complete, metadata, name);
                            assert.equal(await item.getAttribute("data-plurnk-note"), null);
                            assert.equal(await item.locator("article > pre, article > p").count(), 0);
                        }
                        await display('{"body":"","aside":null}');
                        assert.equal(await item.locator("article").textContent(), "");
                        assert.equal(await item.getByRole("article", { name: "NOTE · note", exact: true }).count(), 1);
                    });
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
});

// One browser-test entry point owns browser lifetimes; checks retain cold documents.
test("{§web-operation-summary} every operation shares its authored summary with its own receipt", { timeout: 60_000 }, verifySemanticContent);
test("{§web-worker-diagnostics} public notices and Problems remain visible outside conversation", { timeout: 60_000 }, verifyDiagnostics);

test("{§web-worker-status} {§web-worker-identity} public state projects through native status and navigation", { timeout: 60_000 }, verifyStatus);
test("{§web-result-bodies} visible content loads securely without an inspection UI", { timeout: 60_000 }, verifyBodies);
test("{§web-worker-reasoning} reasoning stays outside history until explicitly read", { timeout: 60_000 }, verifyReasoning);
test("{§web-worker-streams} current executor state and explicit output inspection", { timeout: 60_000 }, verifyStreams);
test("{§web-worker-activity} non-conversation observations retain identity and explicit inspection", { timeout: 60_000 }, verifyActivity);
test("{§web-worker-commands} isolated command delivery and literal results", { timeout: 60_000 }, verifyCommands);
test("{§web-footnote-content} native footnotes through the real conversation outlet", { timeout: 60_000 }, verifyFootnotes);
test("{§web-math-content} {§web-content-reflow} math through the real conversation outlet", { timeout: 60_000 }, verifyMath);
test("{§web-math-content} a missing math chunk preserves source, reports failure and leaves ordinary messages usable", verifyUnavailableMath);
test("{§web-conversation-content} {§web-browser-security} adversarial content across roles, streaming and replay", { timeout: 60_000 }, verifyContentSecurity);
test("{§web-diagram-content} {§web-content-reflow} static Mermaid images through the real conversation outlet", { timeout: 60_000 }, verifyMermaid);
test("{§web-diagram-content} unavailable diagram compilation preserves source and ordinary messages", verifyUnavailableMermaid);
test("{§web-worker-approval} native review controls project complete SDK interrupt sets", { timeout: 60_000 }, verifyApproval);
test("{§web-worker-questions} native and JSON answers preserve the full response contract", { timeout: 60_000 }, verifyInteractions);
