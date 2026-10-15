import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright";
import httpAgentBundle from "./http-agent-bundle.js";
import startModel from "./model-fixture.js";

// {§web-access-token} Real password, authorization code, cookie and OAuth token endpoints.
export default async function verifyTokens({ t, withDaemon }) {
    const mount = await httpAgentBundle();
    await t.test("{§web-access-token} browser sign-in supplies only access credentials and sign-out revokes them", async () => {
        await withDaemon({ PLURNK_PASS: "token-fixture-password", PLURNK_AGUI_ACCESS_TTL_SEC: "3" }, async (base) => {
            const browser = await chromium.launch();
            try {
                const context = await browser.newContext();
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
                    const { HttpAgent, Observer } = await import("/__test__/http-agent.js");
                    globalThis.connection = {
                        events: [], settled: false, failure: null,
                        async discover(token) {
                            const agent = new HttpAgent({ url: new URL("/agui", location.href).href, threadId: "tokens", headers: { Authorization: `Bearer ${token}` } });
                            const events = [];
                            try {
                                await agent.runAgent({ forwardedProps: { plurnk: { action: { kind: "discover" } } } }, { onEvent: ({ event }) => events.push(event) });
                                return { events };
                            } catch (error) { return { status: error.status }; }
                        },
                        async create(token) {
                            const agent = new HttpAgent({ url: new URL("/agui", location.href).href, threadId: "tokens", headers: { Authorization: `Bearer ${token}` } });
                            const events = [];
                            // A worker-setting action creates this model-less fixture; observation cannot.
                            await agent.runAgent({ forwardedProps: { plurnk: { workspace: "tokens", action: { kind: "worker.child.set", selector: null } } } }, {
                                onEvent: ({ event }) => events.push(event),
                            });
                            return { terminal: events.at(-1), action: events.find(({ name }) => name === "plurnk.action.result")?.value };
                        },
                        observe(token) {
                            this.agent = new Observer({ url: new URL("/agui/connect", location.href).href, threadId: "tokens", headers: { Authorization: `Bearer ${token}` } });
                            this.pending = this.agent.connectAgent({ forwardedProps: { plurnk: { workspace: "tokens" } } }, {
                                onEvent: ({ event }) => this.events.push(event),
                            }).catch((error) => { this.failure = error.message; }).finally(() => { this.settled = true; });
                        },
                    };
                });
                const discover = (access) => page.evaluate((access) => globalThis.connection.discover(access), access);
                assert.equal((await discover(supplied.body.access_token)).events.at(-1).type, "RUN_FINISHED");
                const created = await page.evaluate((access) => globalThis.connection.create(access), supplied.body.access_token);
                assert.equal(created.action?.kind, "worker.child.set");
                assert.equal(created.action.ok, true);
                assert.equal(created.terminal.type, "RUN_FINISHED");
                assert.deepEqual(created.terminal.outcome, { type: "success" });
                await page.evaluate((access) => globalThis.connection.observe(access), supplied.body.access_token);
                await page.waitForFunction(() => globalThis.connection.events.some(({ type }) => type === "MESSAGES_SNAPSHOT"));
                await setTimeout((supplied.body.expires_in + 1) * 1000);
                assert.equal((await discover(supplied.body.access_token)).status, 401, "new requests cannot reuse the expired credential");
                assert.equal(await page.evaluate(() => globalThis.connection.settled), false, "expiry does not sever an admitted observation");
                const renewed = await Promise.all(Array.from({ length: 8 }, token));
                assert.ok(renewed.every(({ status }) => status === 200));
                assert.equal(new Set(renewed.map(({ body }) => body.access_token)).size, 1, "concurrent browser requests share the rotated grant");
                const current = renewed[0].body.access_token;
                assert.notEqual(current, supplied.body.access_token);
                assert.equal((await discover(current)).events.at(-1).type, "RUN_FINISHED");
                const secondTab = await context.newPage();
                await secondTab.goto(new URL("/account/", base).href);
                await secondTab.getByRole("button", { name: "Sign out", exact: true }).click();
                await secondTab.waitForURL(base);
                await page.waitForFunction(() => globalThis.connection.settled);
                const revoked = await page.evaluate(() => ({ events: globalThis.connection.events, failure: globalThis.connection.failure, running: globalThis.connection.agent.isRunning }));
                assert.equal(revoked.failure, null);
                assert.equal(revoked.events.at(-1).type, "RUN_ERROR");
                assert.equal(revoked.running, false);
                assert.equal((await token()).status, 401);
                assert.equal((await discover(current)).status, 401, "the issued access token shares the revoked sign-in family");
            } finally { await browser.close(); }
        });
    });
    await t.test("{§web-access-token} sign-out ends an admitted controlling connection without cancelling its worker", async () => {
        const model = await startModel();
        const secret = crypto.randomUUID();
        try {
            await withDaemon({ ...model.env, PLURNK_PASS: "revocation-password", PLURNK_SECRET: secret }, async (base) => {
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext();
                    const page = await context.newPage();
                    await mount(page, base);
                    await page.goto(new URL("/account/", base).href);
                    await page.getByLabel("Password", { exact: true }).fill("revocation-password");
                    await page.getByRole("button", { name: "Continue", exact: true }).click();
                    await page.waitForURL(new URL("/account/", base).href);
                    await page.evaluate(async () => {
                        const { HttpAgent } = await import("/__test__/http-agent.js");
                        const response = await fetch("/auth/token", { method: "POST" });
                        if (!response.ok) throw new Error(`Token request failed: ${response.status}`);
                        const { access_token } = await response.json();
                        const agent = new HttpAgent({ url: new URL("/agui", location.href).href, threadId: "revocation",
                            initialMessages: [{ id: "revocation-prompt", role: "user", content: "Lifecycle fixture: held-revocation." }],
                            headers: { Authorization: `Bearer ${access_token}` } });
                        const state = globalThis.revocation = { agent, events: [], settled: false, error: null };
                        state.pending = agent.runAgent({ forwardedProps: { plurnk: { workspace: "revocation" } } }, {
                            onEvent: ({ event }) => state.events.push(event),
                        }).catch((error) => { state.error = error.message; }).finally(() => { state.settled = true; });
                    });
                    await page.waitForFunction(() => globalThis.revocation.events.some(({ type }) => type === "REASONING_MESSAGE_CONTENT"));
                    const second = await context.newPage();
                    await second.goto(new URL("/account/", base).href);
                    await second.getByRole("button", { name: "Sign out", exact: true }).click();
                    await second.waitForURL(base);
                    await page.waitForFunction(() => globalThis.revocation.settled);
                    const revoked = await page.evaluate(() => ({ error: globalThis.revocation.error, final: globalThis.revocation.events.at(-1) }));
                    assert.equal(revoked.error, null);
                    assert.equal(revoked.final.type, "RUN_ERROR");
                    assert.match(revoked.final.code, /credential-revoked$/u);
                    const exchanged = await fetch(new URL("/oauth/token", base), {
                        method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: "operator", client_secret: secret, scope: "agui" }),
                    });
                    assert.equal(exchanged.status, 200);
                    const { access_token } = await exchanged.json();
                    await page.evaluate(async (access) => {
                        const { Observer } = await import("/__test__/http-agent.js");
                        const agent = new Observer({ url: new URL("/agui/connect", location.href).href, threadId: "revocation", headers: { Authorization: `Bearer ${access}` } });
                        const state = globalThis.survivor = { agent, events: [], settled: false, error: null };
                        state.pending = agent.connectAgent({ forwardedProps: { plurnk: { workspace: "revocation" } } }, {
                            onEvent: ({ event }) => state.events.push(event),
                        }).catch((error) => { state.error = error.message; }).finally(() => { state.settled = true; });
                    }, access_token);
                    await page.waitForFunction(() => globalThis.survivor.events.some(({ type }) => type === "MESSAGES_SNAPSHOT"));
                    model.release("held-revocation");
                    const completed = await page.evaluate(async () => {
                        await globalThis.survivor.pending;
                        return { error: globalThis.survivor.error, final: globalThis.survivor.events.at(-1), messages: globalThis.survivor.agent.messages };
                    });
                    assert.equal(completed.error, null);
                    assert.equal(completed.final.type, "RUN_FINISHED");
                    assert.deepEqual(completed.final.outcome, { type: "success" });
                    assert.equal(completed.messages.findLast(({ role }) => role === "assistant").content, "Completed held-revocation.");
                    assert.equal(model.requests.length, 1, "revocation neither cancels nor restarts the model");
                    assert.deepEqual(model.errors, []);
                } finally { await browser.close(); }
            });
        } finally { await model.close(); }
    });
}
