import assert from "node:assert/strict";
import SessionAgent from "../web/session-agent.js";
import { networkFailure } from "./browser-diagnostics.js";
import { inspectResult, observeMessages } from "./result-body.js";
import { inputPage } from "./session-input.js";

const interrupted = (page) => page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "interrupted");
const connected = (page) => page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");

function requestsFrom(page) {
    const requests = [];
    page.on("request", (request) => {
        const body = request.postDataJSON();
        if (
            new URL(request.url()).pathname === "/acp"
            && body !== null
            && body.method !== "initialize"
            && body.params?._meta?.plurnk?.control !== false
        ) {
            requests.push(body);
        }
    });
    return requests;
}

async function requestApproval(page, name) {
    page.setDefaultTimeout(5000);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill(`Lifecycle fixture: ${name}.`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await interrupted(page);
}

// {§web-session-approval} The real native form is the only review UI in these installed journeys.
export default async function verifySessionApproval({ t, withDaemon: startDaemon }) {
    const manualPage = (verify, options = {}) =>
        inputPage(startDaemon, verify, { ...options, env: { PLURNK_WEB_YOLO: "0", ...options.env } });
    await t.test("{§web-session-approval} configured YOLO accepts review once without another user message", { timeout: 60_000 }, () => inputPage(startDaemon, async ({ page, model, checkBrowser }) => {
        page.setDefaultTimeout(5000);
        const requests = requestsFrom(page);
        const approval = page.getByRole("button", { name: "Automatic approval", exact: true });
        await page.getByRole("textbox", { name: "Message", exact: true }).focus();
        assert.equal(await approval.getAttribute("aria-pressed"), "true");
        assert.equal(await approval.isVisible(), true);
        assert.match(await approval.evaluate((element) => getComputedStyle(element, "::before").content), /🔥/u);
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: approval-automatic.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.getByText("Completed approval-automatic.", { exact: true }).waitFor();
        await connected(page);
        assert.equal(model.requests.length, 2);
        assert.equal(requests.length, 2, "one message and one decision, with no retry");
        assert.deepEqual(requests[1].result?.outcome, { outcome: "selected", optionId: "allow_once" });
        assert.equal(await page.locator('[data-message-role="user"]').count(), 1);
        assert.equal(await page.getByRole("form", { name: "Review requests", exact: true }).isVisible(), false);
        assert.ok(JSON.stringify(model.requests[1].messages).includes("approved"), "the executor actually ran");
        checkBrowser();
    }, { env: { PLURNK_WEB_YOLO: "1" } }));
    await t.test("{§web-session-approval} a session page reached from another site never approves automatically", { timeout: 60_000 }, () => inputPage(startDaemon, async ({ page, context, path, base, headers, model, checkBrowser }) => {
        page.setDefaultTimeout(5000);
        const sessionId = await page.locator("#session-status").getAttribute("data-session-id");
        await page.close();
        // The proposal waits with no page open on its session.
        const agent = new SessionAgent({ url: new URL("/acp", base).href, sessionId, headers });
        const controller = new AbortController();
        const running = agent.send({
            abortController: controller,
            message: { id: crypto.randomUUID(), role: "user", content: "Lifecycle fixture: approval-automatic." },
        }).catch(() => {});
        try {
            await running;
            await context.route("http://elsewhere.test/**", (route) => route.fulfill({ contentType: "text/html",
                body: `<!doctype html><title>Elsewhere</title><link rel="icon" href="data:,"><a href="${path}">Open the session</a>` }));
            const visitor = await context.newPage();
            visitor.setDefaultTimeout(5000);
            const sent = requestsFrom(visitor);
            await visitor.goto("http://elsewhere.test/");
            // Browsers send this navigation `Sec-Fetch-Site: cross-site`; Chromium's headless shell does not report it to Playwright.
            await visitor.getByRole("link", { name: "Open the session", exact: true }).click();
            await interrupted(visitor);
            assert.equal(await visitor.getByRole("button", { name: "Automatic approval", exact: true, includeHidden: true }).getAttribute("aria-pressed"), "false");
            assert.equal(await visitor.getByRole("form", { name: "Review requests", exact: true }).isVisible(), true, "the proposal waits for review");
            assert.equal(sent.filter((req) => req?.result?.outcome !== undefined).length, 0, "nothing was decided");
            // The person's own navigation keeps the configured preference.
            const own = await context.newPage();
            await own.goto(path);
            await own.getByText("Completed approval-automatic.", { exact: true }).waitFor();
            assert.equal(model.requests.length, 2);
        } finally {
            controller.abort();
            agent.close();
            await running;
        }
        checkBrowser();
    }, { env: { PLURNK_WEB_YOLO: "1" } }));
    await t.test("{§web-session-approval} a proposal's deadline shows, and the page follows the daemon cancelling it", { timeout: 60_000 }, () => manualPage(async ({ page, checkBrowser }) => {
        page.setDefaultTimeout(5000);
        const requests = requestsFrom(page);
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: approval-input.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await interrupted(page);
        const form = page.getByRole("form", { name: "Review requests", exact: true });
        assert.ok(Number.isFinite(Date.parse(await form.locator("time").getAttribute("datetime") ?? "")), "the deadline is shown");
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected", null, { timeout: 15_000 });
        assert.equal(await form.isVisible(), false, "the daemon's cancellation withdraws the review");
        assert.equal(requests.filter((req) => req?.result?.outcome !== undefined).length, 0, "the page answered nothing");
        checkBrowser();
    }, { env: { PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS: "3000" } }));
    await t.test("{§web-session-approval} configured YOLO cannot override daemon rejection", { timeout: 60_000 }, () => inputPage(startDaemon, async ({ page, model, checkBrowser }) => {
        page.setDefaultTimeout(5000);
        const requests = requestsFrom(page);
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: approval-server-reject.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.getByText("Completed approval-server-reject.", { exact: true }).waitFor();
        await connected(page);
        assert.equal(model.requests.length, 2);
        assert.equal(requests.length, 1, "daemon policy settles the operation without asking the client");
        const outcome = page.locator('[data-call-id][data-plurnk-type="sh"] [data-plurnk-field="outcome"]');
        assert.match(await outcome.textContent(), /The proposal was rejected \(policy_veto\)\./u);
        checkBrowser();
    }, { env: { PLURNK_SERVICE_PROPOSALS: "reject", PLURNK_WEB_YOLO: "1" } }));
    await t.test("{§web-session-approval} uncertain YOLO delivery stops without replaying its decision", { timeout: 60_000 }, () => inputPage(startDaemon, async ({ page, model, checkBrowser }) => {
        page.setDefaultTimeout(5000);
        const requests = requestsFrom(page);
        await page.route("**/acp", (route) => route.request().postDataJSON()?.result?.outcome ? route.abort() : route.continue());
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: approval-auto-failure.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "disconnected");
        assert.match(await page.locator('[data-text="command-error"]').textContent(), /Response could not be confirmed:/u);
        assert.equal(model.requests.length, 1);
        assert.equal(requests.length, 2, "a failed automatic decision is not retried");
        assert.equal(await page.getByRole("button", { name: "Reconnect", exact: true }).isVisible(), true);
        checkBrowser([
            networkFailure("/acp"),
        ]);
    }, { env: { PLURNK_WEB_YOLO: "1" } }));
    for (const decision of ["accept", "reject"]) {
        await t.test(`{§web-session-approval} explicit ${decision} resumes the exact proposal and preserves the operation's result`, { timeout: 60_000 }, () => manualPage(async ({ page, model, checkBrowser }) => {
            await page.setViewportSize({ width: 320, height: 700 });
            const requests = requestsFrom(page);
            const name = `approval-${decision}`;
            await requestApproval(page, name);
            const review = page.getByRole("form", { name: "Review requests", exact: true });
            assert.equal(await review.count(), 1);
            assert.equal(await review.locator("[data-requests] > fieldset").count(), 1);
            assert.equal(await review.locator('[data-text="proposal-session"]').innerText(), "user");
            assert.equal(await review.locator('[data-text="proposal-op"]').innerText(), "sh");
            const targetText = await review.locator("[data-proposal-target]").textContent();
            assert.ok(targetText && !targetText.includes('"scheme"'), "command proposal shows readable target instead of raw URI object JSON");
            assert.equal(await review.locator("[data-proposal-diff]").isVisible(), false, "command proposal hides unified diff container");
            assert.equal(await review.locator('[data-proposal-body]').textContent(), "[sh] printf approved");
            assert.equal(await review.locator('[data-text="proposal-details"]').count(), 0, "review facts are not duplicated in an envelope dump");
            assert.equal(await review.locator("input:checked").count(), 0, "permission has no preselected answer");
            await review.getByRole("button", { name: "Submit responses", exact: true }).click();
            assert.equal(requests.length, 1, "native required controls prevent an unanswered review");
            assert.equal(model.requests.length, 1);
            const reasoning = page.locator('[data-message-role="reasoning"]').first();
            await page.locator("[data-operations] > details > summary").first().click();
            await reasoning.locator("summary").click();
            await reasoning.locator("[data-body-reference]").scrollIntoViewIfNeeded();
            await reasoning.locator('[data-body-state="loaded"]').waitFor();
            assert.equal(await reasoning.locator('[data-body-reference]').textContent(), `Considering ${name}.`,
                "{§web-session-reasoning} authenticated inspection uses the real protected reasoning resource");
            await page.getByRole("textbox", { name: "Message", exact: true }).fill("Keep this newer draft.");
            await review.getByRole("radio", { name: decision, exact: false }).check();
            await review.getByRole("button", { name: "Submit responses", exact: true }).click();
            await page.getByText(`Completed ${name}.`, { exact: true }).waitFor();
            await connected(page);
            assert.equal(model.requests.length, 2);
            assert.equal(requests.length, 2);
            const resume = requests[1];
            const expectedOptionId = decision === "accept" ? "allow_once" : "reject_once";
            assert.deepEqual(resume.result?.outcome, { outcome: "selected", optionId: expectedOptionId });
            assert.equal(JSON.stringify(resume).includes(`Considering ${name}.`), false,
                "explicitly inspected reasoning never enters the approval response");
            assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "Keep this newer draft.");
            assert.equal(await page.locator('[data-message-role="user"]').count(), 1, "review is not another user message");
            const call = page.locator('[data-call-id][data-plurnk-type="sh"]');
            assert.equal(await call.count(), 1);
            const userReceipts = JSON.stringify(model.requests[1].messages.filter(({ role }) => role === "user"));
            if (decision === "accept") {
                assert.ok(userReceipts.includes("approved"), "accepted work produces its exact output");
            } else {
                assert.match(await call.locator('[data-plurnk-field="outcome"]').textContent(), /The proposal was rejected \([^)]+\)\./u);
                assert.equal(userReceipts.includes("approved"), false, "rejection never runs the command");
            }
            assert.equal(await review.isVisible(), false);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]), [[], []]);
            const ids = await page.locator("[data-messages] [data-message-id]").evaluateAll((rows) => rows.map((row) => row.dataset.messageId));
            await page.reload();
            await page.getByText(`Completed ${name}.`, { exact: true }).waitFor();
            assert.deepEqual(await page.locator("[data-messages] [data-message-id]").evaluateAll((rows) => rows.map((row) => row.dataset.messageId)), ids);
            assert.equal(model.requests.length, 2);
            checkBrowser();
        }, { authenticated: true }));
    }

    await t.test("{§web-session-approval} shared views withdraw settled approval forms and follow work without manual reconnection", { timeout: 60_000 }, () => manualPage(async ({ page, context, path, model, checkBrowser }) => {
        page.setDefaultTimeout(5000);
        const requests = requestsFrom(page);
        await requestApproval(page, "approval-tabs");
        const other = await context.newPage();
        other.setDefaultTimeout(5000);
        const otherRequests = requestsFrom(other);
        await other.goto(path);
        await interrupted(other);
        const before = await page.locator('[data-requests] > fieldset').getAttribute("data-interrupt-id");
        await page.getByRole("radio", { name: "Reject", exact: true }).check();
        await page.reload();
        await interrupted(page);
        assert.notEqual(await page.locator('[data-requests] > fieldset').getAttribute("data-interrupt-id"), before);
        assert.equal(await page.locator('[data-requests] input:checked').count(), 0, "refresh does not replay an unsubmitted choice");
        assert.equal(model.requests.length, 1);
        await page.getByRole("radio", { name: "Accept", exact: true }).check();
        await page.getByRole("button", { name: "Submit responses", exact: true }).click();
        await page.getByText("Completed approval-tabs.", { exact: true }).waitFor();
        await other.getByText("Completed approval-tabs.", { exact: true }).waitFor();
        await connected(other);
        assert.equal(await other.getByRole("form", { name: "Review requests", exact: true }).isVisible(), false);
        assert.equal(await other.locator('[aria-label="Message feedback"] [role="alert"]').isVisible(), false);
        assert.equal(requests.length, 2);
        assert.equal(model.requests.length, 2, "external settlement does not repeat execution or inference");
        assert.equal(otherRequests.some((req) => req?.result?.outcome !== undefined), false, "the second view observes the decision; it does not answer again");
        checkBrowser();
    }, { authenticated: true }));

    await t.test("{§web-session-approval} held review retains unsent choices and live elapsed time without repeated presentations", { timeout: 60_000 }, () => manualPage(async ({ page, model, checkBrowser }) => {
        const resumes = [];
        page.on("request", (request) => {
            if (new URL(request.url()).pathname !== "/acp") return;
            const input = request.postDataJSON();
            if (input?.method === "session/resume") resumes.push(input);
        });
        await requestApproval(page, "approval-held");
        const id = await page.locator('[data-requests] > fieldset').getAttribute("data-interrupt-id");
        await page.getByRole("radio", { name: "Reject", exact: true }).check();
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("Keep this draft while deciding.");
        const elapsed = await page.locator('[data-text="elapsed"]').textContent();
        await page.waitForFunction((before) => document.querySelector('[data-text="elapsed"]')?.textContent !== before, elapsed);
        assert.equal(await page.locator("#session-status").getAttribute("data-connection"), "interrupted");
        assert.equal(await page.locator('[data-requests] > fieldset').getAttribute("data-interrupt-id"), id);
        assert.equal(await page.getByRole("radio", { name: "Reject", exact: true }).isChecked(), true);
        assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "Keep this draft while deciding.");
        assert.equal(resumes.length, 0, "held connection does not loop on session/resume");
        assert.equal(model.requests.length, 1, "waiting does not answer or run another inference");
        await page.getByRole("button", { name: "Submit responses", exact: true }).click();
        await page.getByText("Completed approval-held.", { exact: true }).waitFor();
        await connected(page);
        assert.equal(model.requests.length, 2);
        checkBrowser();
    }));

    await t.test("{§web-session-approval} an answer overtaken in transit remains refused while the browser follows settled work", { timeout: 60_000 }, () => manualPage(async ({ page, context, path, model, checkBrowser }) => {
        await requestApproval(page, "approval-late");
        const other = await context.newPage();
        other.setDefaultTimeout(5000);
        await other.goto(path);
        await interrupted(other);
        const requests = requestsFrom(other);
        const sent = Promise.withResolvers();
        await other.route("**/acp", (route) => { sent.resolve(route); }, { times: 1 });
        await other.getByRole("radio", { name: "Reject", exact: true }).check();
        await other.getByRole("button", { name: "Submit responses", exact: true }).click();
        const delayed = await sent.promise;
        await page.getByRole("radio", { name: "Accept", exact: true }).check();
        await page.getByRole("button", { name: "Submit responses", exact: true }).click();
        await page.getByText("Completed approval-late.", { exact: true }).waitFor();
        await delayed.continue();
        await other.getByText("Completed approval-late.", { exact: true }).waitFor();
        await connected(other);
        assert.match(await other.locator('[data-text="command-error"]').textContent(), /^Response not accepted: /u);
        assert.equal(await other.getByRole("form", { name: "Review requests", exact: true }).isVisible(), false);
        assert.equal(requests.length, 1, "a refused decision is never retried");
        assert.equal(requests[0].result?.outcome?.optionId, "reject_once", "the refused answer differs from the accepted answer");
        assert.equal(model.requests.length, 2, "only the accepted decision continues the model");
        assert.ok(JSON.stringify(model.requests[1].messages).includes("approved"));
        checkBrowser();
    }, { authenticated: true }));

    await t.test("{§web-session-approval} serial operations present fresh gates without inheriting a prior decision", { timeout: 60_000 }, () => manualPage(async ({ page, base, headers, model, checkBrowser }) => {
        const requests = requestsFrom(page);
        await requestApproval(page, "approval-batch");
        const groups = page.locator('[data-requests] > fieldset');
        assert.equal(await groups.count(), 1, "dispatch waits for the first proposal before reaching the next operation");
        assert.equal(await groups.locator('[data-proposal-body]').textContent(), "[sh] printf first");
        const first = await groups.getAttribute("data-interrupt-id");
        await page.getByRole("button", { name: "Submit responses", exact: true }).click();
        assert.equal(requests.length, 1, "an unanswered proposal cannot resume");
        await groups.getByRole("radio", { name: "Accept", exact: true }).check();
        await page.getByRole("button", { name: "Submit responses", exact: true }).click();
        await page.waitForFunction((id) => {
            const group = document.querySelector("[data-requests] > fieldset");
            return document.querySelector("#session-status")?.dataset.connection === "interrupted"
                && group && group.dataset.interruptId !== id;
        }, first);
        assert.equal(await groups.count(), 1);
        assert.equal(await groups.locator('[data-proposal-body]').textContent(), "[sh] printf second");
        assert.equal(await groups.locator("input:checked").count(), 0);
        assert.equal(model.requests.length, 1, "both operations belong to the same model turn");
        await groups.getByRole("radio", { name: "Reject", exact: true }).check();
        await page.getByRole("button", { name: "Submit responses", exact: true }).click();
        await page.getByText("Completed approval-batch.", { exact: true }).waitFor();
        await connected(page);
        assert.equal(requests.length, 3);
        assert.deepEqual(requests.slice(1).map((r) => r.result?.outcome), [
            { outcome: "selected", optionId: "allow_once" },
            { outcome: "selected", optionId: "reject_once" },
        ]);
        const calls = page.locator('[data-call-id][data-plurnk-type="sh"]');
        assert.equal(await calls.count(), 2);
        assert.match(await calls.nth(1).locator('[data-plurnk-field="outcome"]').textContent(), /The proposal was rejected \([^)]+\)\./u);
        const messages = await observeMessages(requests[0].params.sessionId, base, headers);
        const accepted = await calls.first().getAttribute("data-call-id");
        const result = messages.find((message) => message.role === "tool" && message.toolCallId === accepted && message._meta?.plurnk?.op === "read");
        assert.ok(result, "the accepted command's stream output remains correlated with its call");
        assert.equal((await inspectResult(result.content, undefined, base)).content, "first");
        assert.equal(model.requests.length, 2);
        checkBrowser();
    }));

    await t.test("{§web-session-approval} an idle owner reviews independent children without borrowing their conversation", { timeout: 60_000 }, () => manualPage(async ({ page, context, path, base, headers, model, checkBrowser }) => {
        page.setDefaultTimeout(5000);
        const requests = requestsFrom(page);
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: owner-ready.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.getByText("Completed owner-ready.", { exact: true }).waitFor();
        await connected(page);
        const sessionId = await page.locator("#session-status").getAttribute("data-session-id");
        for (const name of ["one", "two"]) {
            const fork = new SessionAgent({ url: new URL("/acp", base).href, sessionId, headers });
            const { result } = await fork.send({ action: { kind: "session/fork", name } });
            assert.equal(result.ok, true, JSON.stringify(result));
            const child = new SessionAgent({ url: new URL("/acp", base).href, sessionId: `${sessionId.split("#")[0]}#${name}`, headers });
            const reasoning = Promise.withResolvers();
            const controller = new AbortController();
            const running = child.send({
                abortController: controller,
                message: { id: crypto.randomUUID(), role: "user", content: `Lifecycle fixture: held-approval-${name}.` },
            }, { onThoughtChunk: () => { reasoning.resolve(); } });
            await reasoning.promise;
            controller.abort();
            child.close();
            await running.catch(() => {});
        }
        model.release("held-approval-one");
        model.release("held-approval-two");
        await interrupted(page);
        await page.waitForFunction(() => document.querySelector('#session-status [data-text="gated"]')?.textContent === "2");
        assert.equal(await page.locator('#session-status [data-status-field="lifecycle"]').getAttribute("aria-label"), "completed",
            "pending descendant requests do not change the owner's own lifecycle");
        const seen = [];
        for (let index = 0; index < 2; index++) {
            await interrupted(page);
            const group = page.locator('[data-requests] > fieldset');
            assert.equal(await group.count(), 1, "one requesting session per presentation");
            const session = await group.locator('[data-text="proposal-session"]').innerText();
            assert.ok(["one", "two"].includes(session), session);
            assert.ok(!seen.includes(session));
            seen.push(session);
            assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).count(), 0, "a child's pending approval does not expose Stop on its idle parent");
            assert.equal(await page.getByRole("button", { name: "Stop", exact: true, includeHidden: true }).isDisabled(), true, "the idle parent's Stop cannot cancel a child");
            await group.getByRole("radio", { name: "Accept", exact: true }).check();
            await page.getByRole("button", { name: "Submit responses", exact: true }).click();
            // Each accepted child finishes independently of the owner's already-finished loop.
            const childPage = await context.newPage();
            await childPage.goto(path.replace("@user/", `@${session}/`));
            await childPage.getByText(`Completed held-approval-${session}.`, { exact: true }).waitFor();
            assert.equal(await childPage.locator('[data-message-role="user"]').count(), 2, "fork retains the owner's history plus the child's prompt");
            await childPage.close();
        }
        await connected(page);
        await page.waitForFunction(() => document.querySelector('#session-status [data-text="gated"]')?.textContent === "0");
        assert.deepEqual(await page.locator("#session-descendants [data-text=descendant-gates]").allTextContents(), ["0", "0"]);
        assert.equal(model.requests.length, 5);
        assert.equal(requests.filter((req) => req?.result?.outcome !== undefined).length, 2);
        assert.equal(await page.locator('[data-message-role="user"]').count(), 1);
        assert.equal(await page.locator('[data-call-id][data-plurnk-type="sh"]').count(), 0,
            "independent child calls do not become the owner's own conversation");
        checkBrowser();
    }));

    await t.test("{§web-session-approval} a failed decision delivery requires rediscovery and a new explicit choice", { timeout: 60_000 }, () => manualPage(async ({ page, model, checkBrowser }) => {
        const requests = requestsFrom(page);
        await requestApproval(page, "approval-transport");
        await page.route("**/acp", (route) => route.abort("failed"), { times: 1 });
        await page.getByRole("radio", { name: "Accept", exact: true }).check();
        await page.getByRole("button", { name: "Submit responses", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "disconnected");
        assert.match(await page.locator('[data-text="command-error"]').textContent(), /Response could not be confirmed:.*(Failed to fetch|NetworkError|Load failed)/u);
        assert.equal(await page.getByRole("button", { name: "Submit responses", exact: true }).isDisabled(), true);
        assert.equal(model.requests.length, 1);
        assert.equal(requests.length, 2);
        checkBrowser([
            networkFailure("/acp"),
        ]);
        await page.getByRole("button", { name: "Reconnect", exact: true }).click();
        await interrupted(page);
        assert.equal(await page.locator('[data-requests] input:checked').count(), 0);
        assert.equal(model.requests.length, 1);
        assert.equal(requests.length, 2, "rediscovery does not retry the decision");
        await page.getByRole("radio", { name: "Reject", exact: true }).check();
        await page.getByRole("button", { name: "Submit responses", exact: true }).click();
        await page.getByText("Completed approval-transport.", { exact: true }).waitFor();
        await connected(page);
        assert.equal(model.requests.length, 2);
        assert.equal(requests.length, 3);
        assert.notEqual(requests[1].result?.outcome?.optionId, requests[2].result?.outcome?.optionId);
        const outcome = page.locator('[data-call-id][data-plurnk-type="sh"] [data-plurnk-field="outcome"]');
        assert.equal(await outcome.textContent(), "Rejected — The proposal was rejected (rejected).");
        checkBrowser();
    }));

    await t.test("{§web-session-approval} lost settlement delivery is rediscovered without replaying an accepted decision", { timeout: 60_000 }, () => manualPage(async ({ page, model, checkBrowser }) => {
        const requests = requestsFrom(page);
        await requestApproval(page, "approval-lost-settlement");
        const truncated = Promise.withResolvers();
        await page.route("**/acp", async (route) => {
            try {
                const response = await route.fetch();
                assert.equal(response.status(), 202);
                await new Promise((r) => setTimeout(r, 5));
                const connId = route.request().headers()["acp-connection-id"];
                if (connId) {
                    await fetch(route.request().url(), { method: "DELETE", headers: { "acp-connection-id": connId } });
                }
                const deadline = Date.now() + 2000;
                while (model.requests.length < 2 && Date.now() < deadline) {
                    await new Promise((r) => setTimeout(r, 10));
                }
                await route.fulfill({ response });
                truncated.resolve();
            } catch (error) {
                await route.abort();
                truncated.reject(error);
            }
        }, { times: 1 });
        await page.getByRole("radio", { name: "Accept", exact: true }).check();
        await Promise.all([page.getByRole("button", { name: "Submit responses", exact: true }).click(), truncated.promise]);
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "disconnected");
        assert.match(await page.locator('[data-text="command-error"]').textContent(), /Response could not be confirmed: Delivery ended without a session outcome/u);
        assert.equal(model.requests.length, 2);
        await page.getByRole("button", { name: "Reconnect", exact: true }).click();
        await page.getByText("Completed approval-lost-settlement.", { exact: true }).waitFor();
        await connected(page);
        assert.equal(await page.getByRole("form", { name: "Review requests", exact: true }).isVisible(), false);
        assert.equal(await page.locator('[aria-label="Message feedback"] [role="alert"]').isVisible(), false);
        assert.equal(requests.length, 2);
        assert.equal(model.requests.length, 2, "rediscovery starts no replacement work");
        assert.equal(await page.locator('[data-message-role="user"]').count(), 1);
        checkBrowser();
    }));

    for (const departure of ["navigate", "close"]) {
        await t.test(`{§web-session-approval} ${departure} after acceptance does not cancel resumed work`, { timeout: 60_000 }, () => manualPage(async ({ page, context, path, model, checkBrowser }) => {
            const name = `approval-resumed-${departure}`;
            const requests = requestsFrom(page);
            await requestApproval(page, name);
            await page.getByRole("radio", { name: "Accept", exact: true }).check();
            await page.getByRole("button", { name: "Submit responses", exact: true }).click();
            await page.locator("[data-reasoning-preview]").getByText(`Considering ${name}.`, { exact: true }).waitFor();
            assert.equal(model.requests.length, 2, "the accepted operation has released the next model call");
            if (departure === "navigate") {
                await page.getByRole("link", { name: "Workspaces", exact: true }).first().click();
                await page.waitForLoadState("load");
            } else await page.close();
            model.release(name);
            const observer = await context.newPage();
            await observer.goto(path);
            await observer.getByText(`Completed ${name}.`, { exact: true }).waitFor();
            await connected(observer);
            assert.equal(await observer.locator('#session-status [data-status-field="lifecycle"]').getAttribute("aria-label"), "completed");
            assert.equal(await observer.locator('[data-message-role="user"]').count(), 1);
            assert.equal(model.requests.length, 2);
            assert.equal(requests.length, 2);
            assert.ok(requests.every((input) => input.method !== "_plurnk/action"));
            checkBrowser();
        }, { authenticated: true }));
    }

    await t.test("{§web-session-approval} revoked browser authority cannot decide and fresh sign-in rediscovers the gate", { timeout: 60_000 }, () => manualPage(async ({ page, context, path, base, model, checkBrowser }) => {
        const requests = requestsFrom(page);
        await requestApproval(page, "approval-revoked");
        await page.getByRole("radio", { name: "Accept", exact: true }).check();
        const logout = await context.request.post(new URL("/auth/logout", base).href, { headers: { Origin: new URL(base).origin }, maxRedirects: 0 });
        assert.equal(logout.status(), 303);
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "signed-out");
        assert.match(await page.locator('[data-text="connection-detail"]').textContent(), /credential.*revoked/iu);
        assert.equal(await page.getByRole("button", { name: "Submit responses", exact: true }).isDisabled(), true);
        assert.equal(await page.getByRole("link", { name: "Sign in", exact: true }).isVisible(), true);
        assert.equal(model.requests.length, 1);
        assert.equal(requests.length, 1, "no resume is sent without a fresh credential");
        checkBrowser();
        await page.getByRole("link", { name: "Sign in", exact: true }).click();
        await page.waitForLoadState("load");
        await page.getByLabel("Password", { exact: true }).fill("compose-password");
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await page.waitForURL(path);
        await interrupted(page);
        assert.equal(await page.locator('[data-requests] input:checked').count(), 0);
        await page.getByRole("radio", { name: "Reject", exact: true }).check();
        await page.getByRole("button", { name: "Submit responses", exact: true }).click();
        await page.getByText("Completed approval-revoked.", { exact: true }).waitFor();
        assert.equal(model.requests.length, 2);
        checkBrowser();
    }, { authenticated: true }));
}
