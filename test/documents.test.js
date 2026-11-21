import assert from "node:assert/strict";
import test from "node:test";
import Documents from "../src/documents.js";
import { ownNavigation } from "../src/http.js";

const navigation = '<template id="session-navigation"><a href="/account/">Account</a><form method="post" action="/auth/logout"><button>Sign out</button></form></template>';
const session = (id, name, parentSessionId = null, origin = "model", owner = "_plurnk") => ({
    id, name, parentSessionId, origin, owner, kind: parentSessionId === null ? "root" : "work", lifecycle: "completed", archived_at: null,
});

test("{§web-page-shell} session status sits outside the scrolling main; search directory entries are native articles", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main></main>`, false, 128, 128);
    const port = {
        listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null, archived_at: null }],
        listSessions: async () => [session(9, "user")],
    };
    const html = (await document.read({ kind: "session", workspace: "work", session: "user" }, port, false)).toString();
    assert.match(html, /<\/main><footer id="session-status"/u);
    assert.match(html, /aria-label="Model controls"/u);
    assert.match(html, /<details id="session-usage">[\s\S]*?<ul aria-label="Session statistics">/u);
    const listing = (await document.search(false, port)).toString();
    assert.match(listing, /<li[^>]*><article[^>]*><header>/u);
});

test("{§web-session-approval} a session page starts automatic only when configured and reached by the person's own navigation", async () => {
    const arrivals = /** @type {const} */ ([["same-origin", true], ["none", true], ["cross-site", false], ["same-site", false], [undefined, false]]);
    for (const yolo of [true, false]) {
        for (const [site, own] of arrivals) {
            assert.equal(ownNavigation({ headers: site === undefined ? {} : { "sec-fetch-site": site } }), own, String(site));
            const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main></main>`, yolo, 128, 128);
            const html = (await document.read({ kind: "session", workspace: "work", session: "user" }, {
                listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null, archived_at: null }],
                listSessions: async () => [session(9, "user")],
            }, false, { own })).toString();
            const automatic = yolo && own;
            assert.ok(html.includes(`id="session-yolo" aria-pressed="${automatic}"`), `configured ${yolo}, arrival ${site}`);
            assert.ok(html.includes(`aria-label="Automatic approval" title="${automatic ? "Auto" : "Manual"} Approval (Shift+Tab · /yolo)"><span data-text="yolo-label">${automatic ? "Auto-approve" : "Review"}</span>`));
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

test("{§web-session-conversation} only a session workbench document supplies the passive conversation outlet", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main></main>`, false, 128, 128);
    const port = {
        listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null, archived_at: null }],
        listSessions: async () => [session(9, "user")],
    };
    const html = (await document.read({ kind: "session", workspace: "work", session: "user" }, port, false)).toString();
    assert.match(html, /<section id="session-conversation" aria-label="Conversation">/u);
    assert.match(html, /<ul[^>]*data-messages[^>]*><\/ul>/u);
    assert.match(html, /Conversation requires JavaScript\./u);
    assert.doesNotMatch(html, /<textarea|contenteditable|<h1\b/u);
    assert.doesNotMatch((await document.search(false, port)).toString(), /id="session-conversation"/u);
    const emptyWs = (await document.read({ kind: "workspace", workspace: "work" }, { ...port, listSessions: async () => [] }, false)).toString();
    assert.doesNotMatch(emptyWs, /id="session-conversation"/u);
});

test("{§web-session-observer} readable names never select the session's live session identity", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main></main>`, false, 128, 128);
    for (const name of ["~/project", "42#alice", "renamed workspace"]) {
        const html = (await document.read({ kind: "session", workspace: name, session: "user" }, {
            listWorkspaces: async () => [{ id: 7, name, project_root: null, project_label: null, archived_at: null }],
            listSessions: async () => [session(9, "user")],
        }, false)).toString();
        assert.match(html, /data-session-id="7#user"/u);
        assert.doesNotMatch(html, /data-workspace=|data-session=/u);
        const escapedTitle = `${name}#user — Plurnk`.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        assert.ok(html.includes(escapedTitle));
    }
});

test("{§web-page-shell} {§web-workspace-folder} header place and search directory distinguish workspace names from literal daemon folder labels", async () => {
    const document = new Documents(`<title>Plurnk</title><header><nav aria-label="Main navigation">${navigation}</nav></header><main></main>`, false, 128, 128);
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
            listWorkspaces: async () => [{ id: 7, name, project_root, project_label, archived_at: null }],
            listSessions: async () => [],
        };
        const searchHtml = (await document.search(false, port)).toString();
        assert.match(searchHtml, /<div id="header-place"><span aria-current="page" data-i18n="search">Search<\/span><\/div>/u);
        assert.doesNotMatch(searchHtml, /<h1\b/u);
        const page = (await document.read({ kind: "workspace", workspace: name }, port, false)).toString();
        const escaped = name.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        assert.ok(page.includes(`<button type="button" id="session-workspace" data-workspace-settings aria-label="Workspace settings" title="Workspace settings"><span role="img" aria-label="${label}" data-bind="aria-label:workspace-icon-label" data-text="workspace-icon">${icon}</span> <span data-text="workspace-name">${escaped}</span></button>`));
        assert.match(page, /<p[^>]*>No sessions in this workspace yet\.<\/p>/u);
        assert.doesNotMatch(page, /<h1\b/u);
        if (separateFolder && project_label !== null) {
            const folder = project_label.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
            assert.ok(page.includes(`<p id="session-folder" data-project-label="${folder}"><span role="img" aria-label="Project folder">🗂️</span> <span data-text="project-label">${folder}</span></p>`));
        } else {
            assert.ok(page.includes('<p id="session-folder" data-project-label="">'));
        }
        assert.doesNotMatch(page, /\/home\/daemon|<script>/u, "display the supplied label, not the filesystem root or executable markup");
    }
});

