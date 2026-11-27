import assert from "node:assert/strict";
import { test } from "node:test";
import Documents, { BUG_REPORT_URL, WEB_LICENSE, WEB_VERSION } from "../src/documents.js";

const SHELL = '<!doctype html><html lang="en"><head><title data-text="page-title">Plurnk</title></head><body><header><a href="/settings/search" data-nav="search" data-bind="href:search-settings-path">Search</a><nav aria-label="Main navigation"><ul></ul></nav></header><main id="main" data-page="home">Home</main></body></html>';

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

test("{§web-directory-documents} {§web-page-shell} {§web-workspace-tabs} {§web-session-creation} {§web-workspace-folder} session shell escapes workspace identities, renders broad-to-narrow top bar, and links + to /settings/sessions?new=1", () => {
    const documents = new Documents(SHELL);
    for (const name of ["~/project", 'research<&>"', "42#alice"]) {
        const html = documents.session(name).toString();
        const escaped = name
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;");
        const workspacesHref = `/settings/workspaces?${new URLSearchParams({ workspace: name })}`.replaceAll("&", "&amp;");
        const sessionsHref = `/settings/sessions?${new URLSearchParams({ workspace: name })}`.replaceAll("&", "&amp;");
        const newSessionHref = `/settings/sessions?${new URLSearchParams({ workspace: name, new: "1" })}`.replaceAll("&", "&amp;");
        const modelsHref = `/settings/models?${new URLSearchParams({ workspace: name })}`.replaceAll("&", "&amp;");
        assert.ok(html.includes(`<title data-text="page-title">${escaped} — Plurnk</title>`));
        assert.ok(html.includes(`<a id="session-workspace" href="${workspacesHref}" data-bind="href:workspace-settings-path" aria-label="Workspaces" title="Workspaces">`));
        assert.ok(html.includes(`<a id="header-session" href="${sessionsHref}" data-bind="href:header-session-settings-path" aria-label="Sessions" title="Sessions" hidden>`));
        assert.ok(html.includes(`<a id="header-model" href="${modelsHref}" data-bind="href:header-models-settings-path title:header-model-label" aria-label="Models" title="Models" hidden>`));
        assert.ok(html.includes(`<main id="main" data-page="session" data-requested-workspace="${escaped}"><p id="session-folder" data-project-label=""><span role="img" aria-label="Project folder">🗂️</span> <span data-text="project-label"></span></p></main>`));
        assert.ok(html.includes(`<nav id="workspace-tabs" aria-label="Workspace sessions" data-workspace-name="${escaped}" data-tab-count="0"><a href="${newSessionHref}" data-tab-new data-bind="href:new-session-path" aria-label="New session" title="New session (Alt+N)">+</a><ul></ul></nav>`));
        assert.doesNotMatch(html, /<dialog\b|<h1\b|<script>/u);
    }
});

test("{§web-search} {§web-session-directory} /settings/search escapes filter parameters and preserves active context without server-side session scraping", () => {
    const documents = new Documents(SHELL);
    const html = documents.settings("search", {
        workspace: "alpha",
        session: "session1",
        q: 'wal_sender & <script>"x"',
        filterWorkspace: '~/team&"ws"',
        status: "archived",
        kind: "work",
    }).toString();
    assert.match(html, /<title data-text="page-title">alpha · Search — Plurnk<\/title>/u);
    assert.match(html, /<a href="\/~\/alpha#session1" data-settings-back/u);
    assert.match(html, /<main id="main" data-page="settings" data-settings-section="search" data-workspace-name="alpha" data-session-name="session1" data-connection="initial">/u);
    assert.match(html, /<form id="search-controls" method="get" action="\/settings\/search"/u);
    assert.ok(html.includes('value="wal_sender &amp; &lt;script&gt;&quot;x&quot;"'));
    assert.ok(html.includes('<input type="hidden" name="filterWorkspace" value="~/team&amp;&quot;ws&quot;" data-search-workspace>'));
    assert.ok(html.includes('<input type="hidden" name="kind" value="work" data-search-kind>'));
    assert.ok(html.includes('<option value="archived" selected>Archived</option>'));
    assert.ok(html.includes('<section id="search-workspaces" aria-label="Workspaces"></section>'));
    assert.doesNotMatch(html, /<script>/u);
});

