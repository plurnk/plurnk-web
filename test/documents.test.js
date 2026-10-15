import assert from "node:assert/strict";
import test from "node:test";
import Documents from "../ai.plurnk/documents.js";

const navigation = '<template id="session-navigation"><a href="/account/">Account</a><form method="post" action="/auth/logout"><button>Sign out</button></form></template>';
const worker = (id, name, parentWorkerId = null, origin = "model", owner = "_plurnk") => ({ id, name, parentWorkerId, origin, owner });

test("{§web-page-shell} {§web-workspace-folder} breadcrumbs distinguish workspace names from literal daemon folder labels", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main></main>`);
    for (const [name, project_root, project_label, icon, label, separateFolder] of [
        ["~/looks-like-a-folder", null, null, "☁️", "Folderless workspace", false],
        ["~/project", "/home/daemon/project", "~/project", "📁", "Project workspace", false],
        ["research<&>", "/home/daemon/project", "~/project", "☁️", "Workspace", true],
        ["~/project/", "/home/daemon/project", "~/project", "☁️", "Workspace", true],
        ["~", "/home/daemon", "~", "📁", "Project workspace", false],
        ["/", "/", "/", "📁", "Project workspace", false],
        ["研究", '/srv/資料 @<script>&"', '/srv/資料 @<script>&"', "☁️", "Workspace", true],
    ]) {
        const port = {
            listWorkspaces: async () => [{ id: 7, name, project_root, project_label }],
            listWorkers: async () => [],
        };
        const index = (await document.read({ kind: "daemon" }, port, false)).toString();
        assert.match(index, /<nav aria-label="breadcrumb"><ul><li><span aria-current="page" data-text="name">Workspaces<\/span><\/li><\/ul><\/nav>/u);
        assert.doesNotMatch(index, /<h1\b/u);
        const page = (await document.read({ kind: "workspace", workspace: name }, port, false)).toString();
        assert.match(page, /<nav aria-label="breadcrumb"><ul><li><a href="\/~\/"[^>]*>Workspaces<\/a><\/li>/u);
        const escaped = name.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        assert.ok(page.includes(`<li><span role="img" aria-label="${label}">${icon}</span> <span aria-current="page" data-text="name">${escaped}</span></li>`), page);
        assert.match(page, /<p[^>]*>No workers\.<\/p>/u);
        assert.doesNotMatch(page, /<h1\b/u);
        assert.equal(page.match(/aria-current="page"/gu).length, 1, "the workspace breadcrumb has one current item");
        assert.match(page, /<header>[\s\S]*<nav aria-label="breadcrumb">[\s\S]*<\/nav><\/header>/u);
        assert.doesNotMatch(page.split("<main")[1], /aria-label="breadcrumb"/u);
        if (separateFolder) {
            const folder = project_label.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
            assert.ok(page.includes(`<p><span role="img" aria-label="Project folder">📁</span> <span data-text="project-label">${folder}</span></p>`));
        } else {
            assert.doesNotMatch(page, /data-text="project-label"/u, "no duplicate or invented folder row");
        }
        assert.doesNotMatch(page, /\/home\/daemon|<script>/u, "display the supplied label, not the filesystem root or executable markup");
    }
});

test("{§web-worker-directory} model lineage is complete, collapsed and independent of names and approval owners", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`);
    const workers = [
        worker(1, "_plurnk", null, "_plurnk"),
        worker(6, "review", 4, "model", "agui://owner"),
        worker(3, "2bb6a400-7106-4299-ae47-66daea5d6077"),
        worker(4, "user", null, "model", "agui://owner"),
        worker(5, "research", 4),
        worker(7, "evidence", 6),
        worker(8, "incoming", 1),
        worker(9, "other", 1, "model", "agui://owner"),
        worker(10, "incoming-child", 8),
    ];
    const port = { listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null }], listWorkers: async () => workers };
    const html = (await document.read({ kind: "workspace", workspace: "work" }, port, false)).toString();
    const link = (name) => `<a href="/~/work@${name}/" data-text="name">${name}</a>`;
    const children = (count, list) => `<details><summary data-text="child-workers">${count} child worker${count === 1 ? "" : "s"}</summary><ul>${list}</ul></details>`;
    assert.ok(html.includes([
        "<ul>",
        `<li>${link("2bb6a400-7106-4299-ae47-66daea5d6077")}</li>`,
        `<li>${link("user")}${children(2, `<li>${link("review")}${children(1, `<li>${link("evidence")}</li>`)}</li><li>${link("research")}</li>`)}</li>`,
        "</ul>",
        '<details><summary data-i18n="background-work">Background work</summary><ul>',
        `<li>${link("incoming")}${children(1, `<li>${link("incoming-child")}</li>`)}</li>`,
        `<li>${link("other")}</li>`,
        "</ul></details>",
    ].join("")), html);
    const names = [...html.matchAll(/href="\/~\/work@([^"]+)\/"/gu)].map((match) => match[1]);
    assert.deepEqual(names.toSorted(), workers.filter(({ origin }) => origin === "model").map(({ name }) => name).toSorted());
    assert.doesNotMatch(html, /_plurnk|agui:|\bopen\b|role="tree"|<script/u);
    for (const internal of workers.filter(({ origin }) => origin !== "model")) {
        assert.equal(await document.read({ kind: "worker", workspace: "work", worker: internal.name }, port, false), null);
    }
    const child = (await document.read({ kind: "worker", workspace: "work", worker: "review" }, port, false)).toString();
    assert.match(child, /<p><span data-i18n="parent-worker">Parent:<\/span> <a href="\/~\/work@user\/" data-text="name">user<\/a><\/p>/u);
    const background = (await document.read({ kind: "worker", workspace: "work", worker: "incoming" }, port, false)).toString();
    assert.match(background, /<p><span data-i18n="parent-worker">Parent:<\/span> <span data-text="name">_plurnk<\/span><\/p>/u);
    const root = (await document.read({ kind: "worker", workspace: "work", worker: "user" }, port, false)).toString();
    assert.doesNotMatch(root, /parent-worker/u);
});

