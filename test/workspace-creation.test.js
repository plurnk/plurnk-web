import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { Problems } from "@plurnk/plurnk-contracts";
import createModule from "../src/module.js";

const envelope = (name) => ({ workspaceId: 41, workspaceName: name, projectRoot: null, projectLabel: null });

// {§web-workspace-creation} Tests both anonymous and authenticated postures without global env pollution.
async function fixture(t, { auth = false, admitted = true, create = async (/** @type {any} */ _args) => envelope("fresh"), rename = async (id, name) => ({ id, name }), createSession = async (args) => ({ sessionId: 10, sessionName: args.name || "bob" }), setWorkspaceArchived = async ({ workspaceId, archived }) => ({ id: workspaceId, archived_at: archived ? new Date().toISOString() : null }), setSessionArchived = async ({ sessionId, archived }) => ({ id: sessionId, archived_at: archived ? new Date().toISOString() : null, sessionIds: [sessionId] }), workspaces = [{ id: 7, name: "work", project_root: null, project_label: null, archived_at: null }], sessions = [{ id: 10, name: "bob", origin: "model", parentSessionId: null, kind: "work", lifecycle: "completed", archived_at: null }] } = {}) {
    const created = [];
    let handler;
    const module = createModule();
    const credentials = {
        verify: (token) => token === "valid-session" ? /** @type {const} */ ({ kind: "session", clientId: "plurnk-web", scopes: ["acp"], family: "f1", subject: "op" }) : null,
        onRevoked: () => () => {},
    };
    if (auth) {
        await module.setup({
            credentials: {
                registerClient: () => ({ clientId: "plurnk-web", clientSecret: "sec" }),
            },
        });
    }

    let base = "";
    const seam = {
        credentials: {
            ...credentials,
            face: () => auth ? { issuer: () => base } : null,
        },
        registerHttpRoute(_prefix, serve) { handler = serve; },
        listWorkspaces: async () => workspaces,
        listSessions: async () => sessions,
        createWorkspace: async (args) => { created.push(args); return create(args); },
        renameWorkspace: rename,
        createSession,
        setWorkspaceArchived,
        setSessionArchived,
    };
    await module.start(/** @type {any} */ (seam));
    const server = createServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => module.close());
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

    const post = (token, headers = {}, extraBody = {}) => {
        const finalHeaders = {
            "content-type": "application/x-www-form-urlencoded",
            origin: base,
            ...(auth && admitted ? { cookie: "plurnk_web_session=valid-session" } : {}),
            ...headers,
        };
        for (const [key, value] of Object.entries(finalHeaders)) {
            if (value === undefined) delete finalHeaders[key];
        }
        return fetch(new URL("/workspaces/new", base), {
            method: "POST",
            headers: finalHeaders,
            body: new URLSearchParams({ token, ...extraBody }),
            redirect: "manual",
        });
    };

    return { base, created, post };
}
async function formToken(base, headers = {}) {
    const page = await fetch(new URL("/~/", base), { headers });
    assert.equal(page.status, 200, "the workspaces directory carries the creation form");
    const html = await page.text();
    const token = /name="token" value="([^"]+)"/u.exec(html)?.[1];
    assert.ok(token);
    assert.match(html, /id="workspace-create"/u);
    assert.match(html, /title="New workspace"/u);
    return token;
}

test("{§web-workspace-creation} the native form creates one folderless workspace and converges retries", async (t) => {
    const { base, created, post } = await fixture(t);
    const token = await formToken(base);
    for (const attempt of ["first submission", "retry after the browser lost the response"]) {
        const res = await post(token);
        assert.equal(res.status, 303, attempt);
        assert.equal(res.headers.get("location"), "/~/fresh/", attempt);
    }
    assert.deepEqual(created, [{ projectRoot: null }], "the daemon's creation contract is invoked exactly once with no folder, name or settings");
});

