import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { HttpAgent } from "@ag-ui/client";
import { chromium } from "playwright";
import { directoryPath } from "../ai.plurnk/directory-addresses.js";
import startModel, { contentAttack, diagramContent } from "./model-fixture.js";
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
    await t.test("{§web-conversation-content} hostile model output stays inert through authenticated SDK delivery and replay", async () => {
        const model = await startModel();
        const secret = crypto.randomUUID();
        try {
            await withDaemon({ ...model.env, PLURNK_PASS: "content-password", PLURNK_SECRET: secret }, async (base) => {
                const setup = await controller(base, secret);
                await setup.runAgent({ forwardedProps: { plurnk: { workspace: "content-security", action: { kind: "worker.model.set", selector: "browser" } } } });
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext();
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    const unexpected = [];
                    await context.route("**/*", (route) => {
                        const url = new URL(route.request().url());
                        if (url.origin === new URL(base).origin && url.pathname !== "/security-probe") return route.continue();
                        unexpected.push(url.href);
                        return route.abort();
                    });
                    const path = new URL("/~/content-security@user/", base).href;
                    await page.goto(path);
                    await page.getByLabel("Password", { exact: true }).fill("content-password");
                    await page.getByRole("button", { name: "Continue", exact: true }).click();
                    await page.waitForURL(path);
                    await connected(page);
                    const header = await page.locator("body > header").evaluate((element) => element.outerHTML);
                    const run = await controller(base, secret, prompt("content-security"));
                    await run.runAgent({ forwardedProps: { plurnk: { workspace: "content-security" } } });
                    assert.equal(run.messages.findLast(({ role }) => role === "assistant").content, contentAttack, "the protocol preserves the source; the browser owns its interpretation");
                    const verify = async () => {
                        await connected(page);
                        await page.waitForFunction(() => [...document.querySelectorAll('[data-message-role="assistant"] > article > [data-message-body] strong')].some((element) => element.textContent === "Readable evidence"));
                        const note = page.locator('[data-call-kind="note"]');
                        assert.equal(await note.count(), 1);
                        assert.equal(JSON.parse(await note.locator("[data-text=call-arguments]").textContent()).body, contentAttack);
                        assert.equal(await note.locator("[data-message-body] strong").textContent(), "Readable evidence");
                        assert.equal(await page.locator("[data-message-body] script, [data-message-body] img, [data-message-body] form, [data-message-body] [data-bind], [data-message-body] [id]").count(), 0);
                        assert.equal(await page.locator('[data-message-role="assistant"] [data-message-body] [data-text]').count(), 0, "rich content cannot add bindings; literal result templates retain their owned text slot");
                        assert.equal(await page.locator('[data-message-body] a[href^="javascript:"]').count(), 0);
                        assert.equal(await page.locator("#worker-status").count(), 1);
                        assert.equal(await page.locator("body > header").evaluate((element) => element.outerHTML), header);
                        assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).count(), 1);
                        assert.equal(await page.evaluate(() => window.contentExecuted), undefined);
                        await page.waitForFunction(() => document.querySelector('#worker-status [data-text="lifecycle"]')?.textContent === "completed");
                        assert.equal(await value(page, "lifecycle"), "completed");
                    };
                    await verify();
                    await page.reload();
                    await verify();
                    assert.equal(page.url(), path);
                    assert.equal(model.requests.length, 1, "refresh replays evidence without executing work");
                    assert.deepEqual(model.errors, []);
                    assert.deepEqual(unexpected, [], "neither live output nor replay requests authored media");
                    checkBrowser();
                } finally { await browser.close(); }
            });
        } finally { await model.close(); }
    });

    await t.test("{§web-working-notes} packed NOTE calls retain quiet bodies, arguments and results live and on replay", async () => {
        const model = await startModel();
        try {
            await withDaemon({ ...model.env, PLURNK_AUTH: "0" }, async (base) => {
                const setup = await controller(base);
                await setup.runAgent({ forwardedProps: { plurnk: { workspace: "notes", action: { kind: "worker.model.set", selector: "browser" } } } });
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    await page.goto(new URL("/~/notes@user/", base).href);
                    await connected(page);
                    const run = await controller(base, undefined, prompt("notes"));
                    await run.runAgent({ forwardedProps: { plurnk: { workspace: "notes" } } });
                    const verify = async () => {
                        const notes = page.locator('[data-call-kind="note"]');
                        await page.waitForFunction(() => document.querySelectorAll('[data-call-kind="note"]').length === 3);
                        assert.deepEqual(await notes.locator("[data-text=call-aside]").allTextContents(), ["fact", "idea", "plan"]);
                        const note = notes.first();
                        assert.equal(await note.locator(":scope > details").getAttribute("open"), null);
                        assert.equal(await note.locator("[data-message-body]").isVisible(), false);
                        await note.locator("summary").first().click();
                        assert.equal(await note.locator("[data-message-body] strong").innerText(), "working fact");
                        const args = JSON.parse(await note.locator("[data-text=call-arguments]").textContent());
                        assert.equal(args.body, "A **working fact**, not the answer.");
                        assert.equal(args.aside, "fact");
                        const id = await note.getAttribute("data-call-id");
                        const href = `#${encodeURIComponent(`call-${encodeURIComponent(id)}`)}`;
                        const result = page.locator('[data-message-role="tool"]').filter({ has: page.locator(`[data-call-link] a[href="${href}"]`) });
                        assert.equal(await result.count(), 1, "the real correlated result remains in SDK order");
                        assert.ok(await page.locator('[data-message-role="assistant"] > article > [data-message-body]').filter({ hasText: "Completed notes." }).count());
                        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                        return notes.evaluateAll((items) => items.map((item) => item.dataset.callId));
                    };
                    const ids = await verify();
                    await page.reload();
                    await connected(page);
                    assert.deepEqual(await verify(), ids);
                    assert.equal(model.requests.length, 1, "replay starts no inference");
                    assert.deepEqual(model.errors, []);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        } finally { await model.close(); }
    });

    await t.test("{§web-math-content} the packed worker receives real messages and loads only local math assets", async () => {
        const model = await startModel();
        try {
            await withDaemon({ ...model.env, PLURNK_AUTH: "0" }, async (base) => {
                const setup = await controller(base);
                await setup.runAgent({ forwardedProps: { plurnk: { workspace: "math", action: { kind: "worker.model.set", selector: "browser" } } } });
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    const requests = [];
                    page.on("request", (request) => requests.push(request.url()));
                    await page.goto(new URL("/~/math@user/", base).href);
                    await connected(page);
                    assert.ok(!requests.some((path) => /math-renderer-|Temml-/u.test(path)), "no math code, style or font load before a formula exists");
                    const run = await controller(base, undefined, prompt("math"));
                    await run.runAgent({ forwardedProps: { plurnk: { workspace: "math" } } });
                    await page.locator("math mfrac").waitFor();
                    assert.equal(await page.locator("math annotation").textContent(), String.raw`\mathscr{F}=\frac{a}{b}`);
                    await page.evaluate(() => document.fonts.ready);
                    assert.ok(requests.some((path) => /\/Temml-[^/]+\.woff2$/u.test(path)));
                    assert.ok(requests.every((path) => new URL(path).origin === new URL(base).origin));
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                    await page.reload();
                    await connected(page);
                    await page.locator("math mfrac").waitFor();
                    assert.equal(model.requests.length, 1, "refresh renders retained math without inference");
                    assert.deepEqual(model.errors, []);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        } finally { await model.close(); }
    });

    await t.test("{§web-diagram-content} authenticated delivery and replay produce local static images", async () => {
        const model = await startModel();
        const secret = crypto.randomUUID();
        try {
            await withDaemon({ ...model.env, PLURNK_PASS: "diagram-password", PLURNK_SECRET: secret }, async (base) => {
                const setup = await controller(base, secret);
                await setup.runAgent({ forwardedProps: { plurnk: { workspace: "diagrams", action: { kind: "worker.model.set", selector: "browser" } } } });
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    const requests = [];
                    const unexpected = [];
                    page.on("request", (request) => requests.push(request.url()));
                    await context.route("**/*", (route) => {
                        const url = new URL(route.request().url());
                        if (url.origin === new URL(base).origin) return route.continue();
                        unexpected.push(url.href);
                        return route.abort();
                    });
                    const path = new URL("/~/diagrams@user/", base).href;
                    await page.goto(path);
                    await page.getByLabel("Password", { exact: true }).fill("diagram-password");
                    await page.getByRole("button", { name: "Continue", exact: true }).click();
                    await page.waitForURL(path);
                    await connected(page);
                    assert.ok(!requests.some((path) => /mermaid-renderer-/u.test(path)), "an idle worker loads no diagram code");
                    const run = await controller(base, secret, prompt("diagrams"));
                    await run.runAgent({ forwardedProps: { plurnk: { workspace: "diagrams" } } });
                    assert.equal(run.messages.findLast(({ role }) => role === "assistant").content, diagramContent);
                    const verify = async () => {
                        const figure = page.locator('[data-message-role="assistant"] [data-diagram]:not([hidden])');
                        await figure.waitFor();
                        assert.equal(await figure.locator("img").evaluate((image) => image.complete && image.naturalWidth > 0 && image.src.startsWith("data:image/svg+xml;")), true);
                        assert.equal(await figure.locator("details").evaluate((element) => element.open), false);
                        await figure.getByText("Diagram source", { exact: true }).click();
                        assert.equal(await figure.locator("pre code").innerText(), "flowchart LR\n Client --> Daemon\n");
                        assert.equal(await page.locator("[data-message-body] svg, [data-message-body] iframe, [data-message-body] style").count(), 0);
                        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                    };
                    await verify();
                    await page.reload();
                    await connected(page);
                    await verify();
                    assert.ok(requests.some((path) => /mermaid-renderer-/u.test(path)));
                    assert.deepEqual(unexpected, [], "no remote renderer or font requests");
                    assert.equal(model.requests.length, 1, "refresh renders retained diagrams without inference");
                    assert.deepEqual(model.errors, []);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        } finally { await model.close(); }
    });

    await t.test("{§web-worker-conversation} the packed page projects live SDK messages and passive replay without owning work", async () => {
        const projectRoot = await mkdtemp(join(tmpdir(), "plurnk-web-conversation-"));
        const model = await startModel();
        await writeFile(join(projectRoot, "witness.txt"), "cobalt heron\n");
        try {
            await withDaemon({ ...model.env, PLURNK_AUTH: "0", PLURNK_MEMBERS_witness: "witness.txt" }, async (base) => {
                const setup = await controller(base);
                let created;
                await setup.runAgent({ forwardedProps: { plurnk: { workspace: "conversation", projectRoot,
                    action: { kind: "worker.model.set", selector: "browser" },
                } } }, { onRunFinishedEvent: ({ event }) => { created = event.result; } });
                assert.equal(created?.ok, true, JSON.stringify(created));
                const run = await controller(base, undefined, prompt("conversation"));
                let completion;
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 420, height: 700 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    const requests = [];
                    page.on("request", (request) => requests.push(request));
                    await page.goto(new URL("/~/conversation@user/", base).href);
                    await connected(page);
                    assert.equal(model.requests.length, 0, "viewing an idle worker starts no inference");
                    completion = run.runAgent({ forwardedProps: { plurnk: { workspace: "conversation" } } });
                    const reasoning = page.locator('[data-message-role="reasoning"]').filter({ hasText: "Considering conversation." }).first();
                    await reasoning.waitFor();
                    assert.equal(await reasoning.locator("details").getAttribute("open"), null);
                    await reasoning.locator("summary").click();
                    await reasoning.evaluate((element) => { window.observedReasoning = element; });
                    assert.equal(model.requests.length, 1, "only the controlling request starts inference");
                    model.release("conversation");
                    await completion;
                    await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-message-role="assistant"] [data-message-body]'))
                        .some((element) => element.textContent === "Completed conversation.\n"));
                    await connected(page);
                    assert.equal(run.messages.findLast(({ role }) => role === "assistant").content, "Completed conversation.");
                    assert.equal(await reasoning.evaluate((element) => element === window.observedReasoning), true, "passive replay retains the existing row");
                    assert.equal(await reasoning.locator("details").evaluate((element) => element.open), true, "native disclosure choice survives replay");
                    const ids = () => page.locator("[data-messages] > li").evaluateAll((rows) => rows.map((row) => row.dataset.messageId));
                    const beforeReload = await ids();
                    assert.equal(beforeReload.length, new Set(beforeReload).size, "reconnect does not duplicate messages");
                    const calls = await page.locator("[data-call-id]").evaluateAll((rows) => rows.map((row) => ({
                        id: row.dataset.callId, name: row.dataset.callName, arguments: row.dataset.callArguments,
                    })));
                    const reads = calls.filter(({ name }) => name === "READ");
                    assert.equal(reads.length, 2);
                    assert.ok(reads.some(({ arguments: args }) => args.includes("witness.txt")), "exact daemon arguments reach the template");
                    const receipts = page.locator('[data-message-role="tool"]');
                    const receiptBodies = await receipts.locator("[data-message-body]").allTextContents();
                    assert.ok(receiptBodies.some((body) => body.includes("cobalt heron")), "the real file result is inspectable");
                    assert.ok(receiptBodies.some((body) => body.includes("Entry not found")), "the real operation failure is inspectable");
                    for (const link of await receipts.locator("[data-call-link] a").all()) {
                        assert.equal(await link.evaluate((element) => Boolean(document.getElementById(decodeURIComponent(new URL(element.href).hash.slice(1))))), true);
                    }
                    for (const colorScheme of ["light", "dark"]) {
                        await page.emulateMedia({ colorScheme });
                        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "long literal receipts do not widen the viewport");
                    }
                    await page.reload();
                    await connected(page);
                    await page.waitForFunction((count) => document.querySelectorAll("[data-messages] > li").length === count, beforeReload.length);
                    assert.deepEqual(await ids(), beforeReload, "a fresh page reads the same SDK snapshot, without a browser history store");
                    assert.equal(model.requests.length, 2, "neither replay nor refresh creates a model call");
                    assert.deepEqual(model.errors, []);
                    assert.equal(await page.locator("#worker-conversation form, #worker-conversation textarea, #worker-conversation [contenteditable]").count(), 0);
                    for (const request of requests.filter((request) => new URL(request.url()).pathname === "/agui/connect")) {
                        const input = request.postDataJSON();
                        assert.deepEqual(input.messages, []);
                        assert.deepEqual(input.tools, []);
                        assert.equal(input.resume, undefined);
                    }
                    checkBrowser();
                } finally {
                    run.abortRun();
                    await completion;
                    await browser.close();
                }
            });
        } finally {
            await model.close();
            await rm(projectRoot, { recursive: true, force: true });
        }
    });

    await t.test("{§web-worker-observer} the actual page observes consecutive loops, cancellation and workspace rename without owning work", async () => {
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
                        onRunFinishedEvent: ({ event }) => { result = event.result; },
                    });
                    assert.equal(result?.ok, true, JSON.stringify(result));
                    return result.result;
                };
                await action("worker.model.set", { selector: "browser" });
                const { workspaces } = await action("workspace.list");
                const identity = `${workspaces.find(({ name }) => name === workspace).id}#${threadId}`;
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
                    let terminal;
                    const cancellation = cancelled.runAgent({ forwardedProps: { plurnk: { workspace } } }, {
                        onReasoningMessageContentEvent: () => { ready.resolve(); },
                        onRunFinishedEvent: ({ event }) => { terminal = event; },
                    });
                    await ready.promise;
                    await page.waitForFunction(() => document.querySelector('[data-text="lifecycle"]')?.textContent === "running");
                    assert.deepEqual(await action("loop.cancel", { reason: "browser-stop" }), { cancelled: true });
                    await cancellation;
                    assert.deepEqual(terminal?.outcome, { type: "cancelled" });
                    assert.equal(terminal.metadata.plurnk.terminal.result.problem.reason, "browser-stop");
                    await page.waitForFunction(() => document.querySelector('[data-text="lifecycle"]')?.textContent === "failed");
                    await connected();
                    assert.equal(await page.getByRole("alert").isVisible(), false, "a cancelled worker is not a disconnected observer");
                    assert.equal(model.requests.length, 3);

                    assert.ok(observations.length >= 5, "loop terminals, refresh and navigation reopen passive observations");
                    for (const input of observations) {
                        assert.equal(input.threadId, identity);
                        assert.deepEqual(input.messages, []);
                        assert.deepEqual(input.tools, []);
                        assert.equal(input.forwardedProps?.plurnk?.workspace, undefined);
                        assert.equal(input.forwardedProps?.plurnk?.control, undefined);
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
                    const afterRename = await controller(base, secret, prompt("held-page-rename"));
                    afterRename.threadId = identity;
                    const readyAfterRename = Promise.withResolvers();
                    const completionAfterRename = afterRename.runAgent({}, {
                        onReasoningMessageContentEvent: () => { readyAfterRename.resolve(); },
                    });
                    await readyAfterRename.promise;
                    await page.waitForFunction(() => document.querySelector('[data-text="lifecycle"]')?.textContent === "running");
                    model.release("held-page-rename");
                    await completionAfterRename;
                    await page.waitForFunction(() => document.querySelector('[data-text="requests"]')?.textContent === "4");
                    await connected();
                    assert.equal(observations.at(-1).threadId, identity, "the open page reattaches by ID after another client renames its workspace");
                    const attempts = observations.length;
                    assert.equal((await page.reload()).status(), 404, "an old named URL is not an identity alias");
                    checkBrowser([httpFailure(path, 404)]);
                    assert.equal(observations.length, attempts, "a missing directory starts no observation");
                    const renamedPath = directoryPath({ kind: "worker", workspace: renamed, worker: threadId });
                    await page.goto(new URL(renamedPath, base).href);
                    await connected();
                    assert.equal(observations.at(-1).threadId, identity);
                    assert.equal(await value("lifecycle"), "completed");
                    const stableWorkers = (workers) => workers.map(({ lifecycle, ...identity }) => identity);
                    assert.deepEqual(stableWorkers((await action("workspace.workers", {}, renamed)).workers), stableWorkers(after.workers),
                        "qualified control and named navigation preserve worker identities, lineage and ownership; only the loop lifecycle changes");
                    assert.equal(model.requests.length, 4);
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
                    assert.equal(await page.getByRole("button", { name: "Reconnect", exact: true }).isVisible(), false);
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

    await t.test("{§web-worker-observer} passive pages leave approvals undecided and expose network loss and shutdown", async () => {
        const model = await startModel();
        try {
            await withDaemon({ ...model.env, PLURNK_AUTH: "0" }, async (base, daemon) => {
                const run = await controller(base, undefined, prompt("approval"));
                const parameters = { forwardedProps: { plurnk: { workspace: "observer-approval" } } };
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
                    await connection(page, "interrupted");
                    assert.equal(await page.getByRole("form", { name: "Review requests", exact: true }).isVisible(), true);
                    assert.equal(await page.locator('[data-requests] input:checked').count(), 0, "passive discovery chooses nothing");
                    assert.equal(model.requests.length, 1, "the approval remains pending");
                    assert.equal(requests.filter((request) => new URL(request.url()).pathname === "/agui/connect").length, 1);
                    assert.equal(requests.some((request) => new URL(request.url()).pathname === "/auth/token"), false);
                    for (const request of requests) assert.equal(request.headers().authorization, undefined);
                    await run.runAgent({ ...parameters, resume: [{ interruptId: run.pendingInterrupts[0].id, status: "resolved", payload: { decision: "accept" } }] });
                    assert.equal(run.pendingInterrupts.length, 0);
                    assert.equal(run.messages.findLast(({ role }) => role === "assistant").content, "Completed approval.");
                    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
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
                    const card = page.locator('#worker-status [role="alert"]');
                    assert.equal(await card.isVisible(), true);
                    for (const colorScheme of ["light", "dark"]) {
                        await page.emulateMedia({ colorScheme });
                        const style = await card.evaluate((element) => ({ padding: getComputedStyle(element).paddingInlineStart, shadow: getComputedStyle(element).boxShadow }));
                        assert.ok(parseFloat(style.padding) > 0);
                        assert.notEqual(style.shadow, "none");
                    }
                    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
                    await connected(page);
                    assert.equal(await value(page, "requests"), "2");
                    await daemon.stop();
                    await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "disconnected");
                    assert.equal(await card.isVisible(), true);
                    assert.match(await card.innerText(), /The PLURNK service is shutting down\./u, "the protocol failure is retained, not replaced with generic transport closure");
                    assert.equal(model.requests.length, 2);
                    assert.deepEqual(model.errors, []);
                    checkBrowser();
                } finally { await browser.close(); await proxy.close(); }
            });
        } finally { await model.close(); }
    });
}
