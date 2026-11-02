import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { setImmediate } from "node:timers/promises";

const workspace = { id: 1, name: "example", project_root: null, project_label: null };

async function fixture(t, createModule, /** @type {any} */ { credentials, ...port } = {}) {
    const module = createModule();
    let handler;
    await module.setup({ credentials });
    await module.start({ credentials, listWorkspaces: async () => [workspace], listSessions: async () => [], ...port,
        registerHttpRoute(prefix, serve) { assert.equal(prefix, "/"); handler = serve; } });
    const errors = [];
    const server = createServer((req, res) => {
        void handler(req, res).catch((error) => { errors.push(error); res.writeHead(500); res.end(); });
    });
    let closing;
    const close = () => closing ??= module.close();
    t.after(async () => {
        try { await close(); }
        finally { await new Promise((resolve) => server.close(resolve)); }
        assert.deepEqual(errors, [], "unexpected route errors must reach the host");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    return { module, close, base, errors, server };
}

function hold() {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    return { entered: entered.promise, release: release.resolve, call: async () => {
        entered.resolve();
        return release.promise;
    } };
}

async function pending(close) {
    let settled = false;
    const result = close().then(() => { settled = true; });
    await setImmediate();
    assert.equal(settled, false, "close must not return while an admitted request is held");
    return { result };
}

async function stopping(response) {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "application/problem+json");
    const problem = await response.json();
    assert.equal(problem.status, 503);
    assert.match(problem.type, /service-stopping$/u);
    assert.match(problem.detail, /shutting down/u);
}

async function authenticated(t, createModule, heldPhase) {
    const issuer = "https://authority.example";
    const records = new Map();
    const observers = new Set();
    const order = [];
    const gate = hold();
    const credentials = {
        registerClient: () => ({ clientId: "plurnk-web", clientSecret: "fixture-only" }),
        face: () => ({ issuer: (req) => req ? base : issuer }),
        onRevoked(listener) { observers.add(listener); return () => { observers.delete(listener); order.push("observer closed"); }; },
        verify(token) { const claims = records.get(token); return claims && claims.expiresAt > Date.now() ? claims : null; },
        issue({ ttlMs, ...claims }) {
            const token = crypto.randomUUID();
            const expiresAt = Date.now() + ttlMs;
            records.set(token, { ...claims, expiresAt });
            order.push(`issued ${claims.kind}`);
            return { token, expiresAt };
        },
    };
    const pair = () => {
        const claims = { family: "one", subject: "operator", clientId: "plurnk-web", scopes: ["acp"] };
        return {
            access_token: credentials.issue({ ...claims, kind: "access", ttlMs: 300_000 }).token,
            refresh_token: credentials.issue({ ...claims, kind: "refresh", ttlMs: 600_000 }).token,
            token_type: "Bearer", expires_in: 300,
        };
    };
    const initial = pair();
    const fetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (input, options) => {
        if (!String(input).startsWith(issuer)) return fetch(input, options);
        if (String(input) === `${issuer}/.well-known/oauth-authorization-server`) {
            if (heldPhase === "login") await gate.call();
            return Response.json({ issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token` });
        }
        assert.equal(String(input), `${issuer}/oauth/token`);
        const grant = new URLSearchParams(options.body).get("grant_type");
        if (grant === "authorization_code") {
            if (heldPhase === "callback") await gate.call();
            return Response.json(initial);
        }
        assert.equal(grant, "refresh_token");
        await gate.call();
        return Response.json(pair());
    });
    const f = await fixture(t, createModule, { credentials });
    const { base } = f;
    const login = () => fetch(`${base}/auth/login`, { redirect: "manual" });
    const callback = (response) => fetch(`${base}/auth/callback?${new URLSearchParams({
        state: new URL(response.headers.get("location")).searchParams.get("state"), code: "fixture-code",
    })}`, { redirect: "manual", headers: { cookie: response.headers.get("set-cookie").split(";")[0] } });
    return { ...f, credentials, gate, observers, order, initial, records, login, callback };
}

/** @param {Response} response The browser session a sign-in callback set, beside its cleared transaction. */
const sessionCookie = (response) => response.headers.getSetCookie().find((value) => value.startsWith("plurnk_web_session="))?.split(";")[0];

/** {§web-route-settlement} Real HTTP requests through source and packed module entry points. */
export default async function verifyRouteSettlement(t, createModule) {
    for (const [name, path] of [["listWorkspaces", "/~/"], ["listSessions", "/~/example/"]]) {
        await t.test(`close joins ${name} without needing a preceding stop`, async (t) => {
            const gate = hold();
            const f = await fixture(t, createModule, { [name]: gate.call });
            const response = fetch(`${f.base}${path}`);
            await gate.entered;
            try { await pending(f.close); }
            finally { gate.release(name === "listWorkspaces" ? [workspace] : []); }
            assert.equal((await response).status, 200);
            await f.close();
            await stopping(await fetch(`${f.base}/`));
        });
    }

    await t.test("stop refuses every route family without inspecting host credentials", async (t) => {
        const f = await authenticated(t, createModule, "none");
        const login = await f.login();
        const signedIn = await f.callback(login);
        const cookie = sessionCookie(signedIn);
        f.records.clear();
        assert.equal(f.observers.size, 1);
        f.module.stop();
        f.module.stop();
        t.mock.method(f.credentials, "verify", () => { throw new Error("credentials accessed after stop"); });
        for (const [path, method] of [
            ["/", "GET"], ["/manifest.webmanifest", "GET"], ["/~/", "GET"], ["/~/example/", "GET"],
            ["/account/", "GET"], ["/account/sessions/", "GET"], ["/account/sessions/one/revoke", "POST"],
            ["/auth/login", "GET"], ["/auth/callback", "GET"], ["/auth/logout", "POST"],
            ["/auth/token", "POST"], ["/render/mermaid", "POST"], ["/missing", "GET"],
        ]) await stopping(await fetch(`${f.base}${path}`, { method, redirect: "manual", headers: { cookie } }));
        const head = await fetch(`${f.base}/`, { method: "HEAD" });
        assert.equal(head.status, 503);
        assert.equal(await head.text(), "");
        assert.equal(f.observers.size, 1, "stop retains the credential observer");
        await f.close();
        assert.equal(f.observers.size, 0);
    });

    await t.test("close waits for all admitted work, including failure after browser departure", async (t) => {
        const gates = [hold(), hold()];
        let calls = 0;
        const f = await fixture(t, createModule, { listWorkspaces: () => gates[calls++].call() });
        const controller = new AbortController();
        const first = fetch(`${f.base}/~/`, { signal: controller.signal });
        await gates[0].entered;
        const second = fetch(`${f.base}/~/`);
        await gates[1].entered;
        const departed = assert.rejects(first, { name: "AbortError" });
        controller.abort();
        await departed;
        const failure = new Error("directory unavailable", { cause: new Error("host fixture failure") });
        try {
            await pending(f.close);
            gates[0].release([workspace]);
            await pending(f.close);
        } finally { gates[0].release([workspace]); gates[1].release(Promise.reject(failure)); }
        assert.equal((await second).status, 500);
        await f.close();
        assert.equal(f.errors.shift(), failure, "joining must preserve the original host-visible rejection");
    });

    for (const phase of ["login", "callback", "refresh"]) {
        await t.test(`close joins OAuth ${phase} before discarding its session resources`, async (t) => {
            const f = await authenticated(t, createModule, phase);
            let response;
            if (phase === "login") response = f.login();
            else {
                const login = await f.login();
                if (phase === "callback") response = f.callback(login);
                else {
                    const signedIn = await f.callback(login);
                    f.records.get(f.initial.access_token).expiresAt = Date.now() - 1;
                    response = fetch(`${f.base}/auth/token`, { method: "POST", headers: {
                        cookie: sessionCookie(signedIn), origin: f.base,
                    } });
                }
            }
            await f.gate.entered;
            try {
                await pending(f.close);
                assert.equal(f.observers.size, 1);
            } finally { f.gate.release(); }
            const completed = await response;
            assert.equal(completed.status, phase === "refresh" ? 200 : 303);
            if (phase === "refresh") assert.notEqual((await completed.json()).access_token, f.initial.access_token);
            await f.close();
            assert.equal(f.observers.size, 0);
            assert.equal(f.order.at(-1), "observer closed", "credential work must precede observer cleanup");
        });
    }

    await t.test("an admitted unfinished diagram body stays owned until the transport settles", async (t) => {
        const f = await fixture(t, createModule);
        const entered = once(f.server, "request");
        const upload = request(`${f.base}/render/mermaid`, { method: "POST", headers: { "content-type": "application/json" } });
        const response = once(upload, "response");
        upload.write('{"source":');
        await entered;
        try { await pending(f.close); }
        finally { upload.end('"flowchart LR\\nA-->B"}'); }
        const [res] = await response;
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        assert.equal(res.statusCode, 503);
        assert.match(JSON.parse(Buffer.concat(chunks).toString()).detail, /stopping/u);
        await f.close();
    });

    await t.test("stop and close tolerate incomplete startup", async () => {
        for (const failStart of [false, true]) {
            const module = createModule();
            if (failStart) {
                await assert.rejects(
                    module.start({ credentials: { face: () => ({ issuer: () => "https://authority.example" }) } }),
                    /completed module setup/u,
                );
            }
            module.stop();
            await module.close();
            await module.close();
        }
        const module = createModule();
        let subscribed = false;
        const credentials = {
            registerClient: () => ({ clientId: "plurnk-web", clientSecret: "fixture-only" }),
            face: () => ({ issuer: () => "https://authority.example" }),
            onRevoked() { subscribed = true; return () => { subscribed = false; }; },
        };
        await module.setup({ credentials });
        const failure = new Error("host refused route registration");
        await assert.rejects(module.start({ credentials, registerHttpRoute() { throw failure; } }), (error) => error === failure);
        assert.equal(subscribed, true);
        await module.close();
        assert.equal(subscribed, false);
    });
}
