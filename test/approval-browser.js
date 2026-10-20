import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics from "./browser-diagnostics.js";

const interrupt = (id, op = "sh") => ({
    id, reason: "tool_call", message: "Review the requested action.",
    metadata: { plurnk: { proposal: {
        logEntryId: 1, workerId: 2, worker: "child", loopId: 3, turnId: 4, coordinate: "3/4/1", op,
        target: { scheme: "file", authority: null, pathname: "evidence.txt" },
        body: "Exact operation body\n", attrs: { pattern: "literal pattern", nested: { name: "evidence" } },
        owner: "agui://operator/threads/parent", disposition: { decision: "review" }, expiresAt: "2030-01-01T00:00:00Z",
    } } },
});

export default async function verifyApproval(t) {
    const fixture = await conversationFixture(new URL("./approval-entry.js", import.meta.url));
    try {
        for (const engine of [chromium, firefox, webkit]) {
            await t.test(engine.name(), async () => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 700 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    await page.goto(fixture.url);
                    await page.waitForFunction(() => typeof window.review === "function");
                    const form = page.getByRole("form", { name: "Review requests", exact: true });
                    assert.equal(await form.isVisible(), false);
                    const gates = [interrupt("id[0]#one"), interrupt("quote\"<two>", "EDIT")];
                    gates[1].metadata.plurnk.proposal.body = '<form action="/auth/logout"><button data-text="proposal-worker">Injected</button></form>\n' + "x".repeat(400);
                    assert.equal(await page.evaluate((values) => window.review(values), gates), true);
                    const groups = form.locator("[data-requests] > fieldset");
                    assert.equal(await groups.count(), 2);
                    assert.deepEqual(await groups.evaluateAll((nodes) => nodes.map((node) => node.dataset.interruptId)), gates.map(({ id }) => id));
                    assert.equal(await groups.nth(1).locator('[data-text="proposal-body"]').textContent(), gates[1].metadata.plurnk.proposal.body);
                    assert.deepEqual(JSON.parse(await groups.nth(1).locator('[data-text="proposal-details"]').textContent()), gates[1].metadata.plurnk.proposal);
                    assert.equal(await form.locator("form, script, [data-text='proposal-body'] button").count(), 0);
                    assert.equal(await form.locator("input:checked").count(), 0);
                    await groups.nth(0).getByRole("radio", { name: "Accept", exact: true }).check();
                    await groups.nth(1).getByRole("radio", { name: "Reject", exact: true }).check();
                    assert.equal(await groups.nth(1).getByRole("radio", { name: "Reject", exact: true }).isChecked(), true);
                    assert.equal(await page.evaluate((values) => window.review(values), gates), true);
                    await groups.nth(0).getByRole("radio", { name: "Accept", exact: true }).check();
                    await form.getByRole("button", { name: "Submit responses", exact: true }).click();
                    assert.deepEqual(await page.evaluate(() => window.responses), [], "native form validation protects complete-set submission");
                    assert.equal(await groups.nth(1).getByRole("radio", { name: "Accept", exact: true }).evaluate((input) => input === document.activeElement), true);
                    // Native validation focuses the unanswered group; the native radio keyboard behavior answers it.
                    await page.keyboard.press("ArrowDown");
                    assert.equal(await groups.nth(1).getByRole("radio", { name: "Reject", exact: true }).isChecked(), true);
                    await form.getByRole("button", { name: "Submit responses", exact: true }).click();
                    assert.deepEqual(await page.evaluate(() => window.responses), [[
                        { interruptId: gates[0].id, status: "resolved", payload: { decision: "accept" } },
                        { interruptId: gates[1].id, status: "resolved", payload: { decision: "reject" } },
                    ]]);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                    assert.equal(await page.evaluate((values) => window.review(values), gates), true);
                    assert.equal(await form.locator("input:checked").count(), 0, "a fresh presentation has no inherited choices");
                    assert.equal(await page.evaluate((values) => window.review(values), [...gates, { id: "question", message: "Unsupported interaction" }]), false);
                    assert.equal(await form.isVisible(), false, "a mixed set cannot partially resolve its supported members");
                    assert.equal(await groups.count(), 0);
                    assert.equal(await page.evaluate(() => window.review([])), false);
                    assert.equal(await form.isVisible(), false);

                    await page.goto(`${fixture.url}?yolo=1`);
                    await page.waitForFunction(() => typeof window.review === "function");
                    await page.evaluate((values) => window.review(values), gates);
                    assert.deepEqual(await page.evaluate(() => window.responses), [gates.map(({ id }) => ({
                        interruptId: id, status: "resolved", payload: { decision: "accept", outcome: "client_yolo" },
                    }))]);
                    assert.equal(await form.isVisible(), false, "automatic approval does not display manual controls");
                    const question = { id: "question", reason: "tool_call", toolCallId: "question-call", responseSchema: {
                        type: "object", properties: { answer: { type: "string", minLength: 1 } }, required: ["answer"],
                    } };
                    const mixed = [...gates, question];
                    const messages = [{ id: "question-message", role: "assistant", toolCalls: [{
                        id: "question-call", type: "function", function: { name: "question", arguments: "{}" },
                    }] }];
                    await page.evaluate(({ mixed, messages }) => window.review(mixed, messages), { mixed, messages });
                    assert.equal(await form.isVisible(), true);
                    assert.equal(await groups.count(), 1, "only the question needs a manual answer in YOLO mode");
                    assert.equal(await page.evaluate(() => window.responses.length), 1, "YOLO cannot answer questions or submit partial sets");
                    await form.getByRole("textbox", { name: "answer", exact: true }).fill("operator answer");
                    await page.evaluate(() => { window.answerNode = document.querySelector("[data-requests] textarea"); });
                    assert.equal(await page.evaluate(() => window.automatic(false)), "manual");
                    assert.deepEqual(await groups.evaluateAll((nodes) => nodes.map((node) => node.dataset.interruptId)), mixed.map(({ id }) => id));
                    assert.equal(await form.getByRole("textbox", { name: "answer", exact: true }).inputValue(), "operator answer");
                    assert.equal(await page.evaluate(() => window.answerNode === document.querySelector("[data-requests] textarea")), true);
                    assert.equal(await form.locator('input[type="radio"]:checked').count(), 0);
                    assert.equal(await page.evaluate(() => window.automatic(true)), "manual");
                    assert.equal(await groups.count(), 1);
                    assert.equal(await form.getByRole("textbox", { name: "answer", exact: true }).inputValue(), "operator answer");
                    assert.equal(await page.evaluate(() => window.responses.length), 1, "changing approval policy never answers the question");
                    await form.getByRole("button", { name: "Submit responses", exact: true }).click();
                    await page.waitForFunction(() => window.responses.length === 2);
                    assert.deepEqual(await page.evaluate(() => window.responses[1]), [
                        ...gates.map(({ id }) => ({ interruptId: id, status: "resolved", payload: { decision: "accept", outcome: "client_yolo" } })),
                        { interruptId: "question", status: "resolved", payload: { answer: "operator answer" } },
                    ]);
                    assert.equal(await page.evaluate((values) => window.review(values), [...gates, { id: "unknown" }]), false);
                    assert.equal(await page.evaluate(() => window.responses.length), 2, "unsupported sets are not partially auto-approved");
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await fixture.server.close(); }
}
