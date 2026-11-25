import assert from "node:assert/strict";
import { test } from "node:test";
import Documents, { BUG_REPORT_URL, WEB_LICENSE, WEB_VERSION } from "../src/documents.js";

const SHELL = '<!doctype html><html lang="en"><head><title data-text="page-title">Plurnk</title></head><body><header><a href="/search/">Search</a><nav aria-label="Main navigation"><ul></ul></nav></header><main id="main" data-page="home">Home</main></body></html>';

test("{§web-assets} the compiled head names one origin-relative application stylesheet", () => {
    assert.equal(
        Documents.stylesheet('<head><link rel="modulepreload" href="/session.js"><link crossorigin href="/assets/app.css" rel="stylesheet"></head><template><link rel="stylesheet" href="/other.css"></template>'),
        "/assets/app.css",
    );
    for (const head of ["", '<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/b.css">']) {
        assert.throws(
            () => Documents.stylesheet(`<head>${head}</head>`),
            { message: "The web document must declare exactly one application stylesheet." },
        );
    }
    for (const path of ["https://elsewhere.invalid/style.css", "//elsewhere.invalid/style.css", "style.css"]) {
        assert.throws(
            () => Documents.stylesheet(`<head><link rel="stylesheet" href="${path}"></head>`),
            { message: "The application stylesheet must have an origin-relative path." },
        );
    }
});

test("{§web-document} {§web-configuration} {§web-arrival} {§web-oidc} home and callback shells stamp boot data-* attributes without inline scripts or env dumps", () => {
    const documents = new Documents(SHELL, {
        acpUrl: "https://acp.example/acp",
        overviewSessions: 150,
        overviewExcerptChars: 120,
    });
    const home = documents.home().toString();
    assert.match(home, /<html lang="en" data-acp-url="https:\/\/acp\.example\/acp" data-app-name="Plurnk" data-overview-sessions="150" data-overview-excerpt-chars="120" data-web-version="\d+\.\d+\.\d+">/u);
    assert.match(home, /<title data-text="page-title">Plurnk<\/title>/u);
    assert.match(home, /<main id="main" data-page="home">Home<\/main>/u);
    assert.doesNotMatch(home, /<script|PLURNK_|process\.env/iu);

    const callback = documents.callback().toString();
    assert.match(callback, /<title data-text="page-title">Sign in — Plurnk<\/title>/u);
    assert.match(callback, /<main id="main" data-page="callback"><article id="auth-callback"[\s\S]*Signing in…[\s\S]*Completing sign-in…/u);
    assert.doesNotMatch(callback, /<script/iu);
});

test("{§web-directory-documents} {§web-page-shell} {§web-workspace-tabs} {§web-workspace-creation} {§web-session-creation} {§web-workspace-folder} session shell escapes workspace identities, mounts bottom tab bar, and renders workspace-creation dialog shell", () => {
    const documents = new Documents(SHELL);
    for (const name of ["~/project", 'research<&>"', "42#alice"]) {
        const html = documents.session(name).toString();
        const escaped = name
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;");
        const settingsHref = `/settings/?${new URLSearchParams({ workspace: name })}`.replaceAll("&", "&amp;");
        assert.ok(html.includes(`<title data-text="page-title">${escaped} — Plurnk</title>`));
        assert.ok(html.includes(`<a id="session-workspace" href="${settingsHref}" data-bind="href:workspace-settings-path" aria-label="Workspace settings" title="Workspace settings"><span role="img" aria-label="Folderless workspace" data-bind="aria-label:workspace-icon-label" data-text="workspace-icon">☁️</span> <span data-text="workspace-name">${escaped}</span></a>`));
        assert.ok(html.includes(`<main id="main" data-page="session" data-requested-workspace="${escaped}"><p id="session-folder" data-project-label=""><span role="img" aria-label="Project folder">🗂️</span> <span data-text="project-label"></span></p></main>`));
        assert.ok(html.includes(`<nav id="workspace-tabs" aria-label="Workspace sessions" data-workspace-name="${escaped}" data-tab-count="0"><button type="button" data-action="new-session" data-tab-new aria-label="New session" title="New session">+</button><button type="button" data-open-sessions aria-label="Sessions and archives" title="Sessions and archives (Ctrl+K)">☰</button><ul></ul></nav>`));
        assert.match(html, /<dialog id="dialog-workspaces"[\s\S]*data-dialog-target="dialog-workspace-create"[^>]*>New workspace…<\/button>/u);
        assert.match(html, /<dialog id="dialog-workspace-create"[\s\S]*<form id="workspace-create" data-workspace-create-form>[\s\S]*name="useProjectFolder"[\s\S]*name="projectRoot"[\s\S]*data-project-folder-note/u);
        assert.match(html, /<dialog id="dialog-session-create"[\s\S]*<form id="session-create" data-session-create-form>[\s\S]*name="name"[\s\S]*name="title"/u);
        assert.doesNotMatch(html, /<h1\b|<script>/u);
    }
});

