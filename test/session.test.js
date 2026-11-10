import assert from "node:assert/strict";
import test from "node:test";
import Session from "../ai.plurnk/session.js";

// {§web-session} The authority decides identity and expiry; a cookie is never a bearer.
test("{§web-session} only this client's live scoped session admits a document", () => {
    /** @type {any} */
    let claims = null;
    const credentials = { verify: () => claims, issue: () => ({ token: "", expiresAt: 0 }), revokeFamily() {}, sessions: () => [], onRevoked: () => () => {} };
    const session = new Session(credentials, { clientId: "plurnk-web", clientSecret: "test" }, { issuer: () => "http://127.0.0.1:1066" }, { ttl: 600 });
    const req = { headers: { cookie: "plurnk_web_session=test" } };
    assert.equal(session.admitted(req), false);
    claims = { kind: "session", clientId: "plurnk-web", scopes: ["acp"], subject: "operator", family: "one" };
    assert.equal(session.admitted(req), true);
    for (const change of [{ kind: "access" }, { kind: "refresh" }, { clientId: "other" }, { scopes: [] }]) {
        const original = claims;
        claims = { ...claims, ...change };
        assert.equal(session.admitted(req), false);
        claims = original;
    }
    assert.equal(session.admitted({ headers: {} }), false);
    assert.equal(session.admitted({ headers: { cookie: "plurnk_web_session=test; plurnk_web_session=other" } }), false);
});