test("{§web-session-directory} {§web-search} model lineage is complete, collapsed and independent of names and approval owners", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`, false, 128, 128);
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
    const port = {
        listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null, archived_at: null }],
        listSessions: async () => sessions,
    };
    const html = (await document.search(false, port, { workspace: "work" })).toString();
    const link = (name) => `<a href="/~/work#${name}" data-text="name" data-session-name="${name}" data-bind="href:session-path">${name}</a>`;
    const entry = (id, name, parent = null, children = "", childCount = 0) => {
        const lineage = parent === null ? "" : `<span data-session-parent>${parent === "_plurnk" ? "<span>_plurnk</span>" : link(parent)} &gt; </span>`;
        const childrenBadge = childCount > 0
            ? `<small data-session-children="${childCount}" aria-label="${childCount} ${childCount === 1 ? "child" : "children"}" title="${childCount} ${childCount === 1 ? "child" : "children"}">${childCount}</small>` : "";
        const identity = `<span data-session-identity><a data-session-link href="/~/work#${name}" aria-label="${name}" title="Open #${name}"></a> `
            + '<span data-lifecycle="completed" role="img" aria-label="completed" title="completed"></span> '
            + `${lineage}<span>#${name}</span>${childrenBadge}</span>`
            + '<span data-session-workspace><span data-folder="false" role="img" aria-label="Folderless workspace"></span> <a href="/~/work" data-text="name">work</a></span>';
        const content = children ? `<details><summary>${identity}</summary><ul>${children}</ul></details>` : `<header>${identity}</header>`;
        const kind = parent === null ? "root" : "work";
        return `<li data-directory-entry="session" data-session-key="7:${id}" data-session-kind="${kind}" data-workspace-name="work" data-lifecycle-state="completed" data-gate-count="0"><article aria-label="Session">${content}</article></li>`;
    };
    assert.ok(html.includes([
        '<section id="search-sessions" aria-label="Sessions"><ul>',
        entry(3, "2bb6a400-7106-4299-ae47-66daea5d6077"),
        entry(4, "user", null, entry(6, "review", "user", entry(7, "evidence", "review"), 1) + entry(5, "research", "user"), 2),
        "</ul>",
        '<details><summary data-i18n="background-work">Background work</summary><ul>',
        entry(8, "incoming", "_plurnk", entry(10, "incoming-child", "incoming"), 1),
        entry(9, "other", "_plurnk"),
        "</ul></details></section>",
    ].join("")), html);
    const names = [...html.matchAll(/data-session-link href="\/~\/work#([^"]+)"/gu)].map((match) => match[1]);
    assert.deepEqual(names.toSorted(), sessions.filter(({ origin }) => origin === "model").map(({ name }) => name).toSorted());
    assert.doesNotMatch(html, /work#_plurnk|acp:|<details\b[^>]*\bopen\b|role="tree"|<script|data-text="session-kind"|child session/u);
    for (const internal of sessions.filter(({ origin }) => origin !== "model")) {
        assert.equal(await document.read({ kind: "session", workspace: "work", session: internal.name }, port, false), null);
    }
    const child = (await document.read({ kind: "session", workspace: "work", session: "review" }, port, false)).toString();
    assert.ok(child.includes(`<p data-session-parent-line><span data-i18n="parent-session">Parent:</span> ${link("user")}</p>`));
    const background = (await document.read({ kind: "session", workspace: "work", session: "incoming" }, port, false)).toString();
    assert.match(background, /<p data-session-parent-line><span data-i18n="parent-session">Parent:<\/span> <span data-text="name">_plurnk<\/span><\/p>/u);
    const root = (await document.read({ kind: "session", workspace: "work", session: "user" }, port, false)).toString();
    assert.doesNotMatch(root, /parent-session/u);
});