test("{§web-workspace-creation} racing double-clicks converge to one creation", async (t) => {
    const gate = Promise.withResolvers();
    const { base, created, post } = await fixture(t, { create: async () => { await gate.promise; return envelope("raced"); } });
    const token = await formToken(base);
    const posts = [post(token), post(token)];
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.resolve();
    for (const res of await Promise.all(posts)) {
        assert.equal(res.status, 303);
        assert.equal(res.headers.get("location"), "/~/raced/");
    }
    assert.deepEqual(created, [{ projectRoot: null }]);
});

test("{§web-workspace-creation} the fixed creation address admits only the native form", async (t) => {
    const { base, post } = await fixture(t);
    for (const method of ["GET", "HEAD"]) {
        const res = await fetch(new URL("/workspaces/new", base), { method, redirect: "manual" });
        assert.equal(res.status, 405, method);
        assert.equal(res.headers.get("allow"), "POST");
    }
    const json = await fetch(new URL("/workspaces/new", base),
        { method: "POST", headers: { "content-type": "application/json", origin: base }, body: "{}", redirect: "manual" });
    assert.equal(json.status, 415);
    const charset = await post(randomUUID(), { "content-type": "application/x-www-form-urlencoded; charset=latin1" });
    assert.equal(charset.status, 415);
    for (const body of ["extra=1", "token=a&extra=1", "token="]) {
        const res = await fetch(new URL("/workspaces/new", base),
            { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: base }, body, redirect: "manual" });
        assert.equal(res.status, 400, body);
    }
    const oversized = await fetch(new URL("/workspaces/new", base),
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: base }, body: `token=${"a".repeat(Number(process.env.PLURNK_WEB_FORM_BYTES))}`, redirect: "manual" });
    assert.equal(oversized.status, 413, "PLURNK_WEB_FORM_BYTES bounds the body");
    const twice = await fetch(new URL("/workspaces/new", base), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
        body: `token=${randomUUID()}&token=${randomUUID()}`, redirect: "manual" });
    assert.equal(twice.status, 400, "exactly one token field");
});

test("{§web-workspace-creation} invalid token syntax is rejected with 400", async (t) => {
    const { created, post } = await fixture(t);
    const res = await post("not-a-uuid");
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Invalid form token\./u);
    assert.deepEqual(created, []);
});

test("{§web-workspace-creation} anonymous creation strictly requires matching origin and sec-fetch-site", async (t) => {
    const { base, created, post } = await fixture(t);
    const token = await formToken(base);
    const host = new URL(base).host;
    for (const [name, headers, status] of /** @type {const} */ ([
        ["missing origin", { origin: undefined }, 403],
        ["foreign origin", { origin: "https://evil.example" }, 403],
        ["cross-site fetch metadata", { "sec-fetch-site": "cross-site" }, 403],
        ["matching origin", { origin: `http://${host}` }, 303],
        ["same-origin fetch metadata", { "sec-fetch-site": "same-origin" }, 303],
    ])) {
        const res = await post(token, headers);
        assert.equal(res.status, status, name);
    }
    assert.deepEqual(created, [{ projectRoot: null }]);
});

