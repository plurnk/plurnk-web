import assert from "node:assert/strict";
import test from "node:test";
import Documents from "../ai.plurnk/documents.js";
import { ownNavigation } from "../ai.plurnk/http.js";

const navigation = '<template id="session-navigation"><a href="/account/">Account</a><form method="post" action="/auth/logout"><button>Sign out</button></form></template>';
const session = (id, name, parentSessionId = null, origin = "model", owner = "_plurnk") => ({
    id, name, parentSessionId, origin, owner, kind: parentSessionId === null ? "root" : "work", lifecycle: "completed", hidden_at: null,
});

test("{§web-page-shell} session status sits outside the scrolling main; directory entries are native articles", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main></main>`, false, 128);
    const port = { listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null, hidden_at: null }],
        listSessions: async () => [session(9, "user")] };
    const html = (await document.read({ kind: "session", workspace: "work", session: "user" }, port, false)).toString();
    assert.match(html, /<\/main><footer id="session-status"/u);
    assert.match(html, /aria-label="Model controls"/u);
    assert.match(html, /aria-label="Session statistics"/u);
    for (const directory of /** @type {const} */ ([{ kind: "daemon" }, { kind: "workspace", workspace: "work" }])) {
        const listing = (await document.read(directory, port, false)).toString();
        assert.match(listing, /<li[^>]*><article[^>]*><header>/u);
    }
});

test("{§web-session-approval} a session page starts automatic only when configured and reached by the person's own navigation", async () => {
    const arrivals = /** @type {const} */ ([["same-origin", true], ["none", true], ["cross-site", false], ["same-site", false], [undefined, false]]);
    for (const yolo of [true, false]) {
        for (const [site, own] of arrivals) {
            assert.equal(ownNavigation({ headers: site === undefined ? {} : { "sec-fetch-site": site } }), own, String(site));
            const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main></main>`, yolo, 128);
            const html = (await document.read({ kind: "session", workspace: "work", session: "user" }, {
                listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null, hidden_at: null }],
                listSessions: async () => [session(9, "user")],
            }, false, own)).toString();
            const automatic = yolo && own;
            assert.ok(html.includes(`id="session-yolo" aria-pressed="${automatic}"`), `configured ${yolo}, arrival ${site}`);
            assert.ok(html.includes(`aria-label="Automatic approval" title="${automatic ? "Auto" : "Manual"} Approval (/yolo)"`));
            assert.ok(html.includes('data-reasoning-preview-chars="128"'), "{§web-session-reasoning} the document carries its supplied preview limit");
            assert.doesNotMatch(html, /PLURNK_|process\.env/u, "a public setting is not an environment dump");
        }
    }
});

test("{§web-authorization-style} the compiled head names one origin-relative application stylesheet", () => {
    assert.equal(Documents.stylesheet('<head><link rel="modulepreload" href="/session.js"><link crossorigin href="/assets/app.css" rel="stylesheet"></head><template><link rel="stylesheet" href="/other.css"></template>'), "/assets/app.css");
    for (const head of ["", '<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/b.css">']) {
        assert.throws(() => Documents.stylesheet(`<head>${head}</head>`), { message: "The web document must declare exactly one application stylesheet." });
    }
    for (const path of ["https://elsewhere.invalid/style.css", "//elsewhere.invalid/style.css", "style.css"]) {
        assert.throws(() => Documents.stylesheet(`<head><link rel="stylesheet" href="${path}"></head>`), { message: "The application stylesheet must have an origin-relative path." });
    }
});

