import assert from "node:assert/strict";
import { HttpAgent } from "@ag-ui/client";
import { inputPage } from "./worker-input.js";
import { httpFailure } from "./browser-diagnostics.js";

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
        assert.equal(await page.locator("#worker-status").getAttribute("data-yolo"), "1");
        assert.equal(await page.locator('[data-text="approval-mode"]').textContent(), "Automatic");
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
    }));
    await t.test("{§web-worker-approval} configured YOLO cannot override daemon rejection", { timeout: 20_000 }, () => inputPage(startDaemon, async ({ page, model, checkBrowser }) => {
        page.setDefaultTimeout(5000);
        const requests = requestsFrom(page);
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: approval-server-reject.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.getByText("Completed approval-server-reject.", { exact: true }).waitFor();
        await connected(page);
        assert.equal(model.requests.length, 2);
        assert.equal(requests.length, 1, "daemon policy settles the operation without asking the client");
        const results = await page.locator('[data-message-role="tool"] [data-message-body]').allTextContents();
        assert.ok(results.some((body) => JSON.parse(body).problem?.type === "https://problems.plurnk.xyz/proposal/rejected"), JSON.stringify(results));
        checkBrowser();
    }, { env: { PLURNK_SERVICE_PROPOSALS: "reject" } }));
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
    }));
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
            assert.equal(await review.locator('[data-text="proposal-body"]').textContent(), "[sh] printf approved");
            const projection = JSON.parse(await review.locator('[data-text="proposal-details"]').textContent());
            assert.equal(projection.worker, "user");
            assert.equal(projection.body, "[sh] printf approved");
            assert.equal(projection.disposition.decision, "review");
            assert.equal(await review.locator("input:checked").count(), 0, "permission has no preselected answer");
            await review.getByRole("button", { name: "Submit responses", exact: true }).click();
            assert.equal(requests.length, 1, "native required controls prevent an unanswered review");
            assert.equal(model.requests.length, 1);
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
            assert.equal(resume.forwardedProps.plurnk.action, undefined);
            assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "Keep this newer draft.");
            assert.equal(await page.locator('[data-message-role="user"]').count(), 1, "review is not another user message");
            const call = page.locator('[data-calls] > li').filter({ has: page.locator('[data-text="call-name"]', { hasText: /^sh$/u }) });
            assert.equal(await call.count(), 1);
            const results = page.locator('[data-message-role="tool"] [data-message-body]');
            const bodies = await results.allTextContents();
            if (decision === "accept") assert.ok(bodies.some((body) => JSON.parse(body).content === "approved"), JSON.stringify(bodies));
            else assert.ok(bodies.some((body) => {
                const result = JSON.parse(body);
                return result.status === 400 && result.problem?.type === "https://problems.plurnk.xyz/proposal/rejected";
            }), JSON.stringify(bodies));
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
        assert.equal(await other.locator('[aria-label="Worker controls"] [role="alert"]').isVisible(), false);
        assert.equal(requests.length, 2);
        assert.equal(model.requests.length, 2, "external settlement does not repeat execution or inference");
        assert.equal(otherRequests.some(({ resume }) => resume?.length > 0), false, "the second view observes the decision; it does not answer again");
        checkBrowser();
    }, { authenticated: true }));

    await t.test("{§web-worker-approval} serial operations present fresh gates without inheriting a prior decision", { timeout: 20_000 }, () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        const requests = requestsFrom(page);
        await requestApproval(page, "approval-batch");
        const groups = page.locator('[data-requests] > fieldset');
        assert.equal(await groups.count(), 1, "dispatch waits for the first proposal before reaching the next operation");
        assert.equal(await groups.locator('[data-text="proposal-body"]').textContent(), "[sh] printf first");
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
        assert.equal(await groups.locator('[data-text="proposal-body"]').textContent(), "[sh] printf second");
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
        const results = await page.locator('[data-message-role="tool"] [data-message-body]').allTextContents();
        assert.ok(results.some((body) => JSON.parse(body).content === "first"));
        assert.ok(results.some((body) => {
            const result = JSON.parse(body);
            return result.status === 400 && result.problem?.type === "https://problems.plurnk.xyz/proposal/rejected";
        }), JSON.stringify(results));
        assert.equal(results.some((body) => JSON.parse(body).content === "second"), false);
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
        const seen = [];
        for (let index = 0; index < 2; index++) {
            await interrupted(page);
            const group = page.locator('[data-requests] > fieldset');
            assert.equal(await group.count(), 1, "one requesting worker per presentation");
            const worker = await group.locator('[data-text="proposal-worker"]').innerText();
            assert.ok(["one", "two"].includes(worker), worker);
            assert.ok(!seen.includes(worker));
            seen.push(worker);
            assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).isDisabled(), true, "the idle parent's Stop cannot cancel a child");
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
        assert.equal(model.requests.length, 5);
        assert.equal(requests.filter(({ resume }) => resume?.length).length, 2);
        assert.ok(requests.filter(({ resume }) => resume?.length).every((input) => input.threadId === threadId));
        assert.equal(await page.locator('[data-message-role="user"]').count(), 1);
        assert.equal(await page.locator('[data-calls] [data-text="call-name"]').allTextContents().then((names) => names.includes("sh")), false,
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
        const results = await page.locator('[data-message-role="tool"] [data-message-body]').allTextContents();
        assert.ok(results.some((body) => {
            const result = JSON.parse(body);
            return result.status === 400 && result.problem?.type === "https://problems.plurnk.xyz/proposal/rejected";
        }), JSON.stringify(results));
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
        assert.equal(await page.locator('[aria-label="Worker controls"] [role="alert"]').isVisible(), false);
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
            await page.getByText(`Considering ${name}.`, { exact: true }).nth(1).waitFor({ state: "attached" });
            assert.equal(model.requests.length, 2, "the accepted operation has released the next model call");
            if (departure === "navigate") await page.getByRole("link", { name: "Workspaces", exact: true }).first().click();
            else await page.close();
            model.release(name);
            const observer = await context.newPage();
            await observer.goto(path);
            await observer.getByText(`Completed ${name}.`, { exact: true }).waitFor();
            await connected(observer);
            assert.equal(await observer.locator('[data-text="lifecycle"]').innerText(), "completed");
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
        const logout = await context.request.post(new URL("/auth/logout", base).href, { headers: { Origin: new URL(base).origin }, maxRedirects: 0 });
        assert.equal(logout.status(), 303);
        await page.getByRole("radio", { name: "Accept", exact: true }).check();
        await page.getByRole("button", { name: "Submit responses", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "signed-out");
        assert.equal(await page.getByRole("button", { name: "Submit responses", exact: true }).isDisabled(), true);
        assert.equal(await page.getByRole("link", { name: "Sign in", exact: true }).isVisible(), true);
        assert.equal(model.requests.length, 1);
        assert.equal(requests.length, 1, "no resume is sent without a fresh credential");
        checkBrowser([httpFailure("/auth/token", 401)]);
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