test("{§web-search} {§web-session-directory} search shell escapes filter parameters and mounts overview controls without server-side session scraping", () => {
    const documents = new Documents(SHELL);
    const html = documents.search({
        q: 'wal_sender & <script>"x"',
        workspace: '~/team&"ws"',
        status: "archived",
        kind: "work",
    }).toString();
    assert.match(html, /<title data-text="page-title">Search — Plurnk<\/title>/u);
    assert.match(html, /<div id="header-place"><button type="button" data-dialog-target="dialog-workspaces"[\s\S]*<span aria-current="page" data-i18n="search">Search<\/span><\/div>/u);
    assert.match(html, /<main id="main" data-page="search" data-connection="initial">/u);
    assert.match(html, /<form id="search-controls" method="get" action="\/search\/"/u);
    assert.ok(html.includes('value="wal_sender &amp; &lt;script&gt;&quot;x&quot;"'));
    assert.ok(html.includes('<input type="hidden" name="workspace" value="~/team&amp;&quot;ws&quot;" data-search-workspace>'));
    assert.ok(html.includes('<input type="hidden" name="kind" value="work" data-search-kind>'));
    assert.ok(html.includes('<option value="archived" selected>Archived</option>'));
    assert.ok(html.includes('<section id="search-workspaces" aria-label="Workspaces"></section>'));
    assert.doesNotMatch(html, /<script>|<h1\b/u);
});

test("{§web-workspace-settings} {§web-workspace-rename} {§web-workspace-archive} {§web-session-archive} settings shell renders 11 tabs including folded-in About and pure /acp forms", () => {
    const documents = new Documents(SHELL);
    const html = documents.settings({ workspace: "alpha", session: "session1" }).toString();
    assert.match(html, /<title data-text="page-title">alpha · Settings — Plurnk<\/title>/u);
    assert.match(html, /<nav id="header-place" aria-label="breadcrumb">[\s\S]*href="\/~\/alpha#session1"[\s\S]*>alpha<[\s\S]*>Settings<[\s\S]*<\/nav>/u);
    assert.match(html, /<main id="main" data-page="settings" data-workspace-name="alpha" data-session-name="session1">/u);
    for (const section of ["workspace", "session", "models", "mcp", "skills", "schedule", "personas", "members", "env", "help", "about"]) {
        assert.match(html, new RegExp(`href="#${section}" data-settings-section="${section}"`, "u"));
    }
    assert.match(html, /<form id="workspace-rename" data-workspace-rename-form>/u);
    assert.match(html, /<form id="workspace-archive" data-workspace-archive-form>/u);
    assert.match(html, /<form id="workspace-unarchive" data-workspace-unarchive-form>/u);
    assert.match(html, /<form id="session-title" data-session-title-form>/u);
    assert.match(html, /<form id="session-archive" data-session-archive-form>/u);
    assert.match(html, /<form id="session-unarchive" data-session-unarchive-form>/u);
    assert.ok(html.includes(`<dt>@plurnk/plurnk-web</dt><dd><code data-text="about-web-version">${WEB_VERSION}</code></dd>`));
    assert.ok(html.includes('<dt data-about-service-term hidden>@plurnk/plurnk-service</dt>'));
    assert.ok(html.includes('<dt data-about-desktop-term hidden>plurnk-desktop</dt>'));
    assert.ok(html.includes(`<dt data-i18n="license">License</dt><dd>${WEB_LICENSE}</dd>`));
    assert.ok(html.includes(`href="${BUG_REPORT_URL}"`));
    assert.doesNotMatch(html, /method="post"/iu, "settings mutations dispatch over /acp rather than server form POST routes");
});