test("{§web-session-directory} session pages keep header place and parent navigation without a duplicated workspace tree", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main></main>`, false, 128, 128);
    const sessions = [session(1, "_plurnk", null, "_plurnk"), { ...session(2, "parent"), lifecycle: "running" },
        { ...session(3, "child", 2), kind: "fork", lifecycle: "failed" },
        { ...session(4, "grandchild", 3), lifecycle: "parked" }, { ...session(5, "sibling", 2), lifecycle: "queued" },
        session(6, "incoming", 1), session(7, "background-child", 6)];
    let reads = 0;
    const port = {
        listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null, archived_at: null }],
        listSessions: async () => { reads++; return sessions; },
    };
    for (const selected of ["parent", "child", "grandchild", "background-child"]) {
        const html = (await document.read({ kind: "session", workspace: "work", session: selected }, port, false)).toString();
        assert.doesNotMatch(html, /session-directory|sessions-at-page-load|Sessions at page load|<nav aria-label="Sessions">/u);
        assert.ok(html.includes('<span data-text="workspace-name">work</span>'));
        assert.ok(html.includes(`<button type="button" id="header-session" data-dialog-target="dialog-session-manage" aria-label="Session actions" title="Session actions"><span data-text="active-session-name">${selected}</span></button>`));
        assert.match(html, /<details id="session-descendants">/u, "live descendant navigation keeps its own statusline home");
    }
    assert.equal(reads, 4, "one authoritative directory read per document; no second client-side directory");
});

test("{§web-session-diagnostics} the session page renders an empty diagnostics list without a static heading", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main></main>`, false, 128, 128);
    const html = (await document.read({ kind: "session", workspace: "work", session: "user" }, {
        listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null, archived_at: null }],
        listSessions: async () => [session(9, "user")],
    }, false)).toString();
    assert.match(html, /<section id="session-diagnostics" aria-label="Diagnostics"><ul><\/ul><\/section>/u);
    assert.match(html, /id="session-conversation"/u);
});

test("{§web-session-directory} {§web-search} empty and internal-only workspaces have no empty navigation controls", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`, false, 128, 128);
    for (const sessions of [[], [session(1, "_plurnk", null, "_plurnk")], [session(3, "user")]]) {
        const html = (await document.search(false, {
            listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null, archived_at: null }],
            listSessions: async () => sessions,
        })).toString();
        assert.doesNotMatch(html, /Background work|<ul><\/ul>/u);
        if (sessions.some(({ origin }) => origin === "model")) assert.match(html, /href="\/~\/work#user"/u);
        else assert.match(html, /<p[^>]*>No matching sessions\.<\/p>/u);
    }
});

test("{§web-session-directory} inconsistent topology fails rather than dropping sessions", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`, false, 128, 128);
    for (const [sessions, message] of /** @type {const} */ ([
        [[session(1, "first"), session(1, "second")], "Session directory contains duplicate identities."],
        [[session(1, "missing", 2)], "Session 1 has an absent parent 2."],
        [[session(1, "self", 1)], "Session directory holds shown model sessions that no shown root reaches."],
        [[session(1, "first", 2), session(2, "second", 1)], "Session directory holds shown model sessions that no shown root reaches."],
    ])) {
        const port = {
            listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null, archived_at: null }],
            listSessions: async () => sessions,
        };
        await assert.rejects(document.read({ kind: "workspace", workspace: "work" }, port, false), { name: "Error", message });
        await assert.rejects(document.search(false, port), { name: "Error", message });
    }
});

