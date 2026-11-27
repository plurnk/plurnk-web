import { readFileSync } from "node:fs";
import { STATUS_CODES } from "node:http";
import {
    BUG_REPORT_URL,
    BUILTIN_SETTINGS_SECTIONS,
    DEFAULT_APP_NAME,
    DEFAULT_BRAND,
    DEFAULT_ICON_HREF,
} from "./brand.js";
import { directoryPath, settingsPath } from "./directory-addresses.js";
import { DEFAULT_ACP_URL, DEFAULT_AUTH_CONFIG, escapeHtml } from "./http.js";

const WEB_MANIFEST = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const WEB_VERSION = typeof WEB_MANIFEST.version === "string" && WEB_MANIFEST.version.length > 0 ? WEB_MANIFEST.version : "4.1.0";
export const WEB_LICENSE = typeof WEB_MANIFEST.license === "string" && WEB_MANIFEST.license.length > 0 ? WEB_MANIFEST.license : "MIT";
export { BUG_REPORT_URL };

/** @type {Readonly<Record<string, { readonly label: string, readonly i18n: string }>>} */
const BUILTIN_SECTION_META = Object.freeze({
    search: { label: "Search", i18n: "search" },
    workspaces: { label: "Workspaces", i18n: "workspaces" },
    sessions: { label: "Sessions", i18n: "sessions" },
    models: { label: "Models", i18n: "ws-settings-tab-models" },
    mcp: { label: "MCP", i18n: "ws-settings-tab-mcp" },
    skills: { label: "Skills", i18n: "ws-settings-tab-skills" },
    schedule: { label: "Schedule", i18n: "ws-settings-tab-schedule" },
    personas: { label: "Personas", i18n: "ws-settings-tab-personas" },
    members: { label: "Members", i18n: "ws-settings-tab-members" },
    env: { label: "Environment", i18n: "ws-settings-tab-env" },
    help: { label: "Help", i18n: "ws-settings-tab-help" },
    about: { label: "About", i18n: "about" },
});

/** @typedef {"htmlAttrs" | "themeColor" | "appName" | "description" | "title" | "icon" | "themeStylesheet" | "pageScripts" | "headerLead" | "main" | "afterMain"} DocumentSlotName */
/** @typedef {{ readonly literal: string } | { readonly slot: DocumentSlotName }} DocumentToken */

/**
 * @param {string} source
 * @param {RegExp} pattern
 */
function locateOptionalTag(source, pattern) {
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1) return null;
    const [match] = matches;
    return { start: match.index, end: match.index + match[0].length };
}

/**
 * @param {string} source
 * @param {RegExp} openPattern
 * @param {RegExp} closePattern
 * @param {string} message
 */
function locatePairedElement(source, openPattern, closePattern, message) {
    const opens = [...source.matchAll(openPattern)];
    const closes = [...source.matchAll(closePattern)];
    if (opens.length !== 1 || closes.length !== 1) throw new Error(message);
    const [open] = opens;
    const [close] = closes;
    const openEnd = open.index + open[0].length;
    if (openEnd > close.index) throw new Error(message);
    return {
        start: open.index,
        end: close.index + close[0].length,
        inner: source.slice(openEnd, close.index),
    };
}

