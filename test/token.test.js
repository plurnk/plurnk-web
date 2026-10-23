import assert from "node:assert/strict";
import test from "node:test";
import Session from "../ai.plurnk/session.js";

const response = () => ({
    headers: {}, status: null, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(body) { this.body = body; },
});

async function fixture(t) {
    const origin = "https://daemon.example";
    const records = new Map();
    const listeners = new Set();
    const common = { clientId: "plurnk-web", scopes: ["agui"], subject: "operator", family: "one" };
    const authority = {
        issue({ ttlMs, ...claims }) {
            const token = crypto.randomUUID();
            const expiresAt = Date.now() + ttlMs;
            records.set(token, { ...claims, expiresAt });
            return { token, expiresAt };
        },
        verify(token) { const claims = records.get(token); return claims && claims.expiresAt > Date.now() ? claims : null; },
        onRevoked(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        revokeFamily(family) {
            for (const [token, claims] of records) if (claims.family === family) records.delete(token);
            for (const listener of listeners) listener(family);
        },
    };
    const pair = (change = {}) => ({
        access_token: authority.issue({ ...common, ...change, kind: "access", ttlMs: 300_000 }).token,
        refresh_token: authority.issue({ ...common, ...change, kind: "refresh", ttlMs: 600_000 }).token,
        token_type: "Bearer", expires_in: 300,
    });
    const initial = pair();
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    const refreshes = [];
    t.mock.method(globalThis, "fetch", async (input, options) => {
        if (String(input) === `${origin}/.well-known/oauth-authorization-server`) {
            return Response.json({ issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token` });
        }
        assert.equal(String(input), `${origin}/oauth/token`);
        const form = new URLSearchParams(options.body);
        assert.match(new Headers(options.headers).get("authorization"), /^Basic /u);
        if (form.get("grant_type") === "authorization_code") return Response.json(initial);
        assert.equal(form.get("grant_type"), "refresh_token");
        refreshes.push(form.get("refresh_token"));
        entered.resolve();
        return released.promise;
    });
    const session = new Session(authority, { clientId: "plurnk-web", clientSecret: "fixture-only" }, { issuer: () => origin }, { ttl: 600 });
    t.after(() => session.close());
    const res = response();
    await session.login({ headers: {}, url: "/auth/login" }, res);
    const binding = res.headers["set-cookie"].split(";")[0];
    const state = new URL(res.headers.location).searchParams.get("state");
    await session.callback({ headers: { cookie: binding }, url: `/auth/callback?code=test&state=${state}` }, res);
    const request = { headers: { cookie: res.headers["set-cookie"].find((value) => value.startsWith("__Host-plurnk_web_session=")).split(";")[0], origin } };
    const expire = () => { records.get(initial.access_token).expiresAt = Date.now() - 1; };
    return { session, request, records, listeners, authority, initial, pair, expire, entered, released, refreshes };
}

test("{§web-access-token} concurrent tabs share one rotating refresh without extending the browser session", async (t) => {
    const f = await fixture(t);
    const first = response();
    await f.session.token(f.request, first);
    assert.equal(JSON.parse(first.body).access_token, f.initial.access_token);
    assert.deepEqual(f.refreshes, []);
    const sessionClaims = [...f.records.values()].find(({ kind }) => kind === "session");
    const originalExpiry = sessionClaims.expiresAt;
    f.expire();
    const responses = Array.from({ length: 10 }, response);
    const calls = responses.map((res) => f.session.token(f.request, res));
    await f.entered.promise;
    assert.deepEqual(f.refreshes, [f.initial.refresh_token]);
    f.records.delete(f.initial.refresh_token); // Rotation consumes the previous credential.
    const next = f.pair();
    f.released.resolve(Response.json(next));
    await Promise.all(calls);
    for (const res of responses) {
        assert.equal(res.status, 200);
        assert.deepEqual(Object.keys(JSON.parse(res.body)).toSorted(), ["access_token", "expires_in", "token_type"]);
        assert.equal(JSON.parse(res.body).access_token, next.access_token);
        assert.equal(res.headers["cache-control"], "no-store");
    }
    assert.equal(sessionClaims.expiresAt, originalExpiry);
    f.authority.revokeFamily("one");
    await assert.rejects(f.session.token(f.request, response()), { status: 401 });
});

test("{§web-access-token} logout during refresh cannot resurrect a session", async (t) => {
    const f = await fixture(t);
    f.expire();
    const res = response();
    const call = f.session.token(f.request, res);
    const rejected = assert.rejects(call, { status: 401 });
    await f.entered.promise;
    f.session.logout(f.request, response());
    f.released.resolve(Response.json(f.pair()));
    await rejected;
    assert.equal(res.body, null);
    assert.equal(f.session.admitted(f.request), false);
});

test("{§web-access-token} invalid refresh ends the family while a failed endpoint is surfaced", async (t) => {
    for (const [error, status] of [["invalid_grant", 401], ["temporarily_unavailable", 502]]) {
        await t.test(error, async (t) => {
            const f = await fixture(t);
            f.expire();
            const rejected = assert.rejects(f.session.token(f.request, response()), (failure) => {
                assert.equal(failure.status, status);
                assert.equal(failure.cause.error, error);
                return true;
            });
            await f.entered.promise;
            f.released.resolve(Response.json({ error }, { status: 400 }));
            await rejected;
            assert.equal(f.session.admitted(f.request), error !== "invalid_grant");
        });
    }
});

test("{§web-access-token} refresh preserves family, subject, registered client and scope", async (t) => {
    for (const [name, change, expected] of [
        ["family", { family: "foreign" }, /changed the web grant during refresh/u],
        ["subject", { subject: "foreign" }, /changed the web grant during refresh/u],
        ["client", { clientId: "foreign" }, /outside the registered web grant/u],
        ["scope", { scopes: [] }, /outside the registered web grant/u],
    ]) {
        await t.test(name, async (t) => {
            const f = await fixture(t);
            f.expire();
            const rejected = assert.rejects(f.session.token(f.request, response()), expected);
            await f.entered.promise;
            f.released.resolve(Response.json(f.pair(change)));
            await rejected;
        });
    }
});

test("{§web-access-token} close releases the observer and in-flight refresh cannot repopulate grants", async (t) => {
    const f = await fixture(t);
    f.expire();
    const rejected = assert.rejects(f.session.token(f.request, response()), { status: 401 });
    await f.entered.promise;
    assert.equal(f.listeners.size, 1);
    f.session.close();
    assert.equal(f.listeners.size, 0);
    f.released.resolve(Response.json(f.pair()));
    await rejected;
    await assert.rejects(f.session.token(f.request, response()), { status: 401 });
});
