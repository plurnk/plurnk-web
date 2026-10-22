import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import createModule from "../ai.plurnk/module.js";

const envelope = (name) => ({ workspaceId: 41, workspaceName: name, projectRoot: null, projectLabel: null });

// {§web-workspace-creation} Tests both anonymous and authenticated postures without global env pollution.
async function fixture(t, { auth = false, admitted = true, create = async () => envelope("fresh"), rename = async (id, name) => ({ id, name }), createWorker = async (args) => ({ workerId: 10, workerName: args.name || "bob" }), workspaces = [{ id: 7, name: "work", project_root: null, project_label: null }] } = {}) {
    const originalAuth = process.env.PLURNK_AUTH;
    process.env.PLURNK_AUTH = auth ? "1" : "0";
    t.after(() => {
        if (originalAuth === undefined) delete process.env.PLURNK_AUTH;
        else process.env.PLURNK_AUTH = originalAuth;
    });

    const created = [];
    let handler;
    const module = createModule();
    const credentials = {
        verify: (token) => token === "valid-session" ? { kind: "session", clientId: "plurnk-web", scopes: ["agui"], family: "f1", subject: "op" } : null,
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
            face: () => ({ issuer: () => base }),
        },
        registerHttpRoute(_prefix, serve) { handler = serve; },
        listWorkspaces: async () => workspaces,
        listWorkers: async () => [],
        createWorkspace: async (args) => { created.push(args); return create(args); },
        renameWorkspace: rename,
        createWorker,
    };

    await module.start(seam);
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
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: base }, body: `token=${"a".repeat(8192)}`, redirect: "manual" });
    assert.equal(oversized.status, 413);
});

test("{§web-workspace-creation} invalid token syntax is rejected with 400", async (t) => {
    const { created, post } = await fixture(t);
    const res = await post("not-a-uuid");
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Invalid workspace creation token\./u);
    assert.deepEqual(created, []);
});

test("{§web-workspace-creation} anonymous creation strictly requires matching origin and sec-fetch-site", async (t) => {
    const { base, created, post } = await fixture(t);
    const token = await formToken(base);
    const host = new URL(base).host;
    for (const [name, headers, status] of [
        ["missing origin", { origin: undefined }, 403],
        ["foreign origin", { origin: "https://evil.example" }, 403],
        ["cross-site fetch metadata", { "sec-fetch-site": "cross-site" }, 403],
        ["matching origin", { origin: `http://${host}` }, 303],
        ["same-origin fetch metadata", { "sec-fetch-site": "same-origin" }, 303],
    ]) {
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

    // Admitted same-origin POST returns 303 redirect
    const admittedRes = await post(token);
    assert.equal(admittedRes.status, 303);
    assert.equal(admittedRes.headers.get("location"), "/~/fresh/");
    assert.deepEqual(created, [{ projectRoot: null }]);
});

test("{§web-workspace-creation} a daemon failure is preserved, not retried blindly", async (t) => {
    const { base, created, post } = await fixture(t, { create: async () => { throw new Error("daemon refused"); } });
    const token = await formToken(base);
    for (const attempt of ["failure", "retry of the settled failure"]) {
        const res = await post(token);
        assert.equal(res.status, 502, attempt);
    }
    assert.equal(created.length, 1);
});

test("{§web-workspace-creation} optional custom workspace name is passed to daemon", async (t) => {
    const { created, post } = await fixture(t);
    const token = randomUUID();
    const res = await post(token, {}, { name: "my-custom-workspace" });
    assert.equal(res.status, 303);
    assert.deepEqual(created, [{ name: "my-custom-workspace", projectRoot: null }]);
test("{§web-workspace-rename} workspace rename updates name and redirects to new canonical path", async (t) => {
    const renamed = [];
    const { base } = await fixture(t, {
        workspaces: [{ id: 7, name: "old-name", project_root: null, project_label: null }],
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

    // Empty name 400
    const empty = await renamePost({ workspace: "old-name", name: "   " });
    assert.equal(empty.status, 400);

    // Valid rename
    const success = await renamePost({ workspace: "old-name", name: "new-name" });
    assert.equal(success.status, 303);
    assert.equal(success.headers.get("location"), "/~/new-name/");
    assert.deepEqual(renamed, [{ id: 7, name: "new-name" }]);
});

test("{§web-worker-creation} worker creation creates independent worker and redirects", async (t) => {
    const createdWorkers = [];
    const { base } = await fixture(t, {
        workspaces: [{ id: 7, name: "my-workspace", project_root: null, project_label: null }],
        createWorker: async (args) => { createdWorkers.push(args); return { workerId: 10, workerName: args.name || "bob" }; },
    });

    const workerPost = (body, headers = {}) => fetch(new URL("/workers/new", base), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: base, ...headers },
        body: new URLSearchParams(body),
        redirect: "manual",
    });

    // Method guard
    for (const method of ["GET", "HEAD"]) {
        const res = await fetch(new URL("/workers/new", base), { method, redirect: "manual" });
        assert.equal(res.status, 405, method);
        assert.equal(res.headers.get("allow"), "POST");
    }

    // Origin check
    const token = randomUUID();
    const foreign = await workerPost({ workspace: "my-workspace", token, name: "alice" }, { origin: "https://evil.example" });
    assert.equal(foreign.status, 403);

    // Missing workspace 404
    const missing = await workerPost({ workspace: "nonexistent", token: randomUUID(), name: "alice" });
    assert.equal(missing.status, 404);

    // Create named worker
    const namedRes = await workerPost({ workspace: "my-workspace", token: randomUUID(), name: "alice" });
    assert.equal(namedRes.status, 303);
    assert.equal(namedRes.headers.get("location"), "/~/my-workspace@alice/");
    assert.deepEqual(createdWorkers[0], { workspaceId: 7, name: "alice" });

    // Create unnamed worker (daemon generates name)
    const unnamedToken = randomUUID();
    const unnamedRes = await workerPost({ workspace: "my-workspace", token: unnamedToken });
    assert.equal(unnamedRes.status, 303);
    assert.equal(unnamedRes.headers.get("location"), "/~/my-workspace@bob/");
    assert.deepEqual(createdWorkers[1], { workspaceId: 7 });

    // Idempotent retry converges to same worker
    const retryRes = await workerPost({ workspace: "my-workspace", token: unnamedToken });
    assert.equal(retryRes.status, 303);
    assert.equal(retryRes.headers.get("location"), "/~/my-workspace@bob/");
    assert.equal(createdWorkers.length, 2);
});
});