/** @param {string} document */
function compileDocumentSlots(document) {
    const outsideTemplates = document.replace(/<template\b[^>]*>[\s\S]*?<\/template>/gu, (match) => " ".repeat(match.length));
    const htmlMatches = [...outsideTemplates.matchAll(/<html\b[^>]*>/gu)];
    if (htmlMatches.length !== 1) {
        throw new Error("The web document must contain exactly one html root element.");
    }
    const htmlOpen = htmlMatches[0];
    const htmlAttrsIndex = htmlOpen.index + htmlOpen[0].length - 1;

    const main = locatePairedElement(
        outsideTemplates,
        /<main\b[^>]*>/gu,
        /<\/main>/gu,
        "The web document must contain exactly one main element.",
    );
    const mainInner = document.slice(
        main.start + (/<main\b[^>]*>/u.exec(document.slice(main.start))?.[0].length ?? 0),
        main.end - "</main>".length,
    );
    const beforeMain = outsideTemplates.slice(0, main.start);
    const title = locatePairedElement(
        beforeMain,
        /<title\b[^>]*>/gu,
        /<\/title>/gu,
        "The web document must contain exactly one title element before main.",
    );
    const header = locatePairedElement(
        beforeMain,
        /<header\b[^>]*>/gu,
        /<\/header>/gu,
        "The web document must contain exactly one header element before main.",
    );
    const headerOpenLen = /<header\b[^>]*>/u.exec(beforeMain.slice(header.start))?.[0].length ?? 0;
    const headerInner = beforeMain.slice(header.start + headerOpenLen, header.end - "</header>".length);
    const mainNavMatch = /<nav\b[^>]*>/u.exec(headerInner);
    const headerLeadIndex = mainNavMatch
        ? header.start + headerOpenLen + mainNavMatch.index
        : header.end - "</header>".length;

    const headCloseMatch = /<\/head>/u.exec(beforeMain);
    const headSection = headCloseMatch ? beforeMain.slice(0, headCloseMatch.index) : beforeMain;
    const themeColorSpan = locateOptionalTag(headSection, /<meta\b[^>]*\bname="theme-color"[^>]*>/gu);
    const appNameSpan = locateOptionalTag(headSection, /<meta\b[^>]*\bname="application-name"[^>]*>/gu);
    const descriptionSpan = locateOptionalTag(headSection, /<meta\b[^>]*\bname="description"[^>]*>/gu);
    const iconSpan = locateOptionalTag(headSection, /<link\b[^>]*\brel="icon"[^>]*>/gu);
    const stylesheetSpan = locateOptionalTag(headSection, /<link\b(?=[^>]*\brel="stylesheet")[^>]*>/gu);
    const themeStylesheetIndex = stylesheetSpan !== null
        ? stylesheetSpan.end
        : headCloseMatch !== null
            ? headCloseMatch.index
            : null;
    const pageScriptsIndex = headCloseMatch !== null ? headCloseMatch.index : null;

    /** @type {readonly { readonly name: DocumentSlotName, readonly start: number, readonly end: number }[]} */
    const spans = [
        { name: /** @type {const} */ ("htmlAttrs"), start: htmlAttrsIndex, end: htmlAttrsIndex },
        ...(themeColorSpan ? [{ name: /** @type {const} */ ("themeColor"), ...themeColorSpan }] : []),
        ...(appNameSpan ? [{ name: /** @type {const} */ ("appName"), ...appNameSpan }] : []),
        ...(descriptionSpan ? [{ name: /** @type {const} */ ("description"), ...descriptionSpan }] : []),
        { name: /** @type {const} */ ("title"), start: title.start, end: title.end },
        ...(iconSpan ? [{ name: /** @type {const} */ ("icon"), ...iconSpan }] : []),
        ...(themeStylesheetIndex !== null ? [{ name: /** @type {const} */ ("themeStylesheet"), start: themeStylesheetIndex, end: themeStylesheetIndex }] : []),
        ...(pageScriptsIndex !== null ? [{ name: /** @type {const} */ ("pageScripts"), start: pageScriptsIndex, end: pageScriptsIndex }] : []),
        { name: /** @type {const} */ ("headerLead"), start: headerLeadIndex, end: headerLeadIndex },
        { name: /** @type {const} */ ("main"), start: main.start, end: main.end },
        { name: /** @type {const} */ ("afterMain"), start: main.end, end: main.end },
    ].toSorted((a, b) => a.start - b.start || a.end - b.end);

    /** @type {DocumentToken[]} */
    const tokens = [];
    let cursor = 0;
    for (const span of spans) {
        if (span.start < cursor) throw new Error(`Document slot ${span.name} overlaps an earlier slot.`);
        if (span.start > cursor) tokens.push({ literal: document.slice(cursor, span.start) });
        tokens.push({ slot: span.name });
        cursor = span.end;
    }
    if (cursor < document.length) tokens.push({ literal: document.slice(cursor) });

    return Object.freeze({
        home: mainInner,
        /** @param {Readonly<Record<DocumentSlotName, string>>} values */
        render(values) {
            let html = "";
            for (const token of tokens) {
                html += "literal" in token ? token.literal : values[token.slot];
            }
            return html;
        },
    });
}

/**
 * @typedef {{
 *   readonly acpUrl?: string | null,
 *   readonly overviewSessions?: number | null,
 *   readonly overviewExcerptChars?: number | null,
 *   readonly brand?: import("./brand.js").BrandConfig,
 *   readonly settingsTabs?: readonly import("./brand.js").LoadedSettingsTab[],
 *   readonly auth?: import("./http.js").AuthConfig,
 * }} DocumentBootOptions
 */

/** {§web-document} {§web-directory-documents} {§web-page-shell} {§web-brand} {§web-settings-extensions} {§web-bff-auth} Static HTML shell compiler stamping boot data attributes without daemon seams or inline scripts. */
export default class Documents {
    #template;
    #acpUrl;
    #overviewSessions;
    #overviewExcerptChars;
    #brand;
    #settingsTabs;
    #settingsSections;
    #auth;

