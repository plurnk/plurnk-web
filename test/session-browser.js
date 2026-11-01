import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright";
import { directoryPath } from "../ai.plurnk/directory-addresses.js";
import SessionAgent from "../web/session-agent.js";
import startModel, { contentAttack, diagramContent, footnoteAnswer } from "./model-fixture.js";
import disconnectProxy from "./disconnect-proxy.js";
import browserDiagnostics, { httpFailure } from "./browser-diagnostics.js";
import { inspectResult } from "./result-body.js";

async function controller(base, secret, messages = []) {
    const headers = {};
    if (secret) {
        const grant = await fetch(new URL("/oauth/token", base), {
            method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: "operator", client_secret: secret, scope: "acp" }),
        });
        assert.equal(grant.status, 200);
        headers.Authorization = `Bearer ${(await grant.json()).access_token}`;
    }
    return new SessionAgent({ url: new URL("/acp", base).href, sessionId: "user", headers, initialMessages: messages });
}

async function connection(page, state) {
    try {
        await page.waitForFunction((state) => document.querySelector("#session-status")?.dataset.connection === state, state);
    } catch (cause) {
        throw new Error(`Expected ${state}: ${await page.locator("#session-status").innerText()}`, { cause });
    }
}
const connected = (page) => connection(page, "connected");
const value = (page, key) => key === "lifecycle"
    ? page.locator('#session-status [data-status-field="lifecycle"]').getAttribute("aria-label")
    : page.locator(`#session-status [data-text="${key}"]`).textContent();
const family = (page) => page.locator("#session-descendants > summary").getAttribute("aria-label");
const deadline = (page) => page.locator('#session-status [data-text="wait"]').getAttribute("datetime");
const prompt = (name) => [{ id: crypto.randomUUID(), role: "user", content: `Lifecycle fixture: ${name}.` }];
const entryRequest = (request, scheme) => {
    const url = new URL(request.url());
    return /\/acp\/\d+\/\d+\/entry$/u.test(url.pathname) && url.searchParams.get("target")?.startsWith(`${scheme}:`);
};