test("{§web-directory-documents} {§web-search} workspace markers describe folder presence without interpreting names", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`, false, 128, 128);
    const html = (await document.search(false, {
        listWorkspaces: async () => [
            { id: 1, name: "~/looks-like-a-folder", project_root: null, project_label: null, archived_at: null },
            { id: 2, name: "research", project_root: "/home/daemon/project", project_label: "~/project", archived_at: null },
            { id: 3, name: "../legacy", project_root: null, project_label: null, archived_at: null },
        ],
        listSessions: async () => [],
    })).toString();
    assert.match(html, /<li data-directory-entry="workspace" data-workspace-name="~\/looks-like-a-folder" data-folder="false"><article aria-label="Folderless workspace"><header><a href="\/~\/~\/looks-like-a-folder" data-text="name">~\/looks-like-a-folder<\/a><\/header><\/article><\/li>/u);
    assert.match(html, /<li data-directory-entry="workspace" data-workspace-name="research" data-folder="true"><article aria-label="Project workspace"><header><a href="\/~\/research" data-text="name">research<\/a> <small data-text="project-label">~\/project<\/small><\/header><\/article><\/li>/u);
    assert.match(html, /<article aria-label="Folderless workspace"><header><span data-text="name">\.\.\/legacy<\/span><\/header><\/article>/u);
    assert.doesNotMatch(html, /\/home\/daemon\/project/u, "search shows the daemon project_label, never raw filesystem paths");
});

test("{§web-directory-documents} {§web-search} read-only lookup escapes names and never invents identities", async () => {
    const calls = [];
    const port = {
        listWorkspaces: async () => {
            calls.push("workspaces");
            return [{ id: 7, name: '~/a&<script>@"b', project_root: null, project_label: null, archived_at: null }, { id: 8, name: "../legacy", project_root: null, project_label: null, archived_at: null }];
        },
        listSessions: async (id) => { calls.push(id); return [session(id * 10 + 1, "user")]; },
    };
    const document = new Documents(`<!doctype html><title>Plurnk</title><header><nav aria-label="Main navigation">${navigation}</nav></header><main>Home</main><script src="/app.js"></script>`, false, 128, 128);
    const searchPage = (await document.search(true, port)).toString();
    assert.match(searchPage, /<li data-directory-entry="workspace"[^>]*><article aria-label="Folderless workspace"><header><a href="\/~\/~\/a%26%3Cscript%3E%40%22b"/u);
    assert.match(searchPage, /~\/a&amp;&lt;script&gt;@&quot;b/u);
    assert.match(searchPage, /<article aria-label="Folderless workspace"><header><span data-text="name">\.\.\/legacy<\/span><\/header><\/article>/u);
    assert.match(searchPage, /<form method="post" action="\/auth\/logout">/u);
    assert.match(searchPage, /<dialog id="dialog-workspace-create">[\s\S]*<form id="workspace-create" method="post" action="\/workspaces\/new">[\s\S]*<button type="submit"[^>]*>Confirm<\/button>/u,
        "{§web-workspace-creation} search carries the native project-folder creation dialog");
    assert.match(searchPage, /<script src="\/app.js"><\/script>/u);
    assert.equal(await document.read({ kind: "workspace", workspace: "missing" }, port, false), null);

    const workspace = /** @type {const} */ ({ kind: "workspace", workspace: '~/a&<script>@"b' });
    const sessions = (await document.read(workspace, port, false)).toString();
    assert.match(sessions, /href="#user"/u);
    assert.match(sessions, /<dialog id="dialog-session-manage"[\s\S]*data-session-fork/u, "workspace workbench carries the session manage dialog");
    assert.match(sessions, /<dialog id="dialog-workspace-rename">[\s\S]*<form id="workspace-rename" method="post" action="\/workspaces\/rename">/u);
    assert.match(sessions, /<dialog id="dialog-workspace-archive">[\s\S]*<form id="workspace-archive" method="post" action="\/workspaces\/archive">/u);
    assert.match(sessions, /<dialog id="dialog-session-archive">[\s\S]*<form id="session-archive" method="post" action="\/sessions\/archive">/u);
    assert.match(sessions, /<dialog id="dialog-session-create">[\s\S]*<form id="session-create" method="post" action="\/sessions\/new">/u);
    assert.match(sessions, /action="\/workspaces\/new"/u, "header carries 1-click New workspace form");
    assert.match(sessions, /action="\/sessions\/new"/u, "header carries 1-click New session form");
    assert.doesNotMatch(sessions, /<form method="post" action="\/auth\/logout"/u);
});

test("{§web-session-status} status is a compact footer after conversation, not a metadata inventory", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`, true, 128, 128);
    const html = (await document.read({ kind: "session", workspace: "review", session: "user" }, {
        listWorkspaces: async () => [{ id: 7, name: "review", project_root: null, project_label: null, archived_at: null }],
        listSessions: async () => [session(1, "user")],
    }, false)).toString();
    assert.match(html, /<footer id="session-status"[^>]*>/u);
    assert.ok(html.indexOf('id="session-status"') > html.indexOf('id="session-conversation"'));
    const footer = html.slice(html.indexOf('<footer id="session-status"'));
    assert.match(footer, /<details id="session-usage">[\s\S]*<ul aria-label="Session statistics">/u);
    assert.match(footer, /<details id="session-descendants"><summary/u);
    assert.match(footer, /aria-controls="dialog-session-model"/u);
    assert.match(footer, /aria-controls="dialog-session-effort"/u);
    assert.match(footer, /data-bind="aria-label:lifecycle title:lifecycle"/u);
    assert.doesNotMatch(footer, /<dl|<table|id="(?:session-accounting|workspace-activity|session-inbox)"|data-text="(?:requests|turns|loop)"/u);
    assert.match(html, /<article id="session-connection" role="alert"><header>[\s\S]*id="session-reconnect"[\s\S]*data-sign-in[\s\S]*<\/header>[\s\S]*<\/main><footer/u);
    assert.doesNotMatch(footer, /<article|session-reconnect/u, "detailed connection notices cannot crowd the pinned composer");
});

test("{§web-directory-documents} a broken document outlet fails at load", () => {
    for (const html of ["", "<main>unclosed", "<main>a</main><main>b</main>", "</main>inverted<main>"]) {
        assert.throws(() => new Documents(html, false, 128, 128), /exactly one main element/u);
    }
});