    /** {§web-assets} Read the stylesheet declaration from our compiled head, not unrelated lazy assets.
     * @param {string} document
     */
    static stylesheet(document) {
        const links = [...document.split("</head>")[0].matchAll(/<link\b(?=[^>]*\brel="stylesheet")[^>]*>/gu)];
        if (links.length !== 1) throw new Error("The web document must declare exactly one application stylesheet.");
        const path = /\bhref="(\/[^"]+)"/u.exec(links[0][0])?.[1];
        if (!path || path.startsWith("//")) throw new Error("The application stylesheet must have an origin-relative path.");
        return path;
    }

    /**
     * @param {string} document
     * @param {DocumentBootOptions} [options]
     */
    constructor(document, {
        acpUrl = DEFAULT_ACP_URL,
        overviewSessions = 200,
        overviewExcerptChars = 160,
        brand = DEFAULT_BRAND,
        settingsTabs = [],
        auth = DEFAULT_AUTH_CONFIG,
    } = {}) {
        this.#acpUrl = acpUrl;
        this.#overviewSessions = overviewSessions;
        this.#overviewExcerptChars = overviewExcerptChars;
        this.#brand = brand;
        this.#settingsTabs = settingsTabs;
        this.#settingsSections = new Set([...BUILTIN_SETTINGS_SECTIONS, ...settingsTabs.map(({ id }) => id)]);
        this.#auth = auth;
        this.#template = compileDocumentSlots(document);
    }

    /** @returns {ReadonlySet<string>} */
    get settingsSections() {
        return this.#settingsSections;
    }

    #htmlBootAttributes() {
        const acpAttr = this.#acpUrl === null ? "invalid" : this.#acpUrl;
        const sessionsAttr = this.#overviewSessions === null ? "invalid" : String(this.#overviewSessions);
        const excerptAttr = this.#overviewExcerptChars === null ? "invalid" : String(this.#overviewExcerptChars);
        return ` data-acp-url="${escapeHtml(acpAttr)}"`
            + ` data-app-name="${escapeHtml(this.#brand.appName)}"`
            + ` data-overview-sessions="${escapeHtml(sessionsAttr)}"`
            + ` data-overview-excerpt-chars="${escapeHtml(excerptAttr)}"`
            + ` data-web-version="${escapeHtml(WEB_VERSION)}"`
            + (this.#auth.loginUrl !== null ? ` data-auth-login-url="${escapeHtml(this.#auth.loginUrl)}"` : "")
            + (this.#auth.logoutUrl !== null
                ? ` data-auth-logout-url="${escapeHtml(this.#auth.logoutUrl)}" data-auth-logout-method="${escapeHtml(this.#auth.logoutMethod)}"`
                : "");
    }

    #iconLinkTag() {
        const href = this.#brand.icon?.href ?? DEFAULT_ICON_HREF;
        const mediaType = this.#brand.icon?.mediaType ?? "image/svg+xml";
        const sizesAttr = (this.#brand.icon ? this.#brand.icon.sizes : "any") === "any" ? ' sizes="any"' : "";
        return `<link rel="icon" href="${escapeHtml(href)}" type="${escapeHtml(mediaType)}"${sizesAttr}>`;
    }

    /**
     * @param {string} title
     * @param {string} body
     * @param {"home" | "session" | "settings" | "callback" | "error"} kind
     * @param {{ headerLead?: string, footer?: string, mainAttributes?: string, pageScripts?: string }} [slots]
     */
    #render(title, body, kind, { headerLead = "", footer = "", mainAttributes = "", pageScripts = "" } = {}) {
        const label = kind === "home" ? title : `${title} — ${this.#brand.appName}`;
        const themeStylesheet = this.#brand.themeCssHref !== null
            ? `<link rel="stylesheet" href="${escapeHtml(this.#brand.themeCssHref)}">`
            : "";
        return Buffer.from(this.#template.render({
            htmlAttrs: this.#htmlBootAttributes(),
            themeColor: `<meta name="theme-color" content="${escapeHtml(this.#brand.themeColor)}">`,
            appName: `<meta name="application-name" content="${escapeHtml(this.#brand.appName)}">`,
            description: `<meta name="description" content="${escapeHtml(this.#brand.appDescription)}">`,
            title: `<title data-text="page-title">${escapeHtml(label)}</title>`,
            icon: this.#iconLinkTag(),
            themeStylesheet,
            pageScripts,
            headerLead,
            main: `<main id="main" data-page="${kind}"${mainAttributes}>${body}</main>`,
            afterMain: footer,
        }));
    }

    /** {§web-arrival} Static arrival shell (`/` and `/index.html`). */
    home() {
        return this.#render(this.#brand.appName, this.#template.home, "home");
    }

    /** {§web-oidc} Static OIDC PKCE callback shell (`/auth/callback`). */
    callback() {
        const body = '<article id="auth-callback" aria-labelledby="auth-callback-title">'
            + '<header><h1 id="auth-callback-title" data-text="callback-title">Signing in…</h1></header>'
            + '<p role="status" data-text="callback-message">Completing sign-in…</p>'
            + '<footer data-callback-footer hidden><a href="/" data-i18n="home">Home</a></footer>'
            + "</article>";
        return this.#render("Sign in", body, "callback");
    }

    /**
     * {§web-directory-documents} {§web-workspace-tabs} {§web-page-shell} Static session workbench shell (`GET /~/<workspace>`).
     * @param {string} workspaceName
     */
    session(workspaceName) {
        const marker = '<span data-header-glyph role="img" aria-label="Folderless workspace" data-bind="aria-label:workspace-icon-label" data-text="workspace-icon">☁️</span>';
        const workspacesHref = settingsPath("workspaces", { workspace: workspaceName }) ?? "/settings/workspaces";
        const sessionsHref = settingsPath("sessions", { workspace: workspaceName }) ?? "/settings/sessions";
        const newSessionHref = settingsPath("sessions", { workspace: workspaceName, extra: { new: "1" } }) ?? "/settings/sessions?new=1";
        const modelsHref = settingsPath("models", { workspace: workspaceName }) ?? "/settings/models";

        const workspaceLink = `<a id="session-workspace" href="${escapeHtml(workspacesHref)}" data-bind="href:workspace-settings-path" aria-label="Workspaces" title="Workspaces">${marker} <span data-text="workspace-name">${escapeHtml(workspaceName)}</span></a>`;
        const sessionLink = `<a id="header-session" href="${escapeHtml(sessionsHref)}" data-bind="href:header-session-settings-path" aria-label="Sessions" title="Sessions" hidden><span data-header-glyph aria-hidden="true" data-text="header-session-icon">💬</span> <span data-header-session-label>#<span data-text="header-session-name"></span></span></a>`;
        const modelLink = `<a id="header-model" href="${escapeHtml(modelsHref)}" data-bind="href:header-models-settings-path title:header-model-label" aria-label="Models" title="Models" hidden><span data-header-glyph aria-hidden="true">🤖</span> <span data-text="header-model">No model</span> <span data-text="header-effort"></span></a>`;
        const headerLead = `<div id="header-place">${workspaceLink}${sessionLink}${modelLink}</div>`;
        const body = '<p id="session-folder" data-project-label=""><span role="img" aria-label="Project folder">🗂️</span> <span data-text="project-label"></span></p>';
        const tabs = `<nav id="workspace-tabs" aria-label="Workspace sessions" data-workspace-name="${escapeHtml(workspaceName)}" data-tab-count="0">`
            + `<a href="${escapeHtml(newSessionHref)}" data-tab-new data-bind="href:new-session-path" aria-label="New session" title="New session (Alt+N)">+</a>`
            + "<ul></ul></nav>";
        return this.#render(workspaceName, body, "session", {
            headerLead,
            footer: tabs,
            mainAttributes: ` data-requested-workspace="${escapeHtml(workspaceName)}"`,
        });
    }

    /**
     * {§web-search} Render the Search tab panel (`/settings/search`).
     * @param {{ readonly workspace: string, readonly session: string, readonly q?: string, readonly status?: string, readonly kind?: string, readonly filterWorkspace?: string }} query
     */
    #searchPanel({ workspace, session, q = "", status = "all", kind = "all", filterWorkspace = "" }) {
        const trimmedQ = q.trim();
        const trimmedFilterWs = filterWorkspace.trim();
        const statusFilter = ["all", "active", "gated", "failed", "archived"].includes(status) ? status : "all";
        const kindFilter = ["all", "root", "work"].includes(kind) ? kind : "all";
        const statusOption = (/** @type {string} */ val, /** @type {string} */ label) =>
            `<option value="${val}"${statusFilter === val ? " selected" : ""}>${label}</option>`;
        return '<section id="search" data-settings-panel="search" aria-label="Search">'
            + '<header data-panel-toolbar><h2 data-i18n="search">Search</h2></header>'
            + '<form id="search-controls" method="get" action="/settings/search" aria-label="Search workspaces and sessions">'
            + (workspace ? `<input type="hidden" name="workspace" value="${escapeHtml(workspace)}" data-bind="value:workspace-name">` : "")
            + (workspace && session ? `<input type="hidden" name="session" value="${escapeHtml(session)}" data-bind="value:active-session-name">` : "")
            + `<input type="search" name="q" list="search-suggestions" data-overview-search value="${escapeHtml(trimmedQ)}" placeholder="Search workspaces and sessions…" aria-label="Search workspaces and sessions" autocomplete="off">`
            + '<datalist id="search-suggestions"></datalist>'
            + (trimmedFilterWs ? `<input type="hidden" name="filterWorkspace" value="${escapeHtml(trimmedFilterWs)}" data-search-workspace>` : "")
            + (kindFilter !== "all" ? `<input type="hidden" name="kind" value="${escapeHtml(kindFilter)}" data-search-kind>` : "")
            + `<select name="status" data-overview-scope aria-label="Status filter">${statusOption("all", "All statuses")}${statusOption("active", "Active")}${statusOption("gated", "Needs input")}${statusOption("failed", "Failed")}${statusOption("archived", "Archived")}</select>`
            + '<button type="submit" data-search-submit data-i18n="filter">Filter</button>'
            + "</form>"
            + '<section id="search-workspaces" aria-label="Workspaces"></section>'
            + "</section>";
    }

    /**
     * {§web-workspace-settings} {§web-workspace-creation} {§web-workspace-rename} {§web-workspace-archive}
     * Render the Workspaces tab panel (`/settings/workspaces`).
     * @param {string} workspaceName
     * @param {string} sessionName
     * @param {boolean} openCreate
     */
    #workspacesPanel(workspaceName, sessionName, openCreate) {
        const projectControls = '<label data-project-folder-toggle><input type="checkbox" name="useProjectFolder" value="1" data-toggle-project-folder> <span data-i18n="project-folder">Project folder</span></label>'
            + '<input type="text" name="projectRoot" value="" placeholder="/path/to/project" aria-label="Project path" data-project-folder-input>'
            + '<small data-project-folder-note hidden></small>';
        const createDisclosure = `<details data-family-disclosure="workspaces"${openCreate ? " open" : ""}>`
            + '<summary data-i18n="ws-settings-add-workspace">+ New workspace</summary>'
            + '<form id="workspace-create" data-workspace-create-form>'
            + '<fieldset data-bind="disabled:ws-settings-busy">'
            + '<input type="text" name="name" value="" placeholder="Workspace name (optional)" aria-label="Workspace name" autocomplete="off" spellcheck="false">'
            + projectControls
            + '<footer><button type="submit" data-i18n="create-workspace">Create workspace</button></footer>'
            + "</fieldset></form></details>";
        const activeCard = `<section data-active-workspace-card aria-label="Current workspace"${workspaceName ? "" : " hidden"}>`
            + '<h3 data-i18n="current-workspace">Current workspace</h3>'
            + '<p data-settings-folder hidden><span role="img" aria-label="Project folder">🗂️</span> <code data-text="project-label"></code></p>'
            + '<form id="workspace-rename" data-workspace-rename-form>'
            + `<input type="hidden" name="workspace" value="${escapeHtml(workspaceName)}" data-bind="value:workspace-name">`
            + `<input type="hidden" name="session" value="${escapeHtml(sessionName)}" data-bind="value:active-session-name">`
            + `<input type="text" name="name" value="${escapeHtml(workspaceName)}" placeholder="Workspace name" aria-label="Rename workspace" required>`
            + '<footer><button type="submit" form="workspace-archive" data-workspace-archive-btn data-i18n="archive">Archive</button><button type="submit" form="workspace-unarchive" data-workspace-unarchive-btn hidden data-i18n="unarchive">Unarchive</button><button type="submit" data-i18n="rename">Rename</button></footer>'
            + "</form>"
            + '<form id="workspace-archive" data-workspace-archive-form>'
            + `<input type="hidden" name="workspace" value="${escapeHtml(workspaceName)}" data-bind="value:workspace-name">`
            + "</form>"
            + '<form id="workspace-unarchive" data-workspace-unarchive-form>'
            + `<input type="hidden" name="workspace" value="${escapeHtml(workspaceName)}" data-bind="value:workspace-name">`
            + "</form>"
            + "</section>";
        const collection = '<div data-collection-bar-outlet></div>'
            + '<p data-workspaces-empty data-i18n="no-workspaces">No matching workspaces.</p>'
            + '<figure data-workspaces-table-wrap>'
            + '<table><thead><tr>'
            + '<th scope="col" data-i18n="ws-settings-col-workspace">Workspace</th>'
            + '<th scope="col" data-i18n="ws-settings-col-folder">Folder</th>'
            + '<th scope="col" data-i18n="ws-settings-col-state">State</th>'
            + '<th scope="col" data-i18n="ws-settings-col-actions">Actions</th>'
            + '</tr></thead><tbody data-workspaces-rows></tbody></table></figure>';
        return '<section id="workspaces" data-settings-panel="workspaces" aria-label="Workspaces" data-collection-count="0">'
            + '<header data-panel-toolbar><h2 data-i18n="workspaces">Workspaces</h2></header>'
            + createDisclosure
            + activeCard
            + collection
            + "</section>";
    }

    /**
     * {§web-workspace-settings} {§web-session-creation} {§web-session-archive}
     * Render the Sessions tab panel (`/settings/sessions`).
     * @param {string} workspaceName
     * @param {string} sessionName
     * @param {boolean} openCreate
     */
    #sessionsPanel(workspaceName, sessionName, openCreate) {
        const createDisclosure = `<details data-family-disclosure="sessions" data-settings-add-session${openCreate ? " open" : ""}>`
            + '<summary data-i18n="ws-settings-add-session">+ New session</summary>'
            + '<form id="session-create" data-session-create-form>'
            + '<fieldset data-bind="disabled:ws-settings-busy">'
            + `<input type="hidden" name="workspace" value="${escapeHtml(workspaceName)}" data-bind="value:workspace-name">`
            + '<input type="text" name="name" value="" placeholder="Session name (optional)" aria-label="Session name" autocomplete="off" spellcheck="false">'
            + '<input type="text" name="title" value="" placeholder="Session title (optional)" aria-label="Session title" autocomplete="off">'
            + '<footer><button type="submit" data-i18n="create-session">Create session</button></footer>'
            + "</fieldset></form></details>";
        const activeCard = '<section data-active-session-card aria-label="Current session">'
            + `<h3 data-session-panel-heading><span data-i18n="current-session">Current session</span><span data-session-heading-handle${sessionName ? "" : " hidden"}> · <code data-text="session-heading-code">#${escapeHtml(sessionName)}</code></span></h3>`
            + '<p data-session-parent-line hidden><span data-i18n="parent-session">Parent:</span> <span data-session-parent-slot></span></p>'
            + `<form id="session-title" data-session-title-form${sessionName ? "" : " hidden"}>`
            + `<input type="hidden" name="workspace" value="${escapeHtml(workspaceName)}" data-bind="value:workspace-name">`
            + `<input type="hidden" name="session" value="${escapeHtml(sessionName)}" data-bind="value:active-session-name">`
            + '<input type="text" name="title" value="" placeholder="Session title" aria-label="Session title" autocomplete="off" required>'
            + '<footer><button type="submit" form="session-archive" data-session-archive-btn data-i18n="archive">Archive</button><button type="submit" form="session-unarchive" data-session-unarchive-btn hidden data-i18n="unarchive">Unarchive</button><button type="button" data-session-fork data-i18n="fork">Fork</button><button type="submit" data-i18n="save-title">Save title</button></footer>'
            + "</form>"
            + '<form id="session-archive" data-session-archive-form>'
            + `<input type="hidden" name="workspace" value="${escapeHtml(workspaceName)}" data-bind="value:workspace-name">`
            + `<input type="hidden" name="session" value="${escapeHtml(sessionName)}" data-bind="value:active-session-name">`
            + "</form>"
            + '<form id="session-unarchive" data-session-unarchive-form>'
            + `<input type="hidden" name="workspace" value="${escapeHtml(workspaceName)}" data-bind="value:workspace-name">`
            + `<input type="hidden" name="session" value="${escapeHtml(sessionName)}" data-bind="value:active-session-name">`
            + "</form>"
            + `<p data-no-active-session data-i18n="no-active-session"${sessionName ? " hidden" : ""}>Open or create a session to configure session settings.</p>`
            + '<div data-session-config-outlet></div>'
            + "</section>";
        const collection = '<div data-collection-bar-outlet></div>'
            + '<p data-sessions-empty data-i18n="no-sessions">No matching sessions.</p>'
            + '<figure data-sessions-table-wrap>'
            + '<table><thead><tr>'
            + '<th scope="col" data-i18n="ws-settings-col-session">Session</th>'
            + '<th scope="col" data-i18n="ws-settings-col-details">Details</th>'
            + '<th scope="col" data-i18n="ws-settings-col-state">State</th>'
            + '<th scope="col" data-i18n="ws-settings-col-actions">Actions</th>'
            + '</tr></thead><tbody data-sessions-rows></tbody></table></figure>';
        return '<section id="sessions" data-settings-panel="sessions" aria-label="Sessions" data-collection-count="0">'
            + '<header data-panel-toolbar><h2 data-i18n="sessions">Sessions</h2></header>'
            + createDisclosure
            + activeCard
            + collection
            + "</section>";
    }

    /** {§web-workspace-settings} {§web-brand} Render the About tab panel (`/settings/about`). */
    #aboutPanel() {
        const aboutLinksHtml = this.#brand.aboutLinks.map(({ label, url }) => {
            const i18nAttr = label === "Report an issue" && url === BUG_REPORT_URL ? ' data-i18n="report-issue"' : "";
            const display = url.replace(/^https?:\/\//iu, "");
            return `<dt${i18nAttr}>${escapeHtml(label)}</dt><dd><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(display)}</a></dd>`;
        }).join("");
        return '<section id="about" data-settings-panel="about" aria-label="About">'
            + '<header data-panel-toolbar><h2 data-i18n="about">About</h2></header>'
            + '<dl data-about-facts>'
            + '<dt data-about-service-term hidden>@plurnk/plurnk-service</dt><dd data-about-service-value hidden><code data-text="about-service-version"></code></dd>'
            + `<dt>@plurnk/plurnk-web</dt><dd><code data-text="about-web-version">${escapeHtml(WEB_VERSION)}</code></dd>`
            + '<dt data-about-desktop-term hidden>plurnk-desktop</dt><dd data-about-desktop-value hidden><code data-text="about-desktop-version"></code></dd>'
            + `<dt data-i18n="license">License</dt><dd>${escapeHtml(WEB_LICENSE)}</dd>`
            + aboutLinksHtml
            + "</dl></section>";
    }

    /**
     * {§web-workspace-settings} {§web-settings-extensions} {§web-search} Static tabbed hub shell (`GET /settings/<section>`).
     * @param {string} section
     * @param {{
     *   readonly workspace?: string,
     *   readonly session?: string | null,
     *   readonly q?: string,
     *   readonly status?: string,
     *   readonly kind?: string,
     *   readonly filterWorkspace?: string,
     *   readonly openCreate?: boolean,
     * }} [query]
     */
    settings(section, query = {}) {
        if (!this.#settingsSections.has(section)) {
            throw new Error(`Unknown settings section: ${section}`);
        }
        const workspaceName = query.workspace ?? "";
        const sessionName = query.session ?? "";
        const openCreate = query.openCreate === true;
        const marker = '<span data-header-glyph role="img" aria-label="Folderless workspace" data-bind="aria-label:workspace-icon-label" data-text="workspace-icon">☁️</span>';
        const backPath = workspaceName
            ? (sessionName
                ? directoryPath({ kind: "session", workspace: workspaceName, session: sessionName })
                : directoryPath({ kind: "workspace", workspace: workspaceName }))
            : "/";
        const backLabel = workspaceName || this.#brand.appName;
        const sessionTag = workspaceName && sessionName
            ? `<span data-settings-back-session>#<span data-text="active-session-name">${escapeHtml(sessionName)}</span></span>`
            : "";
        const backItem = backPath !== null
            ? `<a href="${escapeHtml(backPath)}" data-settings-back data-bind="href:workspace-back-path" aria-label="Back to workbench" title="Back to workbench">← ${marker} <span data-text="workspace-name">${escapeHtml(backLabel)}</span>${sessionTag}</a>`
            : `<span>${marker} <span data-text="workspace-name">${escapeHtml(backLabel)}</span></span>`;
        const headerLead = `<div id="header-place">${backItem}</div>`;

        const context = workspaceName && directoryPath({ kind: "workspace", workspace: workspaceName }) !== null
            ? { workspace: workspaceName, session: sessionName || null }
            : {};

        /** @param {string} id @param {string} label @param {string | null} i18nKey @param {boolean} isExtension */
        const tabItem = (id, label, i18nKey, isExtension) => {
            const href = settingsPath(id, context) ?? `/settings/${id}`;
            const currentAttr = id === section ? ' aria-current="page"' : "";
            const extAttr = isExtension ? ' data-settings-extension="true"' : "";
            const i18nAttr = i18nKey !== null ? ` data-i18n="${i18nKey}"` : "";
            return `<li><a href="${escapeHtml(href)}" data-settings-section="${escapeHtml(id)}"${extAttr}${currentAttr}${i18nAttr}>${escapeHtml(label)}</a></li>`;
        };

        const leadingTabs = ["search", "workspaces", "sessions", "models", "mcp", "skills", "schedule", "personas", "members", "env"]
            .map((id) => tabItem(id, BUILTIN_SECTION_META[id].label, BUILTIN_SECTION_META[id].i18n, false))
            .join("");
        const extensionNavHtml = this.#settingsTabs
            .map(({ id, label }) => tabItem(id, label, null, true))
            .join("");
        const trailingTabs = ["help", "about"]
            .map((id) => tabItem(id, BUILTIN_SECTION_META[id].label, BUILTIN_SECTION_META[id].i18n, false))
            .join("");
        const navHtml = `<nav aria-label="Settings sections"><ul data-settings-nav>${leadingTabs}${extensionNavHtml}${trailingTabs}</ul></nav>`;

        const activeExtension = this.#settingsTabs.find(({ id }) => id === section) ?? null;
        let panelHtml;
        if (section === "search") {
            panelHtml = this.#searchPanel({
                workspace: workspaceName,
                session: sessionName,
                q: query.q,
                status: query.status,
                kind: query.kind,
                filterWorkspace: query.filterWorkspace,
            });
        } else if (section === "workspaces") {
            panelHtml = this.#workspacesPanel(workspaceName, sessionName, openCreate);
        } else if (section === "sessions") {
            panelHtml = this.#sessionsPanel(workspaceName, sessionName, openCreate);
        } else if (section === "about") {
            panelHtml = this.#aboutPanel();
        } else if (activeExtension !== null) {
            panelHtml = `<section id="${escapeHtml(activeExtension.id)}" data-settings-panel="${escapeHtml(activeExtension.id)}" data-settings-extension="true" aria-label="${escapeHtml(activeExtension.label)}">${activeExtension.html}</section>`;
        } else {
            panelHtml = '<div data-settings-subsystems></div>';
        }

        const pageScripts = activeExtension !== null && activeExtension.scriptHref !== null
            ? `<script type="module" src="${escapeHtml(activeExtension.scriptHref)}"></script>`
            : "";

        const sectionLabel = activeExtension?.label ?? BUILTIN_SECTION_META[section]?.label ?? section;
        const headingMark = this.#brand.icon !== null
            ? `<img src="${escapeHtml(this.#brand.icon.href)}" alt="" aria-hidden="true"> `
            : (this.#brand.appName === DEFAULT_APP_NAME ? '<span aria-hidden="true">🐹</span> ' : "");
        const feedbackBanner = '<aside data-settings-feedback data-feedback-level="idle" role="status" aria-live="polite" hidden>'
            + '<span data-feedback-glyph aria-hidden="true"></span>'
            + '<div data-feedback-body>'
            + '<p data-text="ws-settings-message"></p>'
            + '<p data-text="ws-settings-recovery"></p>'
            + "</div>"
            + '<button type="button" data-feedback-dismiss aria-label="Dismiss message" title="Dismiss">✕</button>'
            + "</aside>";
        const closeHref = backPath ?? "/";
        const closeLink = `<a href="${escapeHtml(closeHref)}" data-settings-close data-bind="href:workspace-back-path" aria-label="Close settings" title="Close settings (Esc)">✕</a>`;
        const body = `<article id="workspace-settings" data-active-section="${escapeHtml(section)}" aria-labelledby="workspace-settings-title" data-bind="aria-busy:ws-settings-loading">`
            + `<header><h1 id="workspace-settings-title">${headingMark}<span>${escapeHtml(this.#brand.appName)}</span></h1>${closeLink}</header>`
            + navHtml
            + feedbackBanner
            + panelHtml
            + "</article>";

        const mainAttributes = ` data-settings-section="${escapeHtml(section)}"`
            + (workspaceName ? ` data-workspace-name="${escapeHtml(workspaceName)}"` : "")
            + (sessionName ? ` data-session-name="${escapeHtml(sessionName)}"` : "")
            + (openCreate ? ' data-open-create="true"' : "")
            + (section === "search" ? ' data-connection="initial"' : "");
        const title = workspaceName ? `${workspaceName} · ${sectionLabel}` : sectionLabel;
        return this.#render(title, body, "settings", {
            headerLead,
            mainAttributes,
            pageScripts,
        });
    }

    /** {§web-page-shell} HTTP failures keep native navigation without disclosing request data.
     * @param {number} status @param {string} message
     * @param {{ recovery?: string }} [next]
     */
    error(status, message, { recovery } = {}) {
        const reason = STATUS_CODES[status];
        if (reason === undefined) throw new Error(`Unknown HTTP status: ${status}`);
        const title = `${status} ${reason}`;
        return this.#render(title, '<article aria-labelledby="error-title"><header><h1 id="error-title">'
            + `<span aria-hidden="true">⚠️</span> <span data-text="error-title">${escapeHtml(title)}</span></h1></header>`
            + `<p data-text="error-message">${escapeHtml(message)}</p>`
            + (recovery === undefined ? "" : `<p data-text="error-recovery">${escapeHtml(recovery)}</p>`)
            + '<footer><a href="/" data-i18n="home">Home</a></footer></article>', "error");
    }
}
