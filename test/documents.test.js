import assert from "node:assert/strict";
import test from "node:test";
import Documents from "../ai.plurnk/documents.js";

test("{§web-directory-documents} read-only lookup escapes names and never invents identities", async () => {
    const calls = [];
    const port = {
        listWorkspaces: async () => {
            calls.push("workspaces");
            return [{ id: 7, name: '~/a&<script>@"b', project_root: null }, { id: 8, name: "../legacy", project_root: null }];
        },
        listWorkers: async (id) => { calls.push(id); return [{ name: "user" }]; },
    };
    const document = new Documents('<!doctype html><title>Plurnk</title><main>Home</main><script src="/app.js"></script>');
    const index = (await document.read({ kind: "daemon" }, port, true)).toString();
    assert.match(index, /<ul><li><a href="\/~\/~\/a%26%3Cscript%3E%40%22b\/"/u);
    assert.match(index, /~\/a&amp;&lt;script&gt;@&quot;b/u);
    assert.match(index, /<li><span data-text="name">\.\.\/legacy<\/span><\/li>/u);
    assert.match(index, /<form method="post" action="\/auth\/logout">/u);
    assert.match(index, /<script src="\/app.js"><\/script>/u);
    assert.equal(await document.read({ kind: "workspace", workspace: "missing" }, port, false), null);
    assert.deepEqual(calls, ["workspaces", "workspaces"]);
    const workspace = { kind: "workspace", workspace: '~/a&<script>@"b' };
    const workers = (await document.read(workspace, port, false)).toString();
    assert.match(workers, /a%26%3Cscript%3E%40%22b@user\//u);
    assert.doesNotMatch(workers, /<form/u);
    assert.equal(await document.read({ ...workspace, kind: "worker", worker: "absent" }, port, true), null);
    const worker = (await document.read({ ...workspace, kind: "worker", worker: "user" }, port, true)).toString();
    assert.match(worker, /<h1[^>]*>~\/a&amp;&lt;script&gt;@&quot;b@user<\/h1>/u);
    assert.deepEqual(calls, ["workspaces", "workspaces", "workspaces", 7, "workspaces", 7, "workspaces", 7]);
});

test("{§web-directory-documents} a broken document outlet fails at load", () => {
    for (const html of ["", "<main>unclosed", "<main>a</main><main>b</main>"]) {
        assert.throws(() => new Documents(html), /exactly one main element/u);
    }
});

test("{§web-page-shell} titles and breadcrumbs preserve whole identities, not path segments", async () => {
    const name = "~/project/a&b<script>";
    const port = {
        listWorkspaces: async () => [{ id: 7, name }],
        listWorkers: async () => [{ name: "user" }],
    };
    const document = new Documents('<html><head><title data-text="page-title">Plurnk</title></head><body><header>Shared navigation</header><main id="main" tabindex="-1" data-page="home">Home</main></body></html>');
    const html = (await document.read({ kind: "worker", workspace: name, worker: "user" }, port, true)).toString();
    assert.match(html, /<title[^>]*>~\/project\/a&amp;b&lt;script&gt;@user — Plurnk<\/title>/u);
    assert.match(html, /<header>Shared navigation<\/header>/u);
    assert.match(html, /<main id="main" tabindex="-1" data-page="worker">/u);
    assert.match(html, /<nav aria-label="breadcrumb"><ul><li><a href="\/"[^>]*>Home<\/a><\/li><li><a href="\/~\/"[^>]*>Workspaces<\/a><\/li><li><a href="\/~\/~\/project\/a%26b%3Cscript%3E\/"[^>]*>~\/project\/a&amp;b&lt;script&gt;<\/a><\/li><li><span aria-current="page"[^>]*>user<\/span><\/li><\/ul><\/nav>/u);
    assert.doesNotMatch(html, /<script>|href="\/account/iu);
    assert.equal(html.match(/<main\b/gu).length, 1);
    assert.equal(html.match(/<h1\b/gu).length, 1);
});

test("{§web-page-shell} empty lists and request failures are useful native documents", async () => {
    const document = new Documents('<title>Plurnk</title><main>Home</main>');
    const port = { listWorkspaces: async () => [], listWorkers: async () => [] };
    const empty = (await document.read({ kind: "daemon" }, port, false)).toString();
    assert.match(empty, /<title[^>]*>Workspaces — Plurnk<\/title>/u);
    assert.match(empty, /<p[^>]*>No workspaces\.<\/p>/u);
    assert.doesNotMatch(empty, /<ul><\/ul>/u);
    const workers = (await document.read({ kind: "workspace", workspace: "empty" }, {
        ...port, listWorkspaces: async () => [{ id: 7, name: "empty" }],
    }, false)).toString();
    assert.match(workers, /data-page="workspace"/u);
    assert.match(workers, /<p[^>]*>No workers\.<\/p>/u);
    const error = document.error(403, 'Rejected <script> & "details"').toString();
    assert.match(error, /<title[^>]*>403 Forbidden — Plurnk<\/title>/u);
    assert.match(error, /data-page="error"/u);
    assert.match(error, /Rejected &lt;script&gt; &amp; &quot;details&quot;/u);
    assert.doesNotMatch(error, /<form|<script>/u);
});

test("{§web-page-shell} a missing or duplicate document title fails at load", () => {
    for (const html of ["<main>Home</main>", "<title>A</title><title>B</title><main>Home</main>"]) {
        assert.throws(() => new Documents(html), /exactly one title element/u);
    }
});
