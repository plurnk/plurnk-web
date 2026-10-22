import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import createModule from "../ai.plurnk/module.js";

process.env.PLURNK_AUTH = "0";

const envelope = (name) => ({ workspaceId: 41, workspaceName: name, projectRoot: null, projectLabel: null });

// {§web-workspace-creation} The anonymous module serves the whole native journey: form, post, redirect.
async function fixture(t, create = async () => envelope("fresh")) {
    const created = [];
    let handler;
    const module = createModule();
    await module.start({
        registerHttpRoute(_prefix, serve) { handler = serve; },
        listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null }],
        listWorkers: async () => [],
        createWorkspace: async (args) => { created.push(args); return create(args); },
    });
    const server = createServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => module.close());
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (token, headers = {}) => fetch(new URL("/workspaces/new", base), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams({ token }),
        redirect: "manual",
    });
    return { base, created, post };
}

async function formToken(base) {
    const page = await fetch(new URL("/~/work/", base));
    assert.equal(page.status, 200, "the workspace page carries the creation form");
    const token = /name="token" value="([^"]+)"/u.exec(await page.text())?.[1];
    assert.ok(token);
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
    const { base, created, post } = await fixture(t, async () => { await gate.promise; return envelope("raced"); });
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
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}", redirect: "manual" });
    assert.equal(json.status, 415);
    const charset = await post("x", { "content-type": "application/x-www-form-urlencoded; charset=latin1" });
    assert.equal(charset.status, 415);
    for (const body of ["extra=1", "token=a&extra=1", "token="]) {
        const res = await fetch(new URL("/workspaces/new", base),
            { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, redirect: "manual" });
        assert.equal(res.status, 400, body);
    }
    const oversized = await fetch(new URL("/workspaces/new", base),
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${"a".repeat(8192)}`, redirect: "manual" });
    assert.equal(oversized.status, 413);
});

test("{§web-workspace-creation} a stale form reports itself instead of re-executing", async (t) => {
    const { created, post } = await fixture(t);
    const stale = await post(randomUUID());
    assert.equal(stale.status, 400);
    assert.match(await stale.text(), /This creation form expired\./u);
    assert.deepEqual(created, []);
});

test("{§web-workspace-creation} anonymous creation keeps a first-class same-origin guard", async (t) => {
    const { base, created, post } = await fixture(t);
    const token = await formToken(base);
    const host = new URL(base).host;
    for (const [name, headers, status] of [
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

test("{§web-workspace-creation} a daemon failure is preserved, not retried blindly", async (t) => {
    const { base, created, post } = await fixture(t, async () => { throw new Error("daemon refused"); });
    const token = await formToken(base);
    for (const attempt of ["failure", "retry of the settled failure"]) {
        const res = await post(token);
        assert.equal(res.status, 502, attempt);
    }
    assert.equal(created.length, 1);
});

test("{§web-workspace-creation} an expired form token answers a readable stale-form error", async (t) => {
    const original = process.env.PLURNK_WEB_CREATE_TTL_SEC;
    process.env.PLURNK_WEB_CREATE_TTL_SEC = "1";
    t.after(() => { process.env.PLURNK_WEB_CREATE_TTL_SEC = original; });
    const { base, created, post } = await fixture(t);
    const token = await formToken(base);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const res = await post(token);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /This creation form expired\./u);
    assert.deepEqual(created, []);
});