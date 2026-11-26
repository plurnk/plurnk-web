import assert from "node:assert/strict";
import { test } from "node:test";
import accessHeaders from "../web/access-headers.js";
import {
    acpOrigin,
    acpUrl,
    appName,
    authLoginUrl,
    authLogoutMethod,
    authLogoutUrl,
    daemonPolicy,
    formatPageTitle,
    isModuleDocument,
    mermaidUrl,
    notificationsUrl,
    onDaemonPolicy,
    onServiceVersion,
    overviewExcerptCharsLimit,
    overviewSessionsLimit,
    parseDaemonPolicy,
    recordDaemonPolicy,
    recordServiceVersion,
    serviceVersion,
    webVersion,
} from "../web/endpoints.js";
import {
    OIDC_GRANT_KEY,
    OIDC_PKCE_KEY,
    buildBffLoginUrl,
    canSignOut,
    clearOidcState,
    completeOidcCallback,
    computePkceChallenge,
    ensureValidAccessToken,
    hasActiveOidcGrant,
    normalizeReturnTo,
    readOidcGrant,
    recoverFromUnauthorized,
    refreshOidcGrant,
    selectOidcBearerToken,
    signOut,
    withAccessTokenQuery,
    writeOidcGrant,
} from "../web/oidc.js";
import { isUntouchedDraftSession, matchSnippet, orderByReply, truncateSingleLine } from "../web/session-selection.js";

function createMemoryStorage() {
    /** @type {Map<string, string>} */
    const entries = new Map();
    return /** @type {Storage} */ ({
        get length() { return entries.size; },
        clear() { entries.clear(); },
        getItem(key) { return entries.get(String(key)) ?? null; },
        key(index) { return [...entries.keys()][index] ?? null; },
        removeItem(key) { entries.delete(String(key)); },
        setItem(key, value) { entries.set(String(key), String(value)); },
    });
}

/**
 * @param {import("node:test").TestContext} t
 * @param {{
 *   origin?: string,
 *   pathname?: string,
 *   search?: string,
 *   hash?: string,
 *   dataset?: Record<string, string>,
 * }} [options]
 */
function installBrowserEnv(t, {
    origin = "http://127.0.0.1:4100",
    pathname = "/",
    search = "",
    hash = "",
    dataset = {},
} = {}) {
    const localStorage = createMemoryStorage();
    const sessionStorage = createMemoryStorage();
    /** @type {string[]} */
    const assigned = [];
    /** @type {string[]} */
    const replaced = [];
    let reloaded = 0;

    const prevDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
    const prevLoc = Object.getOwnPropertyDescriptor(globalThis, "location");
    const prevLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const prevSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");

    const attrs = new Map(Object.entries(dataset).map(([k, v]) => [
        `data-${k.replace(/[A-Z]/gu, (ch) => `-${ch.toLowerCase()}`)}`,
        v,
    ]));

    Object.defineProperty(globalThis, "document", {
        configurable: true,
        writable: true,
        value: {
            documentElement: {
                dataset: { ...dataset },
                hasAttribute(name) { return attrs.has(name); },
                getAttribute(name) { return attrs.get(name) ?? null; },
            },
        },
    });
    Object.defineProperty(globalThis, "location", {
        configurable: true,
        writable: true,
        value: {
            origin,
            pathname,
            search,
            hash,
            href: `${origin}${pathname}${search}${hash}`,
            assign(url) { assigned.push(String(url)); },
            replace(url) { replaced.push(String(url)); },
            reload() { reloaded += 1; },
        },
    });
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        writable: true,
        value: localStorage,
    });
    Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        writable: true,
        value: sessionStorage,
    });

    t.after(() => {
        for (const [key, desc] of /** @type {const} */ ([
            ["document", prevDoc],
            ["location", prevLoc],
            ["localStorage", prevLocal],
            ["sessionStorage", prevSession],
        ])) {
            if (desc) Object.defineProperty(globalThis, key, desc);
            else Reflect.deleteProperty(globalThis, key);
        }
    });

    return { localStorage, sessionStorage, assigned, replaced, getReloaded: () => reloaded };
}