test("{§web-workspace-creation} authenticated creation enforces admission and origin", async (t) => {
    const { created, post } = await fixture(t, { auth: true, admitted: true });
    const token = randomUUID();

    // Unadmitted POST returns 401
    const unadmitted = await post(token, { cookie: "" });
    assert.equal(unadmitted.status, 401);

    // Cross-origin POST returns 403
    const crossOrigin = await post(token, { origin: "https://evil.example" });
    assert.equal(crossOrigin.status, 403);
    // A browser reporting another site is refused even with this origin, as in the anonymous posture
    assert.equal((await post(token, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await post(token, { "sec-fetch-site": "same-site" })).status, 403);

    // Admitted same-origin POST returns 303 redirect
    const admittedRes = await post(token);
    assert.equal(admittedRes.status, 303);
    assert.equal(admittedRes.headers.get("location"), "/~/fresh/");
    assert.deepEqual(created, [{ projectRoot: null }]);
});

// The daemon's own refusal of a name, as its operation failure carries it.
const nameConflict = (name) => Object.assign(new Error(`Workspace name '${name}' is already in use.`), {
    result: { status: 409, problem: Problems.create("daemon:workspace", "name-conflict", 409, `Workspace name '${name}' is already in use.`,
        { recovery: "Choose another workspace name or attach to the existing workspace." }) },
});

for (const [form, path, fields] of /** @type {const} */ ([
    ["workspace-create", "/workspaces/new", (token, name) => ({ token, name })],
    ["workspace-rename", "/workspaces/rename", (_token, name) => ({ workspace: "work", name })],
    ["session-create", "/sessions/new", (token, name) => ({ token, workspace: "work", name })],
])) {
    for (const refused of [true, false]) {
        test(`{§web-workspace-creation} {§web-workspace-rename} {§web-session-creation} ${form}: a daemon ${refused ? "refusal keeps its status, detail and recovery" : "failure is a 502"}, and the draft comes back with a fresh token`, async (t) => {
            const calls = [];
            const fail = (name) => { calls.push(name); if (name === "taken") throw refused ? nameConflict(name) : new Error("daemon unreachable"); };
            const { base } = await fixture(t, {
                create: async ({ name }) => { fail(name); return envelope(name); },
                rename: async (id, name) => { fail(name); return { id, name }; },
                createSession: async ({ name }) => { fail(name); return { sessionId: 10, sessionName: name }; },
            });
            const send = (body) => fetch(new URL(path, base), { method: "POST", redirect: "manual",
                headers: { "content-type": "application/x-www-form-urlencoded", origin: base }, body: new URLSearchParams(body) });
            const token = randomUUID();
            const res = await send(fields(token, "taken"));
            const page = await res.text();
            assert.equal(res.status, refused ? 409 : 502);
            if (refused) {
                assert.match(page, /Workspace name &#39;taken&#39; is already in use\./u, "the daemon's detail");
                assert.match(page, /Choose another workspace name or attach to the existing workspace\./u, "the daemon's recovery");
            } else {
                assert.match(page, /The daemon could not/u);
            }
            const retry = new RegExp(`<form id="${form}"[^>]*>[\\s\\S]*?</form>`, "u").exec(page)?.[0];
            assert.ok(retry, "the page offers the form again");
            assert.match(retry, /name="name" value="taken"/u, "holding the draft");
            const retryToken = /name="token" value="([^"]+)"/u.exec(retry)?.[1];
            if (form === "workspace-rename") {
                assert.equal(retryToken, undefined, "rename carries no token");
            } else {
                assert.ok(retryToken && retryToken !== token, "with a fresh token");
                assert.equal((await send(fields(token, "taken"))).status, refused ? 409 : 502, "the settled failure replays");
                assert.deepEqual(calls, ["taken"], "without calling the daemon again");
            }
            const corrected = await send(fields(retryToken ?? token, "corrected"));
            assert.equal(corrected.status, 303, "the corrected draft is a new request");
            assert.deepEqual(calls, ["taken", "corrected"]);
        });
    }
}

test("{§web-workspace-creation} {§web-session-creation} an empty name is no name, and any other name reaches the daemon verbatim", async (t) => {
    const sessions = [];
    const { base, created, post } = await fixture(t, {
        createSession: async (args) => { sessions.push(args); return { sessionId: 10, sessionName: args.name ?? "a1b2c3d4" }; },
    });
    const sessionPost = (body) => fetch(new URL("/sessions/new", base), {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: base }, body: new URLSearchParams(body), redirect: "manual",
    });
    const cases = [["no name field", undefined], ["an empty name", ""], ["a name", "my-custom"], ["a name with spaces around it", "  spaced  "]];
    for (const [label, name] of cases) {
        const named = name === undefined ? {} : { name };
        assert.equal((await post(randomUUID(), {}, named)).status, 303, label);
        assert.equal((await sessionPost({ workspace: "work", token: randomUUID(), ...named })).status, 303, label);
    }
    const requested = cases.map(([, name]) => name === undefined || name === "" ? {} : { name });
    assert.deepEqual(created, requested.map((named) => ({ ...named, projectRoot: null })));
    assert.deepEqual(sessions, requested.map((named) => ({ workspaceId: 7, ...named })));
});

