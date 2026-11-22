import assert from "node:assert/strict";
import { after } from "node:test";
import { chromium } from "playwright";
import SessionAgent from "../web/session-agent.js";
import disconnectProxy from "./disconnect-proxy.js";
import { launchBrowser } from "./engines.js";
import startModel from "./model-fixture.js";
import browserDiagnostics, { httpFailure, networkFailure } from "./browser-diagnostics.js";
import { PNG_1X1_BASE64 } from "./inline-images-browser.js";
import startMockOidcIdp from "./mock-oidc-idp.js";

/**
 * @typedef {object} SharedDaemonEntry
 * @property {Awaited<ReturnType<typeof startModel>>} model
 * @property {Awaited<ReturnType<typeof startMockOidcIdp>> | null} idp
 * @property {string} base
 * @property {Record<string, string>} headers
 * @property {() => Promise<void>} close
 */

/** @type {Map<string, Promise<SharedDaemonEntry>>} */
const sharedDaemons = new Map();

/**
 * Reuse one warm daemon + model fixture per `(authenticated, env)` configuration across isolated workspace tests.
 * @param {(overrides: Record<string, string>, verify: (base: string) => Promise<void>) => Promise<void>} withDaemon
 * @param {boolean} authenticated
 * @param {Record<string, string>} [env]
 */
export async function acquireSharedDaemon(withDaemon, authenticated, env = {}) {
    const key = JSON.stringify({
        authenticated,
        env: Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
    });
    let pending = sharedDaemons.get(key);
    if (!pending) {
        pending = (async () => {
            const model = await startModel();
            const idp = authenticated ? await startMockOidcIdp({ autoApprove: true }) : null;
            const ready = Promise.withResolvers();
            const release = Promise.withResolvers();
            const done = withDaemon(
                { ...model.env, ...(idp ? idp.env : {}), ...env },
                async (base) => {
                    ready.resolve(base);
                    await release.promise;
                },
            );
            done.catch((error) => ready.reject(error));
            const base = await ready.promise;
            /** @type {Record<string, string>} */
            const headers = {};
            if (idp) {
                headers.Authorization = `Bearer ${idp.mintToken()}`;
            }
            return {
                model,
                idp,
                base,
                headers,
                async close() {
                    release.resolve();
                    await Promise.allSettled([done, model.close(), ...(idp ? [idp.close()] : [])]);
                },
            };
        })();
        sharedDaemons.set(key, pending);
    }
    return pending;
}

export async function closeSharedDaemons() {
    const entries = [...sharedDaemons.values()];
    sharedDaemons.clear();
    await Promise.allSettled(entries.map(async (entry) => (await entry).close()));
}

after(closeSharedDaemons);

const acpListeners = new WeakMap();
const routedPages = new WeakSet();

function isReadOnlyDirectoryAcp(body) {
    if (body === null || typeof body !== "object") return false;
    if (body.method === "session/list") return true;
    return body.method === "_plurnk/action"
        && ["workspace.list", "workspace.sessions", "session.loops"].includes(body.params?.kind);
}

function emitAcpPayload(listeners, payload, transport) {
    for (const line of String(payload).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed;
        try { parsed = JSON.parse(trimmed); } catch { continue; }
        if (isReadOnlyDirectoryAcp(parsed)) continue;
        for (const fn of listeners) fn(parsed, transport);
    }
}

export function installAcpRecorder(page) {
    let listeners = acpListeners.get(page);
    if (listeners) return listeners;
    listeners = new Set();
    acpListeners.set(page, listeners);
    const seenWs = new WeakSet();
    page.on("websocket", (ws) => {
        if (seenWs.has(ws)) return;
        let pathname;
        try { pathname = new URL(ws.url()).pathname; } catch { return; }
        if (pathname !== "/acp") return;
        seenWs.add(ws);
        ws.on("framesent", ({ payload }) => {
            if (routedPages.has(page)) return;
            emitAcpPayload(listeners, payload, "ws");
        });
    });
    page.on("request", (req) => {
        let pathname;
        try { pathname = new URL(req.url()).pathname; } catch { return; }
        if (pathname !== "/acp" || req.method() !== "POST") return;
        let body;
        try { body = req.postDataJSON(); } catch { return; }
        if (body !== null && !isReadOnlyDirectoryAcp(body)) {
            for (const fn of listeners) fn(body, "http");
        }
    });
    return listeners;
}

export function onAcpSent(page, listener) {
    installAcpRecorder(page).add(listener);
}

export async function routeAcpWebSocket(page, handler) {
    const listeners = installAcpRecorder(page);
    await page.routeWebSocket("**/acp*", (ws) => {
        routedPages.add(page);
        let server = null;
        let hasUserHandler = false;
        const wrapped = new Proxy(ws, {
            get(target, prop, receiver) {
                if (prop === "connectToServer") {
                    return (...args) => {
                        server = target.connectToServer(...args);
                        return server;
                    };
                }
                if (prop === "onMessage") {
                    return (fn) => {
                        hasUserHandler = true;
                        return target.onMessage((message) => {
                            emitAcpPayload(listeners, message, "ws");
                            return fn(message);
                        });
                    };
                }
                const val = Reflect.get(target, prop, receiver);
                return typeof val === "function" ? val.bind(target) : val;
            },
        });
        handler(wrapped);
        if (!hasUserHandler && server !== null) {
            const upstream = server;
            ws.onMessage((message) => {
                emitAcpPayload(listeners, message, "ws");
                upstream.send(message);
            });
        }
    });
}