test("{§web-configuration} {§web-workspace-settings} endpoints resolve data-acp-url, notificationsUrl, mermaidUrl, limits, versions, and daemon policy", (t) => {
    installBrowserEnv(t, {
        origin: "http://127.0.0.1:4100",
        dataset: {
            acpUrl: "https://acp.example:8443/acp",
            appName: "Acme Bot",
            overviewSessions: "75",
            overviewExcerptChars: "120",
            webVersion: "4.0.0",
        },
    });
    assert.equal(isModuleDocument(), true);
    assert.equal(acpUrl(), "https://acp.example:8443/acp");
    assert.equal(acpOrigin(), "https://acp.example:8443");
    assert.equal(notificationsUrl(), "https://acp.example:8443/notifications");
    assert.equal(notificationsUrl("/42"), "https://acp.example:8443/notifications/42");
    assert.equal(mermaidUrl(), "http://127.0.0.1:4100/render/mermaid");
    assert.equal(appName(), "Acme Bot");
    assert.equal(formatPageTitle("Search"), "Search — Acme Bot");
    assert.equal(overviewSessionsLimit(), 75);
    assert.equal(overviewExcerptCharsLimit(), 120);
    assert.equal(webVersion(), "4.0.0");

    /** @type {string[]} */
    const observed = [];
    const unsubscribe = onServiceVersion((v) => observed.push(v));
    recordServiceVersion("9.1.0");
    assert.equal(serviceVersion(), "9.1.0");
    assert.equal(observed.at(-1), "9.1.0");
    unsubscribe();

    assert.equal(parseDaemonPolicy(null), null);
    assert.equal(parseDaemonPolicy({}), null);
    assert.deepEqual(
        parseDaemonPolicy({
            projectRoot: "confined",
            families: ["env", "mcp", "mcp", 42],
            mcp: { workspaceTransports: ["streamable-http", "bogus"], publicOnly: true },
            skills: { workspaceSources: ["mcp", "local", "bad"], publicOnly: false },
        }),
        {
            projectRoot: "confined",
            families: ["env", "mcp"],
            mcp: { workspaceTransports: ["streamable-http"], publicOnly: true },
            skills: { workspaceSources: ["mcp", "local"], publicOnly: false },
        },
    );
    /** @type {import("../web/endpoints.js").DaemonPolicy[]} */
    const policies = [];
    const unsubPolicy = onDaemonPolicy((p) => policies.push(p));
    recordDaemonPolicy({ projectRoot: "none", families: ["env", "personas"] });
    recordDaemonPolicy({ projectRoot: "none", families: ["env", "personas"] });
    assert.deepEqual(daemonPolicy(), { projectRoot: "none", families: ["env", "personas"] });
    assert.equal(policies.length, 1, "identical policy handshakes deduplicate listener delivery");
    unsubPolicy();
});

test("{§web-oidc} loopback unauthenticated fast path returns empty accessHeaders with zero network preflight", async (t) => {
    installBrowserEnv(t, { dataset: { acpUrl: "/acp" } });
    let fetchCalls = 0;
    t.mock.method(globalThis, "fetch", async () => {
        fetchCalls += 1;
        throw new Error("unexpected network preflight on unauthenticated fast path");
    });
    assert.equal(hasActiveOidcGrant(), false);
    assert.equal(await ensureValidAccessToken(), null);
    assert.deepEqual(await accessHeaders(), {});
    assert.equal(withAccessTokenQuery("ws://127.0.0.1:4100/acp", null), "ws://127.0.0.1:4100/acp");
    assert.equal(fetchCalls, 0);
});