test("{§web-session-conversation} only a session document supplies the passive conversation outlet", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main></main>`, false, 128);
    const port = {
        listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null, hidden_at: null }],
        listSessions: async () => [session(9, "user")],
    };
    const html = (await document.read({ kind: "session", workspace: "work", session: "user" }, port, false)).toString();
    assert.match(html, /<section id="session-conversation" aria-label="Conversation">/u);
    assert.match(html, /<ul[^>]*data-messages[^>]*><\/ul>/u);
    assert.match(html, /Conversation requires JavaScript\./u);
    assert.doesNotMatch(html, /<textarea|contenteditable|<h1\b/u);
    for (const directory of /** @type {const} */ ([{ kind: "daemon" }, { kind: "workspace", workspace: "work" }])) {
        assert.doesNotMatch((await document.read(directory, port, false)).toString(), /id="session-conversation"/u);
    }
});

test("{§web-session-observer} readable names never select the session's live session identity", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main></main>`, false, 128);
    for (const name of ["~/project", "42#alice", "renamed workspace"]) {
        const html = (await document.read({ kind: "session", workspace: name, session: "user" }, {
            listWorkspaces: async () => [{ id: 7, name, project_root: null, project_label: null, hidden_at: null }],
            listSessions: async () => [session(9, "user")],
        }, false)).toString();
        assert.match(html, /data-session-id="7#user"/u);
        assert.doesNotMatch(html, /data-workspace=|data-session=/u);
        assert.ok(html.includes(`${name}@user — Plurnk`));
    }
});