test("{§web-workspace-settings} {§web-workspace-creation} {§web-workspace-rename} {§web-workspace-archive} {§web-session-creation} {§web-session-archive} path-based settings sections render 12 tabs and only the active panel", () => {
    const documents = new Documents(SHELL);
    const wsHtml = documents.settings("workspaces", { workspace: "alpha", session: "session1" }).toString();
    assert.match(wsHtml, /<title data-text="page-title">alpha · Workspaces — Plurnk<\/title>/u);
    assert.match(wsHtml, /<h1 id="workspace-settings-title"><span aria-hidden="true">🐹<\/span> <span>Plurnk<\/span><\/h1>/u);
    assert.match(wsHtml, /<aside data-settings-feedback data-feedback-level="idle" role="status" aria-live="polite" hidden>/u);
    assert.match(wsHtml, /<a href="\/~\/alpha#session1" data-settings-back/u);
    assert.match(wsHtml, /<main id="main" data-page="settings" data-settings-section="workspaces" data-workspace-name="alpha" data-session-name="session1">/u);
    for (const section of ["search", "workspaces", "sessions", "models", "mcp", "skills", "schedule", "personas", "members", "env", "help", "about"]) {
        assert.match(wsHtml, new RegExp(`href="/settings/${section}\\?workspace=alpha&amp;session=session1" data-settings-section="${section}"`, "u"));
    }
    assert.match(wsHtml, /data-settings-section="workspaces" aria-current="page"/u);
    assert.match(wsHtml, /<form id="workspace-create" data-workspace-create-form>/u);
    assert.match(wsHtml, /<form id="workspace-rename" data-workspace-rename-form>/u);
    assert.match(wsHtml, /<form id="workspace-archive" data-workspace-archive-form>/u);
    assert.match(wsHtml, /<form id="workspace-unarchive" data-workspace-unarchive-form>/u);
    assert.doesNotMatch(wsHtml, /data-settings-panel="sessions"|data-settings-panel="about"/u);
    assert.doesNotMatch(wsHtml, /method="post"/iu);

    const sessHtml = documents.settings("sessions", { workspace: "alpha", session: "session1", openCreate: true }).toString();
    assert.match(sessHtml, /<details data-family-disclosure="sessions" data-settings-add-session open>/u);
    assert.match(sessHtml, /<form id="session-create" data-session-create-form>/u);
    assert.match(sessHtml, /<form id="session-title" data-session-title-form>/u);
    assert.match(sessHtml, /<form id="session-archive" data-session-archive-form>/u);
    assert.match(sessHtml, /<form id="session-unarchive" data-session-unarchive-form>/u);

    const aboutHtml = documents.settings("about", { workspace: "alpha", session: "session1" }).toString();
    assert.ok(aboutHtml.includes(`<dt>@plurnk/plurnk-web</dt><dd><code data-text="about-web-version">${WEB_VERSION}</code></dd>`));
    assert.ok(aboutHtml.includes('<dt data-about-service-term hidden>@plurnk/plurnk-service</dt>'));
    assert.ok(aboutHtml.includes('<dt data-about-desktop-term hidden>plurnk-desktop</dt>'));
    assert.ok(aboutHtml.includes(`<dt data-i18n="license">License</dt><dd>${WEB_LICENSE}</dd>`));
    assert.ok(aboutHtml.includes(`href="${BUG_REPORT_URL}"`));

    assert.throws(() => documents.settings("unknown"), /Unknown settings section/u);
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
        settingsTabs: [],
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

    const settings = docs.settings("about").toString();
    assert.ok(settings.includes('<title data-text="page-title">About — Acme &amp; &quot;Co&quot;</title>'));
    assert.ok(settings.includes('<h1 id="workspace-settings-title"><img src="/brand/icon.png" alt="" aria-hidden="true"> <span>Acme &amp; &quot;Co&quot;</span></h1>'));
    assert.ok(settings.includes('<span data-text="workspace-name">Acme &amp; &quot;Co&quot;</span>'));
    assert.ok(settings.includes('<dt>Support &amp; Help</dt><dd><a href="https://support.acme.example/help?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">support.acme.example/help?a=1&amp;b=2</a></dd>'));
    assert.ok(settings.includes('<dt>Terms</dt><dd><a href="https://acme.example/terms" target="_blank" rel="noopener noreferrer">acme.example/terms</a></dd>'));
    assert.doesNotMatch(settings, /github\.com\/plurnk\/plurnk-service\/issues/u);
    assert.ok(settings.includes(`<dt data-i18n="license">License</dt><dd>${WEB_LICENSE}</dd>`));

    const noLinks = new Documents(brandedShell, { brand: { ...brand, aboutLinks: [] } }).settings("about").toString();
    assert.doesNotMatch(noLinks, /Support &amp; Help|github\.com\/plurnk/u);
});