export async function inputPage(withDaemon, verify, { authenticated = false, hostname = "127.0.0.1", env = {}, modelOptions = {}, selector = "browser", contextOptions = {} } = {}) {
    const shared = await acquireSharedDaemon(withDaemon, authenticated, env);
    const { model, idp, base } = shared;
    for (const engine of [chromium]) {
        model.reset(modelOptions);
        const headers = { ...shared.headers };
        const workspace = `input-${engine.name()}-${crypto.randomUUID()}`;
        const setup = new SessionAgent({ url: new URL("/acp", base).href, sessionId: "session1", headers });
        const initialized = await setup.send({
            workspace,
            action: selector === null
                ? { kind: "session/new" }
                : { kind: "session/set_config_option", configId: "model", value: selector },
        });
        assert.equal(initialized.result.ok, true, JSON.stringify(initialized.result));
        const hostProxy = hostname === "127.0.0.1" ? null : await disconnectProxy(base);
        const browser = await launchBrowser(engine);
        try {
            const context = await browser.newContext({
                ...contextOptions,
                ...(hostProxy ? { proxy: { server: hostProxy.url } } : {}),
            });
            context.on("page", installAcpRecorder);
            const checkBrowser = browserDiagnostics(context);
            const address = new URL(`/~/${workspace}#session1`, base);
            address.hostname = hostname;
            const path = address.href;
            if (authenticated && idp && hostname !== "127.0.0.1") {
                const seededGrant = {
                    acpOrigin: address.origin,
                    issuer: idp.issuer,
                    clientId: idp.clientId,
                    tokenEndpoint: `${idp.issuer}/token`,
                    accessToken: idp.mintToken(),
                };
                await context.addInitScript((grant) => {
                    if (location.protocol === "about:") return;
                    localStorage.setItem("plurnk_oidc_grant", JSON.stringify(grant));
                }, seededGrant);
            }
            const page = await context.newPage();
            await page.goto(path);
            if (authenticated && hostname === "127.0.0.1") {
                await page.waitForURL((url) => new URL(url).pathname === `/~/${workspace}`);
            }
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
            if (authenticated && hostname === "127.0.0.1") {
                checkBrowser([
                    Object.assign(httpFailure("/acp", 401), { optional: true }),
                    Object.assign(httpFailure("/notifications", 401), { optional: true }),
                    Object.assign(networkFailure("/acp"), { optional: true }),
                ]);
            }
            try { await verify({ page, context, path, base, model, idp, checkBrowser, workspace, setup, headers, engine }); }
            catch (cause) {
                const document = page.isClosed() ? "Page closed" : await page.locator("main").textContent();
                const message = `Session journey failed (${engine.name()}): ${JSON.stringify({ document, modelErrors: model.errors.map(String) })}`;
                try { checkBrowser(); }
                catch (diagnostic) { throw new AggregateError([cause, diagnostic], message, { cause: diagnostic }); }
                throw new Error(message, { cause });
            }
            assert.deepEqual(model.errors, []);
        } finally {
            setup.close();
            await browser.close();
            await hostProxy?.close();
        }
    }
}