test("{§web-session} HTTPS cookie and session lifetime come from the verified grant", async (t) => {
    const origin = "https://daemon.example";
    const expiresAt = Date.now() + 1000;
    const common = { clientId: "plurnk-web", scopes: ["acp"], subject: "operator", family: "grant-one", expiresAt };
    const issued = [];
    const credentials = {
        onRevoked: () => () => {},
        verify: (token) => token === "access" ? { ...common, kind: /** @type {const} */ ("access") } : token === "refresh" ? { ...common, kind: /** @type {const} */ ("refresh") } : null,
        issue: (claims) => { issued.push(claims); return { token: "session", expiresAt }; },
        revokeFamily() {},
        sessions: () => [],
    };
    let exchanges = 0;
    t.mock.method(globalThis, "fetch", async (input, options) => {
        if (String(input) === `${origin}/.well-known/oauth-authorization-server`) {
            return Response.json({ issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token` });
        }
        assert.equal(String(input), `${origin}/oauth/token`);
        assert.equal(options.method, "POST");
        const form = new URLSearchParams(options.body);
        assert.equal(form.get("grant_type"), "authorization_code");
        assert.equal(form.get("redirect_uri"), `${origin}/auth/callback`);
        assert.match(form.get("code_verifier"), /^[A-Za-z0-9_-]{43}$/u);
        assert.match(new Headers(options.headers).get("authorization"), /^Basic /u);
        // The authority redeems a code once.
        if (exchanges++ > 0) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 300 });
    });
    const session = new Session(credentials, { clientId: "plurnk-web", clientSecret: "fixture" }, { issuer: () => origin }, { ttl: 600 });
    const headers = new Map();
    const response = {
        setHeader: (name, value) => headers.set(name, value),
        writeHead: (status, values) => { assert.equal(status, 303); for (const [key, value] of Object.entries(values)) headers.set(key, value); },
        end() {},
    };
    await session.login({ headers: {}, url: "/auth/login?return=/~/folderless/" }, response);
    assert.match(headers.get("set-cookie"), /; Path=\/auth; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/u);
    const binding = headers.get("set-cookie").split(";")[0];
    const state = new URL(headers.get("location")).searchParams.get("state");
    await session.callback({ headers: { cookie: binding }, url: `/auth/callback?code=test&state=${state}` }, response);
    assert.equal(exchanges, 1);
    assert.equal(issued.length, 1);
    assert.equal(issued[0].kind, "session");
    assert.equal(issued[0].family, "grant-one");
    assert.equal(issued[0].subject, "operator");
    assert.ok(issued[0].ttlMs > 0 && issued[0].ttlMs <= 1000);
    const [cleared, issuedCookie] = headers.get("set-cookie");
    assert.equal(cleared, `__Secure-plurnk_web_login_${state}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0; Secure`, "the transaction is single-use");
    assert.match(issuedCookie, /^__Host-plurnk_web_session=session; Path=\/; HttpOnly; SameSite=Lax; Max-Age=1; Secure$/u,
        "a live subsecond credential must not become a Max-Age=0 deletion; authority verification still enforces exact expiry");
    assert.equal(headers.get("location"), "/~/folderless/");
    assert.equal(headers.get("cache-control"), "no-store");
    await assert.rejects(session.callback({ headers: { cookie: binding }, url: `/auth/callback?code=test&state=${state}` }, response),
        { status: 400, message: "Sign-in was not completed. Start sign-in again." }, "a replayed callback is not a second grant");
    assert.equal(issued.length, 1);
    session.close();
});

test("{§web-session} a sign-in transaction opens only in the browser and module instance that sealed it, before it expires", async (t) => {
    const origin = "https://daemon.example";
    t.mock.method(globalThis, "fetch", async () =>
        Response.json({ issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token` }));
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const credentials = { verify: () => null, issue: () => ({ token: "", expiresAt: 0 }), revokeFamily() {}, sessions: () => [], onRevoked: () => () => {} };
    const start = async (session) => {
        const headers = new Map();
        await session.login({ headers: {}, url: "/auth/login" }, { setHeader: (name, value) => headers.set(name, value), writeHead: (_status, values) => headers.set("location", values.location), end() {} });
        const [name, value] = headers.get("set-cookie").split(";")[0].split("=");
        return { name, value, state: new URL(headers.get("location")).searchParams.get("state") };
    };
    const callback = async (session, cookie, state) => {
        const headers = new Map();
        await assert.rejects(session.callback({ headers: { cookie }, url: `/auth/callback?code=test&state=${state}` }, { setHeader: (name, value) => headers.set(name, value), writeHead() {}, end() {} }),
            { status: 400, message: "This browser holds no current sign-in for this callback. Start sign-in again." });
        return headers.get("set-cookie");
    };
    const session = new Session(credentials, { clientId: "plurnk-web", clientSecret: "test" }, { issuer: () => origin }, { ttl: 600 });
    const other = new Session(credentials, { clientId: "plurnk-web", clientSecret: "test" }, { issuer: () => origin }, { ttl: 600 });
    const first = await start(session);
    const second = await start(session);
    assert.equal(first.name, `__Secure-plurnk_web_login_${first.state}`, "under HTTPS a transaction is Secure-prefixed");
    assert.notEqual(first.name, second.name, "concurrent tabs keep their own transactions");
    const tampered = `${first.value.slice(0, -2)}${first.value.endsWith("AA") ? "AB" : "AA"}`;
    /** @type {[string, string, string, Session?][]} */
    const cases = [
        ["no transaction cookie", "", first.state],
        ["another browser's state", `${second.name}=${second.value}`, first.state],
        ["a transaction moved under another state", `${first.name.replace(first.state, second.state)}=${first.value}`, second.state],
        ["a tampered transaction", `${first.name}=${tampered}`, first.state],
        ["another module instance's transaction", `${first.name}=${first.value}`, first.state, other],
        ["a state that cannot name a cookie", `${first.name}=${first.value}`, `${first.state};x`],
    ];
    for (const [label, cookie, state, target = session] of cases) {
        const cleared = await callback(target, cookie, state);
        if (/^[\w-]+$/u.test(state)) assert.equal(cleared, `__Secure-plurnk_web_login_${state}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0; Secure`, label);
        else assert.equal(cleared, undefined, label);
    }
    t.mock.timers.tick(600_000);
    assert.equal(await callback(session, `${second.name}=${second.value}`, second.state), `${second.name}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
        "an expired transaction is refused");
    for (let index = 0; index < 500; index++) await start(session);
    session.close();
    other.close();
});

test("{§web-session} a second tab's callback does not revoke its own sign-in family", async (t) => {
    const origin = "https://daemon.example";
    const common = { clientId: "plurnk-web", scopes: ["acp"], subject: "operator", family: "shared", expiresAt: Date.now() + 60_000 };
    const revoked = [];
    const credentials = {
        onRevoked: () => () => {},
        verify: (token) => ["access", "refresh", "old-session"].includes(token)
            ? { ...common, kind: /** @type {import("@plurnk/plurnk-contracts").CredentialKind} */ (token === "old-session" ? "session" : token) } : null,
        issue: () => ({ token: "new-session", expiresAt: common.expiresAt }),
        revokeFamily: (family) => revoked.push(family),
        sessions: () => [],
    };
    t.mock.method(globalThis, "fetch", async (input) => String(input).endsWith("/oauth/token")
        ? Response.json({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 60 })
        : Response.json({ issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token` }));
    const session = new Session(credentials, { clientId: "plurnk-web", clientSecret: "test" }, { issuer: () => origin }, { ttl: 600 });
    const headers = new Map();
    const response = {
        setHeader: (name, value) => headers.set(name, value),
        writeHead: (_status, values) => { for (const [name, value] of Object.entries(values)) headers.set(name, value); },
        end() {},
    };
    await session.login({ headers: {}, url: "/auth/login" }, response);
    const binding = headers.get("set-cookie").split(";")[0];
    const state = new URL(headers.get("location")).searchParams.get("state");
    await session.callback({ headers: { cookie: `${binding}; __Host-plurnk_web_session=old-session` }, url: `/auth/callback?code=test&state=${state}` }, response);
    assert.deepEqual(revoked, [], "the two callbacks belong to one browser sign-in, not competing families");
    assert.match(headers.get("set-cookie")[1], /^__Host-plurnk_web_session=new-session;/u);
});

