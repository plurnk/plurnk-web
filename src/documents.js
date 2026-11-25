import { readFileSync } from "node:fs";
import { STATUS_CODES } from "node:http";
import { directoryPath, workspaceSettingsPath } from "./directory-addresses.js";
import { DEFAULT_ACP_URL, escapeHtml } from "./http.js";

const WEB_MANIFEST = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const WEB_VERSION = typeof WEB_MANIFEST.version === "string" && WEB_MANIFEST.version.length > 0 ? WEB_MANIFEST.version : "4.0.0";
export const WEB_LICENSE = typeof WEB_MANIFEST.license === "string" && WEB_MANIFEST.license.length > 0 ? WEB_MANIFEST.license : "MIT";
export const BUG_REPORT_URL = "https://github.com/plurnk/plurnk-service/issues";

const CANCEL = '<button type="button" data-dialog-close data-i18n="cancel">Cancel</button>';
const WORKSPACES_ICON = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>';

/** @typedef {"htmlAttrs" | "title" | "headerLead" | "main" | "afterMain"} DocumentSlotName */
/** @typedef {{ readonly literal: string } | { readonly slot: DocumentSlotName }} DocumentToken */

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

    /** @type {readonly { readonly name: DocumentSlotName, readonly start: number, readonly end: number }[]} */
    const spans = [
        { name: /** @type {const} */ ("htmlAttrs"), start: htmlAttrsIndex, end: htmlAttrsIndex },
        { name: /** @type {const} */ ("title"), start: title.start, end: title.end },
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
 * }} DocumentBootOptions
 */