test("{§web-workspace-rename} workspace rename updates name and redirects to new canonical path", async (t) => {
    const renamed = [];
    const { base } = await fixture(t, {
        workspaces: [{ id: 7, name: "old-name", project_root: null, project_label: null, archived_at: null }],
        rename: async (id, name) => { renamed.push({ id, name }); return { id, name }; },
    });

    const renamePost = (body, headers = {}) => fetch(new URL("/workspaces/rename", base), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: base, ...headers },
        body: new URLSearchParams(body),
        redirect: "manual",
    });

    // Method guard
    for (const method of ["GET", "HEAD"]) {
        const res = await fetch(new URL("/workspaces/rename", base), { method, redirect: "manual" });
        assert.equal(res.status, 405, method);
        assert.equal(res.headers.get("allow"), "POST");
    }

    // Origin check
    const foreign = await renamePost({ workspace: "old-name", name: "new-name" }, { origin: "https://evil.example" });
    assert.equal(foreign.status, 403);

    // Missing workspace 404
    const missing = await renamePost({ workspace: "nonexistent", name: "new-name" });
    assert.equal(missing.status, 404);

    // Empty name 400; any other name reaches the daemon verbatim, for its admission to judge
    const empty = await renamePost({ workspace: "old-name", name: "" });
    assert.equal(empty.status, 400);
    const spaced = await renamePost({ workspace: "old-name", name: "  spaced  " });
    assert.equal(spaced.status, 303);

    // Valid rename
    const success = await renamePost({ workspace: "old-name", name: "new-name" });
    assert.equal(success.status, 303);
    assert.equal(success.headers.get("location"), "/~/new-name/");
    assert.deepEqual(renamed, [{ id: 7, name: "  spaced  " }, { id: 7, name: "new-name" }]);
});

test("{§web-session-creation} session creation creates independent session and redirects", async (t) => {
    const createdSessions = [];
    const { base } = await fixture(t, {
        workspaces: [{ id: 7, name: "my-workspace", project_root: null, project_label: null, archived_at: null }],
        createSession: async (args) => { createdSessions.push(args); return { sessionId: 10, sessionName: args.name || "bob" }; },
    });

    const sessionPost = (body, headers = {}) => fetch(new URL("/sessions/new", base), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: base, ...headers },
        body: new URLSearchParams(body),
        redirect: "manual",
    });

    // Method guard
    for (const method of ["GET", "HEAD"]) {
        const res = await fetch(new URL("/sessions/new", base), { method, redirect: "manual" });
        assert.equal(res.status, 405, method);
        assert.equal(res.headers.get("allow"), "POST");
    }

    // Origin check
    const token = randomUUID();
    const foreign = await sessionPost({ workspace: "my-workspace", token, name: "alice" }, { origin: "https://evil.example" });
    assert.equal(foreign.status, 403);

    // Missing workspace 404
    const missing = await sessionPost({ workspace: "nonexistent", token: randomUUID(), name: "alice" });
    assert.equal(missing.status, 404);

    // Create named session
    const namedRes = await sessionPost({ workspace: "my-workspace", token: randomUUID(), name: "alice" });
    assert.equal(namedRes.status, 303);
    assert.equal(namedRes.headers.get("location"), "/~/my-workspace@alice/");
    assert.deepEqual(createdSessions[0], { workspaceId: 7, name: "alice" });

    // Create unnamed session (daemon generates name)
    const unnamedToken = randomUUID();
    const unnamedRes = await sessionPost({ workspace: "my-workspace", token: unnamedToken });
    assert.equal(unnamedRes.status, 303);
    assert.equal(unnamedRes.headers.get("location"), "/~/my-workspace@bob/");
    assert.deepEqual(createdSessions[1], { workspaceId: 7 });

    // Idempotent retry converges to same session
    const retryRes = await sessionPost({ workspace: "my-workspace", token: unnamedToken });
    assert.equal(retryRes.status, 303);
    assert.equal(retryRes.headers.get("location"), "/~/my-workspace@bob/");
    assert.equal(createdSessions.length, 2);
});

