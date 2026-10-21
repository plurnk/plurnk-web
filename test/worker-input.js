import assert from "node:assert/strict";
import { HttpAgent } from "@ag-ui/client";
import { chromium } from "playwright";
import startModel from "./model-fixture.js";
import browserDiagnostics, { httpFailure } from "./browser-diagnostics.js";

export async function inputPage(withDaemon, verify, { authenticated = false, hostname = "127.0.0.1", env = {}, modelOptions = {}, selector = "browser" } = {}) {
    const model = await startModel(modelOptions);
    const secret = crypto.randomUUID();
    const workspace = `input-${crypto.randomUUID()}`;
    try {
        await withDaemon({ ...model.env, ...env, PLURNK_AUTH: authenticated ? "1" : "0", PLURNK_PASS: "compose-password", PLURNK_SECRET: secret }, async (base) => {
            const headers = {};
            if (authenticated) {
                const response = await fetch(new URL("/oauth/token", base), {
                    method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: "operator", client_secret: secret, scope: "agui" }),
                });
                assert.equal(response.status, 200);
                headers.Authorization = `Bearer ${(await response.json()).access_token}`;
            }
            const setup = new HttpAgent({ url: new URL("/agui", base).href, threadId: "user", headers });
            const initialized = await setup.runAgent({ forwardedProps: { plurnk: { workspace,
                action: selector === null ? { kind: "worker.child.set", selector: null } : { kind: "worker.model.set", selector },
            } } });
            assert.equal(initialized.result.ok, true, JSON.stringify(initialized.result));
            const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`, "--no-proxy-server"] });
            try {
                const context = await browser.newContext();
                const checkBrowser = browserDiagnostics(context);
                const page = await context.newPage();
                const address = new URL(`/~/${workspace}@user/`, base);
                address.hostname = hostname;
                const path = address.href;
                await page.goto(path);
                if (authenticated) {
                    await page.getByLabel("Password", { exact: true }).fill("compose-password");
                    await page.getByRole("button", { name: "Continue", exact: true }).click();
                    await page.waitForURL(path);
                }
                await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "connected");
                try { await verify({ page, context, path, base, model, checkBrowser, workspace, setup, headers, secret }); }
                catch (cause) {
                    const document = page.isClosed() ? "Page closed" : await page.locator("main").textContent();
                    const message = `Worker journey failed: ${JSON.stringify({ document, modelErrors: model.errors.map(String) })}`;
                    try { checkBrowser(); }
                    catch (diagnostic) { throw new AggregateError([cause, diagnostic], message, { cause: diagnostic }); }
                    throw new Error(message, { cause });
                }
                assert.deepEqual(model.errors, []);
            } finally { await browser.close(); }
        });
    } finally { await model.close(); }
}

// {§web-worker-input} Exercise the shipped controls against the real daemon, not an injected SDK.
export default async function verifyWorkerInput({ t, withDaemon }) {
    for (const hostname of ["127.0.0.1", "plurnk-browser.test"]) {
        await t.test(`{§web-worker-input} native Send retains distinct message identities on HTTP ${hostname}`, () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
            const secure = hostname === "127.0.0.1";
            assert.deepEqual(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID })),
                { secure, uuid: secure ? "function" : "undefined" }, "exercise the browser's real origin rules, without changing its APIs");
            page.on("pageerror", (error) => t.diagnostic(error.message));
            const inputs = [];
            page.on("request", (request) => { if (new URL(request.url()).pathname === "/agui") inputs.push(request.postDataJSON()); });
            const field = page.getByRole("textbox", { name: "Message", exact: true });
            for (const name of ["origin-first", "origin-second"]) {
                await field.fill(`Lifecycle fixture: ${name}.`);
                await page.getByRole("button", { name: "Send", exact: true }).click();
                await page.getByText(`Completed ${name}.`, { exact: true }).waitFor({ timeout: 5000 });
                await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "connected");
                assert.equal(await field.inputValue(), "", "authoritative admission clears the draft");
            }
            const ids = inputs.map((input) => input.messages.at(-1).id);
            assert.equal(inputs.length, 2);
            assert.equal(new Set(ids).size, 2);
            for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
            await page.reload();
            await page.getByText("Completed origin-second.", { exact: true }).waitFor();
            assert.deepEqual(await page.locator('[data-message-role="user"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.messageId)), ids);
            assert.equal(model.requests.length, 2, "rediscovery does not repeat either submission");
            checkBrowser();
        }, { hostname }));
    }
    await t.test("{§web-worker-input} native Send continues an observed worker and Stop explicitly cancels its work", async () => {
        const model = await startModel();
        try {
            await withDaemon({ ...model.env, PLURNK_AUTH: "0" }, async (base) => {
                const setup = new HttpAgent({ url: new URL("/agui", base).href, threadId: "user" });
                await setup.runAgent({ forwardedProps: { plurnk: { workspace: "composer", action: { kind: "worker.model.set", selector: "browser" } } } });
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 700 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    const inputs = [];
                    page.on("request", (request) => {
                        if (new URL(request.url()).pathname === "/agui") inputs.push(request.postDataJSON());
                    });
                    await page.goto(new URL("/~/composer@user/", base).href);
                    await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "connected");
                    assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).count(), 1);
                    const text = page.getByRole("textbox", { name: "Message", exact: true });
                    const send = page.getByRole("button", { name: "Send", exact: true });
                    const stop = page.getByRole("button", { name: "Stop", exact: true });
                    assert.equal(await send.isEnabled(), true);
                    assert.equal(await stop.count(), 0, "idle work has no Stop in the accessible controls");
                    assert.equal(model.requests.length, 0, "opening a composer remains passive");
                    await text.fill("   \n   ");
                    await send.click();
                    assert.equal(inputs.length, 0, "whitespace-only messages are not submitted");

                    const body = "  Lifecycle fixture: held-input.\nKeep this exact text.  ";
                    await text.fill(body);
                    await send.click();
                    await page.getByText("Considering held-input.", { exact: true }).waitFor({ state: "attached" });
                    assert.equal(await text.inputValue(), "", "daemon admission clears the submitted draft");
                    assert.equal(await send.isEnabled(), true, "a running worker can receive a follow-up");
                    assert.equal(await stop.isEnabled(), true);
                    assert.equal(inputs[0].messages.at(-1).content, body);
                    assert.deepEqual(inputs[0].tools.map(({ name }) => name), ["question", "mcp_input_required"]);
                    assert.equal(inputs[0].forwardedProps?.plurnk?.interactive, true);
                    assert.equal(inputs[0].forwardedProps?.plurnk?.reasoning, "link");
                    assert.equal(inputs[0].forwardedProps?.plurnk?.workspace, undefined);

                    await text.fill("Lifecycle fixture: follow-up.");
                    await send.click();
                    await page.waitForFunction(() => document.querySelector("#worker-message")?.value === "", undefined, { timeout: 1000 });
                    assert.equal(await send.isEnabled(), true, "accepted input is acknowledged before the next model turn");
                    assert.equal(model.requests.length, 1, "handoff neither restarts nor cancels the running inference");
                    assert.equal(await page.locator("[data-reasoning-preview]").isVisible(), false,
                        "{§web-worker-reasoning} delivery handoff clears the old live preview");
                    assert.equal(JSON.stringify(inputs[1].messages).includes("Considering held-input."), false);
                    assert.equal(await page.locator('#worker-status [data-text="inbox"]').textContent(), "1");
                    const accepted = await page.locator('[data-message-role="user"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.messageId));
                    assert.deepEqual(accepted, inputs.map((input) => input.messages.at(-1).id), "accepted message identities belong to their conversation entries, not a second inventory");
                    await page.reload();
                    await page.getByText("Lifecycle fixture: follow-up.", { exact: true }).waitFor();
                    assert.deepEqual(await page.locator('[data-message-role="user"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.messageId)), accepted);
                    assert.equal(model.requests.length, 1, "fresh replay includes the accepted follow-up without resubmitting it");
                    assert.equal(await page.locator('#worker-status [data-text="inbox"]').textContent(), "1", "accepted-unobserved state survives attachment");
                    model.release("held-input");
                    await page.getByText("Completed follow-up.", { exact: true }).waitFor();
                    assert.equal(await text.inputValue(), "");
                    await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "connected"
                        && document.querySelector('#worker-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "completed");
                    assert.equal(model.requests.length, 2);
                    assert.equal(await stop.count(), 0, "completed work has no Stop");
                    assert.equal(await page.locator('#worker-status [data-text="inbox"]').textContent(), "0");
                    assert.equal(await page.locator('[data-status-field="inbox"]').isVisible(), false, "observed messages clear the pending indicator");
                    assert.equal(await page.locator('[data-message-role="user"]').count(), 2);
                    assert.equal(await page.getByText("Lifecycle fixture: follow-up.", { exact: true }).count(), 1, "arrival does not repeat accepted text");
                    assert.equal(inputs.length, 2);
                    const history = await page.locator("[data-messages] > li").evaluateAll((nodes) => nodes.map((node) => node.dataset.messageId));
                    assert.ok(history.length > 2 && history.every(Boolean));
                    assert.equal(new Set(history).size, history.length);
                    await page.reload();
                    await page.getByText("Completed follow-up.", { exact: true }).waitFor();
                    assert.deepEqual(await page.locator("[data-messages] > li").evaluateAll((nodes) => nodes.map((node) => node.dataset.messageId)), history);
                    assert.equal(model.requests.length, 2);

                    await text.fill("Lifecycle fixture: held-input-stop.");
                    await send.click();
                    await page.getByText("Considering held-input-stop.", { exact: true }).waitFor({ state: "attached" });
                    await text.fill("Unsent draft survives Stop.");
                    await stop.click();
                    await page.waitForFunction(() => document.querySelector('#worker-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "cancelled"
                        && document.querySelector("#worker-status")?.dataset.connection === "connected");
                    assert.equal(await text.inputValue(), "Unsent draft survives Stop.");
                    assert.equal(await stop.count(), 0, "confirmed cancellation removes Stop");
                    assert.equal(model.requests.length, 3);
                    const action = inputs.at(-1);
                    assert.equal(action.threadId, inputs[0].threadId);
                    assert.equal(action.forwardedProps.plurnk.action.kind, "loop.cancel");
                    assert.equal(action.forwardedProps.plurnk.reasoning, "link");
                    assert.equal(await page.locator("[data-reasoning-preview]").isVisible(), false);
                    assert.deepEqual(action.messages, [], "cancellation does not resubmit conversation history");
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                    assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]), [[], []]);
                    assert.deepEqual(model.errors, []);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        } finally { await model.close(); }
    });

    await t.test("{§web-worker-input} a manual approval stays pending; Stop and a subsequent message need no approval-state workaround", async () => {
        const model = await startModel();
        try {
            await withDaemon({ ...model.env, PLURNK_AUTH: "0", PLURNK_WEB_YOLO: "0" }, async (base) => {
                const setup = new HttpAgent({ url: new URL("/agui", base).href, threadId: "user" });
                await setup.runAgent({ forwardedProps: { plurnk: { workspace: "review", action: { kind: "worker.model.set", selector: "browser" } } } });
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext();
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    await page.goto(new URL("/~/review@user/", base).href);
                    const text = page.getByRole("textbox", { name: "Message", exact: true });
                    const send = page.getByRole("button", { name: "Send", exact: true });
                    const stop = page.getByRole("button", { name: "Stop", exact: true });
                    await text.fill("Lifecycle fixture: approval-input.");
                    await send.click();
                    await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "interrupted");
                    assert.equal(await text.inputValue(), "");
                    assert.equal(await send.isDisabled(), true);
                    assert.equal(await stop.isEnabled(), true);
                    assert.equal(await page.getByRole("form", { name: "Review requests", exact: true }).isVisible(), true);
                    assert.equal(await page.locator('[data-requests] input:checked').count(), 0, "only the user can choose a decision");
                    assert.equal(model.requests.length, 1);
                    assert.equal(await page.locator('[data-message-role="tool"]').count(), 0, "no approval is fabricated");
                    await page.reload();
                    await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "interrupted");
                    assert.equal(model.requests.length, 1, "reopening does not answer the gate");
                    await text.fill("A draft to keep.");
                    await stop.click();
                    await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "connected"
                        && document.querySelector('#worker-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "cancelled");
                    assert.equal(await text.inputValue(), "A draft to keep.");
                    await text.fill("Lifecycle fixture: after-stop.");
                    await send.click();
                    await page.getByText("Completed after-stop.", { exact: true }).waitFor();
                    assert.equal(model.requests.length, 2);
                    assert.deepEqual(model.errors, []);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        } finally { await model.close(); }
    });

    await t.test("{§web-worker-input} authenticated admission preserves newer typing and departure never cancels work", () => inputPage(withDaemon, async ({ page, context, path, model, checkBrowser }) => {
        const reached = Promise.withResolvers();
        const release = Promise.withResolvers();
        const requests = [];
        page.on("request", (request) => { if (new URL(request.url()).pathname === "/agui") requests.push(request.postDataJSON()); });
        await page.route("**/agui", async (route) => {
            reached.resolve();
            await release.promise;
            await route.continue();
        }, { times: 1 });
        const text = page.getByRole("textbox", { name: "Message", exact: true });
        const send = page.getByRole("button", { name: "Send", exact: true });
        try {
            await text.fill("Lifecycle fixture: admission.");
            await send.click();
            await reached.promise;
            assert.equal(await send.isDisabled(), true);
            assert.equal(await text.inputValue(), "Lifecycle fixture: admission.");
            await text.fill("Newer typing must survive the acknowledgement.");
            await page.locator("#worker-compose").evaluate((form) => form.requestSubmit());
            assert.equal(requests.length, 1, "a second submission cannot duplicate unconfirmed input");
        } finally { release.resolve(); }
        await page.getByText("Completed admission.", { exact: true }).waitFor();
        assert.equal(await text.inputValue(), "Newer typing must survive the acknowledgement.");
        assert.equal(model.requests.length, 1);
        const observer = await context.newPage();
        await observer.goto(path);
        await observer.getByText("Completed admission.", { exact: true }).waitFor();
        for (const departure of ["navigate", "close"]) {
            await text.fill(`Lifecycle fixture: held-${departure}-input.`);
            await send.click();
            await page.getByText(`Considering held-${departure}-input.`, { exact: true }).waitFor({ state: "attached" });
            assert.equal(await text.inputValue(), "");
            if (departure === "navigate") await page.getByRole("link", { name: "Workspaces", exact: true }).first().click();
            else await page.close();
            model.release(`held-${departure}-input`);
            await observer.getByText(`Completed held-${departure}-input.`, { exact: true }).waitFor();
            if (departure === "navigate") {
                await page.goBack();
                await page.getByText("Completed held-navigate-input.", { exact: true }).waitFor();
            }
        }
        assert.equal(model.requests.length, 3);
        assert.equal(requests.length, 3);
        assert.equal(requests.some((input) => input.forwardedProps?.plurnk?.action), false);
        await observer.reload();
        await observer.getByText("Completed held-close-input.", { exact: true }).waitFor();
        assert.equal(await observer.locator('[data-message-role="user"]').count(), 3);
        checkBrowser();
    }, { authenticated: true }));

    await t.test("{§web-worker-input} refused delivery keeps its draft through explicit reconnection without retrying", () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        const requests = [];
        page.on("request", (request) => { if (new URL(request.url()).pathname === "/agui") requests.push(request.postDataJSON()); });
        await page.route("**/agui", (route) => route.abort("failed"), { times: 1 });
        const text = page.getByRole("textbox", { name: "Message", exact: true });
        const send = page.getByRole("button", { name: "Send", exact: true });
        await text.fill("Lifecycle fixture: delivery-retry.");
        await send.click();
        await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "disconnected");
        assert.equal(await text.inputValue(), "Lifecycle fixture: delivery-retry.");
        assert.equal(await send.isDisabled(), true);
        assert.match(await page.locator('[aria-label="Message feedback"] [role="alert"]').innerText(), /delivery is unconfirmed/u);
        assert.match(await page.locator('#worker-connection').innerText(), /Failed to fetch/u, "the transport failure remains visible beside the stale state");
        assert.equal(model.requests.length, 0);
        assert.equal(requests.length, 1);
        checkBrowser([
            /^error \/agui: Failed to load resource: net::ERR_FAILED$/u,
            /^error \/assets\/worker-[^/]+\.js: Agent execution failed: TypeError: Failed to fetch$/u,
        ]);
        await page.getByRole("button", { name: "Reconnect", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "connected");
        assert.equal(await text.inputValue(), "Lifecycle fixture: delivery-retry.");
        assert.equal(model.requests.length, 0, "reconnection submits no message");
        assert.equal(requests.length, 1);
        await send.click();
        await page.getByText("Completed delivery-retry.", { exact: true }).waitFor();
        assert.equal(model.requests.length, 1);
        assert.equal(requests.length, 2);
        assert.equal(requests[0].messages.at(-1).id, requests[1].messages.at(-1).id, "a deliberate retry retains the message's idempotency key");
        checkBrowser();
    }));

    for (const [label, status, body, explanation] of [
        ["HTTP failure", 502, '{"access_token":"not-a-diagnostic"}', "Access credential request failed (502)."],
        ["invalid JSON", 200, '{"access_token":"not-a-diagnostic",', "Access credential response is not valid JSON."],
        ["invalid shape", 200, '{"access_token":"not-a-diagnostic","token_type":"Unknown"}', "Invalid access credential response."],
        ["null response", 200, "null", "Invalid access credential response."],
    ]) {
        await t.test(`{§web-worker-observer} ${label} retains safe failure detail and never exposes credential bytes`, () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
            await page.route("**/auth/token", (route) => route.fulfill({ status, contentType: "application/json", body }), { times: 1 });
            const field = page.getByRole("textbox", { name: "Message", exact: true });
            await field.fill("Keep this draft on credential failure.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "disconnected");
            assert.ok((await page.locator('#worker-connection').innerText()).includes(explanation));
            assert.doesNotMatch(await page.locator("body").innerText(), /not-a-diagnostic/u);
            assert.equal(await field.inputValue(), "Keep this draft on credential failure.");
            assert.equal(model.requests.length, 0);
            checkBrowser(status === 200 ? [] : [httpFailure("/auth/token", status)]);
            await page.getByRole("button", { name: "Reconnect", exact: true }).click();
            await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "connected");
            assert.equal(await field.inputValue(), "Keep this draft on credential failure.");
            assert.equal(model.requests.length, 0, "reconnection repairs delivery, not resubmits the draft");
            checkBrowser();
        }, { authenticated: true }));
    }

    await t.test("{§web-worker-input} expired browser authority cannot submit or silently replace a draft", () => inputPage(withDaemon, async ({ page, context, base, model, checkBrowser }) => {
        const reached = Promise.withResolvers();
        const release = Promise.withResolvers();
        await page.route("**/auth/token", async (route) => {
            reached.resolve();
            await release.promise;
            await route.continue();
        }, { times: 1 });
        const text = page.getByRole("textbox", { name: "Message", exact: true });
        try {
            await text.fill("Lifecycle fixture: unauthorised.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await reached.promise;
            const logout = await context.request.post(new URL("/auth/logout", base).href, { headers: { Origin: new URL(base).origin }, maxRedirects: 0 });
            assert.equal(logout.status(), 303);
        } finally { release.resolve(); }
        await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "signed-out");
        assert.equal(await text.inputValue(), "Lifecycle fixture: unauthorised.");
        assert.equal(model.requests.length, 0);
        assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
        assert.equal(await page.getByRole("link", { name: "Sign in", exact: true }).isVisible(), true);
        checkBrowser([httpFailure("/auth/token", 401)]);
    }, { authenticated: true }));

    await t.test("{§web-worker-input} delivery lost before acknowledgement is rediscovered without submitting again", () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        const requests = [];
        const truncated = Promise.withResolvers();
        page.on("request", (request) => { if (new URL(request.url()).pathname === "/agui") requests.push(request.postDataJSON()); });
        await page.route("**/agui", async (route) => {
            try {
                const response = await route.fetch();
                assert.equal(response.status(), 200);
                const frames = (await response.text()).split("\n\n");
                assert.equal(JSON.parse(frames[0].slice(6)).type, "RUN_STARTED");
                const prefix = frames[0] + "\n\n";
                // Truncate actual daemon delivery, without inventing an event or changing the admitted input.
                await route.fulfill({ status: 200, contentType: "text/event-stream", body: prefix });
                truncated.resolve();
            } catch (error) {
                await route.abort();
                truncated.reject(error);
            }
        }, { times: 1 });
        const text = page.getByRole("textbox", { name: "Message", exact: true });
        await text.fill("Lifecycle fixture: lost-acknowledgement.");
        await Promise.all([page.getByRole("button", { name: "Send", exact: true }).click(), truncated.promise]);
        await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "disconnected");
        assert.equal(await text.inputValue(), "Lifecycle fixture: lost-acknowledgement.");
        assert.match(await page.locator('[aria-label="Message feedback"] [role="alert"]').innerText(), /delivery is unconfirmed/u);
        assert.match(await page.locator('#worker-connection').innerText(), /Delivery ended without a worker outcome\./u);
        assert.equal(model.requests.length, 1, "the work completed, but this page has not received its acknowledgement");
        await page.getByRole("button", { name: "Reconnect", exact: true }).click();
        await page.getByText("Completed lost-acknowledgement.", { exact: true }).waitFor();
        assert.equal(await text.inputValue(), "", "authoritative rediscovery finally confirms admission");
        assert.equal(await page.locator('[aria-label="Message feedback"] [role="alert"]').isVisible(), false);
        assert.equal(requests.length, 1);
        assert.equal(model.requests.length, 1);
        checkBrowser();
    }));

    await t.test("{§web-worker-input} Stop retains an accepted follow-up that the worker never observed", () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        const text = page.getByRole("textbox", { name: "Message", exact: true });
        const send = page.getByRole("button", { name: "Send", exact: true });
        await text.fill("Lifecycle fixture: held-unobserved.");
        await send.click();
        await page.getByText("Considering held-unobserved.", { exact: true }).waitFor({ state: "attached" });
        await text.fill("Lifecycle fixture: unobserved-follow-up.");
        await send.click();
        await page.waitForFunction(() => document.querySelector("#worker-message")?.value === "", undefined, { timeout: 1000 });
        const accepted = await page.locator('[data-message-role="user"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.messageId));
        assert.equal(accepted.length, 2);
        assert.equal(await text.inputValue(), "");
        assert.equal(await text.evaluate((field) => field.checkValidity()), false, "the empty required message cannot be submitted");
        await page.getByRole("button", { name: "Stop", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#worker-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "cancelled"
            && document.querySelector("#worker-status")?.dataset.connection === "connected");
        assert.equal(model.requests.length, 1, "cancellation precedes the next model turn");
        assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).count(), 0, "Stop bypasses unrelated message validation and disappears after cancellation");
        assert.equal(await page.getByText("Completed unobserved-follow-up.", { exact: true }).count(), 0);
        await page.reload();
        await page.getByText("Lifecycle fixture: unobserved-follow-up.", { exact: true }).waitFor();
        assert.deepEqual(await page.locator('[data-message-role="user"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.messageId)), accepted);
        assert.equal(model.requests.length, 1, "rediscovery neither erases nor resubmits cancelled input");
        assert.equal(await page.locator('#worker-status [data-text="inbox"]').textContent(), "1");
        assert.equal(await page.locator('[data-status-field="inbox"]').getAttribute("aria-label"), "Accepted messages not yet observed: 1");
        assert.equal(await page.locator('[data-status-field="lifecycle"]').getAttribute("aria-label"), "cancelled", "a pending message count never implies cancelled input is still executing");
        checkBrowser();
    }));

    await t.test("{§web-worker-input} a failed Stop is visible and does not cancel work by closing delivery", () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        const text = page.getByRole("textbox", { name: "Message", exact: true });
        await text.fill("Lifecycle fixture: held-stop-failure.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.getByText("Considering held-stop-failure.", { exact: true }).waitFor({ state: "attached" });
        await text.fill("Keep my next message.");
        const response = Promise.withResolvers();
        await page.route("**/agui", async (route) => {
            assert.equal(route.request().postDataJSON().forwardedProps.plurnk.action.kind, "loop.cancel");
            await response.promise;
            return route.abort("failed");
        }, { times: 1 });
        const stop = page.getByRole("button", { name: "Stop", exact: true });
        try {
            await stop.click();
            assert.equal(await stop.isVisible(), true, "pending cancellation is not a worker outcome");
            assert.equal(await stop.isDisabled(), true, "an outstanding cancellation cannot be resubmitted");
        } finally { response.resolve(); }
        await page.getByText(/Stop could not be confirmed:/u).waitFor();
        assert.equal(await stop.isEnabled(), true, "unconfirmed Stop does not settle known live work");
        assert.equal(await text.inputValue(), "Keep my next message.");
        assert.equal(await page.locator('#worker-status [data-status-field="lifecycle"]').getAttribute("aria-label"), "running");
        model.release("held-stop-failure");
        await page.getByText("Completed held-stop-failure.", { exact: true }).waitFor();
        assert.equal(model.requests.length, 1);
        checkBrowser([
            /^error \/agui: Failed to load resource: net::ERR_FAILED$/u,
            /^error \/assets\/worker-[^/]+\.js: Agent execution failed: TypeError: Failed to fetch$/u,
        ]);
    }));

    await t.test("{§web-worker-input} a provider failure is displayed as a worker failure after message admission", () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        const text = page.getByRole("textbox", { name: "Message", exact: true });
        await text.fill("Exercise the rejected browser request.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#worker-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "failed"
            && document.querySelector("#worker-status")?.dataset.connection === "connected");
        assert.equal(await text.inputValue(), "", "admission succeeded even though the model request failed");
        assert.match(await page.locator('[aria-label="Message feedback"] [role="alert"]').innerText(), /Browser fixture deliberately refused this request/u);
        assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).count(), 0, "failed work is no longer stoppable");
        assert.equal(model.requests.length, 1);
        checkBrowser();
    }));
}