test("{§web-page-shell} {§web-workspace-folder} breadcrumbs distinguish workspace names from literal daemon folder labels", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main></main>`, false, 128);
    for (const [name, project_root, project_label, icon, label, separateFolder] of /** @type {const} */ ([
        ["~/looks-like-a-folder", null, null, "☁️", "Folderless workspace", false],
        ["~/project", "/home/daemon/project", "~/project", "🗂️", "Project workspace", false],
        ["research<&>", "/home/daemon/project", "~/project", "☁️", "Workspace", true],
        ["~/project/", "/home/daemon/project", "~/project", "☁️", "Workspace", true],
        ["~", "/home/daemon", "~", "🗂️", "Project workspace", false],
        ["/", "/", "/", "🗂️", "Project workspace", false],
        ["研究", '/srv/資料 @<script>&"', '/srv/資料 @<script>&"', "☁️", "Workspace", true],
    ])) {
        const port = {
            listWorkspaces: async () => [{ id: 7, name, project_root, project_label, hidden_at: null }],
            listSessions: async () => [],
        };
        const index = (await document.read({ kind: "daemon" }, port, false)).toString();
        assert.match(index, /<nav aria-label="breadcrumb"><ul><li><span role="img" aria-current="page" aria-label="Workspaces" title="Workspaces">🗃️<\/span> <button type="button" data-dialog-target="dialog-workspace-create" aria-label="New workspace" title="New workspace">➕<\/button><\/li><\/ul><\/nav>/u);
        assert.doesNotMatch(index, /<h1\b/u);
        const page = (await document.read({ kind: "workspace", workspace: name }, port, false)).toString();
        assert.match(page, /<nav aria-label="breadcrumb"><ul><li><a href="\/~\/"[^>]*>🗃️<\/a><\/li>/u);
        const escaped = name.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        assert.ok(page.includes(`<li><span role="img" aria-label="${label}">${icon}</span> <span aria-current="page" data-text="name">${escaped}</span> <button type="button" data-dialog-target="dialog-workspace-rename" aria-label="Rename workspace" title="Rename workspace">✏️</button> <button type="button" data-dialog-target="dialog-workspace-hide" aria-label="Hide workspace" title="Hide workspace">🗑️</button> <button type="button" data-dialog-target="dialog-session-create" aria-label="New session" title="New session">➕</button></li>`), page);
        assert.match(page, /<p[^>]*>No sessions\.<\/p>/u);
        assert.doesNotMatch(page, /<h1\b/u);
        assert.equal(page.match(/aria-current="page"/gu).length, 1, "the workspace breadcrumb has one current item");
        assert.match(page, /<header>[\s\S]*<nav aria-label="breadcrumb">[\s\S]*<\/nav><\/header>/u);
        assert.doesNotMatch(page.split("<main")[1], /aria-label="breadcrumb"/u);
        if (separateFolder) {
            const folder = project_label.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
            assert.ok(page.includes(`<p><span role="img" aria-label="Project folder">🗂️</span> <span data-text="project-label">${folder}</span></p>`));
        } else {
            assert.doesNotMatch(page, /data-text="project-label"/u, "no duplicate or invented folder row");
        }
        assert.doesNotMatch(page, /\/home\/daemon|<script>/u, "display the supplied label, not the filesystem root or executable markup");
    }
});

test("{§web-session-directory} model lineage is complete, collapsed and independent of names and approval owners", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`, false, 128);
    const sessions = [
        session(1, "_plurnk", null, "_plurnk"),
        session(6, "review", 4, "model", "acp://owner"),
        session(3, "2bb6a400-7106-4299-ae47-66daea5d6077"),
        session(4, "user", null, "model", "acp://owner"),
        session(5, "research", 4),
        session(7, "evidence", 6),
        session(8, "incoming", 1),
        session(9, "other", 1, "model", "acp://owner"),
        session(10, "incoming-child", 8),
    ];
    const port = { listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null, hidden_at: null }], listSessions: async () => sessions };
    const html = (await document.read({ kind: "workspace", workspace: "work" }, port, false)).toString();
    const link = (name) => `<a href="/~/work@${name}/" data-text="name" data-session-name="${name}" data-bind="href:session-path">${name}</a>`;
    const entry = (name, parent = null, children = "") => {
        const lineage = parent === null ? "" : `<span data-session-parent>${parent === "_plurnk" ? "<span>_plurnk</span>" : link(parent)} &gt; </span>`;
        const identity = `<span data-session-identity><a data-session-link href="/~/work@${name}/" aria-label="${name}" title="Open session ${name}"></a> `
            + '<span data-lifecycle="completed" role="img" aria-label="completed" title="completed"></span> '
            + `${lineage}<span>${name}</span></span>`
            + '<span data-session-workspace><span data-folder="false" role="img" aria-label="Folderless workspace"></span> <a href="/~/work/" data-text="name">work</a></span>';
        const content = children ? `<details><summary>${identity}</summary><ul>${children}</ul></details>` : `<header>${identity}</header>`;
        return `<li data-directory-entry="session"><article aria-label="Session">${content}</article></li>`;
    };
    assert.ok(html.includes([
        "<ul>",
        entry("2bb6a400-7106-4299-ae47-66daea5d6077"),
        entry("user", null, entry("review", "user", entry("evidence", "review")) + entry("research", "user")),
        "</ul>",
        '<details><summary data-i18n="background-work">Background work</summary><ul>',
        entry("incoming", "_plurnk", entry("incoming-child", "incoming")),
        entry("other", "_plurnk"),
        "</ul></details>",
    ].join("")), html);
    const names = [...html.matchAll(/data-session-link href="\/~\/work@([^"]+)\/"/gu)].map((match) => match[1]);
    assert.deepEqual(names.toSorted(), sessions.filter(({ origin }) => origin === "model").map(({ name }) => name).toSorted());
    assert.doesNotMatch(html, /work@_plurnk|acp:|\bopen\b|role="tree"|<script|data-text="session-kind"|child session/u);
    for (const internal of sessions.filter(({ origin }) => origin !== "model")) {
        assert.equal(await document.read({ kind: "session", workspace: "work", session: internal.name }, port, false), null);
    }
    const child = (await document.read({ kind: "session", workspace: "work", session: "review" }, port, false)).toString();
    assert.ok(child.includes(`<p><span data-i18n="parent-session">Parent:</span> ${link("user")}</p>`));
    const background = (await document.read({ kind: "session", workspace: "work", session: "incoming" }, port, false)).toString();
    assert.match(background, /<p><span data-i18n="parent-session">Parent:<\/span> <span data-text="name">_plurnk<\/span><\/p>/u);
    const root = (await document.read({ kind: "session", workspace: "work", session: "user" }, port, false)).toString();
    assert.doesNotMatch(root, /parent-session/u);
});

