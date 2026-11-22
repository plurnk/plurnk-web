import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { Problems } from "@plurnk/plurnk-contracts";
import createModule from "../src/module.js";

const envelope = (name) => ({ workspaceId: 41, workspaceName: name, projectRoot: null, projectLabel: null });

// {§web-workspace-creation} Tests both anonymous and authenticated postures without global env pollution.
async function fixture(t, { auth = false, admitted = true, create = async (/** @type {any} */ _args) => envelope("fresh"), rename = async (id, name) => ({ id, name }), createSession = async (args) => ({ sessionId: 10, sessionName: args.name || "bob" }), setWorkspaceArchived = async ({ workspaceId, archived }) => ({ id: workspaceId, archived_at: archived ? new Date().toISOString() : null }), setSessionArchived = async ({ sessionId, archived }) => ({ id: sessionId, archived_at: archived ? new Date().toISOString() : null, sessionIds: [sessionId] }), setSessionTitle = async ({ sessionId, title }) => ({ id: sessionId, title }), workspaces = [{ id: 7, name: "work", project_root: null, project_label: null, archived_at: null }], sessions = [{ id: 10, name: "bob", origin: "model", parentSessionId: null, kind: "work", lifecycle: "completed", archived_at: null }] } = {}) {
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
        setSessionTitle,
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
    const page = await fetch(new URL("/search/", base), { headers });
    assert.equal(page.status, 200, "the search page carries the workspace switcher and creation forms");
    const html = await page.text();
    const token = /name="token" value="([^"]+)"/u.exec(html)?.[1];
    assert.ok(token);
    assert.match(html, /id="workspace-create"/u);
    assert.match(html, /data-dialog-target="dialog-workspace-create"/u);
    assert.doesNotMatch(html, /data-action="new-workspace"/u);
    return token;
}

