import assert from "node:assert/strict";
import { inspectStreamOutput } from "./worker-streams.js";
import { inspectResult, observeMessages } from "./result-body.js";
import { HttpAgent } from "@ag-ui/client";
import { inputPage } from "./worker-input.js";

const interrupted = (page) => page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "interrupted");
const connected = (page) => page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "connected");

function requestsFrom(page) {
    const requests = [];
    page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/agui") requests.push(request.postDataJSON());
    });
    return requests;
}

async function requestApproval(page, name) {
    page.setDefaultTimeout(5000);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill(`Lifecycle fixture: ${name}.`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await interrupted(page);
}

// {§web-worker-approval} The real native form is the only review UI in these installed journeys.
export default async function verifyWorkerApproval({ t, withDaemon: startDaemon }) {
    const withDaemon = (env, verify) => startDaemon({ ...env, PLURNK_WEB_YOLO: "0" }, verify);
    await t.test("{§web-worker-approval} configured YOLO accepts review once without another user message", { timeout: 20_000 }, () => inputPage(startDaemon, async ({ page, model, checkBrowser }) => {
        page.setDefaultTimeout(5000);
        const requests = requestsFrom(page);
        const approval = page.getByRole("button", { name: "Automatic approval", exact: true });
        await page.getByRole("textbox", { name: "Message", exact: true }).focus();
        assert.equal(await approval.getAttribute("aria-pressed"), "true");
        assert.equal(await approval.isVisible(), true);
        assert.equal(await approval.evaluate((element) => getComputedStyle(element, "::before").content), '"🔥" / ""');
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: approval-automatic.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.getByText("Completed approval-automatic.", { exact: true }).waitFor();
        await connected(page);
        assert.equal(model.requests.length, 2);
        assert.equal(requests.length, 2, "one message and one decision, with no retry");
        assert.deepEqual(requests[1].resume.map(({ status, payload }) => ({ status, payload })), [
            { status: "resolved", payload: { decision: "accept", outcome: "client_yolo" } },
        ]);
        assert.equal(await page.locator('[data-message-role="user"]').count(), 1);
        assert.equal(await page.getByRole("form", { name: "Review requests", exact: true }).isVisible(), false);
        assert.ok(JSON.stringify(model.requests[1].messages).includes("approved"), "the executor actually ran");
        checkBrowser();
    }, { env: { PLURNK_WEB_YOLO: "1" } }));
    await t.test("{§web-worker-approval} a worker page reached from another site never approves automatically", { timeout: 20_000 }, () => inputPage(startDaemon, async ({ page, context, path, base, headers, model, checkBrowser }) => {
        page.setDefaultTimeout(5000);
        const threadId = await page.locator("#worker-status").getAttribute("data-thread-id");
        await page.close();
        // The proposal waits with no page open on its worker.
        const agent = new HttpAgent({ url: new URL("/agui", base).href, threadId, headers });
        agent.addMessage({ id: crypto.randomUUID(), role: "user", content: "Lifecycle fixture: approval-automatic." });
        const controller = new AbortController();
        const running = agent.runAgent({ abortController: controller }).catch(() => {});
        try {
            await context.route("http://elsewhere.test/**", (route) => route.fulfill({ contentType: "text/html",
                body: `<!doctype html><title>Elsewhere</title><link rel="icon" href="data:,"><a href="${path}">Open the worker</a>` }));
            const visitor = await context.newPage();
            visitor.setDefaultTimeout(5000);
            const sent = requestsFrom(visitor);
            await visitor.goto("http://elsewhere.test/");
            // Browsers send this navigation `Sec-Fetch-Site: cross-site`; Chromium's headless shell does not report it to Playwright.
            await visitor.getByRole("link", { name: "Open the worker", exact: true }).click();
            await interrupted(visitor);
            assert.equal(await visitor.getByRole("button", { name: "Automatic approval", exact: true, includeHidden: true }).getAttribute("aria-pressed"), "false");
            assert.equal(await visitor.getByRole("form", { name: "Review requests", exact: true }).isVisible(), true, "the proposal waits for review");
            assert.equal(sent.filter(({ resume }) => resume?.length).length, 0, "nothing was decided");
            // The person's own navigation keeps the configured preference.
            const own = await context.newPage();
            await own.goto(path);
            await own.getByText("Completed approval-automatic.", { exact: true }).waitFor();
            assert.equal(model.requests.length, 2);
        } finally {
            controller.abort();
            await running;
        }
        checkBrowser();
    }, { env: { PLURNK_WEB_YOLO: "1" } }));
    await t.test("{§web-worker-approval} a proposal's deadline shows, and the page follows the daemon cancelling it", { timeout: 30_000 }, () => inputPage(withDaemon, async ({ page, checkBrowser }) => {
        page.setDefaultTimeout(5000);
        const requests = requestsFrom(page);
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: approval-input.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await interrupted(page);
        const form = page.getByRole("form", { name: "Review requests", exact: true });
        assert.ok(Number.isFinite(Date.parse(await form.locator("time").getAttribute("datetime") ?? "")), "the deadline is shown");
        await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "connected", null, { timeout: 15_000 });
        assert.equal(await form.isVisible(), false, "the daemon's cancellation withdraws the review");
        assert.equal(requests.filter(({ resume }) => resume?.length).length, 0, "the page answered nothing");
        checkBrowser();
    }, { env: { PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS: "3000" } }));
    await t.test("{§web-worker-approval} configured YOLO cannot override daemon rejection", { timeout: 20_000 }, () => inputPage(startDaemon, async ({ page, model, checkBrowser }) => {
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
    await t.test("{§web-worker-approval} uncertain YOLO delivery stops without replaying its decision", { timeout: 20_000 }, () => inputPage(startDaemon, async ({ page, model, checkBrowser }) => {
        page.setDefaultTimeout(5000);
        const requests = requestsFrom(page);
        await page.route("**/agui", (route) => route.request().postDataJSON().resume ? route.abort() : route.continue());
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: approval-auto-failure.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "disconnected");
        assert.match(await page.locator('[data-text="command-error"]').textContent(), /Response could not be confirmed:/u);
        assert.equal(model.requests.length, 1);
        assert.equal(requests.length, 2, "a failed automatic decision is not retried");
        assert.equal(await page.getByRole("button", { name: "Reconnect", exact: true }).isVisible(), true);
        checkBrowser([
            /^error \/agui: Failed to load resource: net::ERR_FAILED$/u,
            /^error \/assets\/worker-[^/]+\.js: Agent execution failed: TypeError: Failed to fetch$/u,
        ]);
    }, { env: { PLURNK_WEB_YOLO: "1" } }));
    for (const decision of ["accept", "reject"]) {
        await t.test(`{§web-worker-approval} explicit ${decision} resumes the exact proposal and preserves the operation's result`, { timeout: 20_000 }, () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
            await page.setViewportSize({ width: 320, height: 700 });
            const requests = requestsFrom(page);
            const name = `approval-${decision}`;
            await requestApproval(page, name);
            const review = page.getByRole("form", { name: "Review requests", exact: true });
            assert.equal(await review.count(), 1);
            assert.equal(await review.locator("[data-requests] > fieldset").count(), 1);
            assert.equal(await review.locator('[data-text="proposal-worker"]').innerText(), "user");
            assert.equal(await review.locator('[data-text="proposal-op"]').innerText(), "sh");
            assert.equal(await review.locator('[data-proposal-body]').textContent(), "[sh] printf approved");
            assert.equal(await review.locator('[data-text="proposal-details"]').count(), 0, "review facts are not duplicated in an envelope dump");
            assert.equal(await review.locator("input:checked").count(), 0, "permission has no preselected answer");
            await review.getByRole("button", { name: "Submit responses", exact: true }).click();
            assert.equal(requests.length, 1, "native required controls prevent an unanswered review");
            assert.equal(model.requests.length, 1);
            const reasoning = page.locator('[data-message-role="reasoning"]').first();
            await reasoning.locator("summary").click();
            await reasoning.locator("[data-body-reference]").scrollIntoViewIfNeeded();
            await reasoning.locator('[data-body-state="loaded"]').waitFor();
            assert.equal(await reasoning.locator('[data-body-reference]').textContent(), `Considering ${name}.`,
                "{§web-worker-reasoning} authenticated inspection uses the real protected reasoning resource");
            await page.getByRole("textbox", { name: "Message", exact: true }).fill("Keep this newer draft.");
            await review.getByRole("radio", { name: decision, exact: false }).check();
            await review.getByRole("button", { name: "Submit responses", exact: true }).click();
            await page.getByText(`Completed ${name}.`, { exact: true }).waitFor();
            await connected(page);
            assert.equal(model.requests.length, 2);
            assert.equal(requests.length, 2);
            const resume = requests[1];
            assert.equal(resume.threadId, requests[0].threadId);
            assert.deepEqual(resume.tools.map(({ name }) => name), ["question", "mcp_input_required"]);
            assert.equal(resume.resume.length, 1);
            assert.deepEqual(resume.resume[0].payload, { decision });
            assert.equal(resume.resume[0].status, "resolved");
            assert.equal(resume.forwardedProps.plurnk.interactive, true);
            assert.equal(resume.forwardedProps.plurnk.reasoning, "link");
            assert.ok(resume.messages.some(({ role }) => role === "reasoning"));
            assert.ok(resume.messages.filter(({ role }) => role === "reasoning").every(({ content }) => content === ""));
            assert.equal(JSON.stringify(resume.messages).includes(`Considering ${name}.`), false,
                "explicitly inspected reasoning never enters the approval resume upload");
            assert.equal(resume.forwardedProps.plurnk.action, undefined);
            assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "Keep this newer draft.");
            assert.equal(await page.locator('[data-message-role="user"]').count(), 1, "review is not another user message");
            const call = page.locator('[data-call-id][data-plurnk-type="sh"]');
            assert.equal(await call.count(), 1);
            if (decision === "accept") {
                await page.locator('[data-stream-outcomes] > summary').click();
                const outcome = page.locator('[data-stream-outcomes] ul > li');
                assert.equal(await outcome.count(), 1);
                await outcome.locator(':scope > details > summary').click();
                assert.equal((await inspectStreamOutput(outcome)).stdout.content, "approved", "accepted work still produces its exact output through explicit stream inspection");
            } else {
                assert.match(await call.locator('[data-plurnk-field="outcome"]').textContent(), /The proposal was rejected \([^)]+\)\./u);
                assert.equal(await page.locator('[data-stream-outcomes] ul > li').count(), 0, "rejection never starts a stream");
            }
            assert.equal(await review.isVisible(), false);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]), [[], []]);
            const ids = await page.locator("[data-messages] > li").evaluateAll((rows) => rows.map((row) => row.dataset.messageId));
            await page.reload();
            await page.getByText(`Completed ${name}.`, { exact: true }).waitFor();
            assert.deepEqual(await page.locator("[data-messages] > li").evaluateAll((rows) => rows.map((row) => row.dataset.messageId)), ids);
            assert.equal(model.requests.length, 2);
            checkBrowser();
        }, { authenticated: true }));
    }

    await t.test("{§web-worker-approval} shared views withdraw settled approval forms and follow work without manual reconnection", { timeout: 20_000 }, () => inputPage(withDaemon, async ({ page, context, path, model, checkBrowser }) => {
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
        assert.equal(otherRequests.some(({ resume }) => resume?.length > 0), false, "the second view observes the decision; it does not answer again");
        checkBrowser();
    }, { authenticated: true }));

    await t.test("{§web-worker-approval} held review retains unsent choices and live elapsed time without repeated presentations", { timeout: 20_000 }, () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        const holds = [];
        page.on("request", (request) => {
            if (new URL(request.url()).pathname !== "/agui/connect") return;
            const input = request.postDataJSON();
            if (input.forwardedProps?.plurnk?.interrupts?.length) holds.push(input);
        });
        await requestApproval(page, "approval-held");
        const id = await page.locator('[data-requests] > fieldset').getAttribute("data-interrupt-id");
        await page.getByRole("radio", { name: "Reject", exact: true }).check();
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("Keep this draft while deciding.");
        const elapsed = await page.locator('[data-text="elapsed"]').textContent();
        await page.waitForFunction((before) => document.querySelector('[data-text="elapsed"]')?.textContent !== before, elapsed);
        assert.equal(await page.locator("#worker-status").getAttribute("data-connection"), "interrupted");
        assert.equal(await page.locator('[data-requests] > fieldset').getAttribute("data-interrupt-id"), id);
        assert.equal(await page.getByRole("radio", { name: "Reject", exact: true }).isChecked(), true);
        assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "Keep this draft while deciding.");
        assert.equal(holds.length, 1, "one held connection, not a presentation/reconnect loop");
        assert.deepEqual(holds[0].forwardedProps, { plurnk: { interrupts: [id], reasoning: "link" } });
        assert.equal(holds[0].resume, undefined);
        assert.equal(model.requests.length, 1, "waiting does not answer or run another inference");
        await page.getByRole("button", { name: "Submit responses", exact: true }).click();
        await page.getByText("Completed approval-held.", { exact: true }).waitFor();
        await connected(page);
        assert.equal(model.requests.length, 2);
        checkBrowser();
    }));

    await t.test("{§web-worker-approval} an answer overtaken in transit remains refused while the browser follows settled work", { timeout: 20_000 }, () => inputPage(withDaemon, async ({ page, context, path, model, checkBrowser }) => {
        await requestApproval(page, "approval-late");
        const other = await context.newPage();
        other.setDefaultTimeout(5000);
        await other.goto(path);
        await interrupted(other);
        const requests = requestsFrom(other);
        const sent = Promise.withResolvers();
        await other.route("**/agui", (route) => { sent.resolve(route); }, { times: 1 });
        await other.getByRole("radio", { name: "Reject", exact: true }).check();
        await other.getByRole("button", { name: "Submit responses", exact: true }).click();
        const delayed = await sent.promise;
        await page.getByRole("radio", { name: "Accept", exact: true }).check();
        await page.getByRole("button", { name: "Submit responses", exact: true }).click();
        await page.getByText("Completed approval-late.", { exact: true }).waitFor();
        const refused = other.waitForResponse((response) => new URL(response.url()).pathname === "/agui");
        await delayed.continue();
        const events = (await (await refused).text()).split("\n\n").filter((frame) => frame.startsWith("data: ")).map((frame) => JSON.parse(frame.slice(6)));
        const problem = events.find(({ type }) => type === "RUN_ERROR")?.metadata?.plurnk?.problem;
        assert.equal(problem?.status, 409);
        assert.equal(problem?.type, "https://problems.plurnk.xyz/agui/interrupt/interrupt-not-pending");
        await other.getByText("Completed approval-late.", { exact: true }).waitFor();
        await connected(other);
        assert.match(await other.locator('[data-text="command-error"]').textContent(), /^Response not accepted: /u);
        assert.equal(await other.getByRole("form", { name: "Review requests", exact: true }).isVisible(), false);
        assert.equal(requests.length, 1, "a refused decision is never retried");
        assert.equal(requests[0].resume[0].payload.decision, "reject", "the refused answer differs from the accepted answer");
        assert.equal(model.requests.length, 2, "only the accepted decision continues the model");
        assert.ok(JSON.stringify(model.requests[1].messages).includes("approved"));
        checkBrowser();
    }, { authenticated: true }));

    await t.test("{§web-worker-approval} serial operations present fresh gates without inheriting a prior decision", { timeout: 20_000 }, () => inputPage(withDaemon, async ({ page, base, headers, model, checkBrowser }) => {
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
            return document.querySelector("#worker-status")?.dataset.connection === "interrupted"
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
        assert.ok(requests.slice(1).every(({ resume }) => resume.length === 1));
        assert.deepEqual(requests.slice(1).flatMap(({ resume }) => resume.map(({ status, payload }) => ({ status, payload }))), [
            { status: "resolved", payload: { decision: "accept" } },
            { status: "resolved", payload: { decision: "reject" } },
        ]);
        const calls = page.locator('[data-call-id][data-plurnk-type="sh"]');
        assert.equal(await calls.count(), 2);
        assert.match(await calls.nth(1).locator('[data-plurnk-field="outcome"]').textContent(), /The proposal was rejected \([^)]+\)\./u);
        const messages = await observeMessages(requests[0].threadId, base, headers);
        const accepted = await calls.first().getAttribute("data-call-id");
        const result = messages.find((message) => message.role === "tool" && message.toolCallId === accepted && message.metadata?.plurnk?.op === "READ");
        assert.ok(result, "the accepted command's stream output remains correlated with its call");
        assert.equal((await inspectResult(result.content, undefined, base)).content, "first");
        assert.equal(model.requests.length, 2);
        checkBrowser();
    }));

    await t.test("{§web-worker-approval} an idle owner reviews independent children without borrowing their conversation", { timeout: 30_000 }, () => inputPage(withDaemon, async ({ page, context, path, base, headers, model, checkBrowser }) => {
        page.setDefaultTimeout(5000);
        const requests = requestsFrom(page);
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: owner-ready.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.getByText("Completed owner-ready.", { exact: true }).waitFor();
        await connected(page);
        const threadId = await page.locator("#worker-status").getAttribute("data-thread-id");
        for (const name of ["one", "two"]) {
            const fork = new HttpAgent({ url: new URL("/agui", base).href, threadId, headers });
            const { result } = await fork.runAgent({ forwardedProps: { plurnk: { action: { kind: "run.fork", name } } } });
            assert.equal(result.ok, true, JSON.stringify(result));
            const child = new HttpAgent({ url: new URL("/agui", base).href, threadId: `${threadId.split("#")[0]}#${name}`, headers });
            child.addMessage({ id: crypto.randomUUID(), role: "user", content: `Lifecycle fixture: held-approval-${name}.` });
            const reasoning = Promise.withResolvers();
            const controller = new AbortController();
            const running = child.runAgent({ abortController: controller }, { onReasoningMessageContentEvent: () => { reasoning.resolve(); } });
            await reasoning.promise;
            controller.abort();
            await running;
        }
        model.release("held-approval-one");
        model.release("held-approval-two");
        await interrupted(page);
        await page.waitForFunction(() => document.querySelector('#worker-status [data-text="gated"]')?.textContent === "2");
        assert.equal(await page.locator('#worker-status [data-status-field="lifecycle"]').getAttribute("aria-label"), "completed",
            "pending descendant requests do not change the owner's own lifecycle");
        const seen = [];
        for (let index = 0; index < 2; index++) {
            await interrupted(page);
            const group = page.locator('[data-requests] > fieldset');
            assert.equal(await group.count(), 1, "one requesting worker per presentation");
            const worker = await group.locator('[data-text="proposal-worker"]').innerText();
            assert.ok(["one", "two"].includes(worker), worker);
            assert.ok(!seen.includes(worker));
            seen.push(worker);
            assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).count(), 0, "a child's pending approval does not expose Stop on its idle parent");
            assert.equal(await page.getByRole("button", { name: "Stop", exact: true, includeHidden: true }).isDisabled(), true, "the idle parent's Stop cannot cancel a child");
            await group.getByRole("radio", { name: "Accept", exact: true }).check();
            await page.getByRole("button", { name: "Submit responses", exact: true }).click();
            // Each accepted child finishes independently of the owner's already-finished loop.
            const childPage = await context.newPage();
            await childPage.goto(path.replace("@user/", `@${worker}/`));
            await childPage.getByText(`Completed held-approval-${worker}.`, { exact: true }).waitFor();
            assert.equal(await childPage.locator('[data-message-role="user"]').count(), 2, "fork retains the owner's history plus the child's prompt");
            await childPage.close();
        }
        await connected(page);
        await page.waitForFunction(() => document.querySelector('#worker-status [data-text="gated"]')?.textContent === "0");
        assert.deepEqual(await page.locator("#worker-descendants [data-text=descendant-gates]").allTextContents(), ["0", "0"]);
        assert.equal(model.requests.length, 5);
        assert.equal(requests.filter(({ resume }) => resume?.length).length, 2);
        assert.ok(requests.filter(({ resume }) => resume?.length).every((input) => input.threadId === threadId));
        assert.equal(await page.locator('[data-message-role="user"]').count(), 1);
        assert.equal(await page.locator('[data-call-id][data-plurnk-type="sh"]').count(), 0,
            "independent child calls do not become the owner's own conversation");
        checkBrowser();
    }));

    await t.test("{§web-worker-approval} a failed decision delivery requires rediscovery and a new explicit choice", { timeout: 20_000 }, () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        const requests = requestsFrom(page);
        await requestApproval(page, "approval-transport");
        await page.route("**/agui", (route) => route.abort("failed"), { times: 1 });
        await page.getByRole("radio", { name: "Accept", exact: true }).check();
        await page.getByRole("button", { name: "Submit responses", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "disconnected");
        assert.match(await page.locator('[data-text="command-error"]').textContent(), /Response could not be confirmed:.*Failed to fetch/u);
        assert.equal(await page.getByRole("button", { name: "Submit responses", exact: true }).isDisabled(), true);
        assert.equal(model.requests.length, 1);
        assert.equal(requests.length, 2);
        checkBrowser([
            /^error \/agui: Failed to load resource: net::ERR_FAILED$/u,
            /^error \/assets\/worker-[^/]+\.js: Agent execution failed: TypeError: Failed to fetch$/u,
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
        assert.notEqual(requests[1].resume[0].interruptId, requests[2].resume[0].interruptId);
        const outcome = page.locator('[data-call-id][data-plurnk-type="sh"] [data-plurnk-field="outcome"]');
        assert.equal(await outcome.textContent(), "Rejected — The proposal was rejected (rejected).");
        checkBrowser();
    }));

    await t.test("{§web-worker-approval} lost settlement delivery is rediscovered without replaying an accepted decision", { timeout: 20_000 }, () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        const requests = requestsFrom(page);
        await requestApproval(page, "approval-lost-settlement");
        const truncated = Promise.withResolvers();
        await page.route("**/agui", async (route) => {
            try {
                const response = await route.fetch();
                assert.equal(response.status(), 200);
                const [first] = (await response.text()).split("\n\n");
                assert.equal(JSON.parse(first.slice(6)).type, "RUN_STARTED");
                await route.fulfill({ status: 200, contentType: "text/event-stream", body: `${first}\n\n` });
                truncated.resolve();
            } catch (error) {
                await route.abort();
                truncated.reject(error);
            }
        }, { times: 1 });
        await page.getByRole("radio", { name: "Accept", exact: true }).check();
        await Promise.all([page.getByRole("button", { name: "Submit responses", exact: true }).click(), truncated.promise]);
        await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "disconnected");
        assert.match(await page.locator('[data-text="command-error"]').textContent(), /Response could not be confirmed: Delivery ended without a worker outcome/u);
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
        await t.test(`{§web-worker-approval} ${departure} after acceptance does not cancel resumed work`, { timeout: 20_000 }, () => inputPage(withDaemon, async ({ page, context, path, model, checkBrowser }) => {
            const name = `approval-resumed-${departure}`;
            const requests = requestsFrom(page);
            await requestApproval(page, name);
            await page.getByRole("radio", { name: "Accept", exact: true }).check();
            await page.getByRole("button", { name: "Submit responses", exact: true }).click();
            await page.locator("[data-reasoning-preview]").getByText(`Considering ${name}.`, { exact: true }).waitFor();
            assert.equal(model.requests.length, 2, "the accepted operation has released the next model call");
            if (departure === "navigate") await page.getByRole("link", { name: "Workspaces", exact: true }).first().click();
            else await page.close();
            model.release(name);
            const observer = await context.newPage();
            await observer.goto(path);
            await observer.getByText(`Completed ${name}.`, { exact: true }).waitFor();
            await connected(observer);
            assert.equal(await observer.locator('#worker-status [data-status-field="lifecycle"]').getAttribute("aria-label"), "completed");
            assert.equal(await observer.locator('[data-message-role="user"]').count(), 1);
            assert.equal(model.requests.length, 2);
            assert.equal(requests.length, 2);
            assert.ok(requests.every((input) => input.forwardedProps?.plurnk?.action === undefined));
            checkBrowser();
        }, { authenticated: true }));
    }

    await t.test("{§web-worker-approval} revoked browser authority cannot decide and fresh sign-in rediscovers the gate", { timeout: 20_000 }, () => inputPage(withDaemon, async ({ page, context, path, base, model, checkBrowser }) => {
        const requests = requestsFrom(page);
        await requestApproval(page, "approval-revoked");
        await page.getByRole("radio", { name: "Accept", exact: true }).check();
        const logout = await context.request.post(new URL("/auth/logout", base).href, { headers: { Origin: new URL(base).origin }, maxRedirects: 0 });
        assert.equal(logout.status(), 303);
        await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "signed-out");
        assert.match(await page.locator('[data-text="connection-detail"]').textContent(), /credential.*revoked/iu);
        assert.equal(await page.getByRole("button", { name: "Submit responses", exact: true }).isDisabled(), true);
        assert.equal(await page.getByRole("link", { name: "Sign in", exact: true }).isVisible(), true);
        assert.equal(model.requests.length, 1);
        assert.equal(requests.length, 1, "no resume is sent without a fresh credential");
        checkBrowser();
        await page.getByRole("link", { name: "Sign in", exact: true }).click();
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
