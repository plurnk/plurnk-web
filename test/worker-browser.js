import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { HttpAgent } from "@ag-ui/client";
import { chromium } from "playwright";
import { directoryPath } from "../ai.plurnk/directory-addresses.js";
import startModel from "./model-fixture.js";
import disconnectProxy from "./disconnect-proxy.js";
import browserDiagnostics, { httpFailure } from "./browser-diagnostics.js";

async function controller(base, secret, messages = []) {
    const headers = {};
    if (secret) {
        const grant = await fetch(new URL("/oauth/token", base), {
            method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: "operator", client_secret: secret, scope: "agui" }),
        });
        assert.equal(grant.status, 200);
        headers.Authorization = `Bearer ${(await grant.json()).access_token}`;
    }
    return new HttpAgent({ url: new URL("/agui", base).href, threadId: "user", headers, initialMessages: messages });
}

async function connection(page, state) {
    try {
        await page.waitForFunction((state) => document.querySelector("#worker-status")?.dataset.connection === state, state);
    } catch (cause) {
        throw new Error(`Expected ${state}: ${await page.locator("#worker-status").innerText()}`, { cause });
    }
}
const connected = (page) => connection(page, "connected");
const value = (page, key) => page.locator(`#worker-status [data-text="${key}"]`).innerText();
const prompt = (name) => [{ id: crypto.randomUUID(), role: "user", content: `Lifecycle fixture: ${name}.` }];

