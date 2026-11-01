import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";
import startModel from "./model-fixture.js";
import browserDiagnostics, { httpFailure } from "./browser-diagnostics.js";

async function sessionAgentBundle() {
    const built = await build({
        configFile: false,
        logLevel: "error",
        build: {
            write: false,
            lib: {
                entry: fileURLToPath(new URL("../web/session-agent.js", import.meta.url)),
                formats: ["es"],
                fileName: () => "session-agent.js",
            },
        },
    });
    const [{ output }] = Array.isArray(built) ? built : [built];
    const chunk = output.find((entry) => entry.type === "chunk" && entry.isEntry);
    return async (page, base) => {
        await page.route(new URL("/__test__/session-agent.js", base).href, (route) =>
            route.fulfill({ contentType: "text/javascript", body: chunk.code }));
    };
}

// {§web-access-token} Real password, authorization code, cookie and OAuth token endpoints.
export default async function verifyTokens({ t, withDaemon }) {
    const mount = await sessionAgentBundle();
    await t.test("{§web-access-token} browser sign-in supplies only access credentials and sign-out revokes them", async () => {
        await withDaemon({ PLURNK_PASS: "token-fixture-password", PLURNK_AUTH_ACCESS_TTL_SEC: "3" }, async (base) => {
            const browser = await chromium.launch();
            try {
                const context = await browser.newContext();
                const checkBrowser = browserDiagnostics(context);
                const page = await context.newPage();
                await mount(page, base);
                await page.goto(base);
                const token = () => page.evaluate(async () => {
                    const response = await fetch("/auth/token", { method: "POST" });
                    return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.json() };
                });
                const absent = await token();
                assert.equal(absent.status, 401);
                assert.match(absent.headers["content-type"], /application\/problem\+json/u);
                checkBrowser([httpFailure("/auth/token", 401)]);
                await page.goto(new URL("/account/", base).href);
                await page.getByLabel("Password", { exact: true }).fill("token-fixture-password");
                await page.getByRole("button", { name: "Continue", exact: true }).click();
                await page.waitForURL(new URL("/account/", base).href);
                const supplied = await token();
                assert.equal(supplied.status, 200);
                assert.deepEqual(Object.keys(supplied.body).toSorted(), ["access_token", "expires_in", "token_type"]);
                assert.equal(supplied.body.token_type, "Bearer");
                assert.equal(typeof supplied.body.access_token, "string");
                assert.ok(supplied.body.expires_in >= 0 && supplied.body.expires_in <= 3);
                assert.equal(supplied.headers["cache-control"], "no-store");
                assert.equal(supplied.headers["access-control-allow-origin"], undefined);
                assert.equal((await token()).body.access_token, supplied.body.access_token, "valid credentials are reused");
                const endpoint = new URL("/auth/token", base).href;
                for (const origin of [undefined, "null", "https://foreign.example"]) {
                    const refused = await context.request.post(endpoint, { headers: origin === undefined ? {} : { origin } });
                    assert.equal(refused.status(), 403);
                    assert.equal((await refused.json()).status, 403);
                }
                for (const method of ["get", "head", "put", "options"]) {
                    const response = await context.request.fetch(endpoint, { method: method.toUpperCase() });
                    assert.equal(response.status(), 405);
                    assert.equal(response.headers().allow, "POST");
                    assert.equal(response.headers()["access-control-allow-origin"], undefined);
                }
                for (const cookie of await context.cookies()) assert.notEqual(cookie.value, supplied.body.access_token);
                assert.equal((await page.content()).includes(supplied.body.access_token), false);
                assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]), [[], []]);
                await page.evaluate(async () => {
                    const { default: SessionAgent } = await import("/__test__/session-agent.js");
                    globalThis.connection = {
                        snapshot: null, streamError: null, settled: false, failure: null,
                        async discover(token) {
                            const agent = new SessionAgent({ url: new URL("/acp", location.href).href, sessionId: "tokens", headers: { Authorization: `Bearer ${token}` } });
                            try {
                                const outcome = await agent.runAgent({ action: { kind: "discover" } });
                                return { stopReason: outcome.stopReason, result: outcome.result };
                            } catch (error) { return { status: error.status }; }
                        },
                        async create(token) {
                            const agent = new SessionAgent({ url: new URL("/acp", location.href).href, sessionId: "tokens", headers: { Authorization: `Bearer ${token}` } });
                            // A session-setting action creates this model-less fixture; observation cannot.
                            const outcome = await agent.runAgent({ workspace: "tokens", action: { kind: "session/set_config_option", configId: "spawn_model", value: "" } });
                            return { stopReason: outcome.stopReason, action: outcome.result };
                        },
                        observe(token) {
                            this.agent = new SessionAgent({ url: new URL("/acp", location.href).href, sessionId: "tokens", headers: { Authorization: `Bearer ${token}` } });
                            this.pending = this.agent.connectAgent({ workspace: "tokens" }, {
                                onMessagesSnapshot: ({ snapshot }) => { this.snapshot = snapshot; },
                                onError: (err) => { this.streamError = err; },
                            }).catch((error) => { this.failure = error.message; }).finally(() => { this.settled = true; });
                        },
                    };
                });
                const discover = (access) => page.evaluate((access) => globalThis.connection.discover(access), access);
                assert.equal((await discover(supplied.body.access_token)).stopReason, "end_turn");
                const created = await page.evaluate((access) => globalThis.connection.create(access), supplied.body.access_token);
                assert.equal(created.action?.kind, "session/set_config_option");
                assert.equal(created.action.ok, true);
                assert.equal(created.stopReason, "end_turn");
                await page.evaluate((access) => globalThis.connection.observe(access), supplied.body.access_token);
                await page.waitForFunction(() => Boolean(globalThis.connection.snapshot));
                checkBrowser();
                await setTimeout((supplied.body.expires_in + 1) * 1000);
                assert.equal((await discover(supplied.body.access_token)).status, 401, "new requests cannot reuse the expired credential");
                checkBrowser([
                    httpFailure("/acp", 401),
                ]);
                assert.equal(await page.evaluate(() => globalThis.connection.settled), false, "expiry does not sever an admitted observation");
                const renewed = await Promise.all(Array.from({ length: 8 }, token));
                assert.ok(renewed.every(({ status }) => status === 200));
                assert.equal(new Set(renewed.map(({ body }) => body.access_token)).size, 1, "concurrent browser requests share the rotated grant");
                const current = renewed[0].body.access_token;
                assert.notEqual(current, supplied.body.access_token);
                assert.equal((await discover(current)).stopReason, "end_turn");
                const secondTab = await context.newPage();
                await secondTab.goto(new URL("/account/", base).href);
                await secondTab.getByRole("button", { name: "Sign out", exact: true }).click();
                await secondTab.waitForURL(base);
                await page.waitForFunction(() => globalThis.connection.settled);
                const revoked = await page.evaluate(() => ({ streamError: globalThis.connection.streamError, failure: globalThis.connection.failure, running: globalThis.connection.agent.isRunning }));
                assert.equal(revoked.failure, null);
                assert.equal(revoked.streamError?.status, 401);
                assert.match(revoked.streamError?.problem?.type ?? "", /credential-revoked$/u);
                assert.equal(revoked.running, false);
                assert.equal((await token()).status, 401);
                assert.equal((await discover(current)).status, 401, "the issued access token shares the revoked sign-in family");
                checkBrowser([
                    httpFailure("/auth/token", 401), httpFailure("/acp", 401),
                ]);
            } finally { await browser.close(); }
        });
    });
    await t.test("{§web-access-token} sign-out ends an admitted controlling connection without cancelling its session", async () => {
        const model = await startModel();
        const secret = crypto.randomUUID();
        try {
            await withDaemon({ ...model.env, PLURNK_PASS: "revocation-password", PLURNK_SECRET: secret }, async (base) => {
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext();
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    await mount(page, base);
                    await page.goto(new URL("/account/", base).href);
                    await page.getByLabel("Password", { exact: true }).fill("revocation-password");
                    await page.getByRole("button", { name: "Continue", exact: true }).click();
                    await page.waitForURL(new URL("/account/", base).href);
                    await page.evaluate(async () => {
                        const { default: SessionAgent } = await import("/__test__/session-agent.js");
                        const response = await fetch("/auth/token", { method: "POST" });
                        if (!response.ok) throw new Error(`Token request failed: ${response.status}`);
                        const { access_token } = await response.json();
                        const agent = new SessionAgent({ url: new URL("/acp", location.href).href, sessionId: "revocation",
                            initialMessages: [{ id: "revocation-prompt", role: "user", content: "Lifecycle fixture: held-revocation." }],
                            headers: { Authorization: `Bearer ${access_token}` } });
                        const state = globalThis.revocation = { agent, reasoned: false, streamError: null, settled: false, error: null };
                        state.pending = agent.runAgent({ workspace: "revocation" }, {
                            onThoughtChunk: () => { state.reasoned = true; },
                            onError: (err) => { state.streamError = err; },
                        }).catch((error) => { state.error = error.message; }).finally(() => { state.settled = true; });
                    });
                    await page.waitForFunction(() => globalThis.revocation.reasoned);
                    const second = await context.newPage();
                    await second.goto(new URL("/account/", base).href);
                    await second.getByRole("button", { name: "Sign out", exact: true }).click();
                    await second.waitForURL(base);
                    await page.waitForFunction(() => globalThis.revocation.settled);
                    const revoked = await page.evaluate(() => ({ error: globalThis.revocation.error, streamError: globalThis.revocation.streamError }));
                    assert.equal(revoked.error, null);
                    assert.equal(revoked.streamError?.status, 401);
                    assert.match(revoked.streamError?.problem?.type ?? "", /credential-revoked$/u);
                    const exchanged = await fetch(new URL("/oauth/token", base), {
                        method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: "operator", client_secret: secret, scope: "acp" }),
                    });
                    assert.equal(exchanged.status, 200);
                    const { access_token } = await exchanged.json();
                    await page.evaluate(async (access) => {
                        const { default: SessionAgent } = await import("/__test__/session-agent.js");
                        const agent = new SessionAgent({ url: new URL("/acp", location.href).href, sessionId: "revocation", headers: { Authorization: `Bearer ${access}` } });
                        const state = globalThis.survivor = { agent, snapshot: null, outcome: null, settled: false, error: null };
                        state.pending = agent.connectAgent({ workspace: "revocation" }, {
                            onMessagesSnapshot: ({ snapshot }) => { state.snapshot = snapshot; },
                            onSettled: (outcome) => { state.outcome = outcome; },
                        }).catch((error) => { state.error = error.message; }).finally(() => { state.settled = true; });
                    }, access_token);
                    await page.waitForFunction(() => Boolean(globalThis.survivor.snapshot));
                    model.release("held-revocation");
                    const completed = await page.evaluate(async () => {
                        await globalThis.survivor.pending;
                        return { error: globalThis.survivor.error, outcome: globalThis.survivor.outcome, messages: globalThis.survivor.agent.messages };
                    });
                    assert.equal(completed.error, null);
                    assert.equal(completed.outcome?.stopReason, "end_turn");
                    assert.equal(completed.messages.findLast(({ role }) => role === "assistant").content, "Completed held-revocation.");
                    assert.equal(model.requests.length, 1, "revocation neither cancels nor restarts the model");
                    assert.deepEqual(model.errors, []);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        } finally { await model.close(); }
    });
}