test("{§web-page-shell} titles and header place preserve whole identities, not path segments", async () => {
    const name = "~/project/a&b<script>";
    const port = {
        listWorkspaces: async () => [{ id: 7, name, project_root: null, project_label: null, archived_at: null }],
        listSessions: async () => [session(1, "user")],
    };
    const document = new Documents(`<html><head><title data-text="page-title">Plurnk</title></head><body><header>Shared navigation${navigation}</header><main id="main" data-page="home">Home</main></body></html>`, false, 128, 128);
    const html = (await document.read({ kind: "session", workspace: name, session: "user" }, port, true)).toString();
    assert.match(html, /<title[^>]*>~\/project\/a&amp;b&lt;script&gt;#user — Plurnk<\/title>/u);
    assert.match(html, /<header>Shared navigation[\s\S]*href="\/account\/"[\s\S]*<\/header>/u);
    assert.match(html, /<main id="main" data-page="session" data-session-name="user">/u);
    assert.match(html, /<div id="header-place"><button type="button" id="session-workspace" data-workspace-settings[^>]*><span role="img" aria-label="Folderless workspace"[^>]*>☁️<\/span> <span data-text="workspace-name">~\/project\/a&amp;b&lt;script&gt;<\/span><\/button><span data-place-hash aria-hidden="true">#<\/span><button type="button" id="header-session" data-dialog-target="dialog-session-manage"[^>]*><span data-text="active-session-name">user<\/span><\/button>/u);
    assert.doesNotMatch(html, /<script>|<template/iu);
    assert.equal(html.replace(/<dialog\b[\s\S]*?<\/dialog>/gu, "").match(/<footer\b/gu).length, 1, "the session status footer is the only document-level footer");
    assert.equal(html.match(/<main\b/gu).length, 1);
    assert.doesNotMatch(html, /<h1\b/u, "the header place and document title identify the session without a duplicate heading");
});

test("{§web-page-shell} {§web-search} empty lists and request failures are useful native documents", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`, false, 128, 128);
    const port = { listWorkspaces: async () => [], listSessions: async () => [] };
    const empty = (await document.search(false, port)).toString();
    assert.match(empty, /<title[^>]*>Search — Plurnk<\/title>/u);
    assert.match(empty, /<p[^>]*>No matching workspaces\.<\/p>/u);
    assert.match(empty, /<p[^>]*>No matching sessions\.<\/p>/u);
    assert.doesNotMatch(empty, /<ul><\/ul>/u);
    const sessions = (await document.read({ kind: "workspace", workspace: "empty" }, {
        ...port, listWorkspaces: async () => [{ id: 7, name: "empty", project_root: null, project_label: null, archived_at: null }],
    }, false)).toString();
    assert.match(sessions, /data-page="workspace"/u);
    assert.match(sessions, /<p[^>]*>No sessions in this workspace yet\.<\/p>/u);
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
    for (const html of ["<main>Home</main>", "<title>A</title><title>B</title><main>Home</main>", "</title>Inverted<title><main>Home</main>"]) {
        assert.throws(() => new Documents(html, false, 128, 128), /exactly one title element/u);
    }
    for (const html of [
        "<title>Plurnk</title><main>Home</main>",
        '<title>Plurnk</title><header><template id="session-navigation"><a href="/account/">Account</a><template id="other"></template></header><main>Home</main>',
    ]) {
        assert.throws(() => new Documents(html, false, 128, 128), /exactly one session-navigation template/u);
    }
});

test("{§web-page-shell} an absent or ambiguous header insertion boundary fails at load", () => {
    for (const closing of ["", "</header></header>"]) {
        assert.throws(() => new Documents(`<title>Plurnk</title><header>${navigation}${closing}<main></main>`, false, 128, 128), {
            name: "Error", message: "The web document must close its header once after session navigation and before main.",
        });
    }
});

test("{§web-page-shell} named slots tolerate sibling header templates without shifting header or main output", () => {
    const extraBefore = '<template id="header-leading"><span>Lead</span></template>';
    const extraAfter = '<template id="workspace-tab"><a>Tab</a></template>';
    const document = new Documents(
        `<title>Plurnk</title><header>${extraBefore}${navigation}${extraAfter}</header><main>Home</main>`,
        false,
        128,
        128,
    );
    const unauth = document.home(false).toString();
    assert.ok(unauth.includes(extraBefore));
    assert.ok(unauth.includes(extraAfter));
    assert.equal(unauth.includes("/account/"), false);
    const auth = document.home(true).toString();
    assert.ok(auth.includes(extraBefore));
    assert.ok(auth.includes("/account/"));
    assert.ok(auth.includes(extraAfter));
});

test("{§web-account} Account offers native navigation without a fictional profile or inline session inventory", () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main>Home</main>`, false, 128, 128);
    const html = document.account().toString();
    assert.match(html, /<title[^>]*>Profile — Plurnk<\/title>/u);
    assert.match(html, /<article[\s\S]*<h1[^>]*>Account<\/h1>/u);
    assert.match(html, /<nav aria-label="Account"><ul><li><a href="\/account\/sessions\/"[^>]*>Sessions<\/a><\/li><\/ul><\/nav>/u);
    assert.doesNotMatch(html, /Signed in as|Local operator|data-session|<table|revoke/iu);
});

test("{§web-account} Sessions renders authority facts in a native table without invented device facts", () => {
    const document = new Documents('<title>Plurnk</title><header><template id="session-navigation"><a href="/account/">Account</a><form method="post" action="/auth/logout"><button>Sign out</button></form></template></header><main>Home</main>', false, 128, 128);
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
    assert.match(html, /<header>[\s\S]*<nav id="header-place" aria-label="breadcrumb">[\s\S]*<\/nav>[\s\S]*<\/header>/u);
    assert.doesNotMatch(html.split("<main")[1], /aria-label="breadcrumb"/u);
    assert.doesNotMatch(html, /<script>|<template|last active|device|Signed in as/iu);
});

