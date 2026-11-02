import assert from "node:assert/strict";
import { engines } from "./engines.js";
import browserDiagnostics from "./browser-diagnostics.js";
import conversationFixture from "./conversation-fixture.js";

const call = (id, op, body, aside = "") => ({
    id, role: "assistant", toolCalls: [{ toolCallId: `${id}-call`,
        name: op, rawInput: { body, aside, target: { raw: "file.txt" } },
        _meta: { plurnk: { op } },
    }],
});

export default async function verifyDisclosures(t) {
    let reads = 0;
    const { server, url } = await conversationFixture(undefined, new Map([
        ["/acp/disclosure-body", (_request, response) => {
            reads++;
            response.writeHead(200, { "Content-Type": "text/plain" });
            response.end("Literal <pre> tool output.");
        }],
    ]));
    try {
        for (const engine of engines) {
            await t.test(engine.name(), async () => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    await page.goto(url);
                    await page.waitForFunction(() => typeof window.present === "function");
                    const present = (messages) => page.evaluate((messages) => window.present(messages), messages);
                    const row = (id) => page.locator(`[data-message-id="${id}"]`);
                    const disclosure = (id) => row(id).locator("article > details");
                    const source = [
                        { id: "user", role: "user", content: "Question" },
                        { id: "answer", role: "assistant", content: "**Answer**\n\nAnother paragraph." },
                        call("send", "SEND", "Delivered reply"),
                        { id: "cancel", role: "tool", toolCallId: "cancel-call", content: "Cancelled reply", _meta: { plurnk: { op: "FAIL", signal: 499 } } },
                        call("note", "NOTE", "Literal <pre>\n**fact**", "fact"),
                        call("edit", "EDIT", "Replacement", "Update the file"),
                        { id: "tool", role: "tool", toolCallId: "opaque-call", content: "Tool output", error: "Tool failed" },
                        { id: "reasoning", role: "reasoning", content: "Working", _meta: { plurnk: { coordinate: "1/3" } } },
                        call("read", "READ", ""),
                        call("empty", "NOTE", ""),
                        call("wrapped", "EDIT", "Replacement", "Update the file after checking the existing implementation and its complete contract"),
                    ];
                    await present(source);
                    for (const id of ["user", "answer", "send", "cancel"]) {
                        assert.equal(await disclosure(id).count(), 1, `${id} has a native body disclosure`);
                        assert.equal(await disclosure(id).evaluate((node) => node.open), true, `${id} begins open`);
                    }
                    for (const id of ["note", "edit", "tool", "reasoning"]) {
                        assert.equal(await disclosure(id).evaluate((node) => node.open), false, `${id} begins closed`);
                        assert.equal(await row(id).locator("pre").isVisible(), false);
                    }
                    for (const id of ["read", "empty"]) assert.equal(await disclosure(id).count(), 0, "no empty expanders");
                    assert.equal(await row("tool").getByText("Tool failed", { exact: true }).isVisible(), true);
                    assert.equal(await page.locator("summary header, summary p, details[name]").count(), 0, "valid phrasing summaries; independent disclosures");
                    for (const width of [320, 1280]) {
                        await page.setViewportSize({ width, height: 844 });
                        for (const id of ["user", "answer", "note", "wrapped", "read"]) {
                            const geometry = await row(id).locator("article").evaluate((article) => {
                                const shell = article.firstElementChild;
                                const summary = shell.querySelector("summary");
                                const last = summary && !shell.open ? summary : shell.lastElementChild;
                                return {
                                    padding: Number.parseFloat(getComputedStyle(article).paddingBottom),
                                    bottom: article.getBoundingClientRect().bottom - (summary ? last : shell).getBoundingClientRect().bottom,
                                    heading: summary ? summary.getBoundingClientRect().height : null,
                                    fields: summary?.children.length ? Array.from(summary.children).reduce((total, field) => total + field.getBoundingClientRect().height, 0) : null,
                                    lineHeight: summary ? getComputedStyle(summary).lineHeight : null,
                                    bodyLineHeight: getComputedStyle(article).lineHeight,
                                };
                            });
                            assert.ok(Math.abs(geometry.bottom - (id === "read" ? 0 : geometry.padding)) < 1,
                                `${id} at ${width}px: no redundant bottom space (${JSON.stringify(geometry)})`);
                            if (geometry.fields !== null) assert.ok(Math.abs(geometry.heading - geometry.fields) < 1, "the chevron does not add an empty summary row");
                            if (geometry.lineHeight) assert.equal(geometry.lineHeight, geometry.bodyLineHeight, "wrapped summaries retain ordinary readable line spacing");
                        }
                        assert.ok(await row("answer").locator("p").evaluateAll(([first, second]) => second.getBoundingClientRect().top > first.getBoundingClientRect().bottom),
                            "paragraph separation remains intact");
                    }
                    await disclosure("user").locator("summary").click();
                    await disclosure("note").locator("summary").focus();
                    await page.keyboard.press("Enter");
                    assert.equal(await disclosure("user").evaluate((node) => node.open), false);
                    assert.equal(await row("note").locator("pre").isVisible(), true);
                    assert.equal(await row("note").locator("pre").textContent(), "Literal <pre>\n**fact**");
                    await row("note").locator("pre").evaluate((node) => { window.noteBody = node; });
                    const failure = { id: "edit-result", role: "tool", toolCallId: "edit-call", content: JSON.stringify({ status: 409, problem: { title: "Changed on disk" } }) };
                    await present([...source, failure]);
                    assert.equal(await disclosure("user").evaluate((node) => node.open), false, "replay does not reopen a collapsed reply");
                    assert.equal(await disclosure("note").evaluate((node) => node.open), true, "replay does not collapse inspected work");
                    assert.equal(await row("note").locator("pre").evaluate((node) => node === window.noteBody), true);
                    assert.equal(await row("edit").getByText("Update the file", { exact: true }).isVisible(), true);
                    assert.equal(await row("edit").getByText("Changed on disk", { exact: true }).isVisible(), true);
                    assert.equal(await row("edit").locator("pre").isVisible(), false);
                    assert.deepEqual(await disclosure("edit").locator("summary > *").evaluateAll((nodes) => nodes.map((node) => node.dataset.plurnkField ?? (node.hasAttribute("data-plurnk-operands") ? "operands" : null))), ["heading", "outcome", "operands"]);
                    assert.equal(await disclosure("edit").locator("summary").getAttribute("aria-label"), "EDIT · Update the file · Changed on disk · (file.txt)", "summary naming preserves diagnostic and field boundaries");
                    const updated = structuredClone(source);
                    updated[0].content += " updated";
                    updated[4] = call("note", "NOTE", "New content", "fact");
                    updated[9] = call("empty", "NOTE", "Now present");
                    await present(updated);
                    assert.equal(await disclosure("user").evaluate((node) => node.open), false);
                    assert.equal(await disclosure("note").evaluate((node) => node.open), true);
                    assert.equal(await disclosure("empty").evaluate((node) => node.open), false, "late body starts at its own default");
                    assert.equal(await row("edit").locator('[data-plurnk-field="outcome"]').count(), 0, "superseded diagnostic is removed");
                    await disclosure("note").locator("summary").focus();
                    await page.keyboard.press("Space");
                    assert.equal(await disclosure("note").evaluate((node) => node.open), false);
                    const previousReads = reads;
                    const reference = [{ id: "reference", role: "tool", toolCallId: "opaque-reference", content: [{
                        type: "resource_link", uri: new URL("/acp/disclosure-body", url).href, name: "body", mimeType: "text/plain",
                    }] }];
                    await present(reference);
                    await row("reference").scrollIntoViewIfNeeded();
                    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                    assert.equal(reads, previousReads, "closed tool evidence does not fetch");
                    await disclosure("reference").locator("summary").click();
                    await row("reference").locator('[data-body-state="loaded"]').waitFor();
                    assert.equal(await row("reference").locator("pre").textContent(), "Literal <pre> tool output.");
                    assert.equal(reads, previousReads + 1);
                    await present(structuredClone(reference));
                    assert.equal(reads, previousReads + 1, "replay retains the inspected body without refetching");
                    const provisional = { id: "late-attribution", role: "tool", toolCallId: "late-call", content: "Partial evidence", error: "Entry missing" };
                    await present([provisional]);
                    assert.equal(await row(provisional.id).getByText("Entry missing", { exact: true }).count(), 1);
                    await present([{ ...provisional, content: JSON.stringify({ status: 404, problem: { title: "Entry missing" } }),
                        _meta: { plurnk: { op: "READ", status: 404 } },
                    }]);
                    assert.equal(await row(provisional.id).getByText("Entry missing", { exact: true }).count(), 1, "late operation attribution retains one diagnostic, not two renderers' copies");
                    assert.equal(await disclosure(provisional.id).count(), 0, "attributed READ has no receipt-body disclosure");
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}