test("{§web-settings-extensions} {§web-workspace-settings} {§web-document} Documents inserts host Settings tabs before Help/About and loads each extension script only on its own /settings/<id> page", () => {
    const docs = new Documents(SHELL, {
        settingsTabs: [
            {
                id: "account",
                label: 'Account & "Keys"',
                html: '<header data-panel-toolbar><h2>Account</h2></header><p data-account-status>Ready</p>',
                scriptHref: "/brand/tabs/account.js",
            },
            {
                id: "billing",
                label: "Billing",
                html: "<p>Free tier.</p>",
                scriptHref: null,
            },
        ],
    });

    const accountHtml = docs.settings("account", { workspace: "alpha" }).toString();
    const navMatch = /<ul data-settings-nav>[\s\S]*?<\/ul>/u.exec(accountHtml);
    assert.ok(navMatch, "settings nav list is rendered");
    const navHtml = navMatch[0];
    const envPos = navHtml.indexOf('data-settings-section="env"');
    const accountPos = navHtml.indexOf('data-settings-section="account"');
    const billingPos = navHtml.indexOf('data-settings-section="billing"');
    const helpPos = navHtml.indexOf('data-settings-section="help"');
    const aboutPos = navHtml.indexOf('data-settings-section="about"');
    assert.ok(envPos > 0 && accountPos > envPos && billingPos > accountPos && helpPos > billingPos && aboutPos > helpPos,
        "extension nav links appear in declaration order immediately before Help and About");
    assert.ok(accountHtml.includes('<li><a href="/settings/account?workspace=alpha" data-settings-section="account" data-settings-extension="true" aria-current="page">Account &amp; &quot;Keys&quot;</a></li>'));
    assert.ok(accountHtml.includes('<li><a href="/settings/billing?workspace=alpha" data-settings-section="billing" data-settings-extension="true">Billing</a></li>'));
    assert.ok(accountHtml.includes('<section id="account" data-settings-panel="account" data-settings-extension="true" aria-label="Account &amp; &quot;Keys&quot;"><header data-panel-toolbar><h2>Account</h2></header><p data-account-status>Ready</p></section>'));
    assert.ok(accountHtml.includes('<script type="module" src="/brand/tabs/account.js"></script></head>'));
    assert.doesNotMatch(accountHtml, /data-settings-panel="billing"|\/brand\/tabs\/billing\.js/u);

    const billingHtml = docs.settings("billing", { workspace: "alpha" }).toString();
    assert.ok(billingHtml.includes('<section id="billing" data-settings-panel="billing" data-settings-extension="true" aria-label="Billing"><p>Free tier.</p></section>'));
    assert.doesNotMatch(billingHtml, /\/brand\/tabs\/account\.js/u);

    const searchHtml = docs.settings("search").toString();
    assert.doesNotMatch(searchHtml, /\/brand\/tabs\/account\.js/u, "other settings pages do not load extension scripts");

    for (const nonSettings of [
        docs.home().toString(),
        docs.session("alpha").toString(),
        docs.callback().toString(),
        docs.error(404, "Missing").toString(),
    ]) {
        assert.doesNotMatch(nonSettings, /\/brand\/tabs\/|data-settings-extension/u, "extension markup and scripts are emitted only on /settings/<section>");
    }
});

test("{§web-bff-auth} {§web-document} Documents stamps optional BFF auth data-* attributes only when configured", () => {
    const defaultHtml = new Documents(SHELL).home().toString();
    assert.doesNotMatch(defaultHtml, /data-auth-login-url|data-auth-logout-url|data-auth-logout-method/u);

    const bffDocs = new Documents(SHELL, {
        auth: {
            loginUrl: "/oauth2/start?rd={returnTo}&prompt=login",
            logoutUrl: "/auth/logout",
            logoutMethod: "POST",
        },
    });
    const html = bffDocs.home().toString();
    assert.ok(html.includes('data-auth-login-url="/oauth2/start?rd={returnTo}&amp;prompt=login"'));
    assert.ok(html.includes('data-auth-logout-url="/auth/logout"'));
    assert.ok(html.includes('data-auth-logout-method="POST"'));

    const getLogoutHtml = new Documents(SHELL, {
        auth: {
            loginUrl: null,
            logoutUrl: "/oauth2/sign_out",
            logoutMethod: "GET",
        },
    }).settings("search").toString();
    assert.doesNotMatch(getLogoutHtml, /data-auth-login-url/u);
    assert.ok(getLogoutHtml.includes('data-auth-logout-url="/oauth2/sign_out"'));
    assert.ok(getLogoutHtml.includes('data-auth-logout-method="GET"'));
});
