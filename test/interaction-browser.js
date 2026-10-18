import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics from "./browser-diagnostics.js";

const request = (schema, name = "question") => ({
    interrupts: [{ id: "opaque#question", reason: "tool_call", toolCallId: "int:1", message: "Choose the exact answer.", responseSchema: schema }],
    messages: [{ id: "call", role: "assistant", toolCalls: [{ id: "int:1", type: "function", function: { name, arguments: JSON.stringify({ message: "Choose the exact answer.", requestedSchema: schema }) } }] }],
});

export default async function verifyInteractions(t) {
    const fixture = await conversationFixture(new URL("./interaction-entry.js", import.meta.url));
    try {
        for (const engine of [chromium, firefox, webkit]) {
            await t.test(engine.name(), async () => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 800 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    await page.goto(fixture.url);
                    await page.waitForFunction(() => typeof window.review === "function");
                    const schema = { type: "object", properties: {
                        text: { type: "string", title: "Exact text" },
                        count: { type: "integer", minimum: 0 },
                        enabled: { type: "boolean" },
                        choice: { type: "string", enum: ["", "other"], enumNames: ["Empty value", "Free response"] },
                        optional: { type: "string" },
                    }, required: ["text", "count", "enabled", "choice"], additionalProperties: false };
                    assert.equal(await page.evaluate(({ interrupts, messages }) => window.review(interrupts, messages), request(schema)), true,
                        "a schema-shaped question is a supported SDK interrupt");
                    const form = page.getByRole("form", { name: "Review requests", exact: true });
                    await form.getByRole("textbox", { name: "Exact text", exact: true }).fill("  keep this\nverbatim  ");
                    await form.getByRole("spinbutton", { name: "count", exact: true }).fill("0");
                    await form.getByRole("combobox", { name: "enabled", exact: true }).selectOption("false");
                    await form.getByRole("combobox", { name: "choice", exact: true }).selectOption({ label: "Empty value" });
                    await form.getByRole("button", { name: "Submit responses", exact: true }).click();
                    await page.waitForFunction(() => window.responses.length === 1);
                    assert.deepEqual(await page.evaluate(() => window.responses[0]), [{ interruptId: "opaque#question", status: "resolved", payload: {
                        text: "  keep this\nverbatim  ", count: 0, enabled: false, choice: "",
                    } }]);

                    assert.equal(await page.evaluate(({ interrupts, messages }) => window.review(interrupts, messages), request(schema)), true);
                    await form.getByRole("checkbox", { name: "Cancel this request", exact: true }).check();
                    await form.getByRole("button", { name: "Submit responses", exact: true }).click();
                    await page.waitForFunction(() => window.responses.length === 2);
                    assert.deepEqual(await page.evaluate(() => window.responses[1]), [{ interruptId: "opaque#question", status: "cancelled" }]);

                    const complex = { type: "object", properties: { response: { oneOf: [
                        { type: "object", properties: { action: { const: "accept" }, content: schema }, required: ["action", "content"] },
                        { type: "object", properties: { action: { enum: ["decline", "cancel"] } }, required: ["action"] },
                    ] } }, required: ["response"] };
                    assert.equal(await page.evaluate(({ interrupts, messages }) => window.review(interrupts, messages), request(complex, "mcp_input_required")), true);
                    const json = form.getByRole("textbox", { name: "Answer (JSON)", exact: true });
                    await json.fill("{");
                    await form.getByRole("button", { name: "Submit responses", exact: true }).click();
                    await form.getByText("Enter valid JSON.", { exact: true }).waitFor();
                    assert.equal(await json.inputValue(), "{");
                    await json.fill('{"response":{"action":"unknown"}}');
                    await form.getByRole("button", { name: "Submit responses", exact: true }).click();
                    await form.getByRole("alert").filter({ hasText: /does not satisfy/u }).waitFor();
                    assert.equal((await page.evaluate(() => window.responses)).length, 2, "invalid schema values never resume work");
                    const exact = { response: { action: "decline" } };
                    await json.fill(JSON.stringify(exact));
                    await form.getByRole("button", { name: "Submit responses", exact: true }).click();
                    await page.waitForFunction(() => window.responses.length === 3);
                    assert.deepEqual(await page.evaluate(() => window.responses[2]), [{ interruptId: "opaque#question", status: "resolved", payload: exact }]);

                    const defaults = { type: "object", properties: {
                        action: { type: "string", default: "" },
                        content: { type: "boolean", default: false },
                        count: { type: "integer", default: 0 },
                        omitted: { type: "string", default: "remove me" },
                    }, additionalProperties: false };
                    await page.evaluate(({ interrupts, messages }) => window.review(interrupts, messages), request(defaults));
                    const optional = form.locator('[data-field-name="omitted"]');
                    await optional.getByRole("checkbox", { name: "Include this answer", exact: true }).uncheck();
                    assert.equal(await optional.getByRole("textbox").isDisabled(), true);
                    await form.getByRole("button", { name: "Submit responses", exact: true }).click();
                    await page.waitForFunction(() => window.responses.length === 4);
                    assert.deepEqual(await page.evaluate(() => window.responses[3]), [{ interruptId: "opaque#question", status: "resolved", payload: {
                        action: "", content: false, count: 0,
                    } }], "defaults retain their types; action/content are answer keys, not a wrapper");

                    const injected = '<script>window.schemaExecuted=true</script><form action="/auth/logout">';
                    const unsafe = request({ $ref: "https://schema.invalid/not-fetched.json", description: injected });
                    unsafe.interrupts[0].message = injected;
                    unsafe.messages[0].toolCalls[0].function.arguments = injected;
                    const external = [];
                    page.on("request", (network) => { if (new URL(network.url()).hostname === "schema.invalid") external.push(network.url()); });
                    await page.evaluate(({ interrupts, messages }) => window.review(interrupts, messages), unsafe);
                    assert.equal(await form.locator('[data-text="request-message"]').textContent(), injected);
                    assert.equal(await form.locator('[data-text="request-arguments"]').textContent(), injected);
                    assert.equal(await form.locator("script, form").count(), 0);
                    await json.fill("{}");
                    await form.getByRole("button", { name: "Submit responses", exact: true }).click();
                    await form.getByRole("alert").filter({ hasText: /Answer validation failed/u }).waitFor();
                    assert.deepEqual(external, []);
                    assert.equal(await page.evaluate(() => window.schemaExecuted), undefined);
                    assert.equal(await json.inputValue(), "{}");
                    await form.getByRole("checkbox", { name: "Cancel this request", exact: true }).check();
                    await form.getByRole("button", { name: "Submit responses", exact: true }).click();
                    await page.waitForFunction(() => window.responses.length === 5);
                    assert.deepEqual(await page.evaluate(() => window.responses[4]), [{ interruptId: "opaque#question", status: "cancelled" }]);

                    const mixed = request({ type: "object", properties: { answer: { type: "string", minLength: 1 } }, required: ["answer"] });
                    mixed.interrupts.push({ id: "proposal", reason: "tool_call", metadata: { plurnk: { proposal: {
                        logEntryId: 1, workerId: 2, worker: "user", loopId: 3, turnId: 4, coordinate: "3/4/1", op: "sh",
                        target: { scheme: "exec", authority: null, pathname: "sh" }, body: "printf reviewed", attrs: {},
                        owner: "agui://operator/threads/user", disposition: { decision: "review" }, expiresAt: "2030-01-01T00:00:00Z",
                    } } } });
                    assert.equal(await page.evaluate(({ interrupts, messages }) => window.review(interrupts, messages), mixed), true);
                    await form.getByRole("radio", { name: "Reject", exact: true }).check();
                    await form.getByRole("button", { name: "Submit responses", exact: true }).click();
                    await form.getByRole("alert").filter({ hasText: /does not satisfy/u }).waitFor();
                    assert.equal(await page.evaluate(() => window.responses.length), 5, "a bad answer cannot partially submit a mixed set");
                    await form.getByRole("textbox", { name: "answer", exact: true }).fill("ready");
                    await form.getByRole("button", { name: "Submit responses", exact: true }).click();
                    await page.waitForFunction(() => window.responses.length === 6);
                    assert.deepEqual(await page.evaluate(() => window.responses[5]), [
                        { interruptId: "opaque#question", status: "resolved", payload: { answer: "ready" } },
                        { interruptId: "proposal", status: "resolved", payload: { decision: "reject" } },
                    ]);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                    assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]), [[], []]);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await fixture.server.close(); }
}