// {§web-session-observer} The shipped page, not an injected SDK or substituted ACP response.
export default async function verifySessionPage({ t, withDaemon }) {
    await t.test("{§web-session-status} direct children and cumulative descendant spend come from the daemon", async () => {
        const model = await startModel();
        try {
            await withDaemon({ ...model.env, PLURNK_AUTH: "0" }, async (base) => {
                const workspace = "family-status";
                const setup = await controller(base);
                await setup.runAgent({ workspace, action: { kind: "session/set_config_option", configId: "model", value: "browser" } });
                const workspaceId = setup.state.plurnk.workspace.id;
                const fork = async (session, name) => {
                    const request = await controller(base);
                    request.sessionId = `${workspaceId}#${session}`;
                    const { result, meta } = await request.runAgent({ action: { kind: "session/fork", name } });
                    assert.equal(result.ok, true, JSON.stringify(result));
                    assert.equal(meta?.sessionName ?? result.result?._meta?.plurnk?.sessionName, name);
                };
                await fork("user", "child");
                await fork("child", "grandchild");
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext();
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    await page.goto(new URL("/~/family-status@user/", base).href);
                    await connected(page);
                    await page.getByText("No messages.", { exact: true }).waitFor();
                    assert.equal(await family(page), "Descendant sessions: 2; active direct children: 0");
                    assert.equal(await page.locator("#session-descendants > ul").isVisible(), false);
                    const running = [];
                    for (const name of ["child", "grandchild"]) {
                        const request = await controller(base, undefined, prompt(`status-${name}`));
                        request.sessionId = `${workspaceId}#${name}`;
                        const starts = [Promise.withResolvers(), Promise.withResolvers()];
                        let call = 0;
                        const completion = request.runAgent({}, {
                            onThoughtChunk: () => { starts[call++]?.resolve(); },
                        });
                        running.push({ name, completion, second: starts[1].promise });
                        await Promise.race([starts[0].promise, completion.then(() => assert.fail(`${name} completed before its first call began`))]);
                    }
                    await page.waitForFunction(() => document.querySelector("#session-descendants > summary")?.getAttribute("aria-label") === "Descendant sessions: 2; active direct children: 1");
                    assert.equal(await value(page, "descendants"), "2");
                    await page.getByRole("textbox", { name: "Message", exact: true }).focus();
                    await page.locator("#session-descendants > summary").click();
                    assert.deepEqual(await page.locator("#session-descendants > ul > li > a").allTextContents(), ["child"]);
                    assert.equal(await page.locator("#session-descendants ul ul > li > a").textContent(), "grandchild");
                    assert.equal(await value(page, "lifecycle"), "idle", "child activity does not invent a parent loop");
                    await page.reload();
                    await connected(page);
                    assert.equal(await family(page), "Descendant sessions: 2; active direct children: 1", "two active descendants are one direct child");
                    for (const { name, completion, second } of running) {
                        model.release(`status-${name}`);
                        await Promise.race([second, completion.then(() => assert.fail(`${name} completed before its second call began`))]);
                    }
                    for (const { name, completion } of running.toReversed()) {
                        model.release(`status-${name}`);
                        await completion;
                    }
                    await page.waitForFunction(() => document.querySelector("#session-descendants > summary")?.getAttribute("aria-label") === "Descendant sessions: 2; active direct children: 0"
                        && document.querySelector('#session-status [data-text="input"]')?.textContent === "2k");
                    assert.equal(await value(page, "input"), "2k", "descendant usage is the daemon's cumulative projection");
                    assert.match(await page.locator('[data-status-field="usage"]').getAttribute("aria-label"), /Input: 2000\./u);
                    assert.equal(await value(page, "cost"), "$?");
                    assert.equal(await value(page, "lifecycle"), "idle");
                    assert.equal(await value(page, "descendants"), "2", "completed sessions remain navigable");
                    assert.deepEqual(await page.locator("#session-descendants [data-text=descendant-lifecycle]").allTextContents(), ["completed", "completed"]);
                    assert.equal(model.requests.length, 5, "two calls per descendant plus the child's observation of its grandchild's result; no root inference");
                    assert.deepEqual(model.errors, []);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        } finally { await model.close(); }
    });

    await t.test("{§web-session-status} an actual WAIT counts down, freezes on disconnect and resumes from authoritative state", async () => {
        const model = await startModel();
        try {
            await withDaemon({ ...model.env, PLURNK_AUTH: "0" }, async (base) => {
                const setup = await controller(base);
                await setup.runAgent({ workspace: "wait-status", action: { kind: "session/set_config_option", configId: "model", value: "browser" } });
                const browser = await chromium.launch();
                const proxy = await disconnectProxy(base);
                try {
                    const context = await browser.newContext();
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    const observations = [];
                    page.on("request", (request) => {
                        const body = request.postDataJSON();
                        if (new URL(request.url()).pathname === "/acp" && body?.method === "session/resume" && body?.params?._meta?.plurnk?.control === false) {
                            observations.push(body);
                        }
                    });
                    await page.goto(new URL("/~/wait-status@user/", proxy.url).href);
                    await connected(page);
                    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: wait-status.");
                    await page.getByRole("button", { name: "Send", exact: true }).click();
                    await page.waitForFunction(() => document.querySelector('#session-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "parked");
                    await model.streamStarted;
                    await connected(page);
                    const until = await deadline(page);
                    assert.ok(Date.parse(until) > Date.now());
                    const countdown = await value(page, "wait");
                    await page.waitForFunction((previous) => document.querySelector('#session-status [data-text="wait"]')?.textContent !== previous, countdown);
                    assert.equal(await value(page, "lifecycle"), "parked");
                    assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).isEnabled(), true, "parked work remains stoppable");
                    const liveConnectionCount = observations.length;
                    const next = await value(page, "elapsed");
                    await page.waitForFunction((previous) => document.querySelector('#session-status [data-text="elapsed"]')?.textContent !== previous, next);
                    assert.equal(observations.length, liveConnectionCount, "clock repaint does not poll the daemon");
                    assert.equal(await page.locator("[data-open-streams]").count(), 0, "WAIT needs no separate open-stream inventory");
                    proxy.drop();
                    await connection(page, "disconnected");
                    assert.equal(await value(page, "lifecycle"), "parked", "transport loss never settles the session");
                    assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).isVisible(), true, "disconnection does not erase known live work");
                    assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).isDisabled(), true);
                    const frozen = { elapsed: await value(page, "elapsed"), wait: await value(page, "wait") };
                    await setTimeout(1100);
                    assert.deepEqual({ elapsed: await value(page, "elapsed"), wait: await value(page, "wait") }, frozen);
                    assert.equal(model.requests.length, 1, "delivery loss does not wake or cancel work");
                    checkBrowser([
                        /^error \/acp: Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING$/u,
                        /^error \/acp: Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING$/u,
                    ]);
                    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
                    await connected(page);
                    assert.equal(await value(page, "lifecycle"), "parked");
                    assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).isEnabled(), true, "reconnection restores explicit cancellation");
                    assert.equal(await deadline(page), until, "reattachment keeps the daemon deadline, not a new local timeout");
                    assert.notEqual(await value(page, "wait"), frozen.wait);
                    model.release("status-stream");
                    await page.waitForFunction(() => document.querySelector('#session-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "completed");
                    await connected(page);
                    assert.equal(await value(page, "wait"), "");
                    assert.equal(await deadline(page), null);
                    assert.equal(await value(page, "input"), "800");
                    assert.equal(model.requests.length, 2);
                    assert.deepEqual(model.errors, []);
                    checkBrowser();
                } finally { await browser.close(); await proxy.close(); }
            });
        } finally { await model.close(); }
    });

    await t.test("{§web-session-diagnostics} packed notices and Problems stay visible without stopping healthy work", async () => {
        const model = await startModel();
        try {
            await withDaemon({
                ...model.env, PLURNK_AUTH: "0", PLURNK_SERVICE_EXEC_CONCURRENCY: "invalid",
                PLURNK_MODEL_unavailable: "browser-fixture/browser-fixture", PLURNK_PROVIDERS_EFFORT_unavailable: "invalid",
            }, async (base) => {
                const setup = await controller(base);
                await setup.runAgent({ workspace: "diagnostics", action: { kind: "session/set_config_option", configId: "model", value: "browser" } });
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext();
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    await page.goto(new URL("/~/diagnostics@user/", base).href);
                    await connected(page);
                    const rows = page.locator("#session-diagnostics ul > li");
                    const notice = rows.filter({ hasText: "PLURNK_SERVICE_EXEC_CONCURRENCY" });
                    const problem = page.locator('#session-diagnostics li[data-diagnostic-type="problem"][data-diagnostic-level="error"]')
                        .filter({ hasText: /unavailable.*effort|effort.*unavailable/u });
                    await notice.waitFor();
                    await problem.waitFor();
                    assert.equal(await notice.getAttribute("data-diagnostic-type"), "notice");
                    assert.equal(await notice.getAttribute("data-diagnostic-level"), "warn");
                    assert.equal(await problem.getAttribute("data-diagnostic-type"), "problem");
                    assert.equal(await problem.getAttribute("data-diagnostic-level"), "error");
                    assert.match(await problem.locator("article").getAttribute("aria-label"), /^Error · /u);
                    assert.match(await problem.locator('pre').textContent(), /unavailable.*effort|effort.*unavailable/u);
                    assert.equal(await problem.locator("code").count(), 0, "the message is content, not a duplicated diagnostic payload");
                    assert.equal(await problem.locator("article > details").evaluate((node) => node.open), false);
                    assert.equal(await problem.locator("summary").isVisible(), true);
                    assert.equal(await page.locator("[data-messages] > li").count(), 0, "configuration evidence is not a fabricated conversation");
                    await notice.evaluate((element) => { window.retainedNotice = element; });
                    const count = await rows.count();
                    const reattached = page.waitForRequest((request) => {
                        const body = request.postDataJSON();
                        return new URL(request.url()).pathname === "/acp"
                            && body?.method === "session/resume"
                            && body?.params?._meta?.plurnk?.control === false;
                    });
                    const run = await controller(base, undefined, prompt("diagnostics"));
                    await run.runAgent({ workspace: "diagnostics" });
                    await page.waitForFunction(() => document.querySelector('#session-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "completed");
                    await reattached;
                    await connected(page);
                    assert.equal(await notice.count(), 1, "a replayed warning keeps its existing entry");
                    assert.equal(await problem.count(), 1, "a replayed Problem keeps its existing entry");
                    const progress = rows.filter({ has: page.getByRole("article", { name: "Information · engine:turn:turn_generated", exact: true }) });
                    assert.equal(await progress.getAttribute("data-diagnostic-level"), "info");
                    assert.equal(await progress.getAttribute("data-diagnostic-details"), null, "accounting remains with the status owner, not a diagnostic payload copy");
                    assert.equal(await rows.filter({ has: page.getByRole("article", { name: "Information · engine:turn:turn_awaiting_model", exact: true }) }).count(), 1);
                    assert.equal(await rows.count(), count + 2, "new turn progress remains inspectable alongside replayed configuration evidence");
                    assert.equal(await notice.evaluate((element) => element === window.retainedNotice), true);
                    assert.equal(run.messages.findLast(({ role }) => role === "assistant").content, "Completed diagnostics.");
                    assert.equal(model.requests.length, 1);
                    await page.reload();
                    await connected(page);
                    await notice.waitFor();
                    await problem.waitFor();
                    assert.equal(await notice.count(), 1, "a fresh page projects the daemon's configuration warning again");
                    assert.equal(await problem.count(), 1, "a fresh page projects the daemon's catalog Problem again");
                    assert.equal(await notice.locator("details").count(), 0, "reload retains the content-first diagnostic projection");
                    assert.equal(model.requests.length, 1, "diagnostics and refresh never execute work");
                    assert.deepEqual(model.errors, []);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        } finally { await model.close(); }
    });

    await t.test("{§web-conversation-content} hostile model output stays inert through authenticated SDK delivery and replay", async () => {
        const model = await startModel();
        const secret = crypto.randomUUID();
        try {
            await withDaemon({ ...model.env, PLURNK_PASS: "content-password", PLURNK_SECRET: secret }, async (base) => {
                const setup = await controller(base, secret);
                await setup.runAgent({ workspace: "content-security", action: { kind: "session/set_config_option", configId: "model", value: "browser" } });
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
                    await run.runAgent({ workspace: "content-security" });
                    assert.equal(run.messages.findLast(({ role }) => role === "assistant").content, contentAttack, "the protocol preserves the source; the browser owns its interpretation");
                    const verify = async () => {
                        await connected(page);
                        await page.waitForFunction(() => [...document.querySelectorAll('[data-message-role="assistant"] > article strong')].some((element) => element.textContent === "Readable evidence"));
                        const note = page.locator('[data-messages] [data-plurnk-note]');
                        assert.equal(await note.count(), 1);
                        assert.equal(JSON.parse(run.messages.flatMap((message) => message.toolCalls ?? []).find((call) => call.function.name === "NOTE").function.arguments).body, contentAttack);
                        assert.equal(await note.locator("article > details > pre").textContent(), contentAttack);
                        assert.equal(await note.locator("pre > *").count(), 0, "NOTE content cannot become HTML elements");
                        assert.equal(await page.locator("[data-messages]").locator("article script, article img, article form, article [id]").count(), 0);
                        assert.deepEqual(await page.locator("[data-messages] article [data-bind]").evaluateAll((elements) => elements.map((element) => ({
                            tag: element.tagName, binding: element.dataset.bind, action: element.dataset.action,
                            role: element.closest("[data-message-role]").dataset.messageRole,
                        }))), [
                            { tag: "PRE", binding: "aria-busy:body-pending", action: undefined, role: "reasoning" },
                        ],
                        "bindings belong to the document-owned reasoning reader, never authored content");
                        assert.equal(await page.locator('[data-message-role="assistant"] article [data-text]').count(), 0, "rich content cannot add bindings; literal result templates retain their owned text slot");
                        assert.equal(await page.locator('[data-messages] article a[href^="javascript:"]').count(), 0);
                        assert.equal(await page.locator("#session-status").count(), 1);
                        assert.equal(await page.locator("body > header").evaluate((element) => element.outerHTML), header);
                        assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).count(), 1);
                        assert.equal(await page.evaluate(() => window.contentExecuted), undefined);
                        await page.waitForFunction(() => document.querySelector('#session-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "completed");
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

    await t.test("{§web-working-notes} packed NOTE calls expose semantic bodies and correlated results live and on replay", async () => {
        const model = await startModel();
        try {
            await withDaemon({ ...model.env, PLURNK_AUTH: "0" }, async (base) => {
                const setup = await controller(base);
                await setup.runAgent({ workspace: "notes", action: { kind: "session/set_config_option", configId: "model", value: "browser" } });
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    await page.goto(new URL("/~/notes@user/", base).href);
                    await connected(page);
                    const run = await controller(base, undefined, prompt("notes"));
                    await run.runAgent({ workspace: "notes" });
                    const verify = async () => {
                        const notes = page.locator('[data-messages] [data-plurnk-note]');
                        await page.waitForFunction(() => document.querySelectorAll('[data-messages] [data-plurnk-note]').length === 3);
                        assert.deepEqual(await notes.evaluateAll((rows) => rows.map((row) => row.dataset.plurnkNote)), ["fact", "idea", "plan"]);
                        const note = notes.first();
                        assert.equal(await note.locator("section, div, ul").count(), 0);
                        assert.equal(await note.locator("article > details > summary").count(), 1);
                        assert.equal(await note.locator("details").evaluate((node) => node.open), false);
                        assert.equal(await note.getByRole("article", { name: "NOTE · fact", exact: true }).count(), 1);
                        assert.equal(await note.locator("article > details > pre").textContent(), "A **working fact**, not the answer.");
                        const args = JSON.parse(run.messages.flatMap((message) => message.toolCalls ?? []).find((call) => call.function.name === "NOTE").function.arguments);
                        assert.equal(args.body, "A **working fact**, not the answer.");
                        assert.equal(args.aside, "fact");
                        const id = await note.getAttribute("data-call-id");
                        const result = page.locator(`[data-message-role="tool"][data-tool-call-id="${id}"]`);
                        assert.equal(await result.count(), 0, "the real immediate receipt completes its call's summary");
                        assert.equal(await note.getAttribute("data-plurnk-status"), "200");
                        assert.ok(run.messages.some((message) => message.role === "tool" && message.toolCallId === id), "folding the presentation does not delete SDK evidence");
                        assert.ok(await page.locator('[data-message-role="assistant"] > article').filter({ hasText: "Completed notes." }).count());
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

    await t.test("{§web-footnote-content} packed SDK delivery and replay retain message-local native footnotes", async () => {
        const model = await startModel();
        try {
            await withDaemon({ ...model.env, PLURNK_AUTH: "0" }, async (base) => {
                const setup = await controller(base);
                await setup.runAgent({ workspace: "footnotes", action: { kind: "session/set_config_option", configId: "model", value: "browser" } });
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    await page.goto(new URL("/~/footnotes@user/", base).href);
                    await connected(page);
                    const run = await controller(base, undefined, prompt("footnotes"));
                    await run.runAgent({ workspace: "footnotes" });
                    assert.equal(run.messages.findLast(({ role }) => role === "assistant").content, footnoteAnswer);
                    const verify = async () => {
                        await connected(page);
                        await page.waitForFunction(() => document.querySelector('[data-message-role="assistant"]:not([data-call-id]) article section[aria-label="Footnotes"]'));
                        const answer = page.locator('[data-message-role="assistant"]:not([data-call-id]) > article').filter({ has: page.locator("section") });
                        const note = page.locator('[data-messages] [data-plurnk-note]');
                        assert.equal(await note.getByRole("article", { name: "NOTE · fact", exact: true }).count(), 1);
                        assert.equal(JSON.parse(run.messages.flatMap((message) => message.toolCalls ?? []).find((call) => call.function.name === "NOTE").function.arguments).body, footnoteAnswer);
                        assert.equal(await note.locator("article > details > pre").textContent(), footnoteAnswer);
                        assert.equal(await note.locator("[id], sup, section").count(), 0, "working notes cannot create footnote navigation");
                        const ids = await answer.locator("[id]").evaluateAll((elements) => elements.map(({ id }) => id));
                        assert.equal(ids.length, 5);
                        assert.equal(new Set(ids).size, ids.length);
                        assert.deepEqual(await answer.locator('section > ol > li > p:first-child').allTextContents(), ["First definition.", "Second definition."]);
                        assert.equal(await answer.locator("sup > a").count(), 3);
                        const reference = answer.locator("sup > a").nth(1);
                        const referenceId = await reference.getAttribute("id");
                        await reference.click();
                        assert.equal(await answer.locator(":target").count(), 1, "navigation stays within its answer");
                        await answer.getByRole("link", { name: "Back to reference 1.2", exact: true }).click();
                        assert.equal(await page.locator(":target").getAttribute("id"), referenceId);
                        assert.equal(await page.locator("#session-status").getAttribute("data-connection"), "connected");
                        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                        return ids;
                    };
                    const ids = await verify();
                    await page.reload();
                    assert.deepEqual(await verify(), ids);
                    assert.equal(model.requests.length, 1, "navigation and replay do not start inference");
                    assert.deepEqual(model.errors, []);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        } finally { await model.close(); }
    });

    await t.test("{§web-math-content} the packed session receives real messages and loads only local math assets", async () => {
        const model = await startModel();
        try {
            await withDaemon({ ...model.env, PLURNK_AUTH: "0" }, async (base) => {
                const setup = await controller(base);
                await setup.runAgent({ workspace: "math", action: { kind: "session/set_config_option", configId: "model", value: "browser" } });
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
                    await run.runAgent({ workspace: "math" });
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
                const denied = await fetch(new URL("/render/mermaid", base), { method: "POST",
                    headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "flowchart LR\n A-->B" }) });
                assert.equal(denied.status, 401, "the packed compiler uses web session admission");
                assert.equal((await denied.json()).status, 401);
                const setup = await controller(base, secret);
                await setup.runAgent({ workspace: "diagrams", action: { kind: "session/set_config_option", configId: "model", value: "browser" } });
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
                    assert.ok(!requests.some((path) => path.endsWith("/render/mermaid")), "an idle session requests no compilation");
                    const run = await controller(base, secret, prompt("diagrams"));
                    await run.runAgent({ workspace: "diagrams" });
                    assert.equal(run.messages.findLast(({ role }) => role === "assistant").content, diagramContent);
                    const verify = async () => {
                        const figure = page.locator('[data-message-role="assistant"] [data-diagram]:not([hidden])');
                        await figure.waitFor();
                        assert.equal(await figure.locator("img").evaluate((image) => image.complete && image.naturalWidth > 0 && image.src.startsWith("data:image/svg+xml;")), true);
                        assert.equal(await figure.getAttribute("data-diagram-url"), null, "the SVG is held once, by the image");
                        assert.equal(await figure.locator("details").evaluate((element) => element.open), false);
                        await figure.getByText("Diagram source", { exact: true }).click();
                        assert.equal(await figure.locator("pre code").innerText(), "flowchart LR\n Client --> Daemon\n");
                        assert.equal(await page.locator("[data-messages]").locator("article svg, article iframe, article style").count(), 0);
                        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                    };
                    await verify();
                    await page.reload();
                    await connected(page);
                    await verify();
                    assert.ok(requests.some((path) => path.endsWith("/render/mermaid")));
                    assert.ok(!requests.some((path) => /mermaid-renderer|\.wasm$/u.test(path)), "compiler stays on the daemon");
                    assert.deepEqual(unexpected, [], "no remote renderer or font requests");
                    assert.equal(model.requests.length, 1, "refresh renders retained diagrams without inference");
                    assert.deepEqual(model.errors, []);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        } finally { await model.close(); }
    });

    await t.test("{§web-diagram-content} a page with more diagrams than the service admits at once renders them all", async () => {
        const model = await startModel();
        try {
            await withDaemon({ ...model.env, PLURNK_AUTH: "0", PLURNK_WEB_DIAGRAM_PENDING: "1", PLURNK_WEB_DIAGRAM_THREADS: "1" }, async (base) => {
                const setup = await controller(base);
                await setup.runAgent({ workspace: "burst", action: { kind: "session/set_config_option", configId: "model", value: "browser" } });
                // One loop with two diagram bodies, the message's and the reply's, which replay renders together.
                const run = await controller(base, undefined, [{ id: crypto.randomUUID(), role: "user",
                    content: "Lifecycle fixture: diagrams.\n\n```mermaid\nflowchart LR\n Browser --> Web\n```" }]);
                await run.runAgent({ workspace: "burst" });
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext();
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    // Replay renders both bodies at once: two compilations against an admission of one.
                    await page.goto(new URL("/~/burst@user/", base).href);
                    await connected(page);
                    const held = () => page.evaluate(() => ({
                        rendered: document.querySelectorAll("[data-messages] [data-diagram]:not([hidden])").length,
                        refused: document.querySelectorAll("[data-messages] [data-diagram-error]").length,
                        sources: document.querySelectorAll("[data-messages] [data-mermaid]").length,
                    }));
                    try {
                        await page.waitForFunction(() => document.querySelectorAll(
                            "[data-messages] [data-diagram]:not([hidden]), [data-messages] [data-diagram-error]").length === 2, null, { timeout: 15_000 });
                    } catch (cause) { throw new Error(`Two diagrams did not settle: ${JSON.stringify(await held())}`, { cause }); }
                    assert.deepEqual(await held(), { rendered: 2, refused: 0, sources: 0 }, "both diagrams render; none is refused");
                    assert.equal(model.requests.length, 1);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        } finally { await model.close(); }
    });

    await t.test("{§web-session-conversation} the packed page projects live SDK messages and passive replay without owning work", async () => {
        const projectRoot = await mkdtemp(join(tmpdir(), "plurnk-web-conversation-"));
        const model = await startModel();
        await writeFile(join(projectRoot, "witness.txt"), "cobalt heron\n");
        try {
            await withDaemon({ ...model.env, PLURNK_AUTH: "0", PLURNK_MEMBERS_witness: "witness.txt" }, async (base) => {
                const setup = await controller(base);
                let created;
                await setup.runAgent({
                    workspace: "conversation",
                    projectRoot,
                    action: { kind: "session/set_config_option", configId: "model", value: "browser" },
                }, { onSettled: ({ result }) => { created = result; } });
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
                    assert.equal(model.requests.length, 0, "viewing an idle session starts no inference");
                    completion = run.runAgent({ workspace: "conversation" });
                    const preview = page.locator("[data-reasoning-preview]");
                    await preview.getByText("Considering conversation.", { exact: true }).waitFor();
                    assert.equal(await page.locator('[data-message-role="reasoning"]').count(), 0,
                        "{§web-session-reasoning} live text is a preview, not history");
                    assert.equal(model.requests.length, 1, "only the controlling request starts inference");
                    model.release("conversation");
                    await completion;
                    await page.getByText("Completed conversation.", { exact: true }).waitFor();
                    await connected(page);
                    assert.equal(run.messages.findLast(({ role }) => role === "assistant").content, "Completed conversation.");
                    assert.equal(await preview.isVisible(), false);
                    assert.equal(await preview.locator("pre").textContent(), "");
                    const reasoning = page.locator('[data-message-role="reasoning"]').first();
                    await reasoning.waitFor();
                    assert.equal(await reasoning.locator("details").getAttribute("open"), null);
                    assert.equal(requests.some((request) => entryRequest(request, "reasoning")), false,
                        "completed reasoning is a reference, not an automatic fetch");
                    await reasoning.locator("summary").click();
                    await reasoning.locator("[data-body-reference]").scrollIntoViewIfNeeded();
                    await reasoning.locator('[data-body-state="loaded"]').waitFor();
                    assert.equal(await reasoning.locator('[data-body-reference]').textContent(), "Considering conversation.");
                    await reasoning.evaluate((element) => { window.observedReasoning = element; window.observedBody = element.querySelector("[data-body-reference]"); });
                    const ids = () => page.locator("[data-messages] > li").evaluateAll((rows) => rows.map((row) => row.dataset.messageId));
                    const calls = await page.locator("[data-call-id]").evaluateAll((rows) => rows.map((row) => ({
                        id: row.dataset.callId, name: row.dataset.plurnkType, body: row.querySelector("article > details > pre")?.textContent ?? "",
                    })));
                    const reads = calls.filter(({ name }) => name === "READ");
                    assert.equal(reads.length, 2);
                    assert.ok(reads.every(({ body }) => body === ""), "bodyless READ calls are semantic entries, not argument envelopes");
                    const readRows = page.locator('[data-call-id][data-plurnk-type="READ"]');
                    const successful = readRows.filter({ has: page.locator('[data-plurnk-field="count"]') });
                    assert.equal(await successful.locator('[data-plurnk-field="path"]').textContent(), "(witness.txt)");
                    assert.equal(await successful.locator('[data-plurnk-field="scope"]').textContent(), "<1,1>");
                    assert.equal(await successful.locator('[data-plurnk-field="pattern"]').textContent(), "/cobalt/");
                    assert.equal(await successful.locator('[data-plurnk-field="count"]').textContent(), "{1}");
                    assert.equal(await successful.locator('[data-plurnk-field="heading"]').innerText(), "selected evidence");
                    const successfulId = await successful.getAttribute("data-call-id");
                    const evidence = run.messages.find((message) => message.role === "tool" && message.toolCallId === successfulId);
                    assert.equal((await inspectResult(evidence.content, undefined, base)).content, "cobalt heron", "actual READ bytes remain accessible through the public evidence resource");
                    const missing = run.messages.filter(({ role, content }) => role === "tool" && typeof content === "string")
                        .map(({ content }) => JSON.parse(content)).find(({ problem }) => problem?.title === "Entry not found");
                    assert.ok(missing, "the fixture actually produced a missing-entry Problem");
                    assert.ok((await readRows.locator('[data-plurnk-field="outcome"]').allTextContents()).some((text) => text.includes(missing.problem.detail)), "the real operation diagnostic is visible content");
                    assert.equal(requests.filter((request) => entryRequest(request, "log")).length, 0, "the browser does not fetch READ bodies for its summary");
                    assert.equal(await readRows.locator("a, button, [data-body-reference]").count(), 0);
                    for (const colorScheme of ["light", "dark"]) {
                        await page.emulateMedia({ colorScheme });
                        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "long literal receipts do not widen the viewport");
                        const incoming = page.locator('[data-message-role="user"]').first();
                        assert.equal(await incoming.getAttribute("data-plurnk-type"), "SEND", "the real daemon decorates incoming user messages");
                        const surface = (element) => element.evaluate((node) => getComputedStyle(node.closest("article") ?? node.querySelector("article")).backgroundColor);
                        const colors = await Promise.all([incoming, successful, page.getByText("Completed conversation.", { exact: true })].map(surface));
                        assert.equal(new Set(colors).size, 3, `${colorScheme}: real user, work and delivered reply keep three distinct surfaces`);
                    }
                    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: reasoning-followup.");
                    await page.getByRole("button", { name: "Send", exact: true }).click();
                    await page.getByText("Completed reasoning-followup.", { exact: true }).waitFor();
                    await connected(page);
                    const upload = requests.find((request) => new URL(request.url()).pathname === "/acp"
                        && request.postDataJSON()?.method === "session/prompt")?.postDataJSON();
                    assert.ok(upload, "the browser sent the follow-up through its real SDK");
                    assert.equal(upload.method, "session/prompt");
                    assert.equal(upload.params._meta.plurnk.reasoning, "link");
                    assert.deepEqual(upload.params.prompt, [{ type: "text", text: "Lifecycle fixture: reasoning-followup." }]);
                    assert.equal(JSON.stringify(upload).includes("Considering conversation."), false,
                        "neither preview nor inspected full reasoning enters a later prompt request");
                    assert.equal(await reasoning.evaluate((element) => element === window.observedReasoning), true, "passive replay retains the existing row");
                    assert.equal(await reasoning.locator("[data-body-reference]").evaluate((element) => element === window.observedBody), true);
                    assert.equal(await reasoning.locator("details").evaluate((element) => element.open), true, "native disclosure choice survives replay");
                    const beforeReload = await ids();
                    assert.equal(beforeReload.length, new Set(beforeReload).size, "reconnect does not duplicate messages");
                    await page.reload();
                    await connected(page);
                    await page.waitForFunction((count) => document.querySelectorAll("[data-messages] > li").length === count, beforeReload.length);
                    assert.deepEqual(await ids(), beforeReload, "a fresh page reads the same SDK snapshot, without a browser history store");
                    assert.equal(model.requests.length, 3, "two original calls and one explicit follow-up; replay and refresh create none");
                    assert.equal(await preview.isVisible(), false);
                    assert.equal(await page.locator('[data-message-role="reasoning"] [data-body-state="loaded"]').count(), 0);
                    assert.equal(requests.filter((request) => entryRequest(request, "reasoning")).length, 1,
                        "refresh does not re-fetch an inspected reasoning body");
                    assert.equal(requests.filter((request) => entryRequest(request, "log")).length, 0,
                        "reload does not fetch receipt bodies for summaries");
                    assert.deepEqual(model.errors, []);
                    assert.equal(await page.locator("#session-conversation form, #session-conversation textarea, #session-conversation [contenteditable]").count(), 0);
                    for (const request of requests.filter((request) => {
                        const body = request.postDataJSON();
                        return new URL(request.url()).pathname === "/acp"
                            && body?.method === "session/resume"
                            && body?.params?._meta?.plurnk?.control === false;
                    })) {
                        const input = request.postDataJSON();
                        assert.equal(input.method, "session/resume");
                        assert.equal(input.params.prompt, undefined);
                        assert.equal(input.params._meta.plurnk.reasoning, "link");
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

    await t.test("{§web-session-observer} the actual page observes consecutive loops, cancellation and workspace rename without owning work", async () => {
        const model = await startModel();
        const secret = crypto.randomUUID();
        try {
            await withDaemon({ ...model.env, PLURNK_PASS: "session-password", PLURNK_SECRET: secret, PLURNK_AUTH_ACCESS_TTL_SEC: "1" }, async (base) => {
                const workspace = '~/observer @%/<draft>&"';
                const sessionId = "user";
                const action = async (kind, parameters = {}, selected = workspace) => {
                    const agent = await controller(base, secret);
                    let result;
                    await agent.runAgent({ workspace: selected, action: { kind, ...parameters } }, {
                        onSettled: ({ result: outcome }) => { result = outcome; },
                    });
                    assert.equal(result?.ok, true, JSON.stringify(result));
                    return result.result;
                };
                const selectedResult = await action("session/set_config_option", { configId: "model", value: "browser" });
                const selected = selectedResult._meta?.plurnk?.status?.model ?? { provider: "browser-fixture", model: "browser-fixture", effort: "" };
                const { workspaces } = await action("workspace.list");
                const identity = `${workspaces.find(({ name }) => name === workspace).id}#${sessionId}`;
                const before = await action("workspace.sessions");
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext();
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    const observations = [];
                    const access = [];
                    page.on("request", (request) => {
                        const body = request.postDataJSON();
                        if (new URL(request.url()).pathname === "/acp" && body?.method === "session/resume" && body?.params?._meta?.plurnk?.control === false) {
                            observations.push(body);
                        }
                    });
                    page.on("response", async (response) => {
                        if (new URL(response.url()).pathname === "/auth/token" && response.ok()) access.push((await response.json()).access_token);
                    });
                    const path = directoryPath({ kind: "session", workspace, session: sessionId });
                    await page.goto(new URL(path, base).href);
                    await page.getByLabel("Password", { exact: true }).fill("session-password");
                    await page.getByRole("button", { name: "Continue", exact: true }).click();
                    await page.waitForURL(new URL(path, base).href);
                    assert.equal(await page.locator("#session-status").count(), 1, "the packed session page supplies the status surface");
                    const connected = () => page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                    const value = (key) => key === "lifecycle"
                        ? page.locator('#session-status [data-status-field="lifecycle"]').getAttribute("aria-label")
                        : page.locator(`#session-status [data-text="${key}"]`).textContent();
                    await connected();
                    checkBrowser();
                    assert.equal(await value("lifecycle"), "idle");
                    assert.equal(await value("input"), "0");
                    assert.equal(await value("cost"), "$0.0000");
                    assert.equal(await value("elapsed"), "");
                    assert.equal(await value("model"), "browser");
                    assert.ok((await page.locator('[data-status-field="model"]').getAttribute("aria-label")).includes(`${selected.provider}/${selected.model}`));
                    assert.equal(await value("effort"), selected.effort ?? "");
                    assert.equal(await value("wait"), "");
                    assert.equal(await family(page), "Descendant sessions: 0; active direct children: 0");
                    assert.equal(await page.locator("#session-descendants").isVisible(), false);
                    assert.equal(await page.locator('[data-status-field="preparation"]').isVisible(), false);
                    assert.equal(await page.locator("#session-status").evaluate((footer) =>
                        Boolean(document.querySelector("#session-conversation").compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING)
                        && Boolean(footer.compareDocumentPosition(document.querySelector('[aria-label="Session controls"]')) & Node.DOCUMENT_POSITION_FOLLOWING)), true,
                    "status follows conversation and precedes the real composer in document order");
                    assert.deepEqual(await action("workspace.sessions"), before);
                    assert.equal(model.requests.length, 0);

                    for (let turn = 1; turn <= 2; turn++) {
                        const run = await controller(base, secret, prompt("held-session-page"));
                        const ready = Promise.withResolvers();
                        const completion = run.runAgent({ workspace }, {
                            onThoughtChunk: () => { ready.resolve(); },
                        });
                        await ready.promise;
                        await page.waitForFunction(() => document.querySelector('#session-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "running");
                        const elapsed = await value("elapsed");
                        await page.waitForFunction((previous) => {
                            const value = document.querySelector('[data-text="elapsed"]')?.textContent;
                            return value !== "" && value !== previous;
                        }, elapsed);
                        if (turn === 1) {
                            await page.reload();
                            await connected();
                            assert.equal(run.isRunning, true, "refresh does not cancel the controlling request");
                            assert.equal(await value("lifecycle"), "running");
                            assert.equal(await page.locator("[data-reasoning-preview]").isVisible(), false,
                                "{§web-session-reasoning} a new attachment never reconstructs the ongoing attempt's preview");
                            await page.getByRole("link", { name: "Workspaces", exact: true }).first().click();
                            assert.equal(run.isRunning, true, "native navigation leaves the session running");
                            await page.goBack();
                            await connected();
                            assert.equal(await value("lifecycle"), "running");
                            assert.equal(await page.locator("[data-reasoning-preview]").isVisible(), false,
                                "history restoration does not resurrect a departed preview");
                        }
                        model.release("held-session-page");
                        await completion;
                        await page.waitForFunction((count) => document.querySelector('[data-text="input"]')?.textContent === String(400 * count)
                            && document.querySelector('[data-status-field="lifecycle"]')?.getAttribute("aria-label") === "completed", turn);
                        await connected();
                        assert.equal(await value("lifecycle"), "completed");
                        assert.equal(await value("input"), String(400 * turn));
                        assert.equal(await value("cost"), "$?");
                        assert.equal(model.requests.length, turn, "observation never submits a prompt");
                    }

                    const cancelled = await controller(base, secret, prompt("held-page-cancel"));
                    const ready = Promise.withResolvers();
                    let terminal;
                    const cancellation = cancelled.runAgent({ workspace }, {
                        onThoughtChunk: () => { ready.resolve(); },
                        onSettled: (event) => { terminal = event; },
                    });
                    await ready.promise;
                    await page.waitForFunction(() => document.querySelector('#session-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "running");
                    const cancelAgent = await controller(base, secret);
                    cancelAgent.sessionId = identity;
                    await cancelAgent.runAgent({ action: { kind: "session/cancel", reason: "browser-stop" } });
                    await cancellation;
                    assert.equal(terminal?.stopReason, "cancelled");
                    assert.equal(terminal.meta.terminal.result.problem.reason, "browser-stop");
                    await page.waitForFunction(() => document.querySelector('#session-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "cancelled");
                    await connected();
                    assert.equal(await page.getByRole("alert").isVisible(), false, "a cancelled session is not a disconnected observer");
                    assert.equal(model.requests.length, 3);

                    assert.ok(observations.length >= 5, "loop terminals, refresh and navigation reopen passive observations");
                    for (const input of observations) {
                        assert.equal(input.params.sessionId, identity);
                        assert.equal(input.method, "session/resume");
                        assert.equal(input.params.prompt, undefined);
                        assert.equal(input.params._meta?.plurnk?.workspace, undefined);
                    }
                    assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]), [[], []]);
                    assert.ok(new Set(access).size > 1, "a later connection gets a fresh credential after expiry");
                    for (const token of access) assert.equal((await page.content()).includes(token), false, "credentials never enter document state");
                    checkBrowser();
                    const after = await action("workspace.sessions");
                    assert.deepEqual(after.sessions.filter(({ origin }) => origin === "model").map(({ id, name }) => ({ id, name })),
                        before.sessions.map(({ id, name }) => ({ id, name })));

                    const renamed = "renamed observer";
                    await action("workspace.rename", { name: renamed });
                    const afterRename = await controller(base, secret, prompt("held-page-rename"));
                    afterRename.sessionId = identity;
                    const readyAfterRename = Promise.withResolvers();
                    const completionAfterRename = afterRename.runAgent({}, {
                        onThoughtChunk: () => { readyAfterRename.resolve(); },
                    });
                    await readyAfterRename.promise;
                    await page.waitForFunction(() => document.querySelector('#session-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "running");
                    model.release("held-page-rename");
                    await completionAfterRename;
                    await page.waitForFunction(() => document.querySelector('[data-status-field="lifecycle"]')?.getAttribute("aria-label") === "completed");
                    await connected();
                    assert.equal(observations.at(-1).params.sessionId, identity, "the open page reattaches by ID after another client renames its workspace");
                    assert.equal(await page.locator("#session-workspace [data-text=workspace-name]").textContent(), renamed);
                    assert.equal(await page.locator("#session-workspace a").getAttribute("href"), directoryPath({ kind: "workspace", workspace: renamed }));
                    assert.equal(await page.locator("#session-reconnect").getAttribute("action"), directoryPath({ kind: "session", workspace: renamed, session: sessionId }));
                    assert.equal(await page.title(), `${renamed}@user — Plurnk`);
                    assert.equal(page.url(), new URL(path, base).href, "a live rename does not rewrite browser history");
                    const attempts = observations.length;
                    assert.equal((await page.reload()).status(), 404, "an old named URL is not an identity alias");
                    checkBrowser([httpFailure(path, 404)]);
                    assert.equal(observations.length, attempts, "a missing directory starts no observation");
                    const renamedPath = directoryPath({ kind: "session", workspace: renamed, session: sessionId });
                    await page.goto(new URL(renamedPath, base).href);
                    await connected();
                    assert.equal(observations.at(-1).params.sessionId, identity);
                    assert.equal(await value("lifecycle"), "completed");
                    const stableSessions = (sessions) => sessions.map(({ lifecycle, ...identity }) => identity);
                    assert.deepEqual(stableSessions((await action("workspace.sessions", {}, renamed)).sessions), stableSessions(after.sessions),
                        "qualified control and named navigation preserve session identities, lineage and ownership; only the loop lifecycle changes");
                    assert.equal(model.requests.length, 4);
                    assert.deepEqual(model.errors, []);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        } finally { await model.close(); }
    });

    await t.test("{§web-session-observer} sign-out ends page observation, not independently controlled work", async () => {
        const model = await startModel();
        const secret = crypto.randomUUID();
        try {
            await withDaemon({ ...model.env, PLURNK_PASS: "revocation-password", PLURNK_SECRET: secret }, async (base) => {
                const run = await controller(base, secret, prompt("held-page-revocation"));
                const ready = Promise.withResolvers();
                const completion = run.runAgent({ workspace: "observer-revocation" }, {
                    onThoughtChunk: () => { ready.resolve(); },
                });
                await ready.promise;
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext();
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    let attempts = 0;
                    page.on("request", (request) => {
                        const body = request.postDataJSON();
                        if (new URL(request.url()).pathname === "/acp" && body?.method === "session/resume" && body?.params?._meta?.plurnk?.control === false) attempts++;
                    });
                    await page.goto(new URL("/~/observer-revocation@user/", base).href);
                    await page.getByLabel("Password", { exact: true }).fill("revocation-password");
                    await page.getByRole("button", { name: "Continue", exact: true }).click();
                    await connected(page);
                    assert.equal(await value(page, "lifecycle"), "running");
                    const second = await context.newPage();
                    await second.goto(new URL("/account/", base).href);
                    await second.getByRole("button", { name: "Sign out", exact: true }).click();
                    await second.waitForURL(base);
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "signed-out");
                    assert.equal(await page.getByRole("img", { name: "Disconnected", exact: true }).isVisible(), true);
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

    await t.test("{§web-session-observer} manual-mode pages leave approvals undecided and expose network loss and shutdown", async () => {
        const model = await startModel();
        try {
            await withDaemon({ ...model.env, PLURNK_AUTH: "0", PLURNK_WEB_YOLO: "0" }, async (base, daemon) => {
                const run = await controller(base, undefined, prompt("approval"));
                const parameters = { workspace: "observer-approval" };
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
                    assert.equal(requests.some((request) => /session-.*\.js|\/auth\/token|\/acp/u.test(request.url())), false, "directory navigation needs no session runtime");
                    await page.goto(new URL("/~/observer-approval@user/", proxy.url).href);
                    await connection(page, "interrupted");
                    assert.equal(await page.getByRole("img", { name: "Disconnected", exact: true }).isVisible(), false,
                        "an ordinary held approval remains connected");
                    assert.equal(await page.getByRole("form", { name: "Review requests", exact: true }).isVisible(), true);
                    assert.equal(await page.locator('[data-requests] input:checked').count(), 0, "passive discovery chooses nothing");
                    assert.equal(model.requests.length, 1, "the approval remains pending");
                    assert.equal(requests.filter((request) => {
                        const body = request.postDataJSON();
                        return new URL(request.url()).pathname === "/acp"
                            && body?.method === "session/resume"
                            && body?.params?._meta?.plurnk?.control === false;
                    }).length, 1, "one held passive observation");
                    assert.equal(requests.some((request) => new URL(request.url()).pathname === "/auth/token"), false);
                    for (const request of requests) assert.equal(request.headers().authorization, undefined);
                    await run.runAgent({ ...parameters, resume: [{ interruptId: run.pendingInterrupts[0].id, status: "resolved", payload: { decision: "accept" } }] });
                    assert.equal(run.pendingInterrupts.length, 0);
                    assert.equal(run.messages.findLast(({ role }) => role === "assistant").content, "Completed approval.");
                    await page.waitForFunction(() => document.querySelector('#session-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "completed");
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
                    assert.equal(await nativePage.locator("#session-status > [data-status-line]").isVisible(), false, "without delivery the footer cannot invent session state");
                    assert.equal(await value(nativePage, "lifecycle"), null);
                    assert.equal(await nativePage.getByText("No messages.", { exact: true }).isVisible(), false,
                        "a native document without conversation delivery cannot claim the existing history is empty");
                    assert.equal(nativeRequests.some((url) => /\/acp|\/auth\/token/u.test(url)), false);
                    checkNative();
                    await native.close();

                    proxy.drop();
                    await connection(page, "disconnected");
                    assert.equal(await page.getByRole("img", { name: "Disconnected", exact: true }).isVisible(), true);
                    const afterLoss = requests.length;
                    await setTimeout(1100);
                    assert.equal(requests.length, afterLoss, "an available endpoint does not trigger automatic retries after connection loss");
                    checkBrowser([
                        /^error \/acp: Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING$/u,
                        /^error \/acp: Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING$/u,
                    ]);
                    const card = page.locator('#session-connection');
                    assert.equal(await card.isVisible(), true);
                    for (const colorScheme of ["light", "dark"]) {
                        await page.emulateMedia({ colorScheme });
                        const style = await card.evaluate((element) => ({ padding: getComputedStyle(element).paddingInlineStart, shadow: getComputedStyle(element).boxShadow }));
                        assert.ok(parseFloat(style.padding) > 0);
                        assert.notEqual(style.shadow, "none");
                    }
                    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
                    await connected(page);
                    assert.equal(await page.getByRole("img", { name: "Disconnected", exact: true }).isVisible(), false);
                    assert.equal(await value(page, "input"), "800");
                    await daemon.stop();
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "disconnected");
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