test("{§web-directory-documents} {§web-search} archived places leave default lists, appear with Unarchive under status=archived, and still open directly", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main></main>`, false, 128, 128);
    const archived = "2026-10-23T00:00:00.000Z";
    const port = {
        listWorkspaces: async () => [
            { id: 7, name: "work", project_root: null, project_label: null, archived_at: null },
            { id: 8, name: "shelved", project_root: null, project_label: null, archived_at: archived },
        ],
        listSessions: async (id) => id !== 7 ? [{ ...session(20, "kept"), archived_at: archived }] : [
            session(9, "shown"), { ...session(10, "gone"), archived_at: archived }, { ...session(11, "gone-child", 10), archived_at: archived },
        ],
    };
    const defaultSearch = (await document.search(false, port)).toString();
    assert.match(defaultSearch, /href="\/~\/work"/u);
    assert.match(defaultSearch, />#shown</u);
    assert.doesNotMatch(defaultSearch, /shelved|gone/u, "archived workspaces and sessions leave default search");

    const archivedSearch = (await document.search(false, port, { status: "archived" })).toString();
    assert.match(archivedSearch, /action="\/workspaces\/unarchive"[\s\S]*value="shelved"/u);
    assert.match(archivedSearch, /action="\/sessions\/unarchive"[\s\S]*value="gone"/u);

    assert.ok(await document.read({ kind: "workspace", workspace: "shelved" }, port, false), "an archived workspace's page opens by its address");
    assert.ok(await document.read({ kind: "session", workspace: "work", session: "gone" }, port, false), "an archived session's page opens by its address");
});

test("{§web-session-directory} {§web-search} search orders by delivered reply recency, filters by query/status/kind, and exposes reply disclosures", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main id="main" data-page="home"></main>`, false, 128, 128);
    assert.match(document.home(false).toString(), /<main id="main" data-page="home"><\/main>/u);
    const workspaces = [
        { id: 7, name: "alpha", project_root: null, project_label: null, projectRoot: null, projectLabel: null, archived_at: null },
        { id: 8, name: "beta", project_root: "/srv/beta", project_label: "~/beta", projectRoot: "/srv/beta", projectLabel: "~/beta", archived_at: null },
    ];
    /** @type {(id: number, coordinate: string, completion?: 200 | 499) => { id: number, coordinate: string, completion: 200 | 499 }} */
    const reply = (id, coordinate, completion = 200) => ({ id, coordinate, completion });
    const overviewSessions = [
        { ...session(1, "_plurnk", null, "_plurnk"), workspaceId: 7, reply: null },
        { ...session(2, "no-reply-first"), workspaceId: 7, reply: null },
        { ...session(3, "older-reply"), workspaceId: 7, reply: reply(40, "1/2/3/send:40") },
        { ...session(4, "newer-reply"), workspaceId: 8, reply: reply(95, "2/1/1/done:95") },
        { ...session(5, "child-older", 3), workspaceId: 7, reply: reply(50, "1/3/1/send:50") },
        { ...session(6, "child-newer", 3), workspaceId: 7, lifecycle: "failed", reply: reply(80, "1/4/1/fail:80", 499) },
        { ...session(7, "child-silent", 3), workspaceId: 7, reply: null },
        { ...session(8, "no-reply-second"), workspaceId: 8, reply: null },
        { ...session(9, "bg-older", 1), workspaceId: 7, reply: reply(10, "1/5/1/send:10") },
        { ...session(10, "bg-newer", 1), workspaceId: 7, reply: reply(60, "1/6/1/send:60") },
    ];
    const modelOverviewSessions = overviewSessions.filter(({ origin }) => origin === "model");
    const port = {
        listWorkspaces: async () => workspaces,
        listSessions: async (id) => overviewSessions.filter((item) => item.workspaceId === id),
        readSessionOverview: async (/** @type {{ workspaceId?: number }} */ { workspaceId } = {}) => ({
            workspaces: workspaceId === undefined ? workspaces : workspaces.filter((ws) => ws.id === workspaceId),
            sessions: workspaceId === undefined ? modelOverviewSessions : modelOverviewSessions.filter((item) => item.workspaceId === workspaceId),
        }),
    };
    const searchHtml = (await document.search(true, port)).toString();
    assert.match(searchHtml, /<main id="main" data-page="search" data-auth="session" data-connection="initial">/u);
    assert.match(searchHtml, /<form id="search-controls" method="get" action="\/search\/"/u);
    const rootOrder = [...searchHtml.split('<details><summary data-i18n="background-work">')[0].matchAll(/data-session-link href="\/~\/[^#]+#([^"]+)"/gu)].map((match) => match[1]);
    assert.deepEqual(rootOrder, ["newer-reply", "older-reply", "child-newer", "child-older", "child-silent", "no-reply-first", "no-reply-second"]);
    const bgOrder = [...searchHtml.split('<details><summary data-i18n="background-work">')[1].matchAll(/data-session-link href="\/~\/[^#]+#([^"]+)"/gu)].map((match) => match[1]);
    assert.deepEqual(bgOrder, ["bg-newer", "bg-older"]);
    assert.ok(searchHtml.includes('data-session-reply="/acp/8/4/entry?target=log%3A%2F%2F%2F2%2F1%2F1%2Fdone%3A95"'), "leaf with delivered reply renders reply disclosure outlet");
    assert.ok(searchHtml.includes('</ul><div data-session-reply="/acp/7/3/entry?target=log%3A%2F%2F%2F1%2F2%2F3%2Fsend%3A40"></div></details>'), "branch with children and reply renders both child list and reply outlet");

    // Server-side status & kind filtering on /search/
    const failedOnly = (await document.search(true, port, { status: "failed", kind: "work" })).toString();
    const failedNames = [...failedOnly.matchAll(/data-session-link href="\/~\/[^#]+#([^"]+)"/gu)].map((match) => match[1]);
    assert.deepEqual(failedNames, ["child-newer"]);

    const boundedSearch = (await document.search(true, {
        listWorkspaces: async () => [workspaces[0]],
        listSessions: async () => [],
        readSessionOverview: async ({ limit, excerptChars }) => {
            assert.equal(limit, 128);
            assert.equal(excerptChars, 128);
            return {
                workspaces: [workspaces[0]],
                sessions: [{
                    ...session(3, "older-reply"),
                    workspaceId: 7,
                    kind: /** @type {const} */ ("fork"),
                    gates: 2,
                    title: "Investigation #1",
                    reply: { id: 40, coordinate: "1/2/3/send:40", completion: /** @type {const} */ (200), at: Date.UTC(2026, 10, 10, 2, 15), excerpt: "Resolved root cause", continued: true },
                }],
                omitted: 12,
            };
        },
    })).toString();
    assert.ok(boundedSearch.includes('data-session-kind="fork"'));
    assert.ok(boundedSearch.includes('<small data-session-title>Investigation #1</small>'));
    assert.ok(boundedSearch.includes('<small data-session-gates="2" aria-label="2 awaiting input" title="2 awaiting input">2</small>'));
    assert.ok(boundedSearch.includes('<time data-session-time datetime="2026-11-10T02:15:00.000Z" title="2026-11-10T02:15:00.000Z">2026-11-10 02:15 UTC</time>'));
    assert.ok(boundedSearch.includes('<small data-session-excerpt>Resolved root cause…</small>'));
    assert.ok(boundedSearch.includes('<p data-overview-omitted><small><span data-text="overview-omitted">12</span>'));
});