test("{§web-session-directory} session pages keep breadcrumb and parent navigation without a duplicated workspace tree", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main></main>`, false, 128);
    const sessions = [session(1, "_plurnk", null, "_plurnk"), { ...session(2, "parent"), lifecycle: "running" },
        { ...session(3, "child", 2), kind: "fork", lifecycle: "failed" },
        { ...session(4, "grandchild", 3), lifecycle: "parked" }, { ...session(5, "sibling", 2), lifecycle: "queued" },
        session(6, "incoming", 1), session(7, "background-child", 6)];
    let reads = 0;
    const port = {
        listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null, hidden_at: null }],
        listSessions: async () => { reads++; return sessions; },
    };
    for (const selected of ["parent", "child", "grandchild", "background-child"]) {
        const html = (await document.read({ kind: "session", workspace: "work", session: selected }, port, false)).toString();
        assert.doesNotMatch(html, /session-directory|sessions-at-page-load|Sessions at page load|<nav aria-label="Sessions">/u);
        assert.ok(html.includes('<a href="/~/work/" data-bind="href:workspace-path" data-text="workspace-name">work</a>'));
        assert.ok(html.includes(`<span aria-current="page" data-text="name">${selected}</span>`));
        assert.match(html, /<details id="session-descendants">/u, "live descendant navigation keeps its own statusline home");
    }
    assert.equal(reads, 4, "one authoritative directory read per document; no second client-side directory");
});

test("{§web-session-streams} the session page has observed outcomes, not an open-stream inventory", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main></main>`, false, 128);
    const html = (await document.read({ kind: "session", workspace: "work", session: "user" }, {
        listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null, hidden_at: null }],
        listSessions: async () => [session(9, "user")],
    }, false)).toString();
    assert.doesNotMatch(html, /data-open-streams|data-no-streams|stream-count|Open streams/u);
    assert.match(html, /<details[^>]* data-stream-outcomes>/u);
    assert.match(html, /id="session-conversation"/u);
});

test("{§web-session-directory} empty and internal-only workspaces have no empty navigation controls", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`, false, 128);
    for (const sessions of [[], [session(1, "_plurnk", null, "_plurnk")], [session(3, "user")]]) {
        const html = (await document.read({ kind: "workspace", workspace: "work" }, {
            listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null, hidden_at: null }], listSessions: async () => sessions,
        }, false)).toString();
        assert.doesNotMatch(html, /<details|Background work|<ul><\/ul>/u);
        if (sessions.some(({ origin }) => origin === "model")) assert.match(html, /href="\/~\/work@user\/"/u);
        else assert.match(html, /<p[^>]*>No sessions\.<\/p>/u);
    }
});

test("{§web-session-directory} inconsistent topology fails rather than dropping sessions", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`, false, 128);
    for (const [sessions, message] of /** @type {const} */ ([
        [[session(1, "first"), session(1, "second")], "Session directory contains duplicate identities."],
        [[session(1, "missing", 2)], "Session 1 has an absent parent 2."],
        [[session(1, "self", 1)], "Session directory holds shown model sessions that no shown root reaches."],
        [[session(1, "first", 2), session(2, "second", 1)], "Session directory holds shown model sessions that no shown root reaches."],
    ])) {
        await assert.rejects(document.read({ kind: "workspace", workspace: "work" }, {
            listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null, hidden_at: null }], listSessions: async () => sessions,
        }, false), { name: "Error", message });
    }
});