test("{§web-page-shell} error shell escapes untrusted failure text and validates document slots at construction", () => {
    const documents = new Documents(SHELL);
    const error = documents.error(403, 'Rejected <script> & "details"', { recovery: "Use same-origin." }).toString();
    assert.match(error, /<title data-text="page-title">403 Forbidden — Plurnk<\/title>/u);
    assert.match(error, /<main id="main" data-page="error"><article aria-labelledby="error-title"><header><h1 id="error-title"><span aria-hidden="true">⚠️<\/span> <span data-text="error-title">403 Forbidden<\/span><\/h1><\/header><p data-text="error-message">Rejected &lt;script&gt; &amp; &quot;details&quot;<\/p><p data-text="error-recovery">Use same-origin\.<\/p><footer><a href="\/" data-i18n="home">Home<\/a><\/footer><\/article><\/main>/u);
    assert.doesNotMatch(error, /<form|<script>/u);

    for (const badHtml of [
        "<head><title>Plurnk</title></head><body><header></header><main>Home</main></body>",
        "<html><head><title>Plurnk</title></head><body><header></header></body></html>",
        "<html><head></head><body><header></header><main>Home</main></body></html>",
        "<html><head><title>Plurnk</title></head><body><main>Home</main></body></html>",
    ]) {
        assert.throws(() => new Documents(badHtml));
    }

    const withTemplates = new Documents(
        '<!doctype html><html lang="en"><head><title>Plurnk</title></head><body><header><template id="lead"><span>Lead</span></template><nav></nav><template id="tail"><a>Tab</a></template></header><main>Home</main></body></html>',
    );
    const rendered = withTemplates.home().toString();
    assert.ok(rendered.includes('<template id="lead"><span>Lead</span></template>'));
    assert.ok(rendered.includes('<template id="tail"><a>Tab</a></template>'));
});

test("{§web-brand} {§web-document} Documents stamps custom brand identity, theme stylesheet, icon, and About links with strict escaping", () => {
    const brandedShell = '<!doctype html><html lang="en"><head>'
        + '<meta name="theme-color" content="#148800">'
        + '<meta name="application-name" content="Plurnk">'
        + '<meta name="description" content="Plurnk agent workspace.">'
        + '<title data-text="page-title">Plurnk</title>'
        + '<link rel="icon" href="/icons/plurnk.svg" type="image/svg+xml" sizes="any">'
        + '<link rel="stylesheet" href="/assets/app.css">'
        + '</head><body><header><nav></nav></header><main id="main" data-page="home"></main></body></html>';
    const brand = {
        appName: 'Acme & "Co"',
        appDescription: "Acme <AI> workbench.",
        themeColor: "#0055aa",
        aboutLinks: [
            { label: "Support & Help", url: "https://support.acme.example/help?a=1&b=2" },
            { label: "Terms", url: "https://acme.example/terms" },
        ],
        themeCssFile: "/etc/acme/theme.css",
        themeCssHref: "/brand/theme.css",
        icon: { filePath: "/etc/acme/logo.png", href: "/brand/icon.png", mediaType: /** @type {const} */ ("image/png"), sizes: null },
        maskableIcon: null,
    };
    const docs = new Documents(brandedShell, { brand });
    const home = docs.home().toString();
    assert.ok(home.includes('data-app-name="Acme &amp; &quot;Co&quot;"'));
    assert.ok(home.includes('<meta name="theme-color" content="#0055aa">'));
    assert.ok(home.includes('<meta name="application-name" content="Acme &amp; &quot;Co&quot;">'));
    assert.ok(home.includes('<meta name="description" content="Acme &lt;AI&gt; workbench.">'));
    assert.ok(home.includes('<title data-text="page-title">Acme &amp; &quot;Co&quot;</title>'));
    assert.ok(home.includes('<link rel="icon" href="/brand/icon.png" type="image/png">'));
    assert.ok(home.includes('<link rel="stylesheet" href="/assets/app.css"><link rel="stylesheet" href="/brand/theme.css">'));

    const settings = docs.settings().toString();
    assert.ok(settings.includes('<title data-text="page-title">Settings — Acme &amp; &quot;Co&quot;</title>'));
    assert.ok(settings.includes('<span data-text="workspace-name">Acme &amp; &quot;Co&quot;</span>'));
    assert.ok(settings.includes('<dt>Support &amp; Help</dt><dd><a href="https://support.acme.example/help?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">support.acme.example/help?a=1&amp;b=2</a></dd>'));
    assert.ok(settings.includes('<dt>Terms</dt><dd><a href="https://acme.example/terms" target="_blank" rel="noopener noreferrer">acme.example/terms</a></dd>'));
    assert.doesNotMatch(settings, /github\.com\/plurnk\/plurnk-service\/issues/u);
    assert.ok(settings.includes(`<dt data-i18n="license">License</dt><dd>${WEB_LICENSE}</dd>`));

    const noLinks = new Documents(brandedShell, { brand: { ...brand, aboutLinks: [] } }).settings().toString();
    assert.doesNotMatch(noLinks, /Support &amp; Help|github\.com\/plurnk/u);
});