// {§web-worker-observer} The shipped page, not an injected SDK or substituted AG-UI response.
export default async function verifyWorkerPage({ t, withDaemon }) {
    await t.test("{§web-worker-observer} the actual page observes two loops without owning or replaying work", async () => {
        const model = await startModel();
        const secret = crypto.randomUUID();
        try {
            await withDaemon({ ...model.env, PLURNK_PASS: "worker-password", PLURNK_SECRET: secret, PLURNK_AGUI_ACCESS_TTL_SEC: "1" }, async (base) => {
                const workspace = '~/observer @%/<draft>&"';
                const threadId = "user";
                const action = async (kind, parameters = {}, selected = workspace) => {
                    const agent = await controller(base, secret);
                    let result;
                    await agent.runAgent({ forwardedProps: { plurnk: { workspace: selected, action: { kind, ...parameters } } } }, {
                        onCustomEvent: ({ event }) => { if (event.name === "plurnk.action.result") result = event.value; },
                    });
                    assert.equal(result?.ok, true, JSON.stringify(result));
                    return result.result;
                };
                await action("worker.model.set", { selector: "browser" });
                const before = await action("workspace.workers");
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext();
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    const observations = [];
                    const access = [];
                    page.on("request", (request) => {
                        if (new URL(request.url()).pathname === "/agui/connect") observations.push(request.postDataJSON());
                    });
                    page.on("response", async (response) => {
                        if (new URL(response.url()).pathname === "/auth/token" && response.ok()) access.push((await response.json()).access_token);
                    });
                    const path = directoryPath({ kind: "worker", workspace, worker: threadId });
                    await page.goto(new URL(path, base).href);
                    await page.getByLabel("Password", { exact: true }).fill("worker-password");
                    await page.getByRole("button", { name: "Continue", exact: true }).click();
                    await page.waitForURL(new URL(path, base).href);
                    assert.equal(await page.locator("#worker-status").count(), 1, "the packed worker page supplies the status surface");
                    const connected = () => page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "connected");
                    const value = (key) => page.locator(`#worker-status [data-text="${key}"]`).innerText();
                    await connected();
                    checkBrowser();
                    assert.equal(await value("lifecycle"), "idle");
                    assert.equal(await value("requests"), "0");
                    assert.equal(await value("cost"), "0");
                    assert.equal(await value("elapsed"), "Unknown");
                    assert.deepEqual(await action("workspace.workers"), before);
                    assert.equal(model.requests.length, 0);

                    for (let turn = 1; turn <= 2; turn++) {
                        const run = await controller(base, secret, prompt("held-worker-page"));
                        const ready = Promise.withResolvers();
                        const completion = run.runAgent({ forwardedProps: { plurnk: { workspace } } }, {
                            onReasoningMessageContentEvent: () => { ready.resolve(); },
                        });
                        await ready.promise;
                        await page.waitForFunction(() => document.querySelector('[data-text="lifecycle"]')?.textContent === "running");
                        const elapsed = await value("elapsed");
                        await page.waitForFunction((previous) => {
                            const value = document.querySelector('[data-text="elapsed"]')?.textContent;
                            return value !== "Unknown" && value !== previous;
                        }, elapsed);
                        if (turn === 1) {
                            await page.reload();
                            await connected();
                            assert.equal(run.isRunning, true, "refresh does not cancel the controlling request");
                            assert.equal(await value("lifecycle"), "running");
                            await page.getByRole("link", { name: "Workspaces", exact: true }).first().click();
                            assert.equal(run.isRunning, true, "native navigation leaves the worker running");
                            await page.goBack();
                            await connected();
                            assert.equal(await value("lifecycle"), "running");
                        }
                        model.release("held-worker-page");
                        await completion;
                        await page.waitForFunction((count) => document.querySelector('[data-text="requests"]')?.textContent === String(count), turn);
                        await connected();
                        assert.equal(await value("lifecycle"), "completed");
                        assert.equal(await value("input"), String(400 * turn));
                        assert.equal(await value("cost"), "Unknown");
                        assert.equal(model.requests.length, turn, "observation never submits a prompt");
                    }

                    const cancelled = await controller(base, secret, prompt("held-page-cancel"));
                    const ready = Promise.withResolvers();
                    const cancellation = cancelled.runAgent({ forwardedProps: { plurnk: { workspace } } }, {
                        onReasoningMessageContentEvent: () => { ready.resolve(); },
                    }).catch((error) => { assert.equal(error.name, "AbortError"); });
                    await ready.promise;
                    await page.waitForFunction(() => document.querySelector('[data-text="lifecycle"]')?.textContent === "running");
                    cancelled.abortRun();
                    await cancellation;
                    await page.waitForFunction(() => document.querySelector('[data-text="lifecycle"]')?.textContent === "failed");
                    await connected();
                    assert.equal(await page.getByRole("alert").isVisible(), false, "a cancelled worker is not a disconnected observer");
                    assert.equal(model.requests.length, 3);

                    assert.ok(observations.length >= 5, "loop terminals, refresh and navigation reopen passive observations");
                    for (const input of observations) {
                        assert.equal(input.threadId, threadId);
                        assert.deepEqual(input.messages, []);
                        assert.deepEqual(input.tools, []);
                        assert.deepEqual(input.forwardedProps, { plurnk: { workspace } });
                        assert.equal(input.resume, undefined);
                    }
                    assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]), [[], []]);
                    assert.ok(new Set(access).size > 1, "a later connection gets a fresh credential after expiry");
                    for (const token of access) assert.equal((await page.content()).includes(token), false, "credentials never enter document state");
                    checkBrowser();
                    const after = await action("workspace.workers");
                    assert.deepEqual(after.workers.filter(({ origin }) => origin === "model").map(({ id, name }) => ({ id, name })),
                        before.workers.map(({ id, name }) => ({ id, name })));

                    const renamed = "renamed observer";
                    await action("workspace.rename", { name: renamed });
                    const attempts = observations.length;
                    assert.equal((await page.reload()).status(), 404, "an old named URL is not an identity alias");
                    checkBrowser([httpFailure(path, 404)]);
                    assert.equal(observations.length, attempts, "a missing directory starts no observation");
                    const renamedPath = directoryPath({ kind: "worker", workspace: renamed, worker: threadId });
                    await page.goto(new URL(renamedPath, base).href);
                    await connected();
                    assert.equal(observations.at(-1).forwardedProps.plurnk.workspace, renamed);
                    assert.equal(await value("lifecycle"), "failed");
                    assert.deepEqual((await action("workspace.workers", {}, renamed)).workers, after.workers,
                        "old-name refusal and new-name navigation preserve the existing worker identities and settings");
                    assert.equal(model.requests.length, 3);
                    assert.deepEqual(model.errors, []);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        } finally { await model.close(); }
    });

    await t.test("{§web-worker-observer} sign-out ends page observation, not independently controlled work", async () => {
        const model = await startModel();
        const secret = crypto.randomUUID();
        try {
            await withDaemon({ ...model.env, PLURNK_PASS: "revocation-password", PLURNK_SECRET: secret }, async (base) => {
                const run = await controller(base, secret, prompt("held-page-revocation"));
                const ready = Promise.withResolvers();
                const completion = run.runAgent({ forwardedProps: { plurnk: { workspace: "observer-revocation" } } }, {
                    onReasoningMessageContentEvent: () => { ready.resolve(); },
                });
                await ready.promise;
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext();
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    let attempts = 0;
                    page.on("request", (request) => { if (new URL(request.url()).pathname === "/agui/connect") attempts++; });
                    await page.goto(new URL("/~/observer-revocation@user/", base).href);
                    await page.getByLabel("Password", { exact: true }).fill("revocation-password");
                    await page.getByRole("button", { name: "Continue", exact: true }).click();
                    await connected(page);
                    assert.equal(await value(page, "lifecycle"), "running");
                    const second = await context.newPage();
                    await second.goto(new URL("/account/", base).href);
                    await second.getByRole("button", { name: "Sign out", exact: true }).click();
                    await second.waitForURL(base);
                    await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "signed-out");
                    const frozen = await value(page, "elapsed");
                    assert.equal(run.isRunning, true);
                    assert.equal(await page.getByRole("alert").isVisible(), true);
                    assert.equal(await page.getByRole("link", { name: "Sign in", exact: true }).isVisible(), true);
                    assert.equal(await page.getByRole("link", { name: "Reconnect", exact: true }).isVisible(), false);
                    await setTimeout(1100);
                    assert.equal(await value(page, "elapsed"), frozen, "a disconnected clock cannot pretend to be live");
                    assert.equal(attempts, 1, "revocation does not start a reconnection loop");
                    model.release("held-page-revocation");
                    await completion;
                    assert.equal(run.messages.findLast(({ role }) => role === "assistant").content, "Completed held-page-revocation.");
                    assert.equal(model.requests.length, 1);
                    await page.getByRole("link", { name: "Sign in", exact: true }).click();
                    assert.equal(await page.getByLabel("Password", { exact: true }).isVisible(), true);
                    checkBrowser();
                } finally { run.abortRun(); await browser.close(); }
            });
        } finally { await model.close(); }
    });

    await t.test("{§web-worker-observer} anonymous passive pages survive approval and expose network loss and shutdown", async () => {
        const model = await startModel();
        try {
            await withDaemon({ ...model.env, PLURNK_AUTH: "0" }, async (base, daemon) => {
                const run = await controller(base, undefined, prompt("approval"));
                const parameters = { tools: [{ name: "request_approval", description: "Review operations", parameters: { type: "object" } }],
                    forwardedProps: { plurnk: { workspace: "observer-approval" } } };
                await run.runAgent(parameters);
                assert.equal(run.pendingInterrupts.length, 1);
                const browser = await chromium.launch();
                const proxy = await disconnectProxy(base);
                try {
                    const context = await browser.newContext();
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    const requests = [];
                    page.on("request", (request) => requests.push(request));
                    await page.goto(new URL("/~/", proxy.url).href);
                    assert.equal(requests.some((request) => /worker-.*\.js|\/auth\/token|\/agui/u.test(request.url())), false, "directory navigation needs no worker runtime");
                    await page.goto(new URL("/~/observer-approval@user/", proxy.url).href);
                    await connected(page);
                    assert.equal(await page.locator('#worker-status [role="alert"]').isVisible(), false);
                    assert.equal(model.requests.length, 1, "the approval remains pending");
                    assert.equal(requests.filter((request) => new URL(request.url()).pathname === "/agui/connect").length, 1);
                    assert.equal(requests.some((request) => new URL(request.url()).pathname === "/auth/token"), false);
                    for (const request of requests) assert.equal(request.headers().authorization, undefined);
                    await run.runAgent({ ...parameters, resume: [{ interruptId: run.pendingInterrupts[0].id, status: "resolved", payload: { decision: "accept" } }] });
                    assert.equal(run.pendingInterrupts.length, 0);
                    assert.equal(run.messages.findLast(({ role }) => role === "assistant").content, "Completed approval.");
                    await page.waitForFunction(() => document.querySelector('[data-text="lifecycle"]')?.textContent === "completed");
                    await connected(page);
                    assert.equal(model.requests.length, 2);
                    checkBrowser();

                    const native = await browser.newContext({ javaScriptEnabled: false });
                    const checkNative = browserDiagnostics(native);
                    const nativePage = await native.newPage();
                    const nativeRequests = [];
                    nativePage.on("request", (request) => nativeRequests.push(request.url()));
                    await nativePage.goto(new URL("/~/observer-approval@user/", base).href);
                    assert.equal(await nativePage.getByText("Live status requires JavaScript.", { exact: true }).isVisible(), true);
                    assert.equal(await value(nativePage, "lifecycle"), "Unknown");
                    assert.equal(nativeRequests.some((url) => /\/agui|\/auth\/token/u.test(url)), false);
                    checkNative();
                    await native.close();

                    proxy.drop();
                    await connection(page, "disconnected");
                    const afterLoss = requests.length;
                    await setTimeout(1100);
                    assert.equal(requests.length, afterLoss, "an available endpoint does not trigger automatic retries after connection loss");
                    checkBrowser([
                        /^error \/agui\/connect: Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING$/u,
                        /^error \/assets\/worker-[^/]+\.js: Agent execution failed: TypeError: network error$/u,
                    ]);
                    const card = page.getByRole("alert");
                    assert.equal(await card.isVisible(), true);
                    for (const colorScheme of ["light", "dark"]) {
                        await page.emulateMedia({ colorScheme });
                        const style = await card.evaluate((element) => ({ padding: getComputedStyle(element).paddingInlineStart, shadow: getComputedStyle(element).boxShadow }));
                        assert.ok(parseFloat(style.padding) > 0);
                        assert.notEqual(style.shadow, "none");
                    }
                    await page.getByRole("link", { name: "Reconnect", exact: true }).click();
                    await connected(page);
                    assert.equal(await value(page, "requests"), "2");
                    await daemon.stop();
                    await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "disconnected");
                    assert.equal(await card.isVisible(), true);
                    assert.equal(model.requests.length, 2);
                    assert.deepEqual(model.errors, []);
                    checkBrowser();
                } finally { await browser.close(); await proxy.close(); }
            });
        } finally { await model.close(); }
    });
}