test("{§web-directory-documents} workspace markers describe folder presence without interpreting names", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`, false, 128);
    const html = (await document.read({ kind: "daemon" }, {
        listWorkspaces: async () => [
            { id: 1, name: "~/looks-like-a-folder", project_root: null, project_label: null, hidden_at: null },
            { id: 2, name: "research", project_root: "/home/daemon/project", project_label: "~/project", hidden_at: null },
            { id: 3, name: "../legacy", project_root: null, project_label: null, hidden_at: null },
        ],
        listSessions: async () => { throw new Error("The workspace index needs no session lookup."); },
    }, false)).toString();
    assert.match(html, /<li data-directory-entry="workspace" data-folder="false"><article aria-label="Folderless workspace"><header><a href="\/~\/~\/looks-like-a-folder\/" data-text="name">~\/looks-like-a-folder<\/a><\/header><\/article><\/li>/u);
    assert.match(html, /<li data-directory-entry="workspace" data-folder="true"><article aria-label="Project workspace"><header><a href="\/~\/research\/" data-text="name">research<\/a><\/header><\/article><\/li>/u);
    assert.match(html, /<article aria-label="Folderless workspace"><header><span data-text="name">\.\.\/legacy<\/span><\/header><\/article>/u);
    assert.doesNotMatch(html, /\/home\/daemon\/project/u, "the index shows each name once, not a redundant filesystem label");
});

test("{§web-directory-documents} read-only lookup escapes names and never invents identities", async () => {
    const calls = [];
    const port = {
        listWorkspaces: async () => {
            calls.push("workspaces");
            return [{ id: 7, name: '~/a&<script>@"b', project_root: null, project_label: null, hidden_at: null }, { id: 8, name: "../legacy", project_root: null, project_label: null, hidden_at: null }];
        },
        listSessions: async (id) => { calls.push(id); return [session(1, "user")]; },
    };
    const document = new Documents(`<!doctype html><title>Plurnk</title><header>${navigation}</header><main>Home</main><script src="/app.js"></script>`, false, 128);
    const index = (await document.read({ kind: "daemon" }, port, true)).toString();
    assert.match(index, /<ul><li data-directory-entry="workspace" data-folder="false"><article aria-label="Folderless workspace"><header><a href="\/~\/~\/a%26%3Cscript%3E%40%22b\/"/u);
    assert.match(index, /~\/a&amp;&lt;script&gt;@&quot;b/u);
    assert.match(index, /<article aria-label="Folderless workspace"><header><span data-text="name">\.\.\/legacy<\/span><\/header><\/article>/u);
    assert.match(index, /<article aria-label="Folderless workspace"><header><span data-text="name">\.\.\/legacy<\/span><\/header><\/article>/u);
    assert.match(index, /<form method="post" action="\/auth\/logout">/u);
    assert.match(index, /<dialog id="dialog-workspace-create">[\s\S]*<form id="workspace-create" method="post" action="\/workspaces\/new">[\s\S]*<button type="submit"[^>]*>Confirm<\/button>/u,
        "{§web-workspace-creation} the daemon workspaces directory carries the native creation dialog");
    assert.doesNotMatch(index.split("<main")[1].split("</main>")[0].replace(/<dialog\b[\s\S]*?<\/dialog>/gu, ""), /<form\b/u,
        "main on workspaces index holds a form only inside its dialog");
    assert.match(index, /<script src="\/app.js"><\/script>/u);
    assert.equal(await document.read({ kind: "workspace", workspace: "missing" }, port, false), null);
    assert.deepEqual(calls, ["workspaces", "workspaces"]);
    const workspace = /** @type {const} */ ({ kind: "workspace", workspace: '~/a&<script>@"b' });
    const sessions = (await document.read(workspace, port, false)).toString();
    assert.match(sessions, /a%26%3Cscript%3E%40%22b@user\//u);
    assert.match(sessions, /<dialog id="dialog-workspace-rename">[\s\S]*<form id="workspace-rename" method="post" action="\/workspaces\/rename">/u, "workspace page carries the rename dialog");
    assert.match(sessions, /<dialog id="dialog-workspace-hide">[\s\S]*<form id="workspace-hide" method="post" action="\/workspaces\/hide">/u, "workspace page carries the hide workspace dialog");
    assert.match(sessions, /<dialog id="dialog-session-create">[\s\S]*<form id="session-create" method="post" action="\/sessions\/new">/u, "workspace page carries the session creation dialog");
    assert.doesNotMatch(sessions.split("<main")[1].split("</main>")[0].replace(/<dialog\b[\s\S]*?<\/dialog>/gu, ""), /<form\b/u,
        "main on workspace page holds forms only inside their dialogs");
    assert.doesNotMatch(sessions, /workspaces\/new/u, "{§web-workspace-creation} workspace pages carry no workspace creation form");
    assert.doesNotMatch(sessions, /<form method="post" action="\/auth\/logout"/u);
    const page = (await document.read({ ...workspace, kind: "session", session: "user" }, port, true)).toString();
    assert.match(page, /<dialog id="dialog-session-hide">[\s\S]*<form id="session-hide" method="post" action="\/sessions\/hide">/u, "session page carries the hide session dialog");
    assert.doesNotMatch(page, /workspaces\/new/u, "{§web-workspace-creation} session pages carry no creation form");
});

test("{§web-session-status} status is a compact footer after conversation, not a metadata inventory", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`, true, 128);
    const html = (await document.read({ kind: "session", workspace: "review", session: "user" }, {
        listWorkspaces: async () => [{ id: 7, name: "review", project_root: null, project_label: null, hidden_at: null }],
        listSessions: async () => [session(1, "user")],
    }, false)).toString();
    assert.match(html, /<footer id="session-status"[^>]*>/u);
    assert.ok(html.indexOf('id="session-status"') > html.indexOf('id="session-conversation"'));
    const footer = html.slice(html.indexOf('<footer id="session-status"'));
    assert.match(footer, /<ul aria-label="Session statistics">/u);
    assert.match(footer, /<details id="session-descendants"><summary/u);
    assert.match(footer, /data-bind="aria-label:lifecycle title:lifecycle"/u);
    assert.doesNotMatch(footer, /<dl|<table|id="(?:session-accounting|workspace-activity|session-inbox)"|data-text="(?:requests|turns|loop)"/u);
    assert.match(html, /<article id="session-connection" role="alert">[\s\S]*id="session-reconnect"[\s\S]*<\/main><footer/u);
    assert.doesNotMatch(footer, /<article|session-reconnect/u, "detailed connection notices cannot crowd the pinned composer");
});

