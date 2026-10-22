import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import browserDiagnostics from "./browser-diagnostics.js";
import conversationFixture from "./conversation-fixture.js";

// {§web-content-reflow} Compiled semantic content owns its geometry without rewriting its text.
export default async function verifyReflow(t) {
    const paragraph = "A provisional idea, with evidence still to inspect. ".repeat(30);
    const token = "unbroken".repeat(80);
    const literal = `${paragraph}\n\n    Indented\tcolumns    remain literal.\n${token}\n</pre><script>window.reflowExecuted=true</script>&copy; **not Markdown**\n`;
    const output = Array.from({ length: 60 }, (_, index) => `    ${index}: ${literal}`).join("\n");
    const { server, url } = await conversationFixture(undefined, new Map([
        ["/agui/reflow-body", (_request, response) => {
            response.writeHead(200, { "Content-Type": "text/plain" });
            response.end(literal);
        }],
    ]));
    const messages = [
        { id: "note", role: "assistant", toolCalls: [{
            id: "note-call", type: "function",
            function: { name: "NOTE", arguments: JSON.stringify({ aside: "idea", body: literal }) },
            metadata: { plurnk: { op: "NOTE" } },
        }] },
        { id: "output", role: "tool", toolCallId: "external-call", content: output },
        { id: "reasoning", role: "reasoning", content: literal },
        { id: "fetched", role: "user", content: [{ type: "document", source: {
            type: "url", value: new URL("/agui/reflow-body", url).href, mimeType: "text/plain",
        } }] },
        { id: "code", role: "assistant", content: `\`\`\`text\n${token}\n\`\`\`` },
    ];
    try {
        for (const engine of [chromium, firefox, webkit]) {
            await t.test(engine.name(), async (t) => {
                const browser = await engine.launch();
                try {
                    for (const colorScheme of ["light", "dark"]) {
                        await t.test(colorScheme, async () => {
                            const context = await browser.newContext({ colorScheme, viewport: { width: 320, height: 700 } });
                            try {
                                const checkBrowser = browserDiagnostics(context);
                                const page = await context.newPage();
                                await page.goto(url);
                                await page.waitForFunction(() => typeof window.present === "function");
                                await page.evaluate((messages) => window.present(messages), messages);
                                const row = (id) => page.locator(`[data-message-id="${id}"]`);
                                for (const id of ["note", "output", "reasoning"]) await row(id).locator("summary").click();
                                await row("fetched").locator("[data-body-reference]").scrollIntoViewIfNeeded();
                                await row("fetched").locator('[data-body-state="loaded"]').waitFor();
                                await row("note").locator("pre").evaluate((element) => {
                                    window.retainedText = element.firstChild;
                                    const range = document.createRange();
                                    range.selectNodeContents(element);
                                    getSelection().removeAllRanges();
                                    getSelection().addRange(range);
                                });
                                const selected = await page.evaluate(() => getSelection().toString());

                                const heights = [];
                                for (const width of [320, 1280, 320]) {
                                    await page.setViewportSize({ width, height: 700 });
                                    await page.evaluate((messages) => window.present(messages), structuredClone(messages));
                                    for (const id of ["note", "output", "reasoning", "fetched"]) {
                                        const pre = row(id).locator("pre");
                                        assert.equal(await pre.textContent(), id === "output" ? output : literal);
                                        assert.equal(await pre.locator("*").count(), 0, `${id}: markup stays text`);
                                        const size = await pre.evaluate((element) => ({
                                            width: element.clientWidth, contentWidth: element.scrollWidth,
                                            height: element.clientHeight, contentHeight: element.scrollHeight,
                                            whiteSpace: getComputedStyle(element).whiteSpace,
                                        }));
                                        assert.ok(size.contentWidth <= size.width + 1, `${id} at ${width}px: literal lines must wrap, not scroll (${JSON.stringify(size)})`);
                                        assert.ok(size.contentHeight <= size.height + 1, `${id}: settled text must grow, not scroll vertically`);
                                        assert.equal(size.whiteSpace, "pre-wrap", `${id}: authored whitespace remains preformatted`);
                                    }
                                    const note = row("note").locator("pre");
                                    heights.push(await note.evaluate((element) => element.clientHeight));
                                    assert.equal(await note.evaluate((element) => element.firstChild === window.retainedText), true);
                                    assert.equal(await page.evaluate(() => getSelection().getRangeAt(0).toString()), literal, "the selected source retains every character, including the final newline");
                                    assert.equal(await page.evaluate(() => getSelection().toString()), selected, "resize and replay preserve the browser's native selection without adding visual line breaks");
                                    assert.ok(await row("output").locator("pre").evaluate((element) => element.clientHeight > innerHeight), "long output grows beyond the viewport");

                                    const code = row("code").locator("pre");
                                    assert.equal(await code.locator("code").textContent(), `${token}\n`);
                                    const codeSize = await code.evaluate((element) => ({
                                        width: element.clientWidth, contentWidth: element.scrollWidth,
                                        whiteSpace: getComputedStyle(element).whiteSpace,
                                    }));
                                    assert.ok(codeSize.contentWidth > codeSize.width, "explicit code keeps its local horizontal scroll");
                                    assert.equal(codeSize.whiteSpace, "pre");
                                    assert.equal(await page.locator("#main").evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, "content does not widen the main scroll area");
                                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "content does not widen the document");
                                }
                                assert.ok(heights[0] > heights[1], "a wider viewport unwraps literal text naturally");
                                assert.equal(heights[0], heights[2], "returning to mobile reflows the same text");
                                assert.equal(await page.evaluate(() => window.reflowExecuted), undefined);
                                checkBrowser();
                            } finally { await context.close(); }
                        });
                    }
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}