test("{§web-workspace-archive} workspace archive calls daemon and redirects to /~/", async (t) => {
    const archived = [];
    const { base } = await fixture(t, {
        workspaces: [{ id: 7, name: "target-ws", project_root: null, project_label: null, archived_at: null }],
        setWorkspaceArchived: async (args) => { archived.push(args); return { id: args.workspaceId, archived_at: "2026-10-23T00:00:00Z" }; },
    });
    const archivePost = (body, headers = {}) => fetch(new URL("/workspaces/archive", base), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: base, ...headers },
        body: new URLSearchParams(body),
        redirect: "manual",
    });

    // Method guard
    for (const method of ["GET", "HEAD"]) {
        const res = await fetch(new URL("/workspaces/archive", base), { method, redirect: "manual" });
        assert.equal(res.status, 405, method);
        assert.equal(res.headers.get("allow"), "POST");
    }

    // Origin check
    const foreign = await archivePost({ workspace: "target-ws" }, { origin: "https://evil.example" });
    assert.equal(foreign.status, 403);

    // Missing workspace 404
    const missing = await archivePost({ workspace: "nonexistent" });
    assert.equal(missing.status, 404);

    // Empty workspace 400
    const empty = await archivePost({ workspace: "" });
    assert.equal(empty.status, 400);

    // Successful archive
    const res = await archivePost({ workspace: "target-ws" });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/~/");
    assert.deepEqual(archived, [{ workspaceId: 7, archived: true }]);
});

test("{§web-session-archive} session archive calls daemon and redirects to workspace address", async (t) => {
    const archived = [];
    const { base } = await fixture(t, {
        workspaces: [{ id: 7, name: "target-ws", project_root: null, project_label: null, archived_at: null }],
        sessions: [{ id: 10, name: "target-session", origin: "model", parentSessionId: null, kind: "work", lifecycle: "completed", archived_at: null }],
        setSessionArchived: async (args) => { archived.push(args); return { id: args.sessionId, archived_at: "2026-10-23T00:00:00Z", sessionIds: [args.sessionId] }; },
    });

    const archivePost = (body, headers = {}) => fetch(new URL("/sessions/archive", base), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: base, ...headers },
        body: new URLSearchParams(body),
        redirect: "manual",
    });

    // Method guard
    for (const method of ["GET", "HEAD"]) {
        const res = await fetch(new URL("/sessions/archive", base), { method, redirect: "manual" });
        assert.equal(res.status, 405, method);
        assert.equal(res.headers.get("allow"), "POST");
    }

    // Origin check
    const foreign = await archivePost({ workspace: "target-ws", session: "target-session" }, { origin: "https://evil.example" });
    assert.equal(foreign.status, 403);

    // Missing workspace 404
    const missingWs = await archivePost({ workspace: "nonexistent", session: "target-session" });
    assert.equal(missingWs.status, 404);

    // Missing session 404
    const missingSession = await archivePost({ workspace: "target-ws", session: "nonexistent" });
    assert.equal(missingSession.status, 404);

    // Empty fields 400
    const empty = await archivePost({ workspace: "target-ws", session: "" });
    assert.equal(empty.status, 400);

    // Successful archive
    const res = await archivePost({ workspace: "target-ws", session: "target-session" });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/~/target-ws/");
    assert.deepEqual(archived, [{ workspaceId: 7, sessionId: 10, archived: true }]);
});
