import assert from "node:assert/strict";
import { HttpAgent } from "@ag-ui/client";
import { inputPage } from "./worker-input.js";
import { answerSchema, exactAnswer } from "./question-fixture.js";
import startMcp from "./mcp-fixture.js";

const interrupted = (page) => page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "interrupted");
const connected = (page) => page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "connected");
const review = (page) => page.getByRole("form", { name: "Review requests", exact: true });
const submit = (page) => review(page).getByRole("button", { name: "Submit responses", exact: true }).click();
const cancel = (page) => review(page).getByRole("checkbox", { name: "Cancel this request", exact: true }).check();

function requestsFrom(page) {
    const requests = [];
    page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/agui") requests.push(request.postDataJSON());
    });
    return requests;
}

async function ask(page, name) {
    page.setDefaultTimeout(5000);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill(`Lifecycle fixture: ${name}.`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await interrupted(page);
}

async function answer(page, form = review(page)) {
    await form.getByRole("combobox", { name: "Next action", exact: true }).selectOption({ label: exactAnswer.action });
    await form.getByRole("textbox", { name: "Exact answer", exact: true }).fill(exactAnswer.content);
    await form.getByRole("spinbutton", { name: "count", exact: true }).fill(String(exactAnswer.count));
    await form.getByRole("combobox", { name: "confirm", exact: true }).selectOption(String(exactAnswer.confirm));
}

const questionResult = async (page) => {
    const bodies = await page.locator('[data-message-role="tool"] [data-message-body]').allTextContents();
    return bodies.map((body) => JSON.parse(body)).find((result) => result.content?.includes('"action"'));
};

// {§web-worker-questions} The real daemon requests input; shipped forms and HttpAgent settle it.
export default async function verifyWorkerQuestions({ t, withDaemon }) {
    for (const cancelled of [false, true]) {
        await t.test(`{§web-worker-questions} ${cancelled ? "cancellation" : "typed native input"} resumes a real question without another prompt`, { timeout: 20_000 }, () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
            await page.setViewportSize({ width: 320, height: 800 });
            const requests = requestsFrom(page);
            const name = cancelled ? "question-cancel" : "question-answer";
            await ask(page, name);
            assert.deepEqual(JSON.parse(await review(page).locator('[data-text="request-schema"]').textContent()), answerSchema);
            assert.equal(await review(page).locator('[data-text="request-tool"]').textContent(), "question");
            assert.equal(model.requests.length, 1);
            if (cancelled) await cancel(page);
            else {
                await submit(page);
                assert.equal(requests.length, 1, "unanswered native required controls prevent a resume");
                await answer(page);
                await review(page).getByRole("spinbutton", { name: "count", exact: true }).fill("1.5");
                await submit(page);
                await review(page).getByRole("alert").filter({ hasText: /does not satisfy/u }).waitFor();
                assert.equal(requests.length, 1, "JSON Schema validation refuses an integer fraction");
                assert.equal(await review(page).getByRole("textbox", { name: "Exact answer", exact: true }).inputValue(), exactAnswer.content);
                await review(page).getByRole("spinbutton", { name: "count", exact: true }).fill("0");
            }
            await page.getByRole("textbox", { name: "Message", exact: true }).fill("Keep this next message.");
            await submit(page);
            await page.getByText(`Completed ${name}.`, { exact: true }).waitFor();
            await connected(page);
            assert.equal(model.requests.length, 2);
            assert.equal(requests.length, 2);
            const [response] = requests[1].resume;
            assert.equal(response.status, cancelled ? "cancelled" : "resolved");
            assert.deepEqual(response.payload, cancelled ? undefined : exactAnswer);
            assert.ok(requests.every(({ tools }) => tools.some(({ name }) => name === "question") && tools.some(({ name }) => name === "mcp_input_required")));
            assert.equal(await page.locator('[data-message-role="user"]').count(), 1);
            assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "Keep this next message.");
            const receipt = await questionResult(page);
            assert.ok(receipt, "the daemon's operation result reaches the conversation");
            assert.deepEqual(JSON.parse(receipt.content), cancelled ? { action: "cancel" } : { action: "accept", content: exactAnswer });
            assert.ok(JSON.stringify(model.requests[1].messages).includes(cancelled ? "cancel" : "cobalt heron"), "the operation result also reaches the resumed model");
            assert.equal(await review(page).isVisible(), false);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            checkBrowser();
        }, { authenticated: true, hostname: "plurnk-browser.test" }));
    }

    await t.test("{§web-worker-questions} complete presentations remain answerable as another question becomes pending", { timeout: 20_000 }, () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        const requests = requestsFrom(page);
        await ask(page, "question-batch");
        const seen = [];
        while (seen.length < 2) {
            const groups = page.locator("[data-question]");
            const ids = await groups.evaluateAll((rows) => rows.map((row) => row.dataset.interruptId));
            assert.ok(ids.length > 0 && seen.length + ids.length <= 2, "only the fixture's two questions are presented");
            assert.equal(model.requests.length, 1, "both questions belong to the same model turn");
            for (const [index, id] of ids.entries()) {
                assert.ok(!seen.includes(id), "an answered presentation cannot be repeated");
                const group = groups.nth(index);
                assert.equal(await group.getByRole("textbox", { name: "Exact answer", exact: true }).inputValue(), "");
                assert.equal(await group.getByRole("checkbox", { name: "Cancel this request", exact: true }).isChecked(), false);
                if (seen.length === 0) await answer(page, group);
                else await group.getByRole("checkbox", { name: "Cancel this request", exact: true }).check();
                seen.push(id);
            }
            await submit(page);
            const observed = await page.waitForFunction((ids) => {
                const status = document.querySelector("#worker-status");
                const state = status?.dataset.connection;
                const next = [...document.querySelectorAll("[data-question]")].map((row) => row.dataset.interruptId);
                const settled = ["disconnected", "signed-out"].includes(state)
                    || (state === "connected" && status.dataset.lifecycle === "completed")
                    || (state === "interrupted" && next.length > 0 && JSON.stringify(next) !== JSON.stringify(ids));
                return settled ? state : null;
            }, ids);
            assert.ok(["interrupted", "connected"].includes(await observed.jsonValue()),
                `every issued complete presentation must be answerable: ${await page.locator('[data-text="command-error"]').textContent()}`);
        }
        await page.getByText("Completed question-batch.", { exact: true }).waitFor();
        await connected(page);
        assert.equal(model.requests.length, 2);
        assert.deepEqual(requests.slice(1).flatMap(({ resume }) => resume.map(({ status, payload }) => ({ status, payload }))), [
            { status: "resolved", payload: exactAnswer }, { status: "cancelled", payload: undefined },
        ]);
        checkBrowser();
    }));

    await t.test("{§web-worker-questions} shared views withdraw answered questions and follow work without manual reconnection", { timeout: 20_000 }, () => inputPage(withDaemon, async ({ page, context, path, model, checkBrowser }) => {
        await ask(page, "question-tabs");
        await answer(page);
        const first = await page.locator("[data-question]").getAttribute("data-interrupt-id");
        await page.reload();
        await interrupted(page);
        assert.notEqual(await page.locator("[data-question]").getAttribute("data-interrupt-id"), first);
        assert.equal(await review(page).getByRole("textbox", { name: "Exact answer", exact: true }).inputValue(), "");
        const other = await context.newPage();
        other.setDefaultTimeout(5000);
        const otherRequests = requestsFrom(other);
        await other.goto(path);
        await interrupted(other);
        assert.equal(model.requests.length, 1);
        await answer(page);
        await submit(page);
        await page.getByText("Completed question-tabs.", { exact: true }).waitFor();
        await other.getByText("Completed question-tabs.", { exact: true }).waitFor();
        await connected(other);
        assert.equal(await review(other).isVisible(), false);
        assert.equal(await other.locator('[aria-label="Worker controls"] [role="alert"]').isVisible(), false);
        assert.equal(model.requests.length, 2, "the answered question creates no duplicate inference");
        assert.equal(otherRequests.some(({ resume }) => resume?.length > 0), false, "the second view never answers an already settled question");
        checkBrowser();
    }, { authenticated: true }));

    await t.test("{§web-worker-questions} daemon rejection remains pending until rediscovery and explicit correction", { timeout: 20_000 }, () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        await ask(page, "question-invalid");
        const first = await page.locator("[data-question]").getAttribute("data-interrupt-id");
        await answer(page);
        await page.route("**/agui", (route) => {
            const input = route.request().postDataJSON();
            input.resume[0].payload.count = "invalid on wire";
            return route.continue({ postData: JSON.stringify(input) });
        }, { times: 1 });
        await submit(page);
        await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "disconnected");
        assert.match(await page.locator('[data-text="command-error"]').textContent(), /Response could not be confirmed:.*schema/iu);
        assert.equal(model.requests.length, 1);
        await page.getByRole("button", { name: "Reconnect", exact: true }).click();
        await interrupted(page);
        assert.notEqual(await page.locator("[data-question]").getAttribute("data-interrupt-id"), first);
        await answer(page);
        await submit(page);
        await page.getByText("Completed question-invalid.", { exact: true }).waitFor();
        assert.equal(model.requests.length, 2);
        checkBrowser();
    }));

    await t.test("{§web-worker-questions} leaving a pending or resumed question never cancels the worker", { timeout: 25_000 }, () => inputPage(withDaemon, async ({ page, context, path, model, checkBrowser }) => {
        await ask(page, "question-resumed-departure");
        await page.getByRole("link", { name: "Workspaces", exact: true }).first().click();
        await page.goto(path);
        await interrupted(page);
        assert.equal(model.requests.length, 1, "navigation neither answers nor cancels a question");
        await answer(page);
        await submit(page);
        await page.getByText("Considering question-resumed-departure.", { exact: true }).nth(1).waitFor({ state: "attached" });
        await page.close();
        model.release("question-resumed-departure");
        const observer = await context.newPage();
        await observer.goto(path);
        await observer.getByText("Completed question-resumed-departure.", { exact: true }).waitFor();
        await connected(observer);
        assert.equal(model.requests.length, 2);
        assert.equal(await observer.locator('[data-text="lifecycle"]').textContent(), "completed");
        checkBrowser();
    }, { authenticated: true }));

    await t.test("{§web-worker-questions} revoked authority cannot answer and fresh sign-in retains the question", { timeout: 20_000 }, () => inputPage(withDaemon, async ({ page, context, base, path, model, checkBrowser }) => {
        const requests = requestsFrom(page);
        await ask(page, "question-revoked");
        await answer(page);
        const logout = await context.request.post(new URL("/auth/logout", base).href, { headers: { Origin: new URL(base).origin }, maxRedirects: 0 });
        assert.equal(logout.status(), 303);
        await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "signed-out");
        assert.match(await page.locator('[data-text="connection-detail"]').textContent(), /credential.*revoked/iu);
        assert.equal(await review(page).getByRole("button", { name: "Submit responses", exact: true }).isDisabled(), true);
        assert.equal(requests.length, 1, "no unauthenticated resume is sent");
        assert.equal(model.requests.length, 1);
        checkBrowser();
        await page.getByRole("link", { name: "Sign in", exact: true }).click();
        await page.getByLabel("Password", { exact: true }).fill("compose-password");
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await page.waitForURL(path);
        await interrupted(page);
        await cancel(page);
        await submit(page);
        await page.getByText("Completed question-revoked.", { exact: true }).waitFor();
        assert.equal(model.requests.length, 2);
        checkBrowser();
    }, { authenticated: true }));

    await t.test("{§web-worker-questions} an idle owner answers a delegated question on the requesting child's continuation", { timeout: 25_000 }, () => inputPage(withDaemon, async ({ page, context, base, path, headers, model, checkBrowser }) => {
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: owner-ready.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.getByText("Completed owner-ready.", { exact: true }).waitFor();
        await connected(page);
        const threadId = await page.locator("#worker-status").getAttribute("data-thread-id");
        const fork = new HttpAgent({ url: new URL("/agui", base).href, threadId, headers });
        const { result } = await fork.runAgent({ forwardedProps: { plurnk: { action: { kind: "run.fork", name: "child" } } } });
        assert.equal(result.ok, true, JSON.stringify(result));
        const child = new HttpAgent({ url: new URL("/agui", base).href, threadId: `${threadId.split("#")[0]}#child`, headers });
        child.addMessage({ id: crypto.randomUUID(), role: "user", content: "Lifecycle fixture: held-question-child." });
        const reasoning = Promise.withResolvers();
        const controller = new AbortController();
        const running = child.runAgent({ abortController: controller }, { onReasoningMessageContentEvent: () => reasoning.resolve() });
        await reasoning.promise;
        controller.abort();
        await running;
        model.release("held-question-child");
        await interrupted(page);
        assert.equal(await review(page).isVisible(), true);
        assert.equal(await review(page).locator('[data-text="request-worker"]').textContent(), String(result.result.workerId));
        await page.reload();
        await interrupted(page);
        assert.equal(await review(page).locator('[data-text="request-worker"]').textContent(), String(result.result.workerId), "rediscovery retains the requesting child's identity");
        assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).isDisabled(), true);
        await answer(page);
        await submit(page);
        const childPage = await context.newPage();
        await childPage.goto(path.replace("@user/", "@child/"));
        await childPage.getByText("Completed held-question-child.", { exact: true }).waitFor();
        assert.deepEqual(JSON.parse((await questionResult(childPage)).content), { action: "accept", content: exactAnswer });
        assert.equal(model.requests.length, 3, JSON.stringify(model.requests.map(({ messages }) => messages.map(({ role, content }) => ({ role, content: String(content).slice(-1200) })))));
        assert.equal(await page.locator('[data-message-role="user"]').count(), 1, "the child request does not admit a new owner prompt");
        checkBrowser();
    }));

    for (const cancelled of [false, true]) {
        await t.test(`{§web-worker-questions} real MCP input ${cancelled ? "cancels" : "accepts/declines"} its complete batch across reconnect`, { timeout: 25_000 }, async () => {
            const mcp = await startMcp();
            try {
                await inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
                    const name = cancelled ? "mcp-question-cancel" : "mcp-question-answer";
                    try { await ask(page, name); }
                    catch (cause) {
                        throw new Error(`MCP question did not arrive: ${JSON.stringify({ peerErrors: mcp.errors.map(String), page: await page.locator("main").textContent() })}`, { cause });
                    }
                    assert.equal(await review(page).locator('[data-text="request-tool"]').textContent(), "mcp_input_required");
                    const args = JSON.parse(await review(page).locator('[data-text="request-arguments"]').textContent());
                    assert.equal(args.requests.authorize.params.url, "https://authorization.invalid/authorize");
                    assert.doesNotMatch(JSON.stringify(args), /private-continuation/u);
                    await page.reload();
                    await interrupted(page);
                    const expected = cancelled ? {
                        profile: { action: "cancel" }, approval: { action: "cancel" }, authorize: { action: "cancel" },
                    } : {
                        profile: { action: "accept", content: { name: "Ada" } }, approval: { action: "decline" }, authorize: { action: "cancel" },
                    };
                    if (cancelled) await cancel(page);
                    else await review(page).getByRole("textbox", { name: "Answer (JSON)", exact: true }).fill(JSON.stringify(expected));
                    await submit(page);
                    await page.getByText(`Completed ${name}.`, { exact: true }).waitFor();
                    await connected(page);
                    assert.deepEqual(mcp.answers, [expected]);
                    assert.deepEqual(mcp.errors, []);
                    assert.equal(model.requests.length, 2);
                    assert.ok(JSON.stringify(model.requests[1].messages).includes("MCP answer received"));
                    checkBrowser();
                }, { env: mcp.env });
            } finally { await mcp.close(); }
        });
    }
}