test("{§web-account} sign-in returns to native account pages without treating query or fragment text as a path", async () => {
    const session = new Session({ verify: () => ({ kind: "session", clientId: "plurnk-web", scopes: ["acp"], subject: "operator", family: "f", expiresAt: 0 }), issue: () => ({ token: "", expiresAt: 0 }), revokeFamily() {}, sessions: () => [], onRevoked: () => () => {} },
        { clientId: "plurnk-web", clientSecret: "test" }, { issuer: () => "https://daemon.example" }, { ttl: 600 });
    const locations = [];
    const response = { setHeader() {}, writeHead: (status, headers) => { assert.equal(status, 303); locations.push(headers.location); }, end() {} };
    for (const path of ["/", "/account/", "/account/sessions/"]) {
        for (const requested of [path, `${path}index.html`, `${path}?filter=example`, `${path}index.html#section`]) {
            await session.login({ headers: { cookie: "__Host-plurnk_web_session=current" }, url: `/auth/login?${new URLSearchParams({ return: requested })}` }, response);
            assert.equal(locations.at(-1), path);
        }
    }
    await session.login({ headers: { cookie: "__Host-plurnk_web_session=current" }, url: "/auth/login" }, response);
    assert.equal(locations.at(-1), "/");
    for (const requested of ["https://foreign.example/account/", "//foreign.example/account/", "/account", "/account/../sessions/"]) {
        await assert.rejects(session.login({ headers: { cookie: "__Host-plurnk_web_session=current" }, url: `/auth/login?${new URLSearchParams({ return: requested })}` }, response),
            { status: 400, message: "Invalid return page." });
    }
});

