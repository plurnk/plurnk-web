import assert from "node:assert/strict";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics from "./browser-diagnostics.js";

const gate = (id, op = "sh") => ({
    id, method: "session/request_permission",
    options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
    ],
    _meta: { plurnk: { proposal: {
        logEntryId: 1, sessionId: 2, session: "child", loopId: 3, turnId: 4, coordinate: "3/4/1", op,
        target: { scheme: "file", authority: null, pathname: "evidence.txt" },
        body: "Exact operation body\n", attrs: { pattern: "literal pattern", nested: { name: "evidence" } },
        owner: "acp://operator/sessions/parent", disposition: { decision: "review" }, expiresAt: "2030-01-01T00:00:00Z",
    } } },
});

export default async function verifyApproval(t) {
    const fixture = await conversationFixture(new URL("./approval-entry.js", import.meta.url));
    try {
        for (const engine of engines) {
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
                    const gates = [gate("id[0]#one"), gate("quote\"<two>", "EDIT")];
                    gates[1]._meta.plurnk.proposal.body = '<form action="/auth/logout"><button data-text="proposal-session">Injected</button></form>\n' + "x".repeat(400);
                    assert.equal(await page.evaluate((values) => window.review(values), gates), true);
                    const groups = form.locator("[data-requests] > fieldset");
                    assert.equal(await groups.count(), 2);
                    assert.deepEqual(await groups.evaluateAll((nodes) => nodes.map((node) => node.dataset.interruptId)), gates.map(({ id }) => id));
                    assert.equal(await groups.nth(1).getAttribute("data-proposal-body"), null, "the operation body is content, not attribute state");
                    assert.equal(await groups.nth(1).locator('[data-proposal-body]').textContent(), gates[1]._meta.plurnk.proposal.body);
                    assert.equal(await groups.nth(1).locator("details").count(), 0);
                    assert.equal(await form.locator("form, script, [data-proposal-body] button").count(), 0);
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
                        { id: gates[0].id, method: "session/request_permission", response: { outcome: { outcome: "selected", optionId: "allow_once" } } },
                        { id: gates[1].id, method: "session/request_permission", response: { outcome: { outcome: "selected", optionId: "reject_once" } } },
                    ]]);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                    assert.equal(await page.evaluate((values) => window.review(values), gates), true);
                    assert.equal(await form.locator("input:checked").count(), 0, "a fresh presentation has no inherited choices");
                    assert.equal(await page.evaluate((values) => window.review(values), [...gates, { id: "question", message: "Unsupported interaction" }]), false);
                    assert.equal(await form.isVisible(), false, "a mixed set cannot partially resolve its supported members");
                    assert.equal(await groups.count(), 0);
                    assert.equal(await page.evaluate(() => window.review([])), false);
                    assert.equal(await form.isVisible(), false);

                    // {§web-session-approval} A deadline is a native time; past it the page presents the set and answers nothing.
                    assert.equal(await page.evaluate((values) => window.review(values), gates), true);
                    assert.equal(await groups.nth(0).locator("[data-proposal-deadline-line]").isVisible(), false, "an untimed wait has no deadline");
                    const timed = { ...gate("timed"), expiresAt: "2030-01-01T00:00:00.000Z" };
                    assert.equal(await page.evaluate((values) => window.review(values), [timed]), true);
                    assert.equal(await groups.locator("time").getAttribute("datetime"), timed.expiresAt);
                    assert.equal(await groups.locator("[data-proposal-deadline-line]").isVisible(), true);
                    assert.equal(await form.locator("[data-deadline-notice]").isVisible(), false);
                    const late = { ...gate("late"), expiresAt: "2020-01-01T00:00:00.000Z" };
                    assert.equal(await page.evaluate((values) => window.review(values), [late]), true);
                    assert.equal(await form.locator("[data-deadline-notice]").isVisible(), true);
                    assert.equal(await groups.getByRole("radio", { name: "Accept", exact: true }).isDisabled(), true, "an expired request cannot be answered");
                    const answered = await page.evaluate(() => window.responses.length);
                    await form.evaluate((element) => element.requestSubmit());
                    assert.equal(await page.evaluate(() => window.responses.length), answered, "nothing answers an expired request");

                    await page.goto(`${fixture.url}?yolo=1`);
                    await page.waitForFunction(() => typeof window.review === "function");
                    await page.evaluate((values) => window.review(values), gates);
                    assert.deepEqual(await page.evaluate(() => window.responses), [gates.map(({ id }) => ({
                        id, method: "session/request_permission",
                        response: {
                            outcome: { outcome: "selected", optionId: "allow_once" },
                            _meta: { plurnk: { outcome: "client_yolo" } },
                        },
                    }))]);
                    assert.equal(await form.isVisible(), false, "automatic approval does not display manual controls");
                    const question = { id: "question", method: "elicitation/create", mode: "form", requestedSchema: {
                        type: "object", properties: { answer: { type: "string", minLength: 1 } }, required: ["answer"],
                    } };
                    const mixed = [...gates, question];
                    await page.evaluate((mixed) => window.review(mixed), mixed);
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
                        ...gates.map(({ id }) => ({
                            id, method: "session/request_permission",
                            response: {
                                outcome: { outcome: "selected", optionId: "allow_once" },
                                _meta: { plurnk: { outcome: "client_yolo" } },
                            },
                        })),
                        { id: "question", method: "elicitation/create", response: { action: "accept", content: { answer: "operator answer" } } },
                    ]);
                    assert.equal(await page.evaluate((values) => window.review(values), [...gates, { id: "unknown" }]), false);
                    assert.equal(await page.evaluate(() => window.responses.length), 2, "unsupported sets are not partially auto-approved");
                    assert.equal(await page.evaluate((values) => window.review(values), [{ ...gate("late"), expiresAt: "2020-01-01T00:00:00.000Z" }]), true);
                    assert.equal(await page.evaluate(() => window.responses.length), 2, "automatic approval never answers an expired request");
                    assert.equal(await form.locator("[data-deadline-notice]").isVisible(), true, "it is presented with its passed deadline");
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await fixture.server.close(); }
}
