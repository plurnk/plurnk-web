import assert from "node:assert/strict";
import test from "node:test";
import Documents from "../ai.plurnk/documents.js";

const navigation = '<template id="session-navigation"><a href="/account/">Account</a><form method="post" action="/auth/logout"><button>Sign out</button></form></template>';

test("{§web-directory-documents} workspace markers describe folder presence without interpreting names", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`);
    const html = (await document.read({ kind: "daemon" }, {
        listWorkspaces: async () => [
            { id: 1, name: "~/looks-like-a-folder", project_root: null },
            { id: 2, name: "research", project_root: "/home/daemon/project" },
            { id: 3, name: "../legacy", project_root: null },
        ],
        listWorkers: async () => { throw new Error("The workspace index needs no worker lookup."); },
    }, false)).toString();
    assert.match(html, /<li><span role="img" aria-label="Folderless workspace">☁️<\/span> <a href="\/~\/~\/looks-like-a-folder\/" data-text="name">~\/looks-like-a-folder<\/a><\/li>/u);
    assert.match(html, /<li><span role="img" aria-label="Project workspace">📁<\/span> <a href="\/~\/research\/" data-text="name">research<\/a><\/li>/u);
    assert.match(html, /<li><span role="img" aria-label="Folderless workspace">☁️<\/span> <span data-text="name">\.\.\/legacy<\/span><\/li>/u);
    assert.doesNotMatch(html, /\/home\/daemon\/project/u, "the index shows each name once, not a redundant filesystem label");
});

test("{§web-directory-documents} read-only lookup escapes names and never invents identities", async () => {
    const calls = [];
    const port = {
        listWorkspaces: async () => {
            calls.push("workspaces");
            return [{ id: 7, name: '~/a&<script>@"b', project_root: null }, { id: 8, name: "../legacy", project_root: null }];
        },
        listWorkers: async (id) => { calls.push(id); return [{ name: "user" }]; },
    };
    const document = new Documents(`<!doctype html><title>Plurnk</title><header>${navigation}</header><main>Home</main><script src="/app.js"></script>`);
    const index = (await document.read({ kind: "daemon" }, port, true)).toString();
    assert.match(index, /<ul><li><span role="img" aria-label="Folderless workspace">☁️<\/span> <a href="\/~\/~\/a%26%3Cscript%3E%40%22b\/"/u);
    assert.match(index, /~\/a&amp;&lt;script&gt;@&quot;b/u);
    assert.match(index, /<li><span role="img" aria-label="Folderless workspace">☁️<\/span> <span data-text="name">\.\.\/legacy<\/span><\/li>/u);
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
    const document = new Documents(`<html><head><title data-text="page-title">Plurnk</title></head><body><header>Shared navigation${navigation}</header><main id="main" tabindex="-1" data-page="home">Home</main></body></html>`);
    const html = (await document.read({ kind: "worker", workspace: name, worker: "user" }, port, true)).toString();
    assert.match(html, /<title[^>]*>~\/project\/a&amp;b&lt;script&gt;@user — Plurnk<\/title>/u);
    assert.match(html, /<header>Shared navigation[\s\S]*href="\/account\/"[\s\S]*<\/header>/u);
    assert.match(html, /<main id="main" tabindex="-1" data-page="worker">/u);
    assert.match(html, /<nav aria-label="breadcrumb"><ul><li><a href="\/"[^>]*>Home<\/a><\/li><li><a href="\/~\/"[^>]*>Workspaces<\/a><\/li><li><a href="\/~\/~\/project\/a%26b%3Cscript%3E\/"[^>]*>~\/project\/a&amp;b&lt;script&gt;<\/a><\/li><li><span aria-current="page"[^>]*>user<\/span><\/li><\/ul><\/nav>/u);
    assert.doesNotMatch(html, /<script>|<template|<footer/iu);
    assert.equal(html.match(/<main\b/gu).length, 1);
    assert.equal(html.match(/<h1\b/gu).length, 1);
});

test("{§web-page-shell} empty lists and request failures are useful native documents", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`);
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
    assert.match(error, /<article aria-labelledby="error-title"><header><h1 id="error-title">/u);
    assert.match(error, /<span aria-hidden="true">⚠️<\/span>/u);
    assert.match(error, /Rejected &lt;script&gt; &amp; &quot;details&quot;/u);
    assert.match(error, /<footer><a href="\/" data-i18n="home">Home<\/a><\/footer><\/article>/u);
    assert.doesNotMatch(error, /<form|<script>/u);
});

test("{§web-page-shell} a missing or duplicate document title fails at load", () => {
    for (const html of ["<main>Home</main>", "<title>A</title><title>B</title><main>Home</main>"]) {
        assert.throws(() => new Documents(html), /exactly one title element/u);
    }
    assert.throws(() => new Documents('<title>Plurnk</title><main>Home</main>'), /exactly one session-navigation template/u);
});

test("{§web-account} Account offers native navigation without a fictional profile or inline session inventory", () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`);
    const html = document.account().toString();
    assert.match(html, /<title[^>]*>Account — Plurnk<\/title>/u);
    assert.match(html, /<article[\s\S]*<h1[^>]*>Account<\/h1>/u);
    assert.match(html, /<nav aria-label="Account"><ul><li><a href="\/account\/sessions\/"[^>]*>Sessions<\/a><\/li><\/ul><\/nav>/u);
    assert.doesNotMatch(html, /Signed in as|Local operator|data-session|<table|revoke/iu);
});

test("{§web-account} Sessions renders authority facts in a native table without invented device facts", () => {
    const document = new Documents('<title>Plurnk</title><header><template id="session-navigation"><a href="/account/">Account</a><form method="post" action="/auth/logout"><button>Sign out</button></form></template></header><main>Home</main>');
    const html = document.sessions({ family: "current", sessions: [
        { family: "current", createdAt: 0, expiresAt: 60_000, clients: ["browser", "plurnk-web"] },
        { family: "other&family", createdAt: 1000, expiresAt: 61_000, clients: ["browser", "a<script>"] },
    ] }).toString();
    assert.match(html, /<title[^>]*>Sessions — Plurnk<\/title>/u);
    assert.match(html, /<article[\s\S]*<figure><table><thead>/u);
    assert.match(html, /<th scope="row"/u);
    assert.match(html, /This session/u);
    assert.match(html, /<time datetime="1970-01-01T00:00:00.000Z"/u);
    assert.match(html, /a&lt;script&gt;/u);
    assert.match(html, /action="\/account\/sessions\/other%26family\/revoke"/u);
    assert.match(html, /action="\/account\/sessions\/revoke-others"/u);
    assert.match(html, /<header>[\s\S]*action="\/auth\/logout"[\s\S]*<\/header>/u);
    assert.doesNotMatch(html, /<script>|<template|last active|device|Signed in as/iu);
});