test("{§web-workspace-tabs} {§web-workspace-settings} workspace session documents render progressive-disclosure #session tabs, fold settled child workers unless selected, and omit tabs outside workspaces", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main></main>`, false, 128, 128);
    assert.doesNotMatch(document.home(false).toString(), /id="workspace-tabs"/u);
    assert.doesNotMatch(document.account().toString(), /id="workspace-tabs"/u);
    assert.doesNotMatch(document.error(404, "Missing.").toString(), /id="workspace-tabs"/u);

    const archived = "2026-04-06T00:00:00.000Z";
    const workspaces = [{ id: 7, name: "alpha", project_root: null, project_label: null, projectRoot: null, projectLabel: null, archived_at: null }];
    /** @type {(id: number, coordinate: string, completion?: 200 | 499) => { id: number, coordinate: string, completion: 200 | 499 }} */
    const reply = (id, coordinate, completion = 200) => ({ id, coordinate, completion });
    const sessions = [
        { ...session(1, "_plurnk", null, "_plurnk"), workspaceId: 7, reply: null },
        { ...session(2, "older-root"), workspaceId: 7, kind: /** @type {const} */ ("root"), lifecycle: "completed", reply: reply(20, "1/1/1/done:20") },
        { ...session(3, "newer-root"), workspaceId: 7, kind: /** @type {const} */ ("root"), lifecycle: "running", reply: reply(90, "1/2/1/send:90") },
        { ...session(4, "fork-branch", 3), workspaceId: 7, kind: /** @type {const} */ ("fork"), lifecycle: "completed", reply: reply(50, "1/1/1/done:50") },
        { ...session(5, "active-worker", 3), workspaceId: 7, kind: /** @type {const} */ ("work"), lifecycle: "running", reply: null },
        { ...session(6, "gated-worker", 3), workspaceId: 7, kind: /** @type {const} */ ("work"), lifecycle: "parked", gates: 2, reply: reply(70, "1/1/1/send:70") },
        { ...session(8, "failed-worker", 3), workspaceId: 7, kind: /** @type {const} */ ("work"), lifecycle: "failed", reply: reply(60, "1/1/1/fail:60", 499) },
        { ...session(9, "settled-worker", 3), workspaceId: 7, kind: /** @type {const} */ ("work"), lifecycle: "completed", reply: reply(95, "1/1/1/done:95") },
        { ...session(10, "archived-root"), workspaceId: 7, kind: /** @type {const} */ ("root"), lifecycle: "completed", archived_at: archived, reply: reply(99, "1/1/1/done:99") },
    ];
    const modelSessions = sessions.filter(({ origin, archived_at }) => origin === "model" && archived_at === null);
    const port = {
        listWorkspaces: async () => workspaces,
        listSessions: async () => sessions,
        readSessionOverview: async () => ({ workspaces, sessions: modelSessions }),
    };

    assert.doesNotMatch((await document.search(false, port)).toString(), /id="workspace-tabs"/u);

    const extractTabs = (/** @type {string} */ html) => {
        const match = html.match(/<\/header>(<nav id="workspace-tabs"[\s\S]*?<\/nav>)<main/u);
        assert.ok(match, "workspace-tabs sits directly between </header> and <main>");
        return match[1];
    };
    const extractTabRoutes = (/** @type {string} */ navHtml) =>
        [...navHtml.matchAll(/<a href="([^"]+)" data-workspace-route="[^"]+"/gu)].map((match) => match[1]);

    // Single-session workspace sets data-tab-count="1" so CSS hides #workspace-tabs until 2+ sessions exist.
    const singleSessionHtml = (await document.read({ kind: "workspace", workspace: "alpha" }, {
        listWorkspaces: async () => workspaces,
        listSessions: async () => [session(3, "user")],
        readSessionOverview: async () => ({ workspaces, sessions: [{ ...session(3, "user"), workspaceId: 7, reply: null }] }),
    }, false)).toString();
    assert.match(extractTabs(singleSessionHtml), /data-tab-count="1"/u);

    // Multi-session workspace selects the most recent unarchived root session (`newer-root`) and renders `data-tab-count="6"`.
    const wsHtml = (await document.read({ kind: "workspace", workspace: "alpha" }, port, false)).toString();
    const wsNav = extractTabs(wsHtml);
    assert.match(wsNav, /data-workspace-id="7" data-workspace-name="alpha" data-auth="none" data-tab-count="6" data-initial-yolo="false" data-live="true"/u);
    assert.match(wsNav, /href="#newer-root"[^>]*aria-current="true"/u);
    assert.deepEqual(extractTabRoutes(wsNav), [
        "#newer-root",
        "#gated-worker",
        "#failed-worker",
        "#fork-branch",
        "#active-worker",
        "#older-root",
    ], "roots order by reply.id descending, active/gated/failed/fork children group beneath parent by reply.id, settled worker and archived root omit");
    assert.match(wsNav, /data-switcher-current>#newer-root<\/span>/u);
    assert.match(wsNav, /data-session-gates="2" aria-label="2 awaiting input">2<\/small>/u);
    assert.match(wsNav, /data-switcher-active="3" aria-label="3 active">3<\/small>/u);
    assert.match(wsHtml, /id="session-workspace" data-workspace-settings/u, "header workspace button triggers workspace settings");

    const settledWorkerHtml = (await document.read({ kind: "session", workspace: "alpha", session: "settled-worker" }, port, true)).toString();
    const settledNav = extractTabs(settledWorkerHtml);
    assert.match(settledNav, /data-auth="session" data-tab-count="7" data-initial-yolo="false" data-live="true"/u);
    assert.match(settledNav, /href="#settled-worker"[^>]*aria-current="true"/u, "selected settled child worker stays in the strip while viewed");
    assert.match(settledNav, /data-switcher-current>#settled-worker<\/span>/u);
    assert.match(settledWorkerHtml, /id="dialog-session-create"/u);
    assert.match(settledWorkerHtml, /id="dialog-session-archive"/u);

    const archivedHtml = (await document.read({ kind: "session", workspace: "alpha", session: "archived-root" }, port, false)).toString();
    const archivedNav = extractTabs(archivedHtml);
    assert.match(archivedNav, /data-archived="true"><a href="#archived-root"[^>]*aria-current="true"/u, "viewing an archived session directly includes its tab");
});

test("{§web-onboarding} session documents mark data-needs-onboarding only when zero aliases and zero ready catalog models exist", async () => {
    const document = new Documents(`<title>Plurnk</title><header>${navigation}</header><main></main>`, false, 128, 128);
    const basePort = {
        listWorkspaces: async () => [{ id: 7, name: "work", project_root: null, project_label: null, archived_at: null }],
        listSessions: async () => [session(9, "user")],
    };
    const withoutOperatorEnv = (await document.read({ kind: "session", workspace: "work", session: "user" }, basePort, false)).toString();
    assert.doesNotMatch(withoutOperatorEnv, /data-needs-onboarding/u);

    const unconfigured = (await document.read({ kind: "session", workspace: "work", session: "user" }, {
        ...basePort,
        readOperatorEnvironment: async () => ({ configFile: "/tmp/.env", entries: [] }),
        listProviders: () => ({ aliases: [] }),
        listModels: () => ({ total: 0 }),
    }, false)).toString();
    assert.match(unconfigured, /id="session-status"[^>]*data-needs-onboarding="true"/u);

    const withReadyCatalog = (await document.read({ kind: "session", workspace: "work", session: "user" }, {
        ...basePort,
        readOperatorEnvironment: async () => ({ configFile: "/tmp/.env", entries: [] }),
        listProviders: () => ({ aliases: [] }),
        listModels: () => ({ total: 3 }),
    }, false)).toString();
    assert.doesNotMatch(withReadyCatalog, /data-needs-onboarding/u);

    const withCatalogProblem = (await document.read({ kind: "session", workspace: "work", session: "user" }, {
        ...basePort,
        readOperatorEnvironment: async () => ({ configFile: "/tmp/.env", entries: [] }),
        listProviders: () => { throw new Error("Invalid effort on alias"); },
        listModels: () => ({ total: 0 }),
    }, false)).toString();
    assert.doesNotMatch(withCatalogProblem, /data-needs-onboarding/u, "catalog configuration errors render the session page for diagnostic projection");
});