test("{§web-oidc} PKCE S256 challenge, protected-resource discovery, callback code exchange, token selection, refresh, and signOut", async (t) => {
    // RFC 7636 Appendix B S256 test vector
    assert.equal(
        await computePkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    assert.equal(normalizeReturnTo("/~/work#session1"), "/~/work#session1");
    assert.equal(normalizeReturnTo("https://evil.example/phish"), "/");
    assert.equal(normalizeReturnTo("//evil.example/phish"), "/");
    assert.equal(normalizeReturnTo("/auth/callback?code=1"), "/");

    // Token selection prefers 3-part JWT access_token, falls back to id_token when access_token is opaque
    assert.equal(
        selectOidcBearerToken({ access_token: "hdr.payload.sig", id_token: "id.payload.sig" }),
        "hdr.payload.sig",
    );
    assert.equal(
        selectOidcBearerToken({ access_token: "opaque-token", id_token: "id.payload.sig" }),
        "id.payload.sig",
    );
    assert.equal(
        selectOidcBearerToken({ access_token: "opaque-only" }),
        "opaque-only",
    );

    const env = installBrowserEnv(t, {
        origin: "http://127.0.0.1:4100",
        pathname: "/~/alpha",
        hash: "#session1",
        dataset: { acpUrl: "http://127.0.0.1:4200/acp" },
    });

    /** @type {string[]} */
    const seenUrls = [];
    t.mock.method(globalThis, "fetch", async (input, init) => {
        const url = String(input);
        seenUrls.push(url);
        if (url === "http://127.0.0.1:4200/.well-known/oauth-protected-resource") {
            return Response.json({
                authorization_servers: ["http://127.0.0.1:4300"],
                client_id: "web-pkce-client",
                scopes_supported: ["openid", "profile"],
            });
        }
        if (url === "http://127.0.0.1:4300/.well-known/openid-configuration") {
            return new Response("Not found", { status: 404 });
        }
        if (url === "http://127.0.0.1:4300/.well-known/oauth-authorization-server") {
            return Response.json({
                issuer: "http://127.0.0.1:4300",
                authorization_endpoint: "http://127.0.0.1:4300/authorize",
                token_endpoint: "http://127.0.0.1:4300/token",
            });
        }
        if (url === "http://127.0.0.1:4300/token") {
            const params = new URLSearchParams(String(init?.body ?? ""));
            const grantType = params.get("grant_type");
            if (grantType === "authorization_code") {
                assert.equal(params.get("client_id"), "web-pkce-client");
                assert.equal(params.get("code"), "auth-code-123");
                assert.equal(params.get("redirect_uri"), "http://127.0.0.1:4100/auth/callback");
                assert.ok((params.get("code_verifier") ?? "").length >= 40);
                return Response.json({
                    access_token: "header.initial-jwt.sig",
                    refresh_token: "refresh-1",
                    expires_in: 300,
                    token_type: "Bearer",
                });
            }
            if (grantType === "refresh_token") {
                assert.equal(params.get("refresh_token"), "refresh-1");
                return Response.json({
                    access_token: "header.refreshed-jwt.sig",
                    refresh_token: "refresh-2",
                    expires_in: 300,
                    token_type: "Bearer",
                });
            }
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
    });

    // 1. 401 triggers protected-resource + AS metadata discovery (with oauth-authorization-server fallback) and stores PKCE state in sessionStorage
    const recovery = await recoverFromUnauthorized({ redirectOnDiscovery: true });
    assert.equal(recovery.status, "redirecting");
    assert.equal(env.assigned.length, 1);
    const authUrl = new URL(env.assigned[0]);
    assert.equal(authUrl.origin + authUrl.pathname, "http://127.0.0.1:4300/authorize");
    assert.equal(authUrl.searchParams.get("response_type"), "code");
    assert.equal(authUrl.searchParams.get("client_id"), "web-pkce-client");
    assert.equal(authUrl.searchParams.get("redirect_uri"), "http://127.0.0.1:4100/auth/callback");
    assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authUrl.searchParams.get("scope"), "openid profile");
    const state = authUrl.searchParams.get("state") ?? "";
    assert.ok(state.length > 10);

    const savedPkce = JSON.parse(env.sessionStorage.getItem(OIDC_PKCE_KEY) ?? "null");
    assert.equal(savedPkce.state, state);
    assert.equal(savedPkce.returnTo, "/~/alpha#session1");
    assert.equal(await computePkceChallenge(savedPkce.verifier), authUrl.searchParams.get("code_challenge"));

    // 2. Callback removes plurnk_oidc_pkce immediately, exchanges code + verifier, saves plurnk_oidc_grant in localStorage, and location.replace(returnTo)
    globalThis.location.pathname = "/auth/callback";
    globalThis.location.search = `?code=auth-code-123&state=${encodeURIComponent(state)}`;
    globalThis.location.hash = "";
    const callbackOutcome = await completeOidcCallback();
    assert.deepEqual(callbackOutcome, { ok: true, returnTo: "/~/alpha#session1" });
    assert.equal(env.sessionStorage.getItem(OIDC_PKCE_KEY), null, "callback consumes PKCE transaction immediately");
    assert.deepEqual(env.replaced, ["/~/alpha#session1"]);
    assert.equal(hasActiveOidcGrant(), true);
    assert.deepEqual(await accessHeaders(), { Authorization: "Bearer header.initial-jwt.sig" });
    assert.equal(
        withAccessTokenQuery("ws://127.0.0.1:4200/acp", "header.initial-jwt.sig"),
        "ws://127.0.0.1:4200/acp?access_token=header.initial-jwt.sig",
    );

    // 3. Proactive / single-flight refresh rotates grant in localStorage
    const grant = readOidcGrant();
    assert.ok(grant);
    writeOidcGrant({ ...grant, expiresAt: Date.now() + 1_000 });
    const [r1, r2] = await Promise.all([refreshOidcGrant(), refreshOidcGrant()]);
    assert.equal(r1?.accessToken, "header.refreshed-jwt.sig");
    assert.equal(r2?.accessToken, "header.refreshed-jwt.sig");
    assert.equal(seenUrls.filter((u) => u.endsWith("/token")).length, 2, "concurrent refreshes share a single token request");
    assert.deepEqual(await accessHeaders(), { Authorization: "Bearer header.refreshed-jwt.sig" });

    // 4. Mismatched callback state is rejected cleanly without touching localStorage grant
    clearOidcState();
    env.sessionStorage.setItem(OIDC_PKCE_KEY, JSON.stringify({ ...savedPkce, state: "expected-state" }));
    globalThis.location.search = "?code=abc&state=wrong-state";
    const badState = await completeOidcCallback();
    assert.equal(badState.ok, false);
    assert.equal(env.sessionStorage.getItem(OIDC_PKCE_KEY), null);
    assert.equal(env.localStorage.getItem(OIDC_GRANT_KEY), null);

    // 5. signOut clears grant + PKCE state and navigates to "/"
    writeOidcGrant({
        acpOrigin: "http://127.0.0.1:4200",
        issuer: "http://127.0.0.1:4300",
        clientId: "web-pkce-client",
        tokenEndpoint: "http://127.0.0.1:4300/token",
        accessToken: "header.refreshed-jwt.sig",
    });
    const beforeSignOutAssigned = env.assigned.length;
    signOut();
    assert.equal(hasActiveOidcGrant(), false);
    assert.equal(env.localStorage.getItem(OIDC_GRANT_KEY), null);
    assert.equal(env.assigned.length, beforeSignOutAssigned + 1);
    assert.equal(env.assigned.at(-1), "/");
});

test("{§web-bff-auth} BFF login URLs, {returnTo} substitution, 401 redirect without OIDC discovery, and POST/GET signOut", async (t) => {
    assert.equal(buildBffLoginUrl("/auth/login", "/~/alpha#session1"), "/auth/login?returnTo=%2F%7E%2Falpha%23session1");
    assert.equal(
        buildBffLoginUrl("/auth/login?prompt=select_account", "/settings/search?q=test"),
        "/auth/login?prompt=select_account&returnTo=%2Fsettings%2Fsearch%3Fq%3Dtest",
    );
    assert.equal(
        buildBffLoginUrl("/oauth2/start?rd={returnTo}", "/~/alpha#session1"),
        "/oauth2/start?rd=%2F~%2Falpha%23session1",
    );
    assert.equal(buildBffLoginUrl("/auth/login", "https://evil.example/phish"), "/auth/login?returnTo=%2F");
    assert.equal(buildBffLoginUrl("/auth/login", "/auth/callback?code=1"), "/auth/login?returnTo=%2F");

    const env = installBrowserEnv(t, {
        origin: "https://app.example",
        pathname: "/~/alpha",
        hash: "#session1",
        dataset: {
            acpUrl: "/acp",
            authLoginUrl: "/oauth2/start?rd={returnTo}",
            authLogoutUrl: "/auth/logout",
            authLogoutMethod: "POST",
        },
    });
    assert.equal(authLoginUrl(), "/oauth2/start?rd={returnTo}");
    assert.equal(authLogoutUrl(), "/auth/logout");
    assert.equal(authLogoutMethod(), "POST");
    assert.equal(hasActiveOidcGrant(), false);
    assert.equal(canSignOut(), true);

    let fetchCalls = 0;
    t.mock.method(globalThis, "fetch", async () => {
        fetchCalls += 1;
        throw new Error("BFF mode must not perform OIDC well-known discovery fetches");
    });

    // Stale browser grant is cleared and 401 with redirectOnDiscovery=false stays signed-out without navigating.
    writeOidcGrant({
        acpOrigin: "https://app.example",
        issuer: "https://idp.example",
        clientId: "plurnk-web",
        tokenEndpoint: "https://idp.example/token",
        accessToken: "stale.jwt.token",
    });
    const passive = await recoverFromUnauthorized({ redirectOnDiscovery: false });
    assert.deepEqual(passive, { status: "signed-out" });
    assert.equal(hasActiveOidcGrant(), false);
    assert.equal(env.assigned.length, 0);
    assert.equal(fetchCalls, 0);

    // 401 with redirectOnDiscovery=true routes straight to the BFF login URL with normalized returnTo.
    const active = await recoverFromUnauthorized({ redirectOnDiscovery: true });
    assert.deepEqual(active, {
        status: "redirecting",
        authorizationUrl: "/oauth2/start?rd=%2F~%2Falpha%23session1",
    });
    assert.deepEqual(env.assigned, ["/oauth2/start?rd=%2F~%2Falpha%23session1"]);
    assert.equal(fetchCalls, 0);

    // POST logout uses submitPost (not location.assign) and clears any OIDC storage.
    /** @type {string[]} */
    const posted = [];
    signOut({ submitPost: (action) => { posted.push(action); } });
    assert.deepEqual(posted, ["/auth/logout"]);
    assert.equal(env.assigned.length, 1);

    // GET logout navigates directly via location.assign.
    globalThis.document.documentElement.dataset.authLogoutMethod = "GET";
    assert.equal(authLogoutMethod(), "GET");
    signOut({ submitPost: () => { throw new Error("GET logout must not POST"); } });
    assert.deepEqual(env.assigned, ["/oauth2/start?rd=%2F~%2Falpha%23session1", "/auth/logout"]);
});

test("{§web-arrival} {§web-search} session selection orders replies newest-first, detects untouched drafts, and extracts bounded snippets", () => {
    const draft = {
        parentSessionId: null,
        kind: "root",
        lifecycle: "idle",
        gates: 0,
        reply: null,
    };
    assert.equal(isUntouchedDraftSession(draft, false), true);
    assert.equal(isUntouchedDraftSession(draft, true), false, "parent with child sessions is not an untouched draft");
    assert.equal(isUntouchedDraftSession({ ...draft, title: "Named" }, false), false);
    assert.equal(isUntouchedDraftSession({ ...draft, gates: 1 }, false), false);
    assert.equal(isUntouchedDraftSession({ ...draft, reply: { id: 5 } }, false), false);

    const ordered = [
        { id: 1, reply: null },
        { id: 2, reply: { id: 10 } },
        { id: 3, reply: { id: 25 } },
        { id: 4, reply: null },
    ].toSorted(orderByReply);
    assert.deepEqual(ordered.map(({ id }) => id), [3, 2, 1, 4]);

    assert.equal(truncateSingleLine("  first   line\nsecond line  ", 12), "first line…");
    assert.equal(matchSnippet("alpha beta gamma delta epsilon zeta", "delta", 18), "…gamma delta epsilo…");
});