/** {§web-document} {§web-directory-documents} {§web-page-shell} Static HTML shell compiler stamping boot data attributes without daemon seams or inline scripts. */
export default class Documents {
    #template;
    #acpUrl;
    #overviewSessions;
    #overviewExcerptChars;

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
    } = {}) {
        this.#acpUrl = acpUrl;
        this.#overviewSessions = overviewSessions;
        this.#overviewExcerptChars = overviewExcerptChars;
        this.#template = compileDocumentSlots(document);
    }

    #htmlBootAttributes() {
        const acpAttr = this.#acpUrl === null ? "invalid" : this.#acpUrl;
        const sessionsAttr = this.#overviewSessions === null ? "invalid" : String(this.#overviewSessions);
        const excerptAttr = this.#overviewExcerptChars === null ? "invalid" : String(this.#overviewExcerptChars);
        return ` data-acp-url="${escapeHtml(acpAttr)}"`
            + ` data-overview-sessions="${escapeHtml(sessionsAttr)}"`
            + ` data-overview-excerpt-chars="${escapeHtml(excerptAttr)}"`
            + ` data-web-version="${escapeHtml(WEB_VERSION)}"`;
    }

    /**
     * @param {string} title
     * @param {string} body
     * @param {"home" | "search" | "session" | "settings" | "callback" | "error"} kind
     * @param {{ headerLead?: string, footer?: string, dialogs?: string, mainAttributes?: string }} [slots]
     */
    #render(title, body, kind, { headerLead = "", footer = "", dialogs = "", mainAttributes = "" } = {}) {
        const label = kind === "home" ? title : `${title} — Plurnk`;
        return Buffer.from(this.#template.render({
            htmlAttrs: this.#htmlBootAttributes(),
            title: `<title data-text="page-title">${escapeHtml(label)}</title>`,
            headerLead,
            main: `<main id="main" data-page="${kind}"${mainAttributes}>${body}</main>`,
            afterMain: footer + dialogs,
        }));
    }

    /** {§web-page-shell} {§web-workspace-creation} Workspace switcher modal shell populated over `/acp`. */
    #workspacesDialog() {
        const actionsHtml = '<div data-workspaces-actions>'
            + '<button type="button" data-dialog-target="dialog-workspace-create" data-i18n="new-workspace">New workspace…</button>'
            + "</div>";
        return '<dialog id="dialog-workspaces" aria-label="Workspaces"><article>'
            + '<header><p><strong data-i18n="workspaces">Workspaces</strong></p>'
            + '<button type="button" aria-label="Close" rel="prev" data-dialog-close></button></header>'
            + '<ul data-workspaces-list hidden></ul>'
            + '<p data-workspaces-empty data-i18n="no-workspaces">No matching workspaces.</p>'
            + actionsHtml
            + '<footer><a href="/search/?status=archived"><span data-i18n="archived-workspaces">Archived workspaces</span> (<span data-text="archived-workspaces-count">0</span>)</a></footer>'
            + "</article></dialog>";
    }

    /** {§web-workspace-creation} Native dialog modal for workspace creation submitted over `/acp`. */
    #creationDialog() {
        const projectControls = '<label data-project-folder-toggle><input type="checkbox" name="useProjectFolder" value="1" data-toggle-project-folder> <span data-i18n="project-folder">Project folder</span></label>'
            + '<input type="text" name="projectRoot" value="" placeholder="/path/to/project" aria-label="Project path" data-project-folder-input>'
            + '<small data-project-folder-note hidden></small>';
        return '<dialog id="dialog-workspace-create" aria-label="New workspace"><article>'
            + '<header><p><strong data-i18n="new-workspace-title">New workspace</strong></p>'
            + '<button type="button" aria-label="Close" rel="prev" data-dialog-close></button></header>'
            + '<p role="alert" data-text="workspace-create-error"></p>'
            + '<form id="workspace-create" data-workspace-create-form>'
            + '<input type="text" name="name" value="" placeholder="Workspace name (optional)" aria-label="Workspace name">'
            + projectControls
            + `<footer>${CANCEL}<button type="submit" data-i18n="confirm">Confirm</button></footer></form>`
            + "</article></dialog>";
    }

    /**
     * {§web-session-creation} Native dialog modal for session creation submitted over `/acp`.
     * @param {string} workspaceName
     */
    #sessionCreationDialog(workspaceName) {
        return '<dialog id="dialog-session-create" aria-label="New session"><article>'
            + '<header><p><strong data-i18n="new-session">New session</strong></p>'
            + '<button type="button" aria-label="Close" rel="prev" data-dialog-close></button></header>'
            + '<p role="alert" data-text="session-create-error"></p>'
            + '<form id="session-create" data-session-create-form>'
            + `<input type="hidden" name="workspace" value="${escapeHtml(workspaceName)}" data-bind="value:workspace-name">`
            + '<input type="text" name="name" value="" placeholder="Session name (optional)" aria-label="Session name" autocomplete="off" spellcheck="false">'
            + '<input type="text" name="title" value="" placeholder="Session title (optional)" aria-label="Session title" autocomplete="off">'
            + `<footer>${CANCEL}<button type="submit" data-i18n="confirm">Confirm</button></footer></form>`
            + "</article></dialog>";
    }

    /** {§web-arrival} Static arrival shell (`/` and `/index.html`). */
    home() {
        return this.#render("Plurnk", this.#template.home, "home");
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
     * {§web-directory-documents} {§web-workspace-tabs} Static session workbench shell (`GET /~/<workspace>`).
     * @param {string} workspaceName
     */
    session(workspaceName) {
        const marker = '<span role="img" aria-label="Folderless workspace" data-bind="aria-label:workspace-icon-label" data-text="workspace-icon">☁️</span>';
        const switcherTrigger = `<button type="button" data-dialog-target="dialog-workspaces" aria-label="Change workspace" title="Change workspace">${WORKSPACES_ICON}</button>`;
        const settingsHref = workspaceSettingsPath(workspaceName);
        const workspaceSettingsTrigger = settingsHref !== null
            ? `<a id="session-workspace" href="${escapeHtml(settingsHref)}" data-bind="href:workspace-settings-path" aria-label="Workspace settings" title="Workspace settings">${marker} <span data-text="workspace-name">${escapeHtml(workspaceName)}</span></a>`
            : `<span id="session-workspace">${marker} <span data-text="workspace-name">${escapeHtml(workspaceName)}</span></span>`;
        const headerLead = `<div id="header-place">${switcherTrigger}${workspaceSettingsTrigger}</div>`;
        const body = '<p id="session-folder" data-project-label=""><span role="img" aria-label="Project folder">🗂️</span> <span data-text="project-label"></span></p>';
        const dialogs = this.#workspacesDialog()
            + this.#creationDialog()
            + this.#sessionCreationDialog(workspaceName);
        const tabs = `<nav id="workspace-tabs" aria-label="Workspace sessions" data-workspace-name="${escapeHtml(workspaceName)}" data-tab-count="0">`
            + '<button type="button" data-action="new-session" data-tab-new aria-label="New session" title="New session">+</button>'
            + '<button type="button" data-open-sessions aria-label="Sessions and archives" title="Sessions and archives (Ctrl+K)">☰</button>'
            + "<ul></ul></nav>";
        return this.#render(workspaceName, body, "session", {
            headerLead,
            footer: tabs,
            dialogs,
            mainAttributes: ` data-requested-workspace="${escapeHtml(workspaceName)}"`,
        });
    }

    /**
     * {§web-search} Static Search directory shell (`GET /search/`).
     * @param {{ readonly q?: string, readonly workspace?: string, readonly status?: string, readonly kind?: string }} [query]
     */
    search(query = {}) {
        const q = (query.q ?? "").trim();
        const wsFilter = (query.workspace ?? "").trim();
        const statusFilter = ["all", "active", "gated", "failed", "archived"].includes(query.status ?? "")
            ? (query.status ?? "all")
            : "all";
        const kindFilter = ["all", "root", "work"].includes(query.kind ?? "")
            ? (query.kind ?? "all")
            : "all";
        const statusOption = (/** @type {string} */ val, /** @type {string} */ label) =>
            `<option value="${val}"${statusFilter === val ? " selected" : ""}>${label}</option>`;
        const controlsHtml = '<form id="search-controls" method="get" action="/search/" aria-label="Search workspaces and sessions">'
            + `<input type="search" name="q" list="search-suggestions" data-overview-search value="${escapeHtml(q)}" placeholder="Search workspaces and sessions…" aria-label="Search workspaces and sessions" autocomplete="off">`
            + '<datalist id="search-suggestions"></datalist>'
            + (wsFilter ? `<input type="hidden" name="workspace" value="${escapeHtml(wsFilter)}" data-search-workspace>` : "")
            + (kindFilter !== "all" ? `<input type="hidden" name="kind" value="${escapeHtml(kindFilter)}" data-search-kind>` : "")
            + `<select name="status" data-overview-scope aria-label="Status filter">${statusOption("all", "All statuses")}${statusOption("active", "Active")}${statusOption("gated", "Needs input")}${statusOption("failed", "Failed")}${statusOption("archived", "Archived")}</select>`
            + '<button type="submit" data-search-submit data-i18n="filter">Filter</button>'
            + "</form>";
        const workspacesSection = '<section id="search-workspaces" aria-label="Workspaces"></section>';
        const switcherTrigger = `<button type="button" data-dialog-target="dialog-workspaces" aria-label="Change workspace" title="Change workspace">${WORKSPACES_ICON}</button>`;
        const headerLead = `<div id="header-place">${switcherTrigger}<span aria-current="page" data-i18n="search">Search</span></div>`;
        const dialogs = this.#workspacesDialog() + this.#creationDialog();
        return this.#render("Search", controlsHtml + workspacesSection, "search", {
            headerLead,
            dialogs,
            mainAttributes: ' data-connection="initial"',
        });
    }

    /**
     * {§web-workspace-settings} Static Settings & About shell (`GET /settings/`).
     * @param {{ readonly workspace?: string, readonly session?: string | null }} [query]
     */
    settings(query = {}) {
        const workspaceName = query.workspace ?? "";
        const sessionName = query.session ?? "";
        const marker = '<span role="img" aria-label="Folderless workspace" data-bind="aria-label:workspace-icon-label" data-text="workspace-icon">☁️</span>';
        const backPath = workspaceName
            ? (sessionName
                ? directoryPath({ kind: "session", workspace: workspaceName, session: sessionName })
                : directoryPath({ kind: "workspace", workspace: workspaceName }))
            : "/";
        const backLabel = workspaceName || "Plurnk";
        const backItem = backPath !== null
            ? `<a href="${escapeHtml(backPath)}" data-settings-back data-bind="href:workspace-back-path">${marker} <span data-text="workspace-name">${escapeHtml(backLabel)}</span></a>`
            : `<span>${marker} <span data-text="workspace-name">${escapeHtml(backLabel)}</span></span>`;
        const headerLead = '<nav id="header-place" aria-label="breadcrumb"><ul>'
            + `<li>${backItem}</li>`
            + '<li><span aria-current="page" data-i18n="settings">Settings</span></li></ul></nav>';

        const addWorkspaceBtn = '<button type="button" data-dialog-target="dialog-workspace-create" data-i18n="ws-settings-add-workspace">+ Add workspace</button>';
        const addSessionBtn = '<button type="button" data-dialog-target="dialog-session-create" data-settings-add-session data-i18n="ws-settings-add-session">+ Add session</button>';

        const navHtml = '<nav aria-label="Settings sections"><ul data-settings-nav>'
            + '<li><a href="#workspace" data-settings-section="workspace" aria-current="true" data-i18n="ws-settings-tab-workspace">Workspace</a></li>'
            + '<li><a href="#session" data-settings-section="session" data-i18n="ws-settings-tab-session">Session</a></li>'
            + '<li><a href="#models" data-settings-section="models" data-i18n="ws-settings-tab-models">Models</a></li>'
            + '<li><a href="#mcp" data-settings-section="mcp" data-i18n="ws-settings-tab-mcp">MCP</a></li>'
            + '<li><a href="#skills" data-settings-section="skills" data-i18n="ws-settings-tab-skills">Skills</a></li>'
            + '<li><a href="#schedule" data-settings-section="schedule" data-i18n="ws-settings-tab-schedule">Schedule</a></li>'
            + '<li><a href="#personas" data-settings-section="personas" data-i18n="ws-settings-tab-personas">Personas</a></li>'
            + '<li><a href="#members" data-settings-section="members" data-i18n="ws-settings-tab-members">Members</a></li>'
            + '<li><a href="#env" data-settings-section="env" data-i18n="ws-settings-tab-env">Environment</a></li>'
            + '<li><a href="#help" data-settings-section="help" data-i18n="ws-settings-tab-help">Help</a></li>'
            + '<li><a href="#about" data-settings-section="about" data-i18n="about">About</a></li>'
            + "</ul></nav>";

        const workspacePanel = '<section id="workspace" data-settings-panel="workspace" aria-label="Workspace">'
            + `<header data-panel-toolbar><h2 data-i18n="ws-settings-tab-workspace">Workspace</h2>${addWorkspaceBtn}</header>`
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

        const sessionPanel = '<section id="session" data-settings-panel="session" aria-label="Session" hidden>'
            + `<header data-panel-toolbar><h2 data-session-panel-heading><span data-i18n="ws-settings-tab-session">Session</span><span data-session-heading-handle${sessionName ? "" : " hidden"}> · <code data-text="session-heading-code">#${escapeHtml(sessionName)}</code></span></h2>${addSessionBtn}</header>`
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

        const aboutPanel = '<section id="about" data-settings-panel="about" aria-label="About" hidden>'
            + '<header data-panel-toolbar><h2 data-i18n="about">About</h2></header>'
            + '<dl data-about-facts>'
            + '<dt data-about-service-term hidden>@plurnk/plurnk-service</dt><dd data-about-service-value hidden><code data-text="about-service-version"></code></dd>'
            + `<dt>@plurnk/plurnk-web</dt><dd><code data-text="about-web-version">${escapeHtml(WEB_VERSION)}</code></dd>`
            + '<dt data-about-desktop-term hidden>plurnk-desktop</dt><dd data-about-desktop-value hidden><code data-text="about-desktop-version"></code></dd>'
            + `<dt data-i18n="license">License</dt><dd>${escapeHtml(WEB_LICENSE)}</dd>`
            + `<dt data-i18n="report-issue">Report an issue</dt><dd><a href="${BUG_REPORT_URL}" target="_blank" rel="noopener noreferrer">github.com/plurnk/plurnk-service/issues</a></dd>`
            + "</dl></section>";

        const body = '<article id="workspace-settings" aria-labelledby="workspace-settings-title" data-bind="aria-busy:ws-settings-loading">'
            + '<header><h1 id="workspace-settings-title" data-i18n="settings">Settings</h1></header>'
            + navHtml
            + '<p role="status" data-text="ws-settings-message"></p>'
            + '<p data-text="ws-settings-recovery"></p>'
            + workspacePanel
            + sessionPanel
            + '<div data-settings-subsystems></div>'
            + aboutPanel
            + "</article>";

        const dialogs = this.#creationDialog() + this.#sessionCreationDialog(workspaceName);
        const mainAttributes = (workspaceName ? ` data-workspace-name="${escapeHtml(workspaceName)}"` : "")
            + (sessionName ? ` data-session-name="${escapeHtml(sessionName)}"` : "");
        const title = workspaceName ? `${workspaceName} · Settings` : "Settings";
        return this.#render(title, body, "settings", {
            headerLead,
            dialogs,
            mainAttributes,
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