test("{§web-directory-documents} a broken document outlet fails at load", () => {
    for (const html of ["", "<main>unclosed", "<main>a</main><main>b</main>"]) {
        assert.throws(() => new Documents(html, false, 128), /exactly one main element/u);
    }
});

test("{§web-page-shell} titles and breadcrumbs preserve whole identities, not path segments", async () => {
    const name = "~/project/a&b<script>";
    const port = {
        listWorkspaces: async () => [{ id: 7, name, project_root: null, project_label: null, hidden_at: null }],
        listSessions: async () => [session(1, "user")],
    };
    const document = new Documents(`<html><head><title data-text="page-title">Plurnk</title></head><body><header>Shared navigation${navigation}</header><main id="main" data-page="home">Home</main></body></html>`, false, 128);
    const html = (await document.read({ kind: "session", workspace: name, session: "user" }, port, true)).toString();
    assert.match(html, /<title[^>]*>~\/project\/a&amp;b&lt;script&gt;@user — Plurnk<\/title>/u);
    assert.match(html, /<header>Shared navigation[\s\S]*href="\/account\/"[\s\S]*<\/header>/u);
    assert.match(html, /<main id="main" data-page="session">/u);
    assert.match(html, /<nav aria-label="breadcrumb"><ul><li><a href="\/~\/"[^>]*>🗃️<\/a><\/li><li><span id="session-workspace"><span role="img" aria-label="Folderless workspace"[^>]*>☁️<\/span> <a href="\/~\/~\/project\/a%26b%3Cscript%3E\/"[^>]*>~\/project\/a&amp;b&lt;script&gt;<\/a><\/span><\/li><li><span aria-current="page"[^>]*>user<\/span> <button type="button" data-dialog-target="dialog-session-hide" aria-label="Hide session" title="Hide session">🗑️<\/button><\/li><\/ul><\/nav>/u);
    assert.doesNotMatch(html, /<script>|<template/iu);
    assert.equal(html.replace(/<dialog\b[\s\S]*?<\/dialog>/gu, "").match(/<footer\b/gu).length, 1, "the session status footer is the only document-level footer");
    assert.equal(html.match(/<main\b/gu).length, 1);
    assert.doesNotMatch(html, /<h1\b/u, "the breadcrumb and document title identify the session without a duplicate heading");
});