test("{§web-account} inventory and revocation are scoped to the authenticated subject", () => {
    const current = { family: "current", subject: "operator", clientId: "plurnk-web", kind: /** @type {const} */ ("session"), scopes: ["acp"], expiresAt: 0, createdAt: 0, clients: ["plurnk-web"] };
    const entries = [current, { ...current, family: "other" }];
    const revoked = [];
    const credentials = {
        onRevoked: () => () => {},
        verify: (token) => token === "current-token" ? current : null,
        issue: () => ({ token: "", expiresAt: 0 }),
        sessions: (subject) => { assert.equal(subject, "operator"); return entries; },
        revokeFamily: (family) => revoked.push(family),
    };
    const origin = "https://daemon.example";
    const session = new Session(credentials, { clientId: "plurnk-web", clientSecret: "test" }, { issuer: () => origin }, { ttl: 600 });
    const req = { headers: { origin, cookie: "__Host-plurnk_web_session=current-token" } };
    const headers = new Map();
    const response = {
        setHeader: (name, value) => headers.set(name, value),
        writeHead: (status, values) => { assert.equal(status, 303); for (const [name, value] of Object.entries(values)) headers.set(name, value); },
        end() {},
    };
    assert.deepEqual(session.account(req), { family: "current", sessions: entries });
    assert.equal(session.account({ headers: {} }), null);
    assert.throws(() => session.revoke({ headers: {} }, response, "other"), { status: 401 });
    assert.throws(() => session.revoke({ headers: { ...req.headers, origin: "https://foreign.example" } }, response, "other"), { status: 403 });
    assert.throws(() => session.revoke(req, response, "foreign-family"), { status: 404 });
    assert.deepEqual(revoked, []);
    session.revoke(req, response, "other");
    assert.deepEqual(revoked, ["other"]);
    assert.equal(headers.get("location"), "/account/sessions/");
    session.revokeOthers(req, response);
    assert.deepEqual(revoked, ["other", "other"]);
    assert.equal(headers.get("location"), "/account/sessions/");
    session.revoke(req, response, "current");
    assert.deepEqual(revoked, ["other", "other", "current"]);
    assert.match(headers.get("set-cookie"), /^__Host-plurnk_web_session=;.*Max-Age=0/u);
    assert.equal(headers.get("location"), "/");
});

test("{§web-workspace-creation} module form mutations require the daemon's own origin", () => {
    const session = new Session({ verify: () => null, issue: () => ({ token: "", expiresAt: 0 }), revokeFamily() {}, sessions: () => [], onRevoked: () => () => {} },
        { clientId: "plurnk-web", clientSecret: "test" }, { issuer: () => "https://daemon.example" }, { ttl: 600 });
    session.sameOriginForm({ headers: { origin: "https://daemon.example" } });
    for (const headers of [{ origin: "https://foreign.example" }, { origin: "https://daemon.example.evil" }, {}]) {
        assert.throws(() => session.sameOriginForm({ headers }), { status: 403 });
    }
});

test("{§web-session} a browser starts sign-in at the issuer's address, and cookie names follow its scheme", () => {
    const credentials = { verify: () => null, issue: () => ({ token: "", expiresAt: 0 }), revokeFamily() {}, sessions: () => [], onRevoked: () => () => {} };
    const at = (issuer) => new Session(credentials, { clientId: "plurnk-web", clientSecret: "test" }, { issuer: () => issuer }, { ttl: 600 });
    assert.equal(at("http://127.0.0.1:1066").signIn({ headers: { host: "127.0.0.1:1066" } }, "/~/work/"), "/auth/login?return=%2F%7E%2Fwork%2F",
        "the address the browser reached is the issuer's");
    assert.equal(at("https://daemon.example").signIn({ headers: { host: "10.0.0.5:1066" } }, "/~/work/"), "https://daemon.example/auth/login?return=%2F%7E%2Fwork%2F",
        "another address starts sign-in at the issuer's, where its callback returns");
    assert.equal(at("http://127.0.0.1:1066").admitted({ headers: { cookie: "__Host-plurnk_web_session=x" } }), false, "plain HTTP reads the unprefixed name");
    const verified = new Session({ verify: () => ({ kind: "session", clientId: "plurnk-web", scopes: ["acp"], subject: "operator", family: "f", expiresAt: 0 }), issue: () => ({ token: "", expiresAt: 0 }), revokeFamily() {}, sessions: () => [], onRevoked: () => () => {} },
        { clientId: "plurnk-web", clientSecret: "test" }, { issuer: () => "https://daemon.example" }, { ttl: 600 });
    assert.equal(verified.admitted({ headers: { cookie: "plurnk_web_session=x" } }), false, "HTTPS reads only the host-only name");
    assert.equal(verified.admitted({ headers: { cookie: "__Host-plurnk_web_session=x" } }), true);
});