// {§web-session-input} Exercise the shipped controls against the real daemon, not an injected SDK.
export default async function verifySessionInput({ t, withDaemon }) {
    await t.test("{§web-session-input} Enter, Ctrl+Enter, and Meta+Enter use native submission while Shift+Enter and Ctrl+J edit multiline drafts", () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        const field = page.getByRole("textbox", { name: "Message", exact: true });
        const send = page.getByRole("button", { name: "Send", exact: true });
        assert.equal(await send.getAttribute("aria-keyshortcuts"), "Enter Control+Enter Meta+Enter");
        assert.equal(await send.getAttribute("title"), "Send (Enter · Ctrl+Enter)");
        const inputs = [];
        onAcpSent(page, (body) => {
            if (body !== null && body.method !== "initialize" && body.params?._meta?.plurnk?.control !== false) {
                inputs.push(body);
            }
        });
        await field.press("Enter");
        assert.equal(await field.evaluate((element) => element.validity.valueMissing), true);
        await field.fill(" \n ");
        await field.press("Control+Enter");
        assert.equal(await field.evaluate((element) => element.validity.customError), true, "the ordinary submit handler rejects whitespace");
        assert.equal(await page.locator('[aria-label="Message feedback"] [role="status"]').isVisible(), false);
        assert.equal(inputs.length, 0);
        await field.fill("Lifecycle fixture: keyboard-input.");
        await field.press("End");
        await field.press("Shift+Enter");
        await field.pressSequentially("Keep this second line.");
        await field.press("Control+j");
        await field.pressSequentially("And Ctrl+J third line.");
        const body = await field.inputValue();
        assert.equal(body, "Lifecycle fixture: keyboard-input.\nKeep this second line.\nAnd Ctrl+J third line.");
        for (const flags of [{ isComposing: true }, { repeat: true }, { altKey: true }, { ctrlKey: true, metaKey: true }]) {
            await field.dispatchEvent("keydown", { key: "Enter", ...flags });
        }
        assert.equal(await field.inputValue(), body);
        assert.equal(await page.locator('[aria-label="Message feedback"] [role="status"]').isVisible(), false);
        assert.equal(inputs.length, 0, "editing and composition do not submit");
        await field.press("Enter");
        await page.getByText("Completed keyboard-input.", { exact: true }).waitFor({ timeout: 5000 });
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
        assert.equal(inputs.length, 1);
        assert.equal(inputs[0].params.prompt[0].text, body);
        assert.equal(await field.inputValue(), "", "daemon admission clears the shortcut-submitted draft");
        await field.fill("/help");
        await field.press("Meta+Enter");
        await page.waitForURL((url) => new URL(url).pathname === "/settings/" && new URL(url).hash === "#help");
        await page.locator('#workspace-settings [data-settings-panel="help"] ul[aria-label="Supported commands"]').waitFor({ state: "visible" });
        assert.equal(inputs.length, 1, "Meta+Enter routes commands through the same non-model path");
        await page.locator("[data-settings-back]").click();
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
        await routeAcpWebSocket(page, (ws) => ws.close({ code: 3001, reason: "Unavailable" }));
        await page.reload();
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "disconnected");
        await field.fill("Retain this draft while disconnected.");
        assert.equal(await send.isDisabled(), true);
        for (const chord of ["Enter", "Control+Enter", "Meta+Enter"]) {
            await field.press(chord);
        }
        assert.equal(await field.inputValue(), "Retain this draft while disconnected.");
        assert.equal(await page.locator('[aria-label="Message feedback"] [role="status"]').isVisible(), false);
        assert.equal(inputs.length, 1, "keyboard submission cannot bypass unavailable delivery");
        assert.equal(model.requests.length, 1);
        checkBrowser([
            networkFailure("/acp"),
        ]);
    }));
    await t.test("{§web-session-input} Apple keycap hints and coarse-pointer virtual keyboards preserve Enter newline while keeping Cmd/Ctrl+Enter submission", () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        const field = page.getByRole("textbox", { name: "Message", exact: true });
        const send = page.getByRole("button", { name: "Send", exact: true });
        assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true);
        assert.equal(await send.getAttribute("aria-keyshortcuts"), "Control+Enter Meta+Enter");
        assert.equal(await send.getAttribute("title"), "Send (⌘+Enter)");
        await field.fill("Lifecycle fixture: coarse-input.");
        await field.press("End");
        await field.press("Enter");
        await field.pressSequentially("Touch second line.");
        assert.equal(await field.inputValue(), "Lifecycle fixture: coarse-input.\nTouch second line.", "coarse-pointer Enter inserts a newline");
        assert.equal(model.requests.length, 0);
        await field.press("Meta+Enter");
        await page.getByText("Completed coarse-input.", { exact: true }).waitFor({ timeout: 5000 });
        assert.equal(model.requests.length, 1);
        await page.locator("body > header > a").focus();
        await page.keyboard.press("?");
        await page.waitForURL((url) => new URL(url).pathname === "/settings/" && new URL(url).hash === "#help");
        const helpShortcut = page.locator('#workspace-settings [data-settings-panel="help"] dl[aria-label="Keyboard shortcuts"]');
        await helpShortcut.waitFor({ state: "visible" });
        assert.match(await helpShortcut.textContent(), /⌘\+Enter/u);
        checkBrowser();
    }, {
        contextOptions: {
            isMobile: true,
            hasTouch: true,
            viewport: { width: 390, height: 844 },
            userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
        },
    }));
    for (const hostname of ["127.0.0.1", "plurnk-browser.test"]) {
        await t.test(`{§web-session-input} native Send retains distinct message identities on HTTP ${hostname}`, () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
            const secure = hostname === "127.0.0.1";
            assert.deepEqual(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID })),
                { secure, uuid: secure ? "function" : "undefined" }, "exercise the browser's real origin rules, without changing its APIs");
            page.on("pageerror", (error) => t.diagnostic(error.message));
            const inputs = [];
            onAcpSent(page, (body) => {
                if (body !== null && body.method !== "initialize" && body.params?._meta?.plurnk?.control !== false) {
                    inputs.push(body);
                }
            });
            const field = page.getByRole("textbox", { name: "Message", exact: true });
            for (const name of ["origin-first", "origin-second"]) {
                await field.fill(`Lifecycle fixture: ${name}.`);
                await page.getByRole("button", { name: "Send", exact: true }).click();
                await page.getByText(`Completed ${name}.`, { exact: true }).waitFor({ timeout: 5000 });
                await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                assert.equal(await field.inputValue(), "", "authoritative admission clears the draft");
            }
            const ids = inputs.map((input) => input.params.messageId);
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
    await t.test("{§web-session-input} native Send continues an observed session and Stop explicitly cancels its work", () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        await page.setViewportSize({ width: 320, height: 700 });
        const inputs = [];
        onAcpSent(page, (body) => {
            if (body !== null && body.method !== "initialize" && body.params?._meta?.plurnk?.control !== false) {
                inputs.push(body);
            }
        });
        assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).count(), 1);
        const text = page.getByRole("textbox", { name: "Message", exact: true });
        const send = page.getByRole("button", { name: "Send", exact: true });
        const stop = page.getByRole("button", { name: "Stop", exact: true });
        assert.equal(await send.isEnabled(), true);
        assert.equal(await stop.count(), 0, "idle work has no Stop in the accessible controls");
        assert.equal(model.requests.length, 0, "opening a composer remains passive");
        await text.fill("   \n   ");
        await send.click();
        assert.equal(await text.evaluate((element) => element.validity.customError), true);
        assert.equal(await page.locator('[aria-label="Message feedback"] [role="status"]').isVisible(), false);
        assert.equal(inputs.length, 0, "whitespace-only messages are not submitted");

        const body = "  Lifecycle fixture: held-input.\nKeep this exact text.  ";
        await text.fill(body);
        await send.click();
        await page.locator('[data-prompt-work][data-work-running="true"] [data-operation-tally="reasoning"]').last().waitFor({ state: "attached" });
        assert.equal(await text.inputValue(), "", "daemon admission clears the submitted draft");
        assert.equal(await send.isEnabled(), true, "a running session can receive a follow-up");
        assert.equal(await stop.isEnabled(), true);
        assert.equal(inputs[0].params.prompt[0].text, body);
        assert.equal(inputs[0].params._meta.plurnk.reasoning, "link");
        assert.equal(inputs[0].params._meta.plurnk.bodies, "link");
        assert.equal(inputs[0].params._meta.plurnk.workspace, undefined);

        await text.fill("Lifecycle fixture: follow-up.");
        await send.click();
        await page.waitForFunction(() => /** @type {HTMLTextAreaElement} */ (document.querySelector("#session-message"))?.value === "", undefined, { timeout: 1000 });
        assert.equal(await send.isEnabled(), true, "accepted input is acknowledged before the next model turn");
        assert.equal(model.requests.length, 1, "handoff neither restarts nor cancels the running inference");
        assert.equal(JSON.stringify(inputs[1].params.prompt).includes("Considering held-input."), false);
        assert.equal(await page.locator('#session-status [data-text="inbox"]').textContent(), "1");
        const accepted = await page.locator('[data-message-role="user"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.messageId));
        assert.deepEqual(accepted, inputs.map((input) => input.params.messageId), "accepted message identities belong to their conversation entries, not a second inventory");
        await page.reload();
        await page.getByText("Lifecycle fixture: follow-up.", { exact: true }).waitFor();
        assert.deepEqual(await page.locator('[data-message-role="user"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.messageId)), accepted);
        assert.equal(model.requests.length, 1, "fresh replay includes the accepted follow-up without resubmitting it");
        assert.equal(await page.locator('#session-status [data-text="inbox"]').textContent(), "1", "accepted-unobserved state survives attachment");
        model.release("held-input");
        await page.getByText("Completed follow-up.", { exact: true }).waitFor();
        assert.equal(await text.inputValue(), "");
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected"
            && document.querySelector('#session-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "completed");
        assert.equal(model.requests.length, 2);
        assert.equal(await stop.count(), 0, "completed work has no Stop");
        assert.equal(await page.locator('#session-status [data-text="inbox"]').textContent(), "0");
        assert.equal(await page.locator('[data-status-field="inbox"]').isVisible(), false, "observed messages clear the pending indicator");
        assert.equal(await page.locator('[data-message-role="user"]').count(), 2);
        assert.equal(await page.getByText("Lifecycle fixture: follow-up.", { exact: true }).count(), 1, "arrival does not repeat accepted text");
        assert.equal(inputs.length, 2);
        const history = await page.locator("[data-messages] [data-message-id]").evaluateAll((nodes) => nodes.map((node) => node.dataset.messageId));
        assert.ok(history.length > 2 && history.every(Boolean));
        assert.equal(new Set(history).size, history.length);
        const turnTexts = await page.locator("[data-messages] [data-message-id] > article > p").allTextContents();
        const firstPromptIdx = turnTexts.findIndex((entry) => entry.includes("Lifecycle fixture: held-input."));
        const firstDoneIdx = turnTexts.findIndex((entry) => entry.includes("Completed held-input."));
        const followUpPromptIdx = turnTexts.findIndex((entry) => entry.includes("Lifecycle fixture: follow-up."));
        const followUpDoneIdx = turnTexts.findIndex((entry) => entry.includes("Completed follow-up."));
        assert.ok(firstPromptIdx !== -1 && firstPromptIdx < firstDoneIdx, "initial prompt heads its turn");
        assert.ok(firstDoneIdx < followUpPromptIdx, "accepted follow-up stays after the turn that was running when it arrived");
        assert.ok(followUpPromptIdx < followUpDoneIdx, "accepted follow-up heads the turn that observes it");
        await page.reload();
        await page.getByText("Completed follow-up.", { exact: true }).waitFor();
        assert.deepEqual(await page.locator("[data-messages] [data-message-id]").evaluateAll((nodes) => nodes.map((node) => node.dataset.messageId)), history);
        assert.equal(model.requests.length, 2);

        await text.fill("Lifecycle fixture: held-input-stop.");
        await send.click();
        await page.locator('[data-prompt-work][data-work-running="true"] [data-operation-tally="reasoning"]').last().waitFor({ state: "attached" });
        await text.fill("Lifecycle fixture: cancelled-follow-up.");
        await send.click();
        await page.waitForFunction(() => /** @type {HTMLTextAreaElement} */ (document.querySelector("#session-message"))?.value === "", undefined, { timeout: 1000 });
        await text.fill("Unsent draft survives Stop.");
        await stop.click();
        await page.waitForFunction(() => document.querySelector('#session-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "cancelled"
            && document.querySelector("#session-status")?.dataset.connection === "connected");
        assert.equal(await text.inputValue(), "Unsent draft survives Stop.");
        assert.equal(await stop.count(), 0, "confirmed cancellation removes Stop");
        assert.equal(model.requests.length, 3);
        const action = inputs.at(-1);
        assert.equal(action.params.sessionId, inputs[0].params.sessionId);
        assert.equal(action.method, "session/cancel");
        assert.equal(action.params.prompt, undefined, "cancellation does not resubmit conversation history");
        await text.fill("Lifecycle fixture: after-stop.");
        await send.click();
        await page.getByText("Completed after-stop.", { exact: true }).waitFor();
        for (const pass of ["live", "reloaded"]) {
            if (pass === "reloaded") {
                await page.reload();
                await page.getByText("Completed after-stop.", { exact: true }).waitFor();
            }
            const items = await page.locator("[data-messages] [data-message-id] > article > p").allTextContents();
            const stopPromptIdx = items.findIndex((entry) => entry.includes("Lifecycle fixture: held-input-stop."));
            const cancelledFollowIdx = items.findIndex((entry) => entry.includes("Lifecycle fixture: cancelled-follow-up."));
            const afterStopPromptIdx = items.findIndex((entry) => entry.includes("Lifecycle fixture: after-stop."));
            const afterStopDoneIdx = items.findIndex((entry) => entry.includes("Completed after-stop."));
            assert.ok(stopPromptIdx !== -1 && stopPromptIdx < cancelledFollowIdx, `${pass}: cancelled follow-up follows its loop's prompt`);
            assert.ok(cancelledFollowIdx < afterStopPromptIdx, `${pass}: cancelled loop's unobserved follow-up does not float below a later loop`);
            assert.ok(afterStopPromptIdx < afterStopDoneIdx, `${pass}: subsequent loop prompt heads its turn`);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]), [[], []]);
        checkBrowser();
    }));

    await t.test("{§web-session-input} a manual approval stays pending; Stop and a subsequent message need no approval-state workaround", () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        const text = page.getByRole("textbox", { name: "Message", exact: true });
        const send = page.getByRole("button", { name: "Send", exact: true });
        const stop = page.getByRole("button", { name: "Stop", exact: true });
        await text.fill("Lifecycle fixture: approval-input.");
        await send.click();
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "interrupted");
        assert.equal(await text.inputValue(), "");
        assert.equal(await send.isDisabled(), true);
        assert.equal(await stop.isEnabled(), true);
        assert.equal(await page.getByRole("form", { name: "Review requests", exact: true }).isVisible(), true);
        assert.equal(await page.locator('[data-requests] input:checked').count(), 0, "only the user can choose a decision");
        assert.equal(model.requests.length, 1);
        assert.equal(await page.locator('[data-message-role="tool"]').count(), 0, "no approval is fabricated");
        await page.reload();
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "interrupted");
        assert.equal(model.requests.length, 1, "reopening does not answer the gate");
        await text.fill("A draft to keep.");
        await stop.click();
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected"
            && document.querySelector('#session-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "cancelled");
        assert.equal(await text.inputValue(), "A draft to keep.");
        await text.fill("Lifecycle fixture: after-stop.");
        await send.click();
        await page.getByText("Completed after-stop.", { exact: true }).waitFor();
        assert.equal(model.requests.length, 2);
        checkBrowser();
    }, { env: { PLURNK_SERVICE_PROPOSALS: "review" } }));

    await t.test("{§web-session-input} Send waits while an arriving interrupt is not yet presented", () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        const arrived = Promise.withResolvers();
        const release = Promise.withResolvers();
        let gateChain = Promise.resolve();
        await routeAcpWebSocket(page, (ws) => {
            const server = ws.connectToServer();
            server.onMessage((message) => {
                if (typeof message === "string" && message.includes('"method":"session/request_permission"')) {
                    arrived.resolve();
                    gateChain = gateChain.then(() => release.promise).then(() => ws.send(message));
                } else {
                    gateChain = gateChain.then(() => ws.send(message));
                }
            });
        });
        try {
            page.setDefaultTimeout(5000);
            await page.reload();
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
            const text = page.getByRole("textbox", { name: "Message", exact: true });
            const send = page.getByRole("button", { name: "Send", exact: true });
            await text.fill("Lifecycle fixture: approval-input.");
            await send.click();
            await arrived.promise;
            await text.fill("A follow-up.");
            await page.waitForFunction(() => /** @type {HTMLButtonElement | null} */ (document.querySelector('button[aria-label="Send"]'))?.disabled === true, null, { timeout: 2000 });
            release.resolve();
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "interrupted");
            assert.equal(await page.getByRole("form", { name: "Review requests", exact: true }).isVisible(), true, "the review appears");
            assert.doesNotMatch(await page.locator("main").innerText(), /unconfirmed/u, "nothing was sent");
            assert.equal(await text.inputValue(), "A follow-up.", "the follow-up stays a draft");
            assert.equal(model.requests.length, 1);
            checkBrowser();
        } finally {
            release.resolve();
        }
    }, { env: { PLURNK_SERVICE_PROPOSALS: "review" } }));

    await t.test("{§web-session-history} on a conversation longer than the view, a review, a failure and command output follow the conversation in main", () => inputPage(withDaemon, async ({ page, checkBrowser }) => {
        page.setDefaultTimeout(5000);
        const text = page.getByRole("textbox", { name: "Message", exact: true });
        const send = page.getByRole("button", { name: "Send", exact: true });
        const afterConversation = (selector) => page.evaluate((targetSelector) => {
            const conversation = document.querySelector("#session-conversation");
            const target = document.querySelector(targetSelector);
            return Boolean(conversation && target && target.closest("main") && (conversation.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING));
        }, selector);
        await text.fill(["Lifecycle fixture: long-note.", ...Array.from({ length: 150 }, (_, index) => `Line ${index + 1} of a long note.`)].join("\n\n"));
        await send.click();
        await page.getByText("Completed long-note.", { exact: true }).waitFor();
        assert.ok(await page.locator("main").evaluate((main) => main.scrollHeight > 2 * main.clientHeight), "the conversation is longer than the view");
        await text.fill("/yolo");
        await send.click();
        await page.locator('[aria-label="Message feedback"] [role="status"]').filter({ hasText: "Approvals: Automatic." }).waitFor();
        assert.equal(await afterConversation('[aria-label="Message feedback"]'), true, "command feedback follows the conversation in main");
        await text.fill("/yolo");
        await send.click();
        await page.locator('[aria-label="Message feedback"] [role="status"]').filter({ hasText: "Approvals: Manual." }).waitFor();
        await text.fill("Lifecycle fixture: approval-input.");
        await send.click();
        const review = page.getByRole("form", { name: "Review requests", exact: true });
        await review.waitFor();
        assert.equal(await afterConversation('[aria-label="Review requests"]'), true, "a review follows the conversation in main");
        await page.route("**/acp", (route) => route.fulfill({ status: 409, contentType: "application/problem+json", body: JSON.stringify({
            type: "https://problems.plurnk.xyz/fixture/stop-refused", title: "Conflict", status: 409, detail: "The fixture refused Stop." }) }), { times: 1 });
        await page.getByRole("button", { name: "Stop", exact: true }).click();
        const failure = page.getByRole("alert").filter({ hasText: "The fixture refused Stop." });
        await failure.waitFor();
        assert.equal(await afterConversation('[aria-label="Message feedback"]'), true, "a failure follows the conversation in main");
        checkBrowser([httpFailure("/acp", 409)]);
    }, { env: { PLURNK_SERVICE_PROPOSALS: "review" } }));

    await t.test("{§web-session-input} authenticated admission preserves newer typing and departure never cancels work", () => inputPage(withDaemon, async ({ page, context, path, model, checkBrowser }) => {
        const reached = Promise.withResolvers();
        const release = Promise.withResolvers();
        const requests = [];
        onAcpSent(page, (body) => {
            if (body !== null && body.method !== "initialize" && body.params?._meta?.plurnk?.control !== false) {
                requests.push(body);
            }
        });
        let holdFirstPrompt = true;
        await routeAcpWebSocket(page, (ws) => {
            const server = ws.connectToServer();
            ws.onMessage((message) => {
                if (holdFirstPrompt && typeof message === "string") {
                    const parsed = JSON.parse(message);
                    if (parsed?.method === "session/prompt") {
                        holdFirstPrompt = false;
                        reached.resolve();
                        void release.promise.then(() => server.send(message));
                        return;
                    }
                }
                server.send(message);
            });
        });
        await page.reload();
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
        const text = page.getByRole("textbox", { name: "Message", exact: true });
        const send = page.getByRole("button", { name: "Send", exact: true });
        try {
            await text.fill("Lifecycle fixture: admission.");
            await send.click();
            await reached.promise;
            assert.equal(await send.isDisabled(), true);
            assert.equal(await text.inputValue(), "Lifecycle fixture: admission.");
            await text.fill("Newer typing must survive the acknowledgement.");
            await page.locator("#session-compose").evaluate((form) => /** @type {HTMLFormElement} */ (form).requestSubmit());
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
            await page.locator('[data-prompt-work][data-work-running="true"] [data-operation-tally="reasoning"]').last().waitFor({ state: "attached" });
            assert.equal(await text.inputValue(), "");
            if (departure === "navigate") {
                await page.getByRole("banner").getByRole("link", { name: "Search", exact: true }).click();
                await page.waitForLoadState("load");
            } else await page.close();
            model.release(`held-${departure}-input`);
            await observer.getByText(`Completed held-${departure}-input.`, { exact: true }).waitFor();
            if (departure === "navigate") {
                await page.goBack();
                await page.getByText("Completed held-navigate-input.", { exact: true }).waitFor();
            }
        }
        assert.equal(model.requests.length, 3);
        assert.equal(requests.length, 3);
        assert.equal(requests.some((input) => input.method === "session/cancel"), false);
        await observer.reload();
        await observer.getByText("Completed held-close-input.", { exact: true }).waitFor();
        const arrivals = () => observer.locator('[data-message-role="user"]').evaluateAll((rows) => rows.map((row) => row.dataset.messageId));
        const sent = requests.map(({ params }) => params.messageId);
        assert.deepEqual(await arrivals(), sent.slice(-2), "reattachment uses the daemon's two-loop window");
        await observer.getByRole("button", { name: "Load earlier messages" }).click();
        await observer.getByText("Completed admission.", { exact: true }).waitFor();
        assert.deepEqual(await arrivals(), sent, "every accepted message remains readable after both departures");
        checkBrowser();
    }, { authenticated: true }));

    await t.test("{§web-session-input} refused delivery keeps its draft through explicit reconnection without retrying", () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        const requests = [];
        onAcpSent(page, (body) => {
            if (body !== null && body.method !== "initialize" && body.params?._meta?.plurnk?.control !== false) {
                requests.push(body);
            }
        });
        let abortNextPrompt = true;
        await routeAcpWebSocket(page, (ws) => {
            const server = ws.connectToServer();
            ws.onMessage((message) => {
                if (abortNextPrompt && typeof message === "string" && JSON.parse(message)?.method === "session/prompt") {
                    abortNextPrompt = false;
                    ws.close({ code: 3001, reason: "ACP WebSocket disconnected." });
                    server.close();
                    return;
                }
                server.send(message);
            });
        });
        await page.reload();
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
        requests.length = 0;
        const text = page.getByRole("textbox", { name: "Message", exact: true });
        const send = page.getByRole("button", { name: "Send", exact: true });
        await text.fill("Lifecycle fixture: delivery-retry.");
        await send.click();
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "disconnected");
        assert.equal(await text.inputValue(), "Lifecycle fixture: delivery-retry.");
        assert.equal(await send.isDisabled(), true);
        assert.match(await page.locator('[aria-label="Message feedback"] [role="alert"]').innerText(), /delivery is unconfirmed/u);
        assert.match(await page.locator('#session-connection').innerText(), /Failed to fetch|NetworkError|Load failed|ACP WebSocket disconnected/u, "the transport failure remains visible beside the stale state");
        assert.equal(model.requests.length, 0);
        assert.equal(requests.length, 1);
        checkBrowser([
            networkFailure("/acp"),
        ]);
        await page.getByRole("button", { name: "Reconnect", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
        assert.equal(await text.inputValue(), "Lifecycle fixture: delivery-retry.");
        assert.equal(model.requests.length, 0, "reconnection submits no message");
        assert.equal(requests.length, 1);
        await send.click();
        await page.getByText("Completed delivery-retry.", { exact: true }).waitFor();
        assert.equal(model.requests.length, 1);
        assert.equal(requests.length, 2);
        assert.equal(requests[0].params.messageId, requests[1].params.messageId, "a deliberate retry retains the message's idempotency key");
        checkBrowser();
    }));

    for (const [label, status, body] of [
        ["HTTP failure", 502, '{"access_token":"not-a-diagnostic"}'],
        ["invalid JSON", 200, '{"access_token":"not-a-diagnostic",'],
        ["invalid shape", 200, '{"token_type":"Unknown"}'],
        ["null response", 200, "null"],
    ]) {
        await t.test(`{§web-session-observer} {§web-oidc} ${label} on OIDC token refresh never exposes credential bytes and preserves the draft`, () => inputPage(withDaemon, async ({ page, idp, model, checkBrowser }) => {
            await page.evaluate(() => {
                const current = JSON.parse(localStorage.getItem("plurnk_oidc_grant") ?? "{}");
                localStorage.setItem("plurnk_oidc_grant", JSON.stringify({ ...current, expiresAt: 1 }));
            });
            await page.route(`${idp.issuer}/token`, (route) => route.fulfill({
                status,
                headers: { "access-control-allow-origin": "*" },
                contentType: "application/json",
                body,
            }), { times: 2 });
            const field = page.getByRole("textbox", { name: "Message", exact: true });
            await field.fill("Keep this draft on credential failure.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "signed-out");
            assert.doesNotMatch(await page.locator("body").innerText(), /not-a-diagnostic/u);
            assert.equal(await field.inputValue(), "Keep this draft on credential failure.");
            assert.equal(model.requests.length, 0);
            checkBrowser([
                ...(status === 200 ? [] : [
                    Object.assign(httpFailure("/token", status), { optional: true }),
                    Object.assign(httpFailure("/token", status), { optional: true }),
                ]),
                Object.assign(httpFailure("/acp", 401), { optional: true }),
                Object.assign(networkFailure("/acp"), { optional: true }),
            ]);
            await page.evaluate((freshToken) => {
                localStorage.setItem("plurnk_oidc_grant", JSON.stringify(freshToken));
            }, {
                acpOrigin: new URL(page.url()).origin,
                issuer: idp.issuer,
                clientId: idp.clientId,
                tokenEndpoint: `${idp.issuer}/token`,
                accessToken: idp.mintToken(),
            });
            await page.reload();
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
            assert.equal(await field.inputValue(), "Keep this draft on credential failure.");
            assert.equal(model.requests.length, 0, "reconnection repairs delivery, not resubmits the draft");
            checkBrowser();
        }, { authenticated: true }));
    }
    await t.test("{§web-session-observer} an event the page cannot take in ends observation with its cause", () => inputPage(withDaemon, async ({ page, checkBrowser }) => {
        let injected = false;
        await routeAcpWebSocket(page, (ws) => {
            const server = ws.connectToServer();
            ws.onMessage((message) => {
                server.send(message);
                if (!injected && typeof message === "string") {
                    const parsed = JSON.parse(message);
                    if (parsed?.method === "session/resume") {
                        injected = true;
                        ws.send(JSON.stringify({
                            jsonrpc: "2.0",
                            method: "session/update",
                            params: {
                                sessionId: parsed.params.sessionId,
                                update: { sessionUpdate: "notice", severity: "error", title: "Problem", _meta: { plurnk: { problem: { title: "Not a Problem" } } } },
                            },
                        }));
                    }
                }
            });
        });
        await page.reload();
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "disconnected");
        assert.match(await page.locator("#session-connection").innerText(), /invalid RFC 9457 Problem Details/u);
        await page.getByRole("button", { name: "Reconnect", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
        checkBrowser();
    }));

    await t.test("{§web-session-input} {§web-oidc} expired browser authority cannot submit or silently replace a draft", () => inputPage(withDaemon, async ({ page, idp, model, checkBrowser }) => {
        const text = page.getByRole("textbox", { name: "Message", exact: true });
        await text.fill("Lifecycle fixture: unauthorised.");
        await page.evaluate(() => {
            const current = JSON.parse(localStorage.getItem("plurnk_oidc_grant") ?? "{}");
            localStorage.setItem("plurnk_oidc_grant", JSON.stringify({
                ...current,
                refreshToken: "revoked-refresh-token",
                expiresAt: 1,
            }));
        });
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "signed-out");
        assert.equal(await text.inputValue(), "Lifecycle fixture: unauthorised.");
        assert.equal(model.requests.length, 0);
        assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
        assert.equal(await page.getByRole("button", { name: "Sign in", exact: true }).isVisible(), true);
        checkBrowser([
            Object.assign(httpFailure("/token", 400), { optional: true }),
            Object.assign(httpFailure("/acp", 401), { optional: true }),
            Object.assign(networkFailure("/acp"), { optional: true }),
        ]);
        void idp;
    }, { authenticated: true }));

    await t.test("{§web-session-input} delivery lost before acknowledgement is rediscovered without submitting again", () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        const requests = [];
        const truncated = Promise.withResolvers();
        onAcpSent(page, (body) => {
            if (body !== null && body.method !== "initialize" && body.params?._meta?.plurnk?.control !== false) {
                requests.push(body);
            }
        });
        let truncateNextPrompt = true;
        await routeAcpWebSocket(page, (ws) => {
            const server = ws.connectToServer();
            let promptId = null;
            ws.onMessage((message) => {
                server.send(message);
                if (truncateNextPrompt && typeof message === "string") {
                    const parsed = JSON.parse(message);
                    if (parsed?.method === "session/prompt") {
                        truncateNextPrompt = false;
                        promptId = parsed.id;
                        void (async () => {
                            const deadline = Date.now() + 2000;
                            while (model.requests.length === 0 && Date.now() < deadline) {
                                await new Promise((r) => setTimeout(r, 10));
                            }
                            ws.close({ code: 1000 });
                            server.close();
                            truncated.resolve();
                        })();
                    }
                }
            });
            server.onMessage((message) => {
                if (promptId !== null && typeof message === "string") {
                    try {
                        const parsed = JSON.parse(message);
                        if (parsed?.id === promptId || parsed?.method === "session/update") return;
                    } catch { /* ignore */ }
                }
                ws.send(message);
            });
        });
        await page.reload();
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
        requests.length = 0;
        const text = page.getByRole("textbox", { name: "Message", exact: true });
        await text.fill("Lifecycle fixture: lost-acknowledgement.");
        await Promise.all([page.getByRole("button", { name: "Send", exact: true }).click(), truncated.promise]);
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "disconnected");
        assert.equal(await text.inputValue(), "Lifecycle fixture: lost-acknowledgement.");
        assert.match(await page.locator('[aria-label="Message feedback"] [role="alert"]').innerText(), /delivery is unconfirmed/u);
        assert.match(await page.locator('#session-connection').innerText(), /Delivery ended without a session outcome\.|Connection closed before response received/u);
        assert.equal(model.requests.length, 1, "the work completed, but this page has not received its acknowledgement");
        await page.getByRole("button", { name: "Reconnect", exact: true }).click();
        await page.getByText("Completed lost-acknowledgement.", { exact: true }).waitFor();
        assert.equal(await text.inputValue(), "", "authoritative rediscovery finally confirms admission");
        assert.equal(await page.locator('[aria-label="Message feedback"] [role="alert"]').isVisible(), false);
        assert.equal(requests.length, 1);
        assert.equal(model.requests.length, 1);
        checkBrowser();
    }));

    await t.test("{§web-session-input} Stop retains an accepted follow-up that the session never observed", () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        const text = page.getByRole("textbox", { name: "Message", exact: true });
        const send = page.getByRole("button", { name: "Send", exact: true });
        await text.fill("Lifecycle fixture: held-unobserved.");
        await send.click();
        await page.locator('[data-prompt-work][data-work-running="true"] [data-operation-tally="reasoning"]').last().waitFor({ state: "attached" });
        await text.fill("Lifecycle fixture: unobserved-follow-up.");
        await send.click();
        await page.waitForFunction(() => /** @type {HTMLTextAreaElement} */ (document.querySelector("#session-message"))?.value === "", undefined, { timeout: 1000 });
        const accepted = await page.locator('[data-message-role="user"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.messageId));
        assert.equal(accepted.length, 2);
        assert.equal(await text.inputValue(), "");
        assert.equal(await text.evaluate((field) => field.checkValidity()), false, "the empty required message cannot be submitted");
        await page.getByRole("button", { name: "Stop", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#session-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "cancelled"
            && document.querySelector("#session-status")?.dataset.connection === "connected");
        assert.equal(model.requests.length, 1, "cancellation precedes the next model turn");
        assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).count(), 0, "Stop bypasses unrelated message validation and disappears after cancellation");
        assert.equal(await page.getByText("Completed unobserved-follow-up.", { exact: true }).count(), 0);
        await page.reload();
        await page.getByText("Lifecycle fixture: unobserved-follow-up.", { exact: true }).waitFor();
        assert.deepEqual(await page.locator('[data-message-role="user"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.messageId)), accepted);
        assert.equal(model.requests.length, 1, "rediscovery neither erases nor resubmits cancelled input");
        assert.equal(await page.locator('#session-status [data-text="inbox"]').textContent(), "1");
        assert.equal(await page.locator('[data-status-field="inbox"]').getAttribute("aria-label"), "Accepted messages not yet observed: 1");
        assert.equal(await page.locator('[data-status-field="lifecycle"]').getAttribute("aria-label"), "cancelled", "a pending message count never implies cancelled input is still executing");
        checkBrowser();
    }));

    await t.test("{§web-session-input} a failed Stop is visible and does not cancel work by closing delivery", () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        const text = page.getByRole("textbox", { name: "Message", exact: true });
        await text.fill("Lifecycle fixture: held-stop-failure.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.locator('[data-prompt-work][data-work-running="true"] [data-operation-tally="reasoning"]').last().waitFor({ state: "attached" });
        await text.fill("Keep my next message.");
        const response = Promise.withResolvers();
        let abortNextCancel = true;
        await page.route("**/acp", async (route) => {
            if (!abortNextCancel || route.request().postDataJSON()?.method !== "session/cancel") {
                return route.continue();
            }
            abortNextCancel = false;
            assert.equal(route.request().postDataJSON().method, "session/cancel");
            await response.promise;
            return route.abort("failed");
        });
        const stop = page.getByRole("button", { name: "Stop", exact: true });
        try {
            await stop.click();
            assert.equal(await stop.isVisible(), true, "pending cancellation is not a session outcome");
            assert.equal(await stop.isDisabled(), true, "an outstanding cancellation cannot be resubmitted");
        } finally { response.resolve(); }
        await page.getByText(/Stop could not be confirmed:/u).waitFor();
        assert.equal(await stop.isEnabled(), true, "unconfirmed Stop does not settle known live work");
        assert.equal(await text.inputValue(), "Keep my next message.");
        assert.equal(await page.locator('#session-status [data-status-field="lifecycle"]').getAttribute("aria-label"), "running");
        model.release("held-stop-failure");
        await page.getByText("Completed held-stop-failure.", { exact: true }).waitFor();
        assert.equal(model.requests.length, 1);
        checkBrowser([
            networkFailure("/acp"),
        ]);
    }));

    await t.test("{§web-session-input} a provider failure is displayed as a session failure after message admission", () => inputPage(withDaemon, async ({ page, context, path, model, checkBrowser }) => {
        const observer = await context.newPage();
        await observer.goto(path);
        await observer.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
        const text = page.getByRole("textbox", { name: "Message", exact: true });
        await text.fill("Exercise the rejected browser request.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#session-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "failed"
            && document.querySelector("#session-status")?.dataset.connection === "connected");
        assert.equal(await text.inputValue(), "", "admission succeeded even though the model request failed");
        assert.match(await page.locator('[aria-label="Message feedback"] [role="alert"]').innerText(), /Browser fixture deliberately refused this request/u);
        assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).count(), 0, "failed work is no longer stoppable");
        await observer.waitForFunction(() => document.querySelector('#session-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === "failed");
        assert.equal(await observer.locator('[aria-label="Message feedback"] [role="alert"]').isVisible(), false,
            "an observer sent nothing: the session's failure is its status, not this page's request");
        assert.equal(model.requests.length, 1);
        checkBrowser();
    }));
    await t.test("{§web-session-observer} a refused observation shows the daemon's Problem, not a transport rendering of it", () => inputPage(withDaemon, async ({ page, checkBrowser }) => {
        let refusedOnce = false;
        const problem = { type: "https://problems.plurnk.xyz/fixture/observation-refused", title: "Conflict", status: 409, detail: "The fixture refused observation." };
        await routeAcpWebSocket(page, (ws) => {
            const server = ws.connectToServer();
            ws.onMessage((message) => {
                if (!refusedOnce && typeof message === "string") {
                    const parsed = JSON.parse(message);
                    if (parsed?.method === "session/resume") {
                        refusedOnce = true;
                        ws.send(JSON.stringify({
                            jsonrpc: "2.0",
                            id: parsed.id,
                            error: { code: -32000, message: problem.detail, data: { plurnk: { problem } } },
                        }));
                        return;
                    }
                }
                server.send(message);
            });
        });
        await page.reload();
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "disconnected");
        const notice = await page.locator("#session-connection").innerText();
        assert.match(notice, /The fixture refused observation\./u);
        assert.doesNotMatch(notice, /HTTP 409|"type"/u);
        checkBrowser();
    }));
    await t.test("{§web-session-input} Stop interrupted by leaving the page says so on return", () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: held-departure.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.locator('[data-prompt-work][data-work-running="true"] [data-operation-tally="reasoning"]').last().waitFor({ state: "attached" });
        const answered = Promise.withResolvers();
        let holdCancel = true;
        await page.route("**/acp", async (route) => {
            if (!holdCancel || route.request().postDataJSON()?.method !== "session/cancel") {
                return route.continue();
            }
            holdCancel = false;
            await answered.promise;
            await route.abort();
        });
        await page.getByRole("button", { name: "Stop", exact: true }).click();
        await page.getByText("Requesting Stop…", { exact: true }).waitFor();
        await page.evaluate(() => {
            window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
            window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
        });
        await page.getByText("Stop could not be confirmed before the page was left.", { exact: true }).waitFor();
        answered.resolve();
        model.release("held-departure");
        checkBrowser();
    }));

    await t.test("{§web-session-input} unsent composer text survives reload in tab-ephemeral sessionStorage until confirmed", () => inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
        const field = page.getByRole("textbox", { name: "Message", exact: true });
        await field.fill("Lifecycle fixture: draft-reload.");
        await page.reload();
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
        assert.equal(await field.inputValue(), "Lifecycle fixture: draft-reload.");
        assert.equal(model.requests.length, 0, "reload restores the draft without auto-sending");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.getByText("Completed draft-reload.", { exact: true }).waitFor();
        assert.equal(await field.inputValue(), "");
        assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]), [[], []]);
        checkBrowser();
    }));

    await t.test("{§web-inline-images} {§web-session-input} composer image attachments publish through the authenticated daemon and render inline in user prompts and read disclosures", () => inputPage(withDaemon, async ({ page, checkBrowser }) => {
        const attachButton = page.getByRole("button", { name: "Attach image", exact: true });
        const field = page.getByRole("textbox", { name: "Message", exact: true });
        const send = page.getByRole("button", { name: "Send", exact: true });
        assert.equal(await attachButton.isVisible(), true, "live plurnk-acp initialize advertises prompt.image");

        const entryTargets = [];
        page.on("request", (req) => {
            const url = new URL(req.url());
            if (/^\/acp\/\d+\/\d+\/entry$/u.test(url.pathname)) {
                entryTargets.push({
                    target: url.searchParams.get("target"),
                    hasBearer: /^Bearer \S+$/u.test(req.headers().authorization ?? ""),
                });
            }
        });

        // 1. Image-only prompt submission through real authenticated daemon.
        await page.locator("input[data-attach-input]").setInputFiles([
            { name: "pixel-only.png", mimeType: "image/png", buffer: Buffer.from(PNG_1X1_BASE64, "base64") },
        ]);
        await page.waitForFunction(() => document.querySelectorAll("[data-compose-attachments] > li").length === 1);
        await send.click();
        await page.getByText("Completed image-only.", { exact: true }).waitFor({ timeout: 5000 });
        assert.equal(await page.locator("[data-compose-attachments] > li").count(), 0);
        await page.locator('[data-message-role="user"] figure[data-inline-image] img[alt="pixel-only.png"]').waitFor();
        assert.equal(await page.locator('[data-message-role="user"] figure[data-inline-image] img[alt="pixel-only.png"]').evaluate((img) => img.naturalWidth), 1);

        // 2. Text + image prompt where model also executes plurnk.read on the published session:// attachment.
        entryTargets.length = 0;
        await page.locator("input[data-attach-input]").setInputFiles([
            { name: "pixel.png", mimeType: "image/png", buffer: Buffer.from(PNG_1X1_BASE64, "base64") },
        ]);
        await page.waitForFunction(() => document.querySelectorAll("[data-compose-attachments] > li").length === 1);
        await field.fill("Lifecycle fixture: image-upload.");
        await send.click();
        await page.getByText("Completed image-upload.", { exact: true }).waitFor({ timeout: 5000 });
        await page.locator('[data-message-role="user"] figure[data-inline-image] img[alt="pixel.png"]').waitFor();
        assert.equal(entryTargets.length, 1, "collapsed read operation does not duplicate user attachment fetch before disclosure");
        assert.equal(entryTargets[0].hasBearer, true);
        assert.match(entryTargets[0].target ?? "", /^session:\/\/session1\/attachments\/[0-9a-f]+\/\S*pixel\.png$/u);

        const loop2Ops = page.locator('[data-loop-seq="2"] [data-prompt-work]');
        assert.equal(await loop2Ops.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), false);
        await loop2Ops.locator(":scope > summary").click();
        const readCall = loop2Ops.locator('[data-plurnk-type="read"]');
        assert.equal(await readCall.locator("details").evaluate((el) => el.open), false);
        await readCall.locator("summary").click();
        // {§web-result-bodies} An opened body reads once it is on screen; opening it at main's end does not scroll it there.
        await readCall.locator("[data-image-reference]").scrollIntoViewIfNeeded();
        await readCall.locator('figure[data-inline-image] img[alt="pixel.png"]').waitFor();
        assert.equal(await readCall.locator('figure[data-inline-image] img[alt="pixel.png"]').evaluate((img) => img.naturalWidth), 1);
        assert.equal(entryTargets.length, 2, "opening read disclosure fetches image entry once");

        // 3. Reload replays both published user attachment images and collapsed read disclosure from the daemon.
        await page.reload();
        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
        await page.locator('[data-message-role="user"] figure[data-inline-image] img[alt="pixel.png"]').waitFor();
        // {§web-result-bodies} Replay lands at main's end; the earlier attachment reads once it is scrolled on screen.
        await page.locator('[data-message-role="user"] [data-image-reference][aria-label="pixel-only.png"]').scrollIntoViewIfNeeded();
        assert.equal(await page.locator('[data-message-role="user"] figure[data-inline-image] img[alt="pixel-only.png"]').evaluate((img) => img.naturalWidth), 1);
        assert.equal(await page.locator('[data-message-role="user"] figure[data-inline-image] img[alt="pixel.png"]').evaluate((img) => img.naturalWidth), 1);
        checkBrowser();
    }, { authenticated: true }));
}
