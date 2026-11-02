import assert from "node:assert/strict";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics from "./browser-diagnostics.js";

const selection = (path, marks, pattern) => ({
    target: path ? { raw: path } : null,
    lineMarker: marks ? { marks } : null,
    matcher: pattern ? { raw: pattern } : null,
});
const call = (id, name, args) => ({ id, role: "assistant", toolCalls: [{
    toolCallId: `${id}-call`, name, rawInput: args,
    _meta: { plurnk: { op: name, attrs: { sentinel: "private envelope" } } },
}] });
const result = (id, receipt) => ({ id: `${id}-result`, role: "tool", toolCallId: `${id}-call`, content: JSON.stringify(receipt) });

/** {§web-operation-summary} Shared structure, authored selection and own receipt; no inferred readback. */
export default async function verifySemanticContent(t) {
    const { server, url } = await conversationFixture();
    try {
        for (const engine of engines) {
            await t.test(engine.name(), async () => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext();
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    const requests = [];
                    page.on("request", (request) => { if (request.url().includes("/acp/")) requests.push(request.url()); });
                    await page.goto(url);
                    await page.waitForFunction(() => typeof window.present === "function");
                    const present = (messages) => page.evaluate((messages) => { window.source = messages; window.present(messages); }, messages);
                    const list = page.locator("[data-messages]");
                    assert.equal(await list.evaluate((element) => element.tagName), "UL");
                    const row = (id) => list.locator(`[data-message-id="${id}"]`);
                    const field = (item, name) => item.locator(`[data-plurnk-field="${name}"]`);
                    const glyph = (item) => field(item, "heading").evaluate((element) => getComputedStyle(element, "::before").content);
                    const glyphs = { FIND: "🔎", READ: "📖", EDIT: "📝", COPY: "🖨️", MOVE: "📦", KILL: "🗑️", WAIT: "⏳", WORK: "🐜", FORK: "🔱", BARE: "☁️", WARN: "⚠️", FAIL: "⛔", INFO: "📌", sh: "⚙️", mcp: "⚙️", schedule: "⚙️", members: "⚙️" };
                    const names = Object.keys(glyphs);
                    const messages = names.flatMap((name) => [
                        call(name, name, { ...selection("README.md", [1, -1], "/mudkips/"), aside: `Actual ${name} aside` }),
                        result(name, { status: 200, path: "README.md", content: "Receipt body is not a summary", range: { unit: "line", total: 40, requested: [1, -1], returned: [1, 3] } }),
                    ]);
                    await present(messages);
                    assert.equal(await list.locator(":scope > li").count(), names.length, "own receipts complete their call, not a second article");
                    for (const name of names) {
                        const item = row(name);
                        assert.equal(await item.locator(":scope > article").count(), 1);
                        assert.deepEqual(await item.locator("article > *").evaluateAll((elements) => elements.map(({ tagName }) => tagName)), ["HEADER"]);
                        assert.deepEqual(await item.locator("article > header > *").evaluateAll((elements) => elements.map(({ tagName }) => tagName)), ["SPAN", "SPAN"]);
                        assert.equal(await field(item, "aside").textContent(), `Actual ${name} aside`);
                        assert.equal(await field(item, "path").textContent(), "(README.md)");
                        assert.equal(await field(item, "scope").textContent(), "<1,-1>");
                        assert.equal(await field(item, "pattern").textContent(), "/mudkips/");
                        assert.equal(await item.getByRole("article", { name, exact: true }).count(), 1);
                        assert.equal(await item.locator("section, div, details, button, a, dl, pre").count(), 0);
                        assert.equal(await item.getAttribute("data-plurnk-status"), "200");
                        assert.ok((await glyph(item)).includes(glyphs[name]), `${name}'s stylesheet glyph survives production pruning`);
                        assert.doesNotMatch(await item.innerText(), /200|Receipt body|private envelope/u);
                    }
                    assert.equal(await field(row("READ"), "count").textContent(), "{3}");
                    assert.equal(await field(row("EDIT"), "count").count(), 0, "no generic range-as-line-count guess");
                    assert.equal(await field(row("mcp"), "runtime").textContent(), "mcp");
                    assert.match(await glyph(row("READ")), /📖/u);
                    assert.match(await glyph(row("mcp")), /⚙/u);
                    assert.deepEqual(await page.evaluate(() => window.source), messages, "projection never rewrites SDK authority");

                    const read = call("read", "READ", { ...selection("README.md", [1, -1], "/mudkips/"), aside: "Looking for mudkips" });
                    /** @type {any} */
                    const readResult = result("read", { status: 200, lineOrdinals: [1, 8], range: { unit: "line", total: 50, requested: [1, -1], returned: [1, 8] } });
                    readResult.content = [{ type: "text", text: readResult.content }, { type: "resource_link", uri: new URL("/acp/body", url).href, name: "body", mimeType: "text/plain" }];
                    await present([read, readResult]);
                    assert.equal(await field(row("read"), "heading").innerText(), "Looking for mudkips");
                    assert.equal(await row("read").locator("[data-plurnk-operands]").innerText(), "(README.md) <1,-1> /mudkips/ {2}");
                    await row("read").scrollIntoViewIfNeeded();
                    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                    assert.equal(await row("read").locator("[data-body-reference], details").count(), 0);
                    assert.deepEqual(requests, [], "a READ summary never fetches its readback body");
                    await present([read, result("read", { status: 404, problem: { title: "Entry not found", detail: "README.md is missing.", recovery: "Choose an existing path." } })]);
                    assert.equal(await field(row("read"), "outcome").textContent(), "Entry not found — README.md is missing. — Choose an existing path.");
                    for (const colorScheme of /** @type {const} */ (["light", "dark"])) {
                        await page.emulateMedia({ colorScheme });
                        const appearance = await field(row("read"), "outcome").evaluate((element) => ({
                            outcome: getComputedStyle(element).color,
                            article: getComputedStyle(element.parentElement).color,
                        }));
                        assert.equal(appearance.outcome, appearance.article, `${colorScheme}: an outcome inherits its Pico article color`);
                    }
                    assert.equal(await row("read").locator("header > [data-plurnk-field=heading] + [data-plurnk-field=outcome] + [data-plurnk-operands]").count(), 1,
                        "a diagnostic separates authored intent from operation operands");
                    const operandsBox = await row("read").locator("[data-plurnk-operands]").boundingBox();
                    const outcomeBox = await field(row("read"), "outcome").boundingBox();
                    assert.ok(operandsBox.y >= outcomeBox.y + outcomeBox.height, "the rendered operands start below the diagnostic row");
                    assert.equal(await row("read").getAttribute("data-plurnk-status"), "404");
                    assert.equal(await field(row("read"), "count").count(), 0, "replacement snapshot removes a stale count");

                    await present([call("copy", "COPY", { source: selection("a.txt", [2, 4], "/source/"), destination: selection("b.txt", [9], null) })]);
                    assert.equal(await row("copy").locator("[data-plurnk-operands]").innerText(), "(a.txt) <2,4> /source/ (b.txt) <9>");
                    assert.deepEqual(await row("copy").locator('[data-plurnk-operand]').allTextContents(), ["(a.txt) <2,4> /source/", "(b.txt) <9>"]);
                    await present([call("wait", "WAIT", { lineMarker: { marks: [600] } }), call("empty", "WAIT", {})]);
                    assert.equal(await row("wait").locator("[data-plurnk-operands]").innerText(), "<600>");
                    assert.equal(await row("empty").locator("article > header").count(), 1);
                    assert.equal(await row("empty").locator("[data-plurnk-operands]").count(), 0, "no empty row or filler text");
                    await present([call("find", "FIND", {}), result("find", { status: 204, range: { unit: "result", total: 0, requested: [1, -1] } })]);
                    assert.equal(await field(row("find"), "count").textContent(), "{0}");
                    const rejected = call("invalid", "READ", { text: "READ (missing closing syntax" });
                    rejected.toolCalls[0]._meta.plurnk.op = "error";
                    await present([rejected, result("invalid", { status: 400, problem: { title: "Invalid operation" } })]);
                    assert.equal(await field(row("invalid"), "path").count(), 0, "rejected syntax is not reparsed into imagined operands");
                    assert.equal(await field(row("invalid"), "outcome").textContent(), "Invalid operation");
                    assert.match(await glyph(row("invalid")), /⛔/u);
                    assert.equal(await row("invalid").locator("header > [data-plurnk-field=heading] + [data-plurnk-field=outcome]").count(), 1,
                        "an outcome without operands follows the operation header directly");
                    await present([rejected, result("invalid", { status: 200 })]);
                    assert.equal(await field(row("invalid"), "outcome").count(), 0, "a cleared outcome leaves no empty paragraph");

                    const literal = '**Not emphasis**\n</pre><script>window.contentExecuted=true</script><pre>\n&copy; 分析 🐹';
                    const note = call("note", "NOTE", { body: literal, aside: "fact" });
                    await present([note]);
                    await row("note").locator("summary").click();
                    await row("note").locator("pre").evaluate((element) => {
                        window.bodyNode = element.firstChild;
                        const range = document.createRange();
                        range.selectNodeContents(element);
                        getSelection().removeAllRanges();
                        getSelection().addRange(range);
                    });
                    await present([note, result("note", { status: 200 })]);
                    assert.equal(await row("note").locator("pre").textContent(), literal);
                    assert.equal(await row("note").locator("pre > *, script, strong, code").count(), 0);
                    assert.equal(await row("note").locator("pre").evaluate((element) => element.firstChild === window.bodyNode), true);
                    assert.equal(await page.evaluate(() => getSelection().toString()), literal, "receipt arrival preserves selection");
                    assert.match(await glyph(row("note")), /📊/u);
                    assert.equal(await field(row("note"), "aside").count(), 0);
                    const attributes = await row("note").evaluate((element) => [element, ...element.querySelectorAll("*")].flatMap((node) => Array.from(node.attributes, ({ value }) => value)));
                    assert.equal(attributes.some((value) => value.includes(literal)), false, "no body mirror in attributes");
                    assert.equal(await page.evaluate(() => window.contentExecuted), undefined);

                    await present([
                        call("done", "DONE", { body: { raw: "Actual **reply**.", json: null } }), result("done", { status: 200, completion: 200 }),
                        call("work", "WORK", { target: { raw: "helper" }, aside: "Delegate" }), result("work", { status: 202 }),
                        { id: "child-reply", role: "tool", toolCallId: "work-call", content: '{"answer":"Delivered **reply**"}', _meta: { plurnk: { op: "DONE", status: 200, signal: 200 } } },
                        { id: "observation", role: "tool", toolCallId: "work-call", content: '{"status":200,"path":"ops://helper/1","range":{"unit":"line","total":2,"requested":[1,-1],"returned":[1,2]}}', _meta: { plurnk: { op: "READ", status: 200 } } },
                    ]);
                    assert.deepEqual(await list.locator(":scope > li").evaluateAll((items) => items.map((item) => item.dataset.messageId)), ["done", "work", "child-reply", "observation"]);
                    assert.equal(await row("done").locator("article > details > p > strong").textContent(), "reply");
                    assert.match(await glyph(row("done")), /🐹/u);
                    await assert.rejects(present([call("duplicate", "WAIT", {}), result("duplicate", { status: 200 }), { ...result("duplicate", { status: 200 }), id: "other-result" }]), /Operation has duplicate immediate receipts\./u);
                    assert.equal(await row("done").count(), 1, "a rejected snapshot leaves the last valid projection intact");
                    assert.equal(await row("child-reply").locator("article > details > p").innerText(), '{"answer":"Delivered reply"}', "JSON-looking delivered speech remains content");
                    assert.equal(await field(row("observation"), "path").textContent(), "(ops://helper/1)");
                    assert.equal(await field(row("observation"), "aside").count(), 0, "later observations do not borrow the invocation's aside");
                    assert.equal(await field(row("observation"), "count").textContent(), "{2}");
                    const hostile = '</header><script>window.summaryExecuted=true</script><img src="/unasked">&copy;';
                    await present([call("hostile", "READ", { ...selection(hostile, [1, 2], hostile), aside: hostile })]);
                    assert.equal(await field(row("hostile"), "aside").textContent(), hostile);
                    assert.equal(await field(row("hostile"), "path").textContent(), `(${hostile})`);
                    assert.equal(await field(row("hostile"), "pattern").textContent(), hostile);
                    assert.equal(await row("hostile").locator("script, img, form, a").count(), 0);
                    assert.equal(await page.evaluate(() => window.summaryExecuted), undefined);
                    assert.deepEqual(requests, []);
                    const speech = { id: "speech", role: "assistant", content: "Unchanged body.", _meta: { plurnk: { op: "SEND", aside: "Earlier aside" } } };
                    await present([speech]);
                    await row("speech").locator("article > details > p").evaluate((element) => { window.speechBody = element; });
                    await present([{ ...speech, _meta: {} }]);
                    assert.equal(await row("speech").locator("header, [data-plurnk-operands]").count(), 0, "changed metadata cannot retain a stale summary");
                    assert.equal(await row("speech").locator("article > details > p").evaluate((element) => element === window.speechBody), true);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}