test("{§web-page-shell} empty lists and request failures are useful native documents", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`, false, 128);
    const port = { listWorkspaces: async () => [], listSessions: async () => [] };
    const empty = (await document.read({ kind: "daemon" }, port, false)).toString();
    assert.match(empty, /<title[^>]*>Workspaces — Plurnk<\/title>/u);
    assert.match(empty, /<p[^>]*>No workspaces\.<\/p>/u);
    assert.doesNotMatch(empty, /<ul><\/ul>/u);
    const sessions = (await document.read({ kind: "workspace", workspace: "empty" }, {
        ...port, listWorkspaces: async () => [{ id: 7, name: "empty", project_root: null, project_label: null, hidden_at: null }],
    }, false)).toString();
    assert.match(sessions, /data-page="workspace"/u);
    assert.match(sessions, /<p[^>]*>No sessions\.<\/p>/u);
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
        assert.throws(() => new Documents(html, false, 128), /exactly one title element/u);
    }
    assert.throws(() => new Documents('<title>Plurnk</title><main>Home</main>', false, 128), /exactly one session-navigation template/u);
});

test("{§web-page-shell} an absent or ambiguous breadcrumb insertion boundary fails at load", () => {
    for (const closing of ["", "</header></header>"]) {
        assert.throws(() => new Documents(`<title>Plurnk</title><header>${navigation}${closing}<main></main>`, false, 128), {
            name: "Error", message: "The web document must close its header once after session navigation and before main.",
        });
    }
});

test("{§web-account} Account offers native navigation without a fictional profile or inline session inventory", () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`, false, 128);
    const html = document.account().toString();
    assert.match(html, /<title[^>]*>Account — Plurnk<\/title>/u);
    assert.match(html, /<article[\s\S]*<h1[^>]*>Account<\/h1>/u);
    assert.match(html, /<nav aria-label="Account"><ul><li><a href="\/account\/sessions\/"[^>]*>Sessions<\/a><\/li><\/ul><\/nav>/u);
    assert.doesNotMatch(html, /Signed in as|Local operator|data-session|<table|revoke/iu);
});

test("{§web-account} Sessions renders authority facts in a native table without invented device facts", () => {
    const document = new Documents('<title>Plurnk</title><header><template id="session-navigation"><a href="/account/">Account</a><form method="post" action="/auth/logout"><button>Sign out</button></form></template></header><main>Home</main>', false, 128);
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

test("{§web-directory-documents} hidden places leave the lists, and their own pages still open", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main></main>`, false, 128);
    const hidden = "2026-10-23T00:00:00.000Z";
    const port = {
        listWorkspaces: async () => [
            { id: 7, name: "work", project_root: null, project_label: null, hidden_at: null },
            { id: 8, name: "shelved", project_root: null, project_label: null, hidden_at: hidden },
        ],
        listSessions: async (id) => id !== 7 ? [session(20, "kept")] : [
            session(9, "shown"), { ...session(10, "gone"), hidden_at: hidden }, { ...session(11, "gone-child", 10), hidden_at: hidden },
        ],
    };
    const daemon = (await document.read({ kind: "daemon" }, port, false)).toString();
    assert.match(daemon, /href="\/~\/work\/"/u);
    assert.doesNotMatch(daemon, /shelved/u, "a hidden workspace leaves the workspaces list");
    const workspace = (await document.read({ kind: "workspace", workspace: "work" }, port, false)).toString();
    assert.match(workspace, />shown</u);
    assert.doesNotMatch(workspace, /gone/u, "a hidden session and its group leave the tree");
    assert.ok(await document.read({ kind: "workspace", workspace: "shelved" }, port, false), "a hidden workspace's page opens by its address");
    assert.ok(await document.read({ kind: "session", workspace: "work", session: "gone" }, port, false), "a hidden session's page opens by its address");
});