test("{§web-workspace-creation} the native form creates one sequential folderless workspace with starter session1 and converges retries", async (t) => {
    const createdSessions = [];
    const { base, created, post } = await fixture(t, {
        create: async (args) => envelope(args.name ?? "fresh"),
        createSession: async (args) => { createdSessions.push(args); return { sessionId: 10, sessionName: args.name || "session1" }; },
    });
    const token = await formToken(base);
    for (const attempt of ["first submission", "retry after the browser lost the response"]) {
        const res = await post(token);
        assert.equal(res.status, 303, attempt);
        assert.equal(res.headers.get("location"), "/~/workspace1#session1", attempt);
    }
    assert.deepEqual(created, [{ name: "workspace1", projectRoot: null }], "folderless unnamed creation allocates sequential workspace1");
    assert.deepEqual(createdSessions, [{ workspaceId: 41, name: "session1" }], "starter session1 is allocated once");
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
        assert.equal(res.headers.get("location"), "/~/raced#session1");
    }
    assert.deepEqual(created, [{ name: "workspace1", projectRoot: null }]);
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
    assert.deepEqual(created, [{ name: "workspace1", projectRoot: null }]);
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
    assert.equal(admittedRes.headers.get("location"), "/~/fresh#session1");
    assert.deepEqual(created, [{ name: "workspace1", projectRoot: null }]);
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
        test(`{§web-workspace-creation} {§web-workspace-rename} {§web-session-creation} ${form}: a daemon ${refusalLabel(refused)}, and the draft comes back with a fresh token`, async (t) => {
            const calls = [];
            const fail = (name) => { calls.push(name); if (name === "taken") throw refused ? nameConflict(name) : new Error("daemon unreachable"); };
            const { base } = await fixture(t, {
                create: async ({ name }) => { fail(name); return envelope(name); },
                rename: async (id, name) => { fail(name); return { id, name }; },
                createSession: async ({ workspaceId, name }) => {
                    if (form === "session-create") fail(name);
                    return { sessionId: workspaceId + 10, sessionName: name || "session1" };
                },
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

function refusalLabel(refused) {
    return refused ? "refusal keeps its status, detail and recovery" : "failure is a 502";
}

test("{§web-workspace-creation} {§web-session-creation} empty names allocate sequential workspaceX/sessionX, folder-backed workspaces omit empty names, and explicit names reach the daemon verbatim", async (t) => {
    const sessions = [];
    const workspaceList = [
        { id: 7, name: "work", project_root: null, project_label: null, archived_at: null },
        { id: 8, name: "workspace1", project_root: null, project_label: null, archived_at: "2026-11-20T00:00:00Z" },
    ];
    const sessionList = [
        { id: 10, name: "session1", origin: "model", parentSessionId: null, kind: "root", lifecycle: "completed", archived_at: "2026-11-20T00:00:00Z" },
    ];
    let racedWsOnce = false;
    let racedSessionOnce = false;
    const { base, created, post } = await fixture(t, {
        workspaces: workspaceList,
        sessions: sessionList,
        create: async (args) => {
            if (args.name === "workspace2" && !racedWsOnce) {
                racedWsOnce = true;
                workspaceList.push({ id: 9, name: "workspace2", project_root: null, project_label: null, archived_at: null });
                throw nameConflict("workspace2");
            }
            const name = args.name ?? "repo";
            workspaceList.push({ id: 40 + workspaceList.length, name, project_root: args.projectRoot ?? null, project_label: args.projectRoot ?? null, archived_at: null });
            return { workspaceId: 41, workspaceName: name, projectRoot: args.projectRoot ?? null, projectLabel: args.projectRoot ?? null };
        },
        createSession: async (args) => {
            if (args.workspaceId === 7) {
                sessions.push(args);
                if (args.name === "session2" && !racedSessionOnce) {
                    racedSessionOnce = true;
                    sessionList.push({ id: 11, name: "session2", origin: "model", parentSessionId: null, kind: "root", lifecycle: "idle", archived_at: null });
                    throw nameConflict("session2");
                }
                const assigned = args.name ?? "a1b2c3d4";
                sessionList.push({ id: 10 + sessionList.length, name: assigned, origin: "model", parentSessionId: null, kind: "root", lifecycle: "idle", archived_at: null });
                return { sessionId: 10 + sessionList.length, sessionName: assigned };
            }
            return { sessionId: 99, sessionName: args.name ?? "session1" };
        },
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
    // Folder-backed workspace with empty name omits `name` so the daemon derives folder basename.
    assert.equal((await post(randomUUID(), {}, { name: "", projectRoot: "/srv/repo" })).status, 303, "folder-backed unnamed");
    assert.deepEqual(created, [
        { name: "workspace2", projectRoot: null },
        { name: "workspace3", projectRoot: null },
        { name: "workspace4", projectRoot: null },
        { name: "my-custom", projectRoot: null },
        { name: "  spaced  ", projectRoot: null },
        { projectRoot: "/srv/repo" },
    ]);
    assert.deepEqual(sessions, [
        { workspaceId: 7, name: "session2" },
        { workspaceId: 7, name: "session3" },
        { workspaceId: 7, name: "session4" },
        { workspaceId: 7, name: "my-custom" },
        { workspaceId: 7, name: "  spaced  " },
    ]);
});

test("{§web-workspace-creation} optional projectRoot reaches the daemon verbatim and survives retry on refusal", async (t) => {
    const invalidPath = (projectRoot) => Object.assign(new Error(`Project root '${projectRoot}' must be an absolute path.`), {
        result: { status: 400, problem: Problems.create("daemon:workspace", "project-root-not-absolute", 400,
            `Project root '${projectRoot}' must be an absolute path.`,
            { recovery: "Supply an absolute directory path on the daemon host." }) },
    });
    const { base, created, post } = await fixture(t, {
        create: async ({ name, projectRoot }) => {
            if (projectRoot && !projectRoot.startsWith("/")) throw invalidPath(projectRoot);
            return { workspaceId: 42, workspaceName: name || "foldered", projectRoot, projectLabel: projectRoot };
        },
    });
    const blankChecked = await post(randomUUID(), {}, { name: "my-repo", useProjectFolder: "1", projectRoot: "   " });
    assert.equal(blankChecked.status, 400);
    const blankPage = await blankChecked.text();
    assert.match(blankPage, /Enter a project folder path\./u);
    assert.match(blankPage, /name="useProjectFolder" value="1" data-toggle-project-folder checked/u);

    const badToken = await formToken(base);
    const badRes = await post(badToken, {}, { name: "my-repo", useProjectFolder: "1", projectRoot: "relative/repo" });
    assert.equal(badRes.status, 400);
    const badPage = await badRes.text();
    assert.match(badPage, /Project root &#39;relative\/repo&#39; must be an absolute path\./u);
    assert.match(badPage, /Supply an absolute directory path on the daemon host\./u);
    const retry = /<form id="workspace-create"[^>]*>[\s\S]*?<\/form>/u.exec(badPage)?.[0];
    assert.ok(retry, "refusal offers the workspace creation form again");
    assert.match(retry, /name="name" value="my-repo"/u, "holding the workspace name draft");
    assert.match(retry, /name="useProjectFolder" value="1" data-toggle-project-folder checked/u, "preserving checked project-folder state");
    assert.match(retry, /name="projectRoot" value="relative\/repo"/u, "holding the projectRoot draft");
    const retryToken = /name="token" value="([^"]+)"/u.exec(retry)?.[1];
    assert.ok(retryToken && retryToken !== badToken, "with a fresh token");

    const okRes = await post(retryToken, {}, { name: "my-repo", useProjectFolder: "1", projectRoot: "/srv/my-repo" });
    assert.equal(okRes.status, 303);
    assert.equal(okRes.headers.get("location"), "/~/my-repo#session1");
    assert.deepEqual(created, [
        { name: "my-repo", projectRoot: "relative/repo" },
        { name: "my-repo", projectRoot: "/srv/my-repo" },
    ]);
});

test("{§web-workspace-creation} PLURNK_WEB_ALLOW_PROJECT_FOLDER=0 omits project folder controls and refuses folder-bound workspace creation", async (t) => {
    const original = process.env.PLURNK_WEB_ALLOW_PROJECT_FOLDER;
    process.env.PLURNK_WEB_ALLOW_PROJECT_FOLDER = "0";
    t.after(() => {
        if (original === undefined) delete process.env.PLURNK_WEB_ALLOW_PROJECT_FOLDER;
        else process.env.PLURNK_WEB_ALLOW_PROJECT_FOLDER = original;
    });
    const { base, created, post } = await fixture(t);
    const searchRes = await fetch(new URL("/search/", base));
    assert.equal(searchRes.status, 200);
    const html = await searchRes.text();
    const createForm = /<form id="workspace-create"[^>]*>[\s\S]*?<\/form>/u.exec(html)?.[0] ?? "";
    assert.ok(createForm, "#workspace-create remains available for folderless workspaces");
    assert.doesNotMatch(createForm, /useProjectFolder|projectRoot/u, "project folder toggle and path field are omitted");

    const refusedRoot = await post(randomUUID(), {}, { name: "repo", projectRoot: "/srv/repo" });
    assert.equal(refusedRoot.status, 403);
    assert.match(await refusedRoot.text(), /Project folder workspaces are disabled on this web interface\./u);

    const refusedFlag = await post(randomUUID(), {}, { name: "repo", useProjectFolder: "1" });
    assert.equal(refusedFlag.status, 403);
    assert.deepEqual(created, []);

    const folderlessRes = await post(randomUUID(), {}, { name: "cloud-only" });
    assert.equal(folderlessRes.status, 303);
    assert.deepEqual(created, [{ name: "cloud-only", projectRoot: null }]);
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

    // Valid rename (without and with active session fragment)
    const success = await renamePost({ workspace: "old-name", name: "new-name" });
    assert.equal(success.status, 303);
    assert.equal(success.headers.get("location"), "/~/new-name");
    const withSession = await renamePost({ workspace: "old-name", name: "new-name", session: "bob" });
    assert.equal(withSession.status, 303);
    assert.equal(withSession.headers.get("location"), "/~/new-name#bob");
    assert.deepEqual(renamed, [{ id: 7, name: "  spaced  " }, { id: 7, name: "new-name" }, { id: 7, name: "new-name" }]);
});

test("{§web-session-creation} session creation creates independent session, applies optional title, and redirects", async (t) => {
    const createdSessions = [];
    const titledSessions = [];
    const { base } = await fixture(t, {
        workspaces: [{ id: 7, name: "my-workspace", project_root: null, project_label: null, archived_at: null }],
        createSession: async (args) => { createdSessions.push(args); return { sessionId: 10 + createdSessions.length, sessionName: args.name || "bob" }; },
        setSessionTitle: async (args) => { titledSessions.push(args); return { id: args.sessionId, title: args.title }; },
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

    // Create named session with optional title
    const namedRes = await sessionPost({ workspace: "my-workspace", token: randomUUID(), name: "alice", title: "  Design sync  " });
    assert.equal(namedRes.status, 303);
    assert.equal(namedRes.headers.get("location"), "/~/my-workspace#alice");
    assert.deepEqual(createdSessions[0], { workspaceId: 7, name: "alice" });
    assert.deepEqual(titledSessions[0], { workspaceId: 7, sessionId: 11, title: "Design sync" });

    // Create unnamed session (client allocates sequential session1)
    const unnamedToken = randomUUID();
    const unnamedRes = await sessionPost({ workspace: "my-workspace", token: unnamedToken });
    assert.equal(unnamedRes.status, 303);
    assert.equal(unnamedRes.headers.get("location"), "/~/my-workspace#session1");
    assert.deepEqual(createdSessions[1], { workspaceId: 7, name: "session1" });
    assert.equal(titledSessions.length, 1, "omitted title leaves session untitled");

    // Idempotent retry converges to same session
    const retryRes = await sessionPost({ workspace: "my-workspace", token: unnamedToken });
    assert.equal(retryRes.status, 303);
    assert.equal(retryRes.headers.get("location"), "/~/my-workspace#session1");
    assert.equal(createdSessions.length, 2);
});

test("{§web-workspace-archive} {§web-search} workspace archive and unarchive call daemon and redirect cleanly", async (t) => {
    const archived = [];
    const { base } = await fixture(t, {
        workspaces: [{ id: 7, name: "target-ws", project_root: null, project_label: null, archived_at: null }],
        setWorkspaceArchived: async (args) => { archived.push(args); return { id: args.workspaceId, archived_at: args.archived ? "2026-10-23T00:00:00Z" : null }; },
    });
    const archivePost = (body, headers = {}, route = "/workspaces/archive") => fetch(new URL(route, base), {
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

    // Successful archive redirects to / (clearing remembered place cookie if it belonged to workspace 7)
    const res = await archivePost({ workspace: "target-ws" }, { cookie: "plurnk_web_place=7:10" });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/");
    assert.match(res.headers.get("set-cookie") ?? "", /^plurnk_web_place=;.*Max-Age=0/u);

    // Successful unarchive redirects to /~/target-ws
    const unarchiveRes = await archivePost({ workspace: "target-ws" }, {}, "/workspaces/unarchive");
    assert.equal(unarchiveRes.status, 303);
    assert.equal(unarchiveRes.headers.get("location"), "/~/target-ws");
    assert.deepEqual(archived, [{ workspaceId: 7, archived: true }, { workspaceId: 7, archived: false }]);
});

test("{§web-session-archive} {§web-search} session archive prefers remaining sessions, allocates a starter tab on last unarchived session, and sets session titles", async (t) => {
    const archived = [];
    const titled = [];
    const allocated = [];
    const sessionRows = [
        { id: 10, name: "target-session", origin: "model", parentSessionId: null, kind: "root", lifecycle: "completed", archived_at: null },
        { id: 11, name: "sibling", origin: "model", parentSessionId: null, kind: "root", lifecycle: "idle", archived_at: null },
    ];
    const { base } = await fixture(t, {
        workspaces: [{ id: 7, name: "target-ws", project_root: null, project_label: null, archived_at: null }],
        sessions: sessionRows,
        createSession: async (args) => {
            allocated.push(args);
            const row = { id: 12, name: "fresh-starter", origin: "model", parentSessionId: null, kind: "root", lifecycle: "idle", archived_at: null };
            sessionRows.push(row);
            return { sessionId: row.id, sessionName: row.name };
        },
        setSessionArchived: async (args) => {
            archived.push(args);
            const row = sessionRows.find((s) => s.id === args.sessionId);
            if (row) row.archived_at = args.archived ? "2026-10-23T00:00:00Z" : null;
            return { id: args.sessionId, archived_at: row?.archived_at ?? null, sessionIds: [args.sessionId] };
        },
        setSessionTitle: async (args) => {
            titled.push(args);
            return { id: args.sessionId, title: args.title };
        },
    });

    const archivePost = (body, headers = {}, route = "/sessions/archive") => fetch(new URL(route, base), {
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

    // Setting session title via POST /sessions/title (blank title answers 400)
    const setTitleRes = await archivePost({ workspace: "target-ws", session: "target-session", title: "  Bug bash  " }, {}, "/sessions/title");
    assert.equal(setTitleRes.status, 303);
    assert.equal(setTitleRes.headers.get("location"), "/~/target-ws#target-session");
    const blankTitleRes = await archivePost({ workspace: "target-ws", session: "target-session", title: "   " }, {}, "/sessions/title");
    assert.equal(blankTitleRes.status, 400);
    assert.deepEqual(titled, [
        { workspaceId: 7, sessionId: 10, title: "Bug bash" },
    ]);

    // Archiving when a sibling remains redirects to /~/target-ws#sibling
    const firstArchive = await archivePost({ workspace: "target-ws", session: "target-session" });
    assert.equal(firstArchive.status, 303);
    assert.equal(firstArchive.headers.get("location"), "/~/target-ws#sibling");

    // Archiving the last unarchived session allocates a fresh sequential session1 in the same workspace
    const lastArchive = await archivePost({ workspace: "target-ws", session: "sibling" });
    assert.equal(lastArchive.status, 303);
    assert.equal(lastArchive.headers.get("location"), "/~/target-ws#fresh-starter");
    assert.deepEqual(allocated, [{ workspaceId: 7, name: "session1" }]);

    // Unarchiving restores /~/target-ws#target-session
    const unarchiveRes = await archivePost({ workspace: "target-ws", session: "target-session" }, {}, "/sessions/unarchive");
    assert.equal(unarchiveRes.status, 303);
    assert.equal(unarchiveRes.headers.get("location"), "/~/target-ws#target-session");
    assert.deepEqual(archived, [
        { workspaceId: 7, sessionId: 10, archived: true },
        { workspaceId: 7, sessionId: 11, archived: true },
        { workspaceId: 7, sessionId: 10, archived: false },
    ]);
});
