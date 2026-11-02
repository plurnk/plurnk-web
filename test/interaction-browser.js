import assert from "node:assert/strict";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics from "./browser-diagnostics.js";

const request = (schema, name = "question") => ({
    /** @type {any[]} */
    gates: [{
        id: "opaque#question",
        method: "elicitation/create",
        mode: "form",
        message: "Choose the exact answer.",
        requestedSchema: schema,
        /** @type {Record<string, any> | undefined} */
        _meta: name !== "question" ? { plurnk: { toolName: name } } : undefined,
    }],
});

export default async function verifyInteractions(t) {
    const fixture = await conversationFixture(new URL("./interaction-entry.js", import.meta.url));
    try {
        for (const engine of engines) {
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
                    const attributed = request(schema);
                    attributed.gates[0]._meta = { plurnk: { interaction: {
                        interactionId: 1, sessionId: 23, loopId: 7, turnId: 9, recipient: "acp://owner",
                        request: { toolName: "question", arguments: {}, requestedSchema: schema },
                    } } };
                    assert.equal(await page.evaluate(({ gates }) => window.review(gates), attributed), true,
                        "a schema-shaped question is a supported SDK gate");
                    const form = page.getByRole("form", { name: "Review requests", exact: true });
                    assert.equal(await form.locator("[data-request-origin]").isVisible(), true);
                    assert.equal(await form.locator('[data-text="request-session"]').textContent(), "23");
                    await form.getByRole("textbox", { name: "Exact text", exact: true }).fill("  keep this\nverbatim  ");
                    await form.getByRole("spinbutton", { name: "count", exact: true }).fill("0");
                    await form.getByRole("combobox", { name: "enabled", exact: true }).selectOption("false");
                    await form.getByRole("combobox", { name: "choice", exact: true }).selectOption({ label: "Empty value" });
                    await form.getByRole("button", { name: "Submit responses", exact: true }).click();
                    await page.waitForFunction(() => window.responses.length === 1);
                    assert.deepEqual(await page.evaluate(() => window.responses[0]), [{
                        id: "opaque#question", method: "elicitation/create",
                        response: {
                            action: "accept",
                            content: { text: "  keep this\nverbatim  ", count: 0, enabled: false, choice: "" },
                        },
                    }]);

                    assert.equal(await page.evaluate(({ gates }) => window.review(gates), request(schema)), true);
                    assert.equal(await form.locator("[data-request-origin]").isVisible(), false, "generic questions need no Plurnk metadata");
                    await form.getByRole("checkbox", { name: "Cancel this request", exact: true }).check();
                    await form.getByRole("button", { name: "Submit responses", exact: true }).click();
                    await page.waitForFunction(() => window.responses.length === 2);
                    assert.deepEqual(await page.evaluate(() => window.responses[1]), [{
                        id: "opaque#question", method: "elicitation/create", response: { action: "cancel" },
                    }]);

                    const complex = { type: "object", properties: { response: { oneOf: [
                        { type: "object", properties: { action: { const: "accept" }, content: schema }, required: ["action", "content"] },
                        { type: "object", properties: { action: { enum: ["decline", "cancel"] } }, required: ["action"] },
                    ] } }, required: ["response"] };
                    assert.equal(await page.evaluate(({ gates }) => window.review(gates), request(complex, "mcp_input_required")), true);
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
                    assert.deepEqual(await page.evaluate(() => window.responses[2]), [{
                        id: "opaque#question", method: "elicitation/create", response: { action: "decline" },
                    }]);

                    const defaults = { type: "object", properties: {
                        action: { type: "string", default: "" },
                        content: { type: "boolean", default: false },
                        count: { type: "integer", default: 0 },
                        omitted: { type: "string", default: "remove me" },
                    }, additionalProperties: false };
                    await page.evaluate(({ gates }) => window.review(gates), request(defaults));
                    const optional = form.locator('[data-field-name="omitted"]');
                    await optional.getByRole("checkbox", { name: "Include this answer", exact: true }).uncheck();
                    assert.equal(await optional.getByRole("textbox").isDisabled(), true);
                    await form.getByRole("button", { name: "Submit responses", exact: true }).click();
                    await page.waitForFunction(() => window.responses.length === 4);
                    assert.deepEqual(await page.evaluate(() => window.responses[3]), [{
                        id: "opaque#question", method: "elicitation/create",
                        response: {
                            action: "accept",
                            content: { action: "", content: false, count: 0 },
                        },
                    }], "defaults retain their types; action/content are answer keys, not a wrapper");

                    const injected = '<script>window.schemaExecuted=true</script><form action="/auth/logout">';
                    const unsafe = request({ $ref: "https://schema.invalid/not-fetched.json", description: injected });
                    unsafe.gates[0].message = injected;
                    unsafe.gates[0]._meta = { plurnk: { arguments: injected, interaction: { sessionId: injected } } };
                    const external = [];
                    page.on("request", (network) => { if (new URL(network.url()).hostname === "schema.invalid") external.push(network.url()); });
                    await page.evaluate(({ gates }) => window.review(gates), unsafe);
                    assert.equal(await form.locator('[data-request-message]').textContent(), injected);
                    assert.equal(await form.locator('[data-request-arguments]').textContent(), injected);
                    assert.equal(await form.locator('fieldset[data-request-message], fieldset[data-request-arguments], fieldset[data-request-schema]').count(), 0,
                        "question content is not copied into fieldset state");
                    assert.equal(await form.locator('[data-text="request-session"]').textContent(), injected);
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
                    assert.deepEqual(await page.evaluate(() => window.responses[4]), [{
                        id: "opaque#question", method: "elicitation/create", response: { action: "cancel" },
                    }]);

                    const mixed = request({ type: "object", properties: { answer: { type: "string", minLength: 1 } }, required: ["answer"] });
                    mixed.gates.push({
                        id: "proposal",
                        method: "session/request_permission",
                        options: [
                            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
                            { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
                        ],
                        _meta: { plurnk: { proposal: {
                            logEntryId: 1, sessionId: 2, session: "user", loopId: 3, turnId: 4, coordinate: "3/4/1", op: "sh",
                            target: { scheme: "exec", authority: null, pathname: "sh" }, body: "printf reviewed", attrs: {},
                            owner: "acp://operator/sessions/user", disposition: { decision: "review" }, expiresAt: "2030-01-01T00:00:00Z",
                        } } },
                    });
                    assert.equal(await page.evaluate(({ gates }) => window.review(gates), mixed), true);
                    await form.getByRole("radio", { name: "Reject", exact: true }).check();
                    await form.getByRole("button", { name: "Submit responses", exact: true }).click();
                    await form.getByRole("alert").filter({ hasText: /does not satisfy/u }).waitFor();
                    assert.equal(await page.evaluate(() => window.responses.length), 5, "a bad answer cannot partially submit a mixed set");
                    await form.getByRole("textbox", { name: "answer", exact: true }).fill("ready");
                    await form.getByRole("button", { name: "Submit responses", exact: true }).click();
                    await page.waitForFunction(() => window.responses.length === 6);
                    assert.deepEqual(await page.evaluate(() => window.responses[5]), [
                        { id: "opaque#question", method: "elicitation/create", response: { action: "accept", content: { answer: "ready" } } },
                        { id: "proposal", method: "session/request_permission", response: { outcome: { outcome: "selected", optionId: "reject_once" } } },
                    ]);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                    assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]), [[], []]);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await fixture.server.close(); }
}