test("{§web-worker-directory} empty and internal-only workspaces have no empty navigation controls", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`);
    for (const workers of [[], [worker(1, "_plurnk", null, "_plurnk")], [worker(3, "user")]]) {
        const html = (await document.read({ kind: "workspace", workspace: "work" }, {
            listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null }], listWorkers: async () => workers,
        }, false)).toString();
        assert.doesNotMatch(html, /<details|Background work|<ul><\/ul>/u);
        if (workers.some(({ origin }) => origin === "model")) assert.match(html, /href="\/~\/work@user\/"/u);
        else assert.match(html, /<p[^>]*>No workers\.<\/p>/u);
    }
});

test("{§web-worker-directory} inconsistent topology fails rather than dropping workers", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`);
    for (const [workers, message] of [
        [[worker(1, "first"), worker(1, "second")], "Worker directory contains duplicate identities."],
        [[worker(1, "missing", 2)], "Worker 1 has an absent parent 2."],
        [[worker(1, "self", 1)], "Worker directory contains cyclic model parentage."],
        [[worker(1, "first", 2), worker(2, "second", 1)], "Worker directory contains cyclic model parentage."],
    ]) {
        await assert.rejects(document.read({ kind: "workspace", workspace: "work" }, {
            listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null }], listWorkers: async () => workers,
        }, false), { name: "Error", message });
    }
});

test("{§web-directory-documents} workspace markers describe folder presence without interpreting names", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`);
    const html = (await document.read({ kind: "daemon" }, {
        listWorkspaces: async () => [
            { id: 1, name: "~/looks-like-a-folder", project_root: null, project_label: null },
            { id: 2, name: "research", project_root: "/home/daemon/project", project_label: "~/project" },
            { id: 3, name: "../legacy", project_root: null, project_label: null },
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
            return [{ id: 7, name: '~/a&<script>@"b', project_root: null, project_label: null }, { id: 8, name: "../legacy", project_root: null, project_label: null }];
        },
        listWorkers: async (id) => { calls.push(id); return [worker(1, "user")]; },
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
    const page = (await document.read({ ...workspace, kind: "worker", worker: "user" }, port, true)).toString();
    assert.match(page, /<title[^>]*>~\/a&amp;&lt;script&gt;@&quot;b@user — Plurnk<\/title>/u);
    assert.doesNotMatch(page, /<h1\b/u);
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
        listWorkspaces: async () => [{ id: 7, name, project_root: null, project_label: null }],
        listWorkers: async () => [worker(1, "user")],
    };
    const document = new Documents(`<html><head><title data-text="page-title">Plurnk</title></head><body><header>Shared navigation${navigation}</header><main id="main" tabindex="-1" data-page="home">Home</main></body></html>`);
    const html = (await document.read({ kind: "worker", workspace: name, worker: "user" }, port, true)).toString();
    assert.match(html, /<title[^>]*>~\/project\/a&amp;b&lt;script&gt;@user — Plurnk<\/title>/u);
    assert.match(html, /<header>Shared navigation[\s\S]*href="\/account\/"[\s\S]*<\/header>/u);
    assert.match(html, /<main id="main" tabindex="-1" data-page="worker">/u);
    assert.match(html, /<nav aria-label="breadcrumb"><ul><li><a href="\/~\/"[^>]*>Workspaces<\/a><\/li><li><a href="\/~\/~\/project\/a%26b%3Cscript%3E\/"[^>]*>~\/project\/a&amp;b&lt;script&gt;<\/a><\/li><li><span aria-current="page"[^>]*>user<\/span><\/li><\/ul><\/nav>/u);
    assert.doesNotMatch(html, /<script>|<template|<footer/iu);
    assert.equal(html.match(/<main\b/gu).length, 1);
    assert.doesNotMatch(html, /<h1\b/u, "the breadcrumb and document title identify the worker without a duplicate heading");
});

test("{§web-page-shell} empty lists and request failures are useful native documents", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`);
    const port = { listWorkspaces: async () => [], listWorkers: async () => [] };
    const empty = (await document.read({ kind: "daemon" }, port, false)).toString();
    assert.match(empty, /<title[^>]*>Workspaces — Plurnk<\/title>/u);
    assert.match(empty, /<p[^>]*>No workspaces\.<\/p>/u);
    assert.doesNotMatch(empty, /<ul><\/ul>/u);
    const workers = (await document.read({ kind: "workspace", workspace: "empty" }, {
        ...port, listWorkspaces: async () => [{ id: 7, name: "empty", project_root: null, project_label: null }],
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

test("{§web-page-shell} an absent or ambiguous breadcrumb insertion boundary fails at load", () => {
    for (const closing of ["", "</header></header>"]) {
        assert.throws(() => new Documents(`<title>Plurnk</title><header>${navigation}${closing}<main></main>`), {
            name: "Error", message: "The web document must close its header once after session navigation and before main.",
        });
    }
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
    assert.match(html, /<header>[\s\S]*<nav aria-label="breadcrumb">[\s\S]*<\/nav><\/header>/u);
    assert.doesNotMatch(html.split("<main")[1], /aria-label="breadcrumb"/u);
    assert.doesNotMatch(html, /<script>|<template|last active|device|Signed in as/iu);
});
