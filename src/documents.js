import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { STATUS_CODES } from "node:http";
import { directoryPath, workspaceSettingsPath } from "./directory-addresses.js";
import { escapeHtml, RequestError } from "./http.js";

const WEB_MANIFEST = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const WEB_VERSION = typeof WEB_MANIFEST.version === "string" && WEB_MANIFEST.version.length > 0 ? WEB_MANIFEST.version : "3.0.0";
const WEB_LICENSE = typeof WEB_MANIFEST.license === "string" && WEB_MANIFEST.license.length > 0 ? WEB_MANIFEST.license : "MIT";
const BUG_REPORT_URL = "https://github.com/plurnk/plurnk-service/issues";

// A dialog's dismissal; a form offered again on an error page has none.
const CANCEL = '<button type="button" data-dialog-close data-i18n="cancel">Cancel</button>';
const WORKSPACES_ICON = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>';

/** @typedef {{ readonly id: number, readonly name: string, readonly project_root: string | null, readonly project_label: string | null, readonly archived_at: string | null }} DirectoryWorkspace */
/** @typedef {{ readonly id: number, readonly coordinate: string, readonly completion: 200 | 499, readonly at?: number, readonly excerpt?: string, readonly continued?: boolean }} DirectoryReply */
/** @typedef {{ readonly id: number, readonly name: string, readonly parentSessionId: number | null, readonly origin: string, readonly kind?: string, readonly lifecycle: string, readonly gates?: number, readonly title?: string | null, readonly openingPrompt?: string, readonly matchedExcerpt?: string, readonly archived_at: string | null, readonly reply?: DirectoryReply | null, readonly workspaceId?: number }} DirectorySession */
/** @typedef {{ readonly id: number, readonly name: string, readonly projectRoot: string | null }} DirectoryOverviewWorkspace */
/** @typedef {{ readonly id: number, readonly workspaceId: number, readonly name: string, readonly parentSessionId: number | null, readonly kind?: string, readonly lifecycle: string, readonly gates?: number, readonly title?: string | null, readonly reply: DirectoryReply | null }} DirectoryOverviewSession */
/** @typedef {{ readonly workspaces: readonly DirectoryOverviewWorkspace[], readonly sessions: readonly DirectoryOverviewSession[], readonly omitted?: number }} DirectoryOverview */
/** @typedef {{ readonly q?: string, readonly workspace?: string, readonly status?: string, readonly kind?: string }} SearchQuery */

/** @param {{ readonly reply?: { readonly id: number } | null }} a @param {{ readonly reply?: { readonly id: number } | null }} b */
export const orderByReply = (a, b) => {
    const aReply = a.reply ?? null;
    const bReply = b.reply ?? null;
    return aReply !== null && bReply !== null ? bReply.id - aReply.id
        : aReply !== null ? -1 : bReply !== null ? 1 : 0;
};

/**
 * {§web-workspace-tabs} {§web-search} Untouched 0-loop root leaf sessions are ephemeral drafts.
 * @param {{ readonly parentSessionId: number | null, readonly kind?: string, readonly lifecycle: string, readonly reply?: unknown, readonly title?: string | null, readonly gates?: number }} entry
 * @param {boolean} [hasModelChildren]
 */
export function isUntouchedDraftSession(entry, hasModelChildren = false) {
    const kind = entry.kind ?? (entry.parentSessionId === null ? "root" : "work");
    return entry.parentSessionId === null
        && kind === "root"
        && entry.lifecycle === "idle"
        && (entry.reply ?? null) === null
        && !(typeof entry.title === "string" && entry.title.trim() !== "")
        && (entry.gates ?? 0) === 0
        && !hasModelChildren;
}

/**
 * @param {string} raw
 * @param {number} maxChars
 */
function truncateSingleLine(raw, maxChars) {
    const clean = raw.replaceAll(/\s+/gu, " ").trim();
    if (clean.length <= maxChars) return clean;
    return `${clean.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

/**
 * @param {string} raw
 * @param {string} qLower
 * @param {number} maxChars
 */
function matchSnippet(raw, qLower, maxChars) {
    const clean = raw.replaceAll(/\s+/gu, " ").trim();
    if (clean.length <= maxChars) return clean;
    const idx = clean.toLowerCase().indexOf(qLower);
    if (idx <= 0) return truncateSingleLine(clean, maxChars);
    const half = Math.max(0, Math.floor((maxChars - qLower.length) / 2));
    const start = Math.max(0, idx - half);
    const slice = clean.slice(start, start + maxChars).trim();
    return `${start > 0 ? "…" : ""}${slice}${start + maxChars < clean.length ? "…" : ""}`;
}

/** @typedef {"title" | "headerLead" | "sessionNavigation" | "headerTail" | "beforeMain" | "main" | "afterMain"} DocumentSlotName */
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
    const main = locatePairedElement(
        outsideTemplates,
        /<main\b[^>]*>/gu,
        /<\/main>/gu,
        "The web document must contain exactly one main element.",
    );
    const mainInner = document.slice(main.start + (/<main\b[^>]*>/u.exec(document.slice(main.start))?.[0].length ?? 0), main.end - "</main>".length);
    const beforeMain = outsideTemplates.slice(0, main.start);
    const rawBeforeMain = document.slice(0, main.start);
    const title = locatePairedElement(
        beforeMain,
        /<title\b[^>]*>/gu,
        /<\/title>/gu,
        "The web document must contain exactly one title element before main.",
    );
    const navOpens = [...rawBeforeMain.matchAll(/<template\b[^>]*\bid="session-navigation"[^>]*>/gu)];
    const navMatches = [...rawBeforeMain.matchAll(/<template\b[^>]*\bid="session-navigation"[^>]*>([\s\S]*?)<\/template>/gu)];
    if (navOpens.length !== 1 || navMatches.length !== 1 || /<template\b/u.test(navMatches[0][1])) {
        throw new Error("The web document must contain exactly one session-navigation template before main.");
    }
    const [navMatch] = navMatches;
    const navSpan = {
        start: navMatch.index,
        end: navMatch.index + navMatch[0].length,
        inner: navMatch[1],
    };
    const beforeNav = beforeMain.slice(0, navSpan.start);
    const afterNav = beforeMain.slice(navSpan.end);
    const headerOpens = [...beforeNav.matchAll(/<header\b[^>]*>/gu)];
    const earlyHeaderCloses = [...beforeNav.matchAll(/<\/header>/gu)];
    const headerCloses = [...afterNav.matchAll(/<\/header>/gu)];
    if (headerOpens.length !== 1 || earlyHeaderCloses.length !== 0 || headerCloses.length !== 1) {
        throw new Error("The web document must close its header once after session navigation and before main.");
    }
    const headerInnerBeforeNav = beforeNav.slice(headerOpens[0].index + headerOpens[0][0].length);
    const mainNavMatch = /<nav\b[^>]*>/u.exec(headerInnerBeforeNav);
    const headerLeadIndex = mainNavMatch
        ? headerOpens[0].index + headerOpens[0][0].length + mainNavMatch.index
        : navSpan.start;
    const headerCloseIndex = navSpan.end + headerCloses[0].index;

    /** @type {readonly { readonly name: DocumentSlotName, readonly start: number, readonly end: number }[]} */
    const spans = [
        { name: /** @type {const} */ ("title"), start: title.start, end: title.end },
        { name: /** @type {const} */ ("headerLead"), start: headerLeadIndex, end: headerLeadIndex },
        { name: /** @type {const} */ ("sessionNavigation"), start: navSpan.start, end: navSpan.end },
        { name: /** @type {const} */ ("headerTail"), start: headerCloseIndex, end: headerCloseIndex },
        { name: /** @type {const} */ ("beforeMain"), start: main.start, end: main.start },
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
        sessionNavigation: navSpan.inner,
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
 * @param {{
 *   listProviders?: () => { readonly aliases: readonly unknown[] },
 *   listModels?: (args: { limit?: number }) => { readonly total: number },
 *   readOperatorEnvironment?: () => Promise<unknown>,
 * }} [port]
 */
function detectNeedsOnboarding(port) {
    if (!port
        || typeof port.readOperatorEnvironment !== "function"
        || typeof port.listProviders !== "function"
        || typeof port.listModels !== "function") {
        return false;
    }
    try {
        return port.listProviders().aliases.length === 0 && port.listModels({ limit: 1 }).total === 0;
    } catch {
        return false;
    }
}

/** {§web-document} {§web-directory-documents} One compiled document supplies the complete HTML/OTM substrate. */
export default class Documents {
    #template;
    #yolo;
    #overviewSessions;
    #overviewExcerptChars;
    #allowProjectFolder;

    /** {§web-authorization-style} Read the stylesheet declaration from our compiled head, not unrelated lazy assets.
     * @param {string} document
     */
    static stylesheet(document) {
        const links = [...document.split("</head>")[0].matchAll(/<link\b(?=[^>]*\brel="stylesheet")[^>]*>/gu)];
        if (links.length !== 1) throw new Error("The web document must declare exactly one application stylesheet.");
        const path = /\bhref="(\/[^"]+)"/u.exec(links[0][0])?.[1];
        if (!path || path.startsWith("//")) throw new Error("The application stylesheet must have an origin-relative path.");
        return path;
    }

    /** @param {string} document @param {boolean | null} yolo @param {number | null} [overviewSessions] @param {number | null} [overviewExcerptChars] @param {boolean | null} [allowProjectFolder] */
    constructor(document, yolo, overviewSessions = 200, overviewExcerptChars = 160, allowProjectFolder = true) {
        this.#yolo = yolo;
        this.#overviewSessions = overviewSessions;
        this.#overviewExcerptChars = overviewExcerptChars;
        this.#allowProjectFolder = allowProjectFolder;
        this.#template = compileDocumentSlots(document);
    }

    /**
     * @param {string} title
     * @param {string} body
     * @param {"home" | "search" | "workspace" | "session" | "settings" | "error" | "account"} kind
     * @param {boolean} [authenticated]
     * @param {{ headerLead?: string, headerTail?: string, beforeMain?: string, footer?: string, dialogs?: string, mainAttributes?: string }} [slots]
     */
    #render(title, body, kind, authenticated = false, { headerLead = "", headerTail = "", beforeMain = "", footer = "", dialogs = "", mainAttributes = "" } = {}) {
        const label = kind === "home" ? title : `${title} — Plurnk`;
        return Buffer.from(this.#template.render({
            title: `<title data-text="page-title">${escapeHtml(label)}</title>`,
            headerLead,
            sessionNavigation: authenticated ? this.#template.sessionNavigation : "",
            headerTail,
            beforeMain,
            main: `<main id="main" data-page="${kind}"${mainAttributes}>${body}${dialogs}</main>`,
            afterMain: footer,
        }));
    }

    /**
     * {§web-page-shell} Center place display in header.
     * @param {{ placeHtml?: string }} [options]
     */
    #headerLead({ placeHtml = "" } = {}) {
        return placeHtml;
    }

    /**
     * {§web-page-shell} {§web-workspace-creation} Workspace switcher modal listing unarchived workspaces and creation actions.
     * @param {readonly DirectoryWorkspace[]} allWorkspaces
     * @param {string | null} currentWorkspaceName
     * @param {boolean} creationsAvailable
     */
    #workspacesDialog(allWorkspaces, currentWorkspaceName, creationsAvailable) {
        const items = allWorkspaces
            .filter(({ archived_at }) => archived_at === null)
            .map((ws) => {
                const path = directoryPath({ kind: "workspace", workspace: ws.name });
                const effectiveProject = ws.project_label ?? ws.project_root;
                const separateFolder = ws.project_label !== null && ws.project_label !== ws.name;
                const glyph = effectiveProject !== null ? "🗂️" : "☁️";
                const folderNote = separateFolder ? ` <small>${escapeHtml(ws.project_label ?? "")}</small>` : "";
                const current = ws.name === currentWorkspaceName ? ' aria-current="page"' : "";
                const label = `${glyph} <span>${escapeHtml(ws.name)}</span>${folderNote}`;
                return path === null
                    ? `<li><span>${label}</span></li>`
                    : `<li><a href="${escapeHtml(path)}"${current}>${label}</a></li>`;
            })
            .join("");
        const listHtml = items
            ? `<ul data-workspaces-list>${items}</ul>`
            : '<p data-i18n="no-workspaces">No matching workspaces.</p>';
        const archivedCount = allWorkspaces.filter(({ archived_at }) => archived_at !== null).length;
        const actionsHtml = creationsAvailable && this.#allowProjectFolder !== null
            ? '<div data-workspaces-actions>'
                + '<button type="button" data-dialog-target="dialog-workspace-create" data-i18n="new-workspace">New workspace…</button>'
                + "</div>"
            : "";
        return '<dialog id="dialog-workspaces" aria-label="Workspaces"><article>'
            + '<header><p><strong data-i18n="workspaces">Workspaces</strong></p>'
            + '<button type="button" aria-label="Close" rel="prev" data-dialog-close></button></header>'
            + listHtml
            + actionsHtml
            + `<footer><a href="/search/?status=archived"><span data-i18n="archived-workspaces">Archived workspaces</span> (${archivedCount})</a></footer>`
            + "</article></dialog>";
    }

    /** @param {boolean} [authenticated] */
    home(authenticated = false) {
        return this.#render("Plurnk", this.#template.home, "home", authenticated);
    }

    /** {§web-page-shell} HTTP failures keep native navigation without disclosing request data.
     * @param {number} status @param {string} message @param {boolean} [authenticated]
     * @param {{ recovery?: string, retry?: string }} [next] What the person can do next, and the form to submit again.
     */
    error(status, message, authenticated = false, { recovery, retry } = {}) {
        const reason = STATUS_CODES[status];
        if (reason === undefined) throw new Error(`Unknown HTTP status: ${status}`);
        const title = `${status} ${reason}`;
        return this.#render(title, '<article aria-labelledby="error-title"><header><h1 id="error-title">'
            + `<span aria-hidden="true">⚠️</span> <span data-text="error-title">${escapeHtml(title)}</span></h1></header>`
            + `<p data-text="error-message">${escapeHtml(message)}</p>`
            + (recovery === undefined ? "" : `<p data-text="error-recovery">${escapeHtml(recovery)}</p>`)
            + (retry ?? "")
            + '<footer><a href="/" data-i18n="home">Home</a></footer></article>', "error", authenticated);
    }

    /** {§web-workspace-creation} The creation form a refused submission offers again, with its draft and a fresh token. @param {string} name @param {string} [projectRoot] @param {boolean} [checkProject] */
    retryCreation(name, projectRoot = "", checkProject = projectRoot !== "") { return this.#creationFields(name, projectRoot, "", checkProject); }

    /** {§web-workspace-rename} @param {string} workspace @param {string} name @param {string} [session] */
    retryRename(workspace, name, session = "") { return this.#renameFields(workspace, name, "", session); }

    /** {§web-session-creation} @param {string} workspace @param {string} name @param {string} [title] */
    retrySession(workspace, name, title = "") { return this.#sessionFields(workspace, name, "", title); }

    /** {§web-account} Unified tabbed Account document (`#sign-ins` and `#about`); only authority-supplied facts are presented as sign-in information.
     * @param {{ family: string, sessions: readonly Pick<import("@plurnk/plurnk-contracts").CredentialSession, "family" | "createdAt" | "expiresAt" | "clients">[] }} account
     * @param {{ serviceVersion?: string | null, desktopVersion?: string | null }} [about]
     */
    account({ family, sessions }, { serviceVersion = null, desktopVersion = null } = {}) {
        const time = (/** @type {number} */ timestamp) => {
            const iso = new Date(timestamp).toISOString();
            return `<time datetime="${iso}" data-text="session-time">${iso.replace("T", " ").replace(/\.\d{3}Z$/u, " UTC")}</time>`;
        };
        const entries = sessions.map((entry) => {
            const current = entry.family === family;
            const action = current ? "/auth/logout" : `/account/sign-ins/${encodeURIComponent(entry.family)}/revoke`;
            return `<tr data-session="${escapeHtml(entry.family)}"><th scope="row"><span data-i18n="${current ? "this-sign-in" : "another-sign-in"}">${current ? "This sign-in" : "Another sign-in"}</span>`
                + `<br><small data-text="session-clients">${entry.clients.map(escapeHtml).join(", ")}</small></th>`
                + `<td>${time(entry.createdAt)}</td><td>${time(entry.expiresAt)}</td>`
                + `<td><form method="post" action="${escapeHtml(action)}"><button type="submit" data-i18n="${current ? "end-this-sign-in" : "revoke-sign-in"}">${current ? "End this sign-in" : "Revoke sign-in"}</button></form></td></tr>`;
        }).join("");
        const others = sessions.some((entry) => entry.family !== family)
            ? '<form method="post" action="/account/sign-ins/revoke-others"><button type="submit" data-i18n="revoke-other-sign-ins">Revoke other sign-ins</button></form>' : "";
        const navHtml = '<nav aria-label="Account sections"><ul data-settings-nav>'
            + '<li><a href="#sign-ins" data-account-section="sign-ins" aria-current="true" data-i18n="sign-ins">Sign-ins</a></li>'
            + '<li><a href="#about" data-account-section="about" data-i18n="about">About</a></li>'
            + "</ul></nav>";
        const signInsPanel = '<section id="sign-ins" data-account-panel="sign-ins" aria-label="Sign-ins">'
            + '<header data-panel-toolbar>'
            + '<h2 data-i18n="active-sign-ins">Active sign-ins</h2>'
            + `<div data-toolbar-actions>${others}<form method="post" action="/auth/logout"><button type="submit" data-i18n="sign-out">Sign out</button></form></div>`
            + "</header>"
            + '<figure><table><thead><tr><th scope="col" data-i18n="sign-in">Sign-in</th><th scope="col" data-i18n="started">Started</th>'
            + '<th scope="col" data-i18n="expires">Expires</th><th scope="col" data-i18n="actions">Actions</th></tr></thead>'
            + `<tbody>${entries}</tbody></table></figure></section>`;
        const serviceRow = typeof serviceVersion === "string" && serviceVersion.length > 0
            ? `<dt>plurnk-service</dt><dd><code data-text="about-service-version">${escapeHtml(serviceVersion)}</code></dd>`
            : "";
        const desktopRow = typeof desktopVersion === "string" && desktopVersion.length > 0
            ? `<dt>plurnk-desktop</dt><dd><code data-text="about-desktop-version">${escapeHtml(desktopVersion)}</code></dd>`
            : "";
        const aboutPanel = '<section id="about" data-account-panel="about" aria-label="About">'
            + '<dl data-about-facts>'
            + serviceRow
            + `<dt>plurnk-web</dt><dd><code data-text="about-web-version">${escapeHtml(WEB_VERSION)}</code></dd>`
            + desktopRow
            + `<dt data-i18n="license">License</dt><dd>${escapeHtml(WEB_LICENSE)}</dd>`
            + `<dt data-i18n="report-issue">Report an issue</dt><dd><a href="${BUG_REPORT_URL}" target="_blank" rel="noopener noreferrer">github.com/plurnk/plurnk-service/issues</a></dd>`
            + "</dl></section>";
        const placeHtml = '<nav id="header-place" aria-label="breadcrumb"><ul>'
            + '<li><a href="/" data-i18n="home">Home</a></li>'
            + '<li><span aria-current="page" data-i18n="account">Account</span></li></ul></nav>';
        const body = '<article id="account-settings" aria-labelledby="account-title">'
            + '<header><h1 id="account-title" data-i18n="account">Account</h1></header>'
            + navHtml
            + signInsPanel
            + aboutPanel
            + "</article>";
        return this.#render("Account", body, "account", true, { headerLead: this.#headerLead({ placeHtml }) });
    }

    /** @param {string} label @param {import("./directory-addresses.js").Directory} directory */
    #link(label, directory) {
        const path = directoryPath(directory);
        return path === null ? `<span data-text="name">${escapeHtml(label)}</span>`
            : `<a href="${escapeHtml(path)}" data-text="name"${directory.kind === "session" ? ` data-session-name="${escapeHtml(directory.session)}" data-bind="href:session-path"` : ""}>${escapeHtml(label)}</a>`;
    }

    /** {§web-workspace-creation} Native dialog modal for workspace creation (including optional project folder binding when allowed). */
    #creationForm() {
        if (this.#allowProjectFolder === null) return "";
        return '<dialog id="dialog-workspace-create" aria-label="New workspace"><article>'
            + '<header><p><strong data-i18n="new-workspace-title">New workspace</strong></p>'
            + '<button type="button" aria-label="Close" rel="prev" data-dialog-close></button></header>'
            + this.#creationFields("", "", CANCEL, false)
            + "</article></dialog>";
    }

    /** @param {string} name @param {string} projectRoot @param {string} cancel @param {boolean} [checkProject] */
    #creationFields(name, projectRoot, cancel, checkProject = projectRoot !== "") {
        const projectControls = this.#allowProjectFolder === true
            ? `<label data-project-folder-toggle><input type="checkbox" name="useProjectFolder" value="1" data-toggle-project-folder${checkProject ? " checked" : ""}> <span data-i18n="project-folder">Project folder</span></label>`
                + `<input type="text" name="projectRoot" value="${escapeHtml(projectRoot)}" placeholder="/path/to/project" aria-label="Project path" data-project-folder-input>`
            : "";
        return '<form id="workspace-create" method="post" action="/workspaces/new">'
            + `<input type="hidden" name="token" value="${randomUUID()}">`
            + `<input type="text" name="name" value="${escapeHtml(name)}" placeholder="Workspace name (optional)" aria-label="Workspace name">`
            + projectControls
            + `<footer>${cancel}<button type="submit" data-i18n="confirm">Confirm</button></footer></form>`;
    }

    /** @param {string} workspace @param {string} name @param {string} cancel @param {string} [session] */
    #renameFields(workspace, name, cancel, session = "") {
        return '<form id="workspace-rename" method="post" action="/workspaces/rename">'
            + `<input type="hidden" name="workspace" value="${escapeHtml(workspace)}" data-bind="value:workspace-name">`
            + (session ? `<input type="hidden" name="session" value="${escapeHtml(session)}" data-bind="value:active-session-name">` : "")
            + `<input type="text" name="name" value="${escapeHtml(name)}" placeholder="New name" aria-label="Rename workspace" required>`
            + `<footer>${cancel}<button type="submit" data-i18n="confirm">Confirm</button></footer></form>`;
    }

    /**
     * {§web-session-creation} Native dialog modal for session creation (`name` and `title` optional).
     * @param {{name: string}} workspace
     */
    #sessionCreationForm(workspace) {
        return '<dialog id="dialog-session-create"><article>'
            + '<header><p><strong data-i18n="new-session">New session</strong></p>'
            + '<button type="button" aria-label="Close" rel="prev" data-dialog-close></button></header>'
            + '<p role="alert" data-text="session-create-error"></p>'
            + this.#sessionFields(workspace.name, "", CANCEL, "")
            + "</article></dialog>";
    }

    /** @param {string} workspace @param {string} name @param {string} cancel @param {string} [title] */
    #sessionFields(workspace, name, cancel, title = "") {
        return '<form id="session-create" method="post" action="/sessions/new">'
            + `<input type="hidden" name="token" value="${randomUUID()}">`
            + `<input type="hidden" name="workspace" value="${escapeHtml(workspace)}" data-bind="value:workspace-name">`
            + `<input type="text" name="name" value="${escapeHtml(name)}" placeholder="Session name (optional)" aria-label="Session name" autocomplete="off" spellcheck="false">`
            + `<input type="text" name="title" value="${escapeHtml(title)}" placeholder="Session title (optional)" aria-label="Session title" autocomplete="off">`
            + `<footer>${cancel}<button type="submit" data-i18n="confirm">Confirm</button></footer></form>`;
    }

    /**
     * {§web-workspace-tabs} {§web-session-archive} Session management dialog opened by clicking the active session tab.
     * @param {{name: string}} workspace
     * @param {DirectorySession} session
     * @param {string} parentLine
     */
    #sessionManageDialog(workspace, session, parentLine) {
        const currentTitle = typeof session.title === "string" ? session.title : "";
        return '<dialog id="dialog-session-manage" aria-label="Session actions"><article>'
            + `<header><p><strong>#<span data-text="active-session-name">${escapeHtml(session.name)}</span></strong></p>`
            + '<button type="button" aria-label="Close" rel="prev" data-dialog-close></button></header>'
            + (parentLine ? `<p data-session-parent-line>${parentLine}</p>` : '<p data-session-parent-line hidden></p>')
            + '<form id="session-title" method="post" action="/sessions/title" data-session-title-form>'
            + `<input type="hidden" name="workspace" value="${escapeHtml(workspace.name)}" data-bind="value:workspace-name">`
            + `<input type="hidden" name="session" value="${escapeHtml(session.name)}" data-bind="value:active-session-name">`
            + '<fieldset role="group">'
            + `<input type="text" name="title" value="${escapeHtml(currentTitle)}" placeholder="Session title" aria-label="Session title" autocomplete="off" required>`
            + '<button type="submit" data-i18n="change-title">Change title</button>'
            + "</fieldset></form>"
            + '<p role="alert" data-text="session-manage-error"></p>'
            + '<div data-session-manage-actions>'
            + '<button type="button" data-session-fork data-i18n="fork-session">Fork session</button>'
            + '<form id="session-archive" method="post" action="/sessions/archive" data-session-archive-form>'
            + `<input type="hidden" name="workspace" value="${escapeHtml(workspace.name)}" data-bind="value:workspace-name">`
            + `<input type="hidden" name="session" value="${escapeHtml(session.name)}" data-bind="value:active-session-name">`
            + '<button type="submit" data-i18n="archive-session">Archive session</button></form>'
            + "</div></article></dialog>";
    }

    /** {§web-session-directory}
     * @param {DirectorySession} session
     * @param {ReadonlyMap<number, DirectorySession>} sessions
     */
    #parent(session, sessions) {
        if (session.parentSessionId === null) return null;
        const parent = sessions.get(session.parentSessionId);
        if (parent === undefined) throw new Error(`Session ${session.id} has an absent parent ${session.parentSessionId}.`);
        return parent;
    }

    /** {§web-session-directory} {§web-search} Session row identity inside a workspace card.
     * @param {{name: string, project_root: string | null}} workspace
     * @param {DirectorySession} session
     * @param {DirectorySession | null} parent
     * @param {number} [childrenCount]
     */
    #sessionIdentity(workspace, session, parent, childrenCount = 0) {
        const path = directoryPath({ kind: "session", workspace: workspace.name, session: session.name });
        const name = escapeHtml(session.name);
        const rawTitle = typeof session.title === "string" && session.title.trim() !== "" ? session.title.trim() : null;
        const rawPrompt = typeof session.openingPrompt === "string" && session.openingPrompt.trim() !== "" ? session.openingPrompt.trim() : null;
        const headline = rawTitle ?? rawPrompt ?? `#${session.name}`;
        const showHandle = headline !== `#${session.name}`;
        const titleAttr = rawTitle !== null ? ` data-session-title="${escapeHtml(rawTitle)}"` : "";
        const promptAttr = rawPrompt !== null ? ` data-session-prompt="${escapeHtml(rawPrompt)}"` : "";
        const link = path === null
            ? `<span data-session-link role="img" aria-label="Session"><span data-session-headline>${escapeHtml(headline)}</span></span>`
            : `<a data-session-link href="${escapeHtml(path)}" aria-label="${name}" title="Open #${name}"${titleAttr}${promptAttr}><span data-session-headline>${escapeHtml(headline)}</span></a>`;
        const handleBadge = showHandle ? `<small data-session-handle>#${name}</small>` : "";
        const parentName = parent === null ? "" : parent.origin === "model"
            ? this.#link(parent.name, { kind: "session", workspace: workspace.name, session: parent.name })
            : `<span>${escapeHtml(parent.name)}</span>`;
        const lineage = parent === null ? "" : `<span data-session-parent>${parentName} &gt; </span>`;
        const lifecycle = escapeHtml(session.lifecycle);
        const gates = (session.gates ?? 0) > 0
            ? `<small data-session-gates="${session.gates}" aria-label="${session.gates} awaiting input" title="${session.gates} awaiting input">${session.gates}</small>` : "";
        const children = childrenCount > 0
            ? `<small data-session-children="${childrenCount}" aria-label="${childrenCount} ${childrenCount === 1 ? "child" : "children"}" title="${childrenCount} ${childrenCount === 1 ? "child" : "children"}">${childrenCount}</small>` : "";
        const replyAt = typeof session.reply?.at === "number" && Number.isFinite(session.reply.at) ? new Date(session.reply.at).toISOString() : null;
        const time = replyAt === null ? "" : `<time data-session-time datetime="${replyAt}" title="${replyAt}">${replyAt.slice(0, 16).replace("T", " ")} UTC</time>`;
        const defaultExcerpt = typeof session.reply?.excerpt === "string" && session.reply.excerpt !== ""
            ? `${session.reply.excerpt}${session.reply.continued ? "…" : ""}` : "";
        const excerptText = typeof session.matchedExcerpt === "string" && session.matchedExcerpt !== ""
            ? session.matchedExcerpt
            : defaultExcerpt;
        const excerpt = excerptText === "" ? "" : `<small data-session-excerpt>${escapeHtml(excerptText)}</small>`;
        const unarchive = session.archived_at !== null
            ? `<form method="post" action="/sessions/unarchive" data-inline-unarchive><input type="hidden" name="workspace" value="${escapeHtml(workspace.name)}"><input type="hidden" name="session" value="${name}"><button type="submit" data-i18n="unarchive">Unarchive</button></form>`
            : "";
        const meta = time || unarchive ? `<span data-session-meta>${time}${unarchive}</span>` : "";
        return `<span data-session-identity><span data-lifecycle="${lifecycle}" role="img" aria-label="${lifecycle}" title="${lifecycle}"></span> `
            + `${lineage}${link}${handleBadge}${gates}${children}${meta}</span>`
            + excerpt;
    }

    /** {§web-session-directory} {§web-search} Render one workspace's non-draft model session hierarchy.
     * @param {{ readonly id: number, readonly name: string, readonly project_root: string | null }} workspace
     * @param {readonly (DirectorySession & { readonly workspaceId: number })[]} models
     * @param {ReadonlyMap<number, DirectorySession & { readonly workspaceId: number }>} allSessions
     */
    #workspaceSessionTree(workspace, models, allSessions) {
        if (models.length === 0) return "";
        const sorted = models.toSorted(orderByReply);
        const visibleIds = new Set(sorted.map(({ id }) => id));
        const children = Map.groupBy(
            sorted,
            ({ parentSessionId }) => parentSessionId !== null && visibleIds.has(parentSessionId) ? parentSessionId : null,
        );
        const background = sorted.filter((session) => {
            if (session.parentSessionId === null || visibleIds.has(session.parentSessionId)) return false;
            const parent = allSessions.get(session.parentSessionId) ?? null;
            return parent !== null && parent.origin !== "model";
        });
        const backgroundIds = new Set(background.map(({ id }) => id));
        const seenInTree = new Set();
        /** @param {readonly (DirectorySession & { readonly workspaceId: number })[]} entries @param {boolean} [isRootList] @returns {string} */
        const list = (entries, isRootList = false) => entries.length === 0 ? ""
            : `<ul${isRootList ? " data-workspace-sessions" : ""}>${entries.map((session) => {
                if (seenInTree.has(session.id)) throw new Error("Session directory holds shown model sessions that no shown root reaches.");
                seenInTree.add(session.id);
                const descendants = children.get(session.id) ?? [];
                const parent = session.parentSessionId !== null ? (allSessions.get(session.parentSessionId) ?? null) : null;
                const identity = this.#sessionIdentity(workspace, session, parent, descendants.length);
                const kind = escapeHtml(session.kind ?? (session.parentSessionId === null ? "root" : "work"));
                const replyAttr = session.reply ? ` data-reply-id="${session.reply.id}"` : "";
                const archivedAttr = session.archived_at !== null ? ' data-archived="true"' : "";
                const content = descendants.length === 0 ? `<header>${identity}</header>`
                    : `<details><summary>${identity}</summary>${list(descendants)}</details>`;
                return `<li data-directory-entry="session" data-session-key="${workspace.id}:${session.id}" data-session-kind="${kind}" data-workspace-name="${escapeHtml(workspace.name)}" data-lifecycle-state="${escapeHtml(session.lifecycle)}" data-gate-count="${session.gates ?? 0}"${replyAttr}${archivedAttr}><article aria-label="Session">${content}</article></li>`;
            }).join("")}</ul>`;
        const rootEntries = (children.get(null) ?? []).filter(({ id }) => !backgroundIds.has(id));
        const roots = list(rootEntries, true);
        const other = background.length === 0 ? "" : '<details data-workspace-background><summary data-i18n="background-work">Background work</summary>'
            + `${list(background)}</details>`;
        if (seenInTree.size !== sorted.length) {
            throw new Error("Session directory holds shown model sessions that no shown root reaches.");
        }
        return roots + other;
    }

    /**
     * {§web-search} Full-page workspace-grouped Search & Directory document (`/search/`).
     * @param {boolean} authenticated
     * @param {{
     *   listWorkspaces(): Promise<readonly DirectoryWorkspace[]>,
     *   listSessions(workspaceId: number): Promise<readonly DirectorySession[]>,
     *   readSessionOverview?: (args: { workspaceId?: number, limit: number, excerptChars: number }) => Promise<DirectoryOverview>,
     *   listSessionLoops?: (args: { workspaceId: number, sessionId: number }) => Promise<readonly { readonly prompt: string }[]>,
     *   listProviders?: () => { readonly aliases: readonly unknown[] },
     *   listModels?: (args: { limit?: number }) => { readonly total: number },
     *   readOperatorEnvironment?: () => Promise<unknown>,
     * }} port
     * @param {SearchQuery} [query]
     * @param {{ creationsAvailable?: boolean }} [options]
     */
    async search(authenticated, port, query = {}, { creationsAvailable = true } = {}) {
        if (this.#overviewSessions === null || this.#overviewExcerptChars === null) {
            throw new RequestError(503, "Search is unavailable because its configuration is invalid.");
        }
        const excerptChars = this.#overviewExcerptChars;
        const q = (query.q ?? "").trim();
        const qLower = q.toLowerCase();
        const wsFilter = query.workspace ?? "";
        const statusFilter = ["all", "active", "gated", "failed", "archived"].includes(query.status ?? "") ? (query.status ?? "all") : "all";
        const kindFilter = ["all", "root", "work"].includes(query.kind ?? "") ? (query.kind ?? "all") : "all";
        const showArchived = statusFilter === "archived";
        const isNarrowing = Boolean(qLower || wsFilter || statusFilter !== "all" || kindFilter !== "all");

        const overviewLimit = this.#overviewSessions;
        const allWorkspaces = await port.listWorkspaces();
        const wsById = new Map(allWorkspaces.map((ws) => [ws.id, ws]));
        const overview = typeof port.readSessionOverview === "function" && !showArchived && wsFilter === ""
            ? await port.readSessionOverview({
                limit: Number.MAX_SAFE_INTEGER,
                excerptChars,
            })
            : null;

        /** @type {Map<number, DirectorySession & { readonly workspaceId: number }>} */
        const sessionById = new Map();
        if (overview !== null) {
            for (const s of overview.sessions) {
                if (sessionById.has(s.id)) throw new Error("Session directory contains duplicate identities.");
                sessionById.set(s.id, {
                    id: s.id,
                    workspaceId: s.workspaceId,
                    name: s.name,
                    parentSessionId: s.parentSessionId,
                    origin: "model",
                    kind: s.kind ?? (s.parentSessionId === null ? "root" : "work"),
                    lifecycle: s.lifecycle,
                    gates: s.gates ?? 0,
                    ...(typeof s.title === "string" ? { title: s.title } : {}),
                    archived_at: null,
                    reply: s.reply,
                });
            }
            for (const s of overview.sessions) {
                if (s.parentSessionId !== null && !sessionById.has(s.parentSessionId)) {
                    sessionById.set(s.parentSessionId, {
                        id: s.parentSessionId,
                        workspaceId: s.workspaceId,
                        name: "_plurnk",
                        parentSessionId: null,
                        origin: "_plurnk",
                        lifecycle: "idle",
                        archived_at: null,
                    });
                }
            }
        } else {
            const targetWorkspaces = wsFilter
                ? allWorkspaces.filter(({ name }) => name === wsFilter)
                : allWorkspaces;
            for (const ws of targetWorkspaces) {
                const wsOverview = typeof port.readSessionOverview === "function" && ws.archived_at === null
                    ? await port.readSessionOverview({ workspaceId: ws.id, limit: Number.MAX_SAFE_INTEGER, excerptChars })
                    : null;
                const ovMap = new Map(wsOverview?.sessions.map((entry) => [entry.id, entry]) ?? []);
                const list = await port.listSessions(ws.id);
                const wsSessionsById = new Map(list.map((entry) => [entry.id, entry]));
                if (wsSessionsById.size !== list.length) throw new Error("Session directory contains duplicate identities.");
                for (const entry of list) {
                    this.#parent(entry, wsSessionsById);
                    if (sessionById.has(entry.id)) throw new Error("Session directory contains duplicate identities.");
                    const info = ovMap.get(entry.id);
                    const sessionTitle = info?.title ?? entry.title;
                    sessionById.set(entry.id, {
                        ...entry,
                        workspaceId: ws.id,
                        kind: info?.kind ?? entry.kind ?? (entry.parentSessionId === null ? "root" : "work"),
                        gates: info?.gates ?? entry.gates ?? 0,
                        ...(typeof sessionTitle === "string" ? { title: sessionTitle } : {}),
                        archived_at: entry.archived_at ?? ws.archived_at,
                        reply: info?.reply ?? entry.reply ?? null,
                    });
                }
            }
        }

        // Count shown-posture model children per parent so root sessions with child workers are never mistaken for empty drafts.
        const childParentsInPosture = new Set();
        for (const s of sessionById.values()) {
            if (s.origin !== "model" || s.parentSessionId === null) continue;
            const ws = wsById.get(s.workspaceId);
            if (!ws) continue;
            const isArchived = s.archived_at !== null || ws.archived_at !== null;
            if (showArchived ? !isArchived : isArchived) continue;
            childParentsInPosture.add(s.parentSessionId);
        }

        // Bound unfiltered overview after filtering untouched 0-loop drafts so empty drafts never consume overview slots or skew omitted counts.
        /** @type {Set<number> | null} */
        let heldNonDraftIds = null;
        let omittedCount = overview?.omitted ?? 0;
        if (overview !== null && !isNarrowing) {
            const rankedNonDraft = [...sessionById.values()]
                .filter((s) => {
                    if (s.origin !== "model") return false;
                    const ws = wsById.get(s.workspaceId);
                    if (!ws || ws.archived_at !== null || s.archived_at !== null) return false;
                    return !isUntouchedDraftSession(s, childParentsInPosture.has(s.id));
                })
                .toSorted((a, b) => a.reply != null && b.reply != null ? b.reply.id - a.reply.id
                    : a.reply != null ? -1 : b.reply != null ? 1 : b.id - a.id);
            const held = rankedNonDraft.filter((s, index) => index < overviewLimit || (s.gates ?? 0) > 0);
            heldNonDraftIds = new Set(held.map(({ id }) => id));
            omittedCount += rankedNonDraft.length - held.length;
        }

        /** @type {Map<number, readonly string[]>} */
        const promptsBySessionId = new Map();
        if (typeof port.listSessionLoops === "function") {
            const loopTargets = [...sessionById.values()].filter((s) => {
                if (s.origin !== "model" || s.lifecycle === "idle") return false;
                if (heldNonDraftIds !== null && !heldNonDraftIds.has(s.id)) return false;
                const ws = wsById.get(s.workspaceId);
                if (!ws || (wsFilter && ws.name !== wsFilter)) return false;
                const isArchived = s.archived_at !== null || ws.archived_at !== null;
                return showArchived ? isArchived : !isArchived;
            });
            const loopLists = await Promise.all(
                loopTargets.map(async (s) => {
                    try {
                        const loops = await port.listSessionLoops?.({ workspaceId: s.workspaceId, sessionId: s.id }) ?? [];
                        return /** @type {const} */ ([s.id, loops.map((l) => l.prompt).filter((p) => typeof p === "string" && p.trim() !== "")]);
                    } catch {
                        return /** @type {const} */ ([s.id, /** @type {readonly string[]} */ ([])]);
                    }
                }),
            );
            for (const [sid, prompts] of loopLists) {
                promptsBySessionId.set(sid, prompts);
                const first = prompts[0];
                const cur = sessionById.get(sid);
                if (first && cur) {
                    sessionById.set(sid, { ...cur, openingPrompt: truncateSingleLine(first, excerptChars) });
                }
            }
        }

        const suggestionTerms = new Set();
        for (const ws of allWorkspaces) {
            if (showArchived ? ws.archived_at !== null : ws.archived_at === null) suggestionTerms.add(ws.name);
        }
        for (const s of sessionById.values()) {
            if (s.origin !== "model") continue;
            const ws = wsById.get(s.workspaceId);
            const isArchived = s.archived_at !== null || ws?.archived_at !== null;
            if (showArchived ? !isArchived : isArchived) continue;
            if (isUntouchedDraftSession(s, childParentsInPosture.has(s.id))) continue;
            suggestionTerms.add(s.name);
            if (typeof s.title === "string" && s.title) suggestionTerms.add(s.title);
        }

        /** @type {Map<number, (DirectorySession & { readonly workspaceId: number })[]>} */
        const sessionsByWorkspace = new Map();
        for (const s of sessionById.values()) {
            if (s.origin !== "model") continue;
            if (heldNonDraftIds !== null && !heldNonDraftIds.has(s.id)) continue;
            const ws = wsById.get(s.workspaceId);
            if (!ws) continue;
            if (wsFilter && ws.name !== wsFilter) continue;
            const isArchived = s.archived_at !== null || ws.archived_at !== null;
            if (showArchived ? !isArchived : isArchived) continue;
            if (isUntouchedDraftSession(s, childParentsInPosture.has(s.id))) continue;
            if (statusFilter === "active" && !["queued", "running", "parked"].includes(s.lifecycle)) continue;
            if (statusFilter === "gated" && (s.gates ?? 0) === 0) continue;
            if (statusFilter === "failed" && s.lifecycle !== "failed") continue;
            const kind = s.kind ?? (s.parentSessionId === null ? "root" : "work");
            if (kindFilter === "root" && kind === "work") continue;
            if (kindFilter === "work" && kind !== "work") continue;
            /** @type {string | undefined} */
            let matchedExcerpt;
            if (qLower) {
                const prompts = promptsBySessionId.get(s.id) ?? [];
                const baseHay = [ws.name, ws.project_label ?? "", s.name, s.title ?? "", s.openingPrompt ?? "", s.reply?.excerpt ?? ""].join("\n").toLowerCase();
                const matchedPrompt = prompts.find((p) => p.toLowerCase().includes(qLower));
                if (!baseHay.includes(qLower) && !matchedPrompt) continue;
                if (matchedPrompt && !(s.reply?.excerpt ?? "").toLowerCase().includes(qLower)) {
                    matchedExcerpt = matchSnippet(matchedPrompt, qLower, excerptChars);
                }
            }
            const bucket = sessionsByWorkspace.get(ws.id) ?? [];
            bucket.push({
                ...s,
                ...(matchedExcerpt ? { matchedExcerpt } : {}),
                archived_at: isArchived ? (s.archived_at ?? ws.archived_at ?? "archived") : null,
            });
            sessionsByWorkspace.set(ws.id, bucket);
        }

        const candidateWorkspaces = allWorkspaces.filter((ws) => {
            if (wsFilter && ws.name !== wsFilter) return false;
            const wsSessions = sessionsByWorkspace.get(ws.id) ?? [];
            if (showArchived) {
                if (ws.archived_at === null && wsSessions.length === 0) return false;
            } else if (ws.archived_at !== null) {
                return false;
            }
            if (statusFilter !== "all" && statusFilter !== "archived" && wsSessions.length === 0) return false;
            if (kindFilter !== "all" && wsSessions.length === 0) return false;
            if (qLower) {
                const wsHay = `${ws.name}\n${ws.project_label ?? ""}`.toLowerCase();
                if (!wsHay.includes(qLower) && wsSessions.length === 0) return false;
            }
            return true;
        });

        // Order workspaces by most recent session reply, then active sessions, then daemon order.
        const maxReplyByWs = new Map(candidateWorkspaces.map((ws) => {
            const wsSessions = sessionsByWorkspace.get(ws.id) ?? [];
            let maxReply = -1;
            for (const s of wsSessions) {
                if (s.reply && s.reply.id > maxReply) maxReply = s.reply.id;
            }
            return [ws.id, maxReply];
        }));
        const orderedWorkspaces = candidateWorkspaces.toSorted((a, b) => {
            const aMax = maxReplyByWs.get(a.id) ?? -1;
            const bMax = maxReplyByWs.get(b.id) ?? -1;
            if (aMax !== bMax) return bMax - aMax;
            const aCount = sessionsByWorkspace.get(a.id)?.length ?? 0;
            const bCount = sessionsByWorkspace.get(b.id)?.length ?? 0;
            if ((aCount > 0) !== (bCount > 0)) return aCount > 0 ? -1 : 1;
            return 0;
        });

        const statusOption = (/** @type {string} */ val, /** @type {string} */ label) =>
            `<option value="${val}"${statusFilter === val ? " selected" : ""}>${label}</option>`;
        const datalistOptions = [...suggestionTerms].slice(0, 100)
            .map((term) => `<option value="${escapeHtml(term)}"></option>`).join("");

        const controlsHtml = '<form id="search-controls" method="get" action="/search/" aria-label="Search workspaces and sessions">'
            + `<input type="search" name="q" list="search-suggestions" data-overview-search value="${escapeHtml(q)}" placeholder="Search workspaces and sessions…" aria-label="Search workspaces and sessions" autocomplete="off">`
            + `<datalist id="search-suggestions">${datalistOptions}</datalist>`
            + (wsFilter ? `<input type="hidden" name="workspace" value="${escapeHtml(wsFilter)}" data-search-workspace>` : "")
            + (kindFilter !== "all" ? `<input type="hidden" name="kind" value="${escapeHtml(kindFilter)}" data-search-kind>` : "")
            + `<select name="status" data-overview-scope aria-label="Status filter">${statusOption("all", "All statuses")}${statusOption("active", "Active")}${statusOption("gated", "Needs input")}${statusOption("failed", "Failed")}${statusOption("archived", "Archived")}</select>`
            + '<button type="submit" data-search-submit data-i18n="filter">Filter</button>'
            + "</form>";

        const workspaceItems = orderedWorkspaces.map((ws) => {
            // {§web-workspace-folder}
            const separateFolder = ws.project_label !== null && ws.project_label !== ws.name;
            const folderNote = separateFolder ? ` <small data-text="project-label">${escapeHtml(ws.project_label)}</small>` : "";
            const unarchive = ws.archived_at !== null
                ? `<form method="post" action="/workspaces/unarchive" data-inline-unarchive><input type="hidden" name="workspace" value="${escapeHtml(ws.name)}"><button type="submit" data-i18n="unarchive">Unarchive</button></form>`
                : "";
            const wsSessions = sessionsByWorkspace.get(ws.id) ?? [];
            const treeHtml = this.#workspaceSessionTree(ws, wsSessions, sessionById);
            return `<li data-directory-entry="workspace" data-workspace-id="${ws.id}" data-workspace-name="${escapeHtml(ws.name)}" data-folder="${ws.project_root !== null}"${ws.archived_at !== null ? ' data-archived="true"' : ""}>`
                + `<article aria-label="${ws.project_root === null ? "Folderless workspace" : "Project workspace"}">`
                + `<header>${this.#link(ws.name, { kind: "workspace", workspace: ws.name })}${folderNote}${unarchive}</header>`
                + `${treeHtml}</article></li>`;
        }).join("");

        const omitted = omittedCount > 0 && !isNarrowing
            ? `<p data-overview-omitted><small><span data-text="overview-omitted">${omittedCount}</span> <span data-i18n="older-sessions-omitted">older sessions omitted — search to narrow.</span></small></p>`
            : "";

        const hasAnyWorkspaceInPosture = allWorkspaces.some((ws) => showArchived ? ws.archived_at !== null : ws.archived_at === null);
        const emptyDirectoryHtml = !hasAnyWorkspaceInPosture && !isNarrowing
            ? '<p data-i18n="no-workspaces">No matching workspaces.</p>'
            : '<p data-i18n="no-sessions">No matching sessions.</p>';
        const workspacesSection = `<section id="search-workspaces" aria-label="Workspaces">${workspaceItems ? `<ul>${workspaceItems}</ul>` : emptyDirectoryHtml}${omitted}</section>`;

        const needsOnboarding = detectNeedsOnboarding(port);
        const switcherTrigger = `<button type="button" data-dialog-target="dialog-workspaces" aria-label="Change workspace" title="Change workspace">${WORKSPACES_ICON}</button>`;
        const headerLead = this.#headerLead({
            placeHtml: `<div id="header-place">${switcherTrigger}<span aria-current="page" data-i18n="search">Search</span></div>`,
        });
        const live = typeof port.readSessionOverview === "function";
        const mainAttributes = `${live ? ` data-auth="${authenticated ? "session" : "none"}" data-connection="initial"` : ""}${needsOnboarding ? ' data-needs-onboarding="true"' : ""}`;
        const dialogs = this.#workspacesDialog(allWorkspaces, null, creationsAvailable)
            + (creationsAvailable ? this.#creationForm() : "");
        return this.#render("Search", controlsHtml + workspacesSection, "search", authenticated, {
            headerLead,
            dialogs,
            mainAttributes,
        });
    }

    /** {§web-session-observer} Identity and navigation belong to the document; status arrives through ACP.
     * @param {import("./directory-addresses.js").Directory & {kind: "session"}} directory @param {number} workspaceId @param {boolean} authenticated
     * @param {boolean} automatic @param {boolean} [needsOnboarding]
     */
    #sessionStatus(directory, workspaceId, authenticated, automatic, needsOnboarding = false) {
        const path = directoryPath(directory);
        if (path === null) throw new Error("An admitted session must have a directory address.");
        const modelsHref = workspaceSettingsPath(directory.workspace, directory.session, "models") ?? path;
        const footer = `<footer id="session-status" aria-label="Session status" data-workspace-id="${workspaceId}" data-session-id="${workspaceId}#${escapeHtml(directory.session)}"`
            + ` data-session-name="${escapeHtml(directory.session)}" data-auth="${authenticated ? "session" : "none"}" data-connection="initial"${needsOnboarding ? ' data-needs-onboarding="true"' : ""}>`
            + '<p role="status" data-text="connection-label">Not connected.</p><noscript><p data-i18n="live-status-needs-js">Live status requires JavaScript.</p></noscript>'
            + '<div data-status-line><ul aria-label="Model controls">'
            + `<li data-status-field="yolo"><button type="button" id="session-yolo" aria-pressed="${automatic}" aria-label="Automatic approval" title="${automatic ? "Auto" : "Manual"} Approval (Shift+Tab · /yolo)"><span data-text="yolo-label">${automatic ? "Auto-approve" : "Review"}</span></button></li>`
            + `<li data-status-field="model" data-bind="aria-label:model-label title:model-label"><a id="session-model" href="${escapeHtml(modelsHref)}" data-bind="href:models-settings-path" aria-label="Model"><span data-text="model">No model</span></a><a id="session-effort" href="${escapeHtml(modelsHref)}" data-bind="href:models-settings-path" aria-label="Effort"><span data-text="effort"></span></a></li></ul>`
            + '<div data-status-telemetry>'
            + '<ul aria-label="Active session activity">'
            + '<li data-status-field="lifecycle" data-bind="aria-label:lifecycle title:lifecycle"></li>'
            + '<li data-status-field="elapsed" aria-label="Latest loop elapsed time" title="Latest loop elapsed time"><time data-text="elapsed"></time></li>'
            + '<li data-status-field="descendants"><details id="session-descendants"><summary data-bind="aria-label:descendants-label title:descendants-label"><span data-text="descendants">0</span></summary><ul></ul></details></li>'
            + '<li data-status-field="gated" data-bind="aria-label:gated-label title:gated-label"><span data-text="gated">0</span></li>'
            + '<li data-status-field="wait"><span data-i18n="wait-remaining">updates in</span> <time data-text="wait" data-bind="datetime:wait-at title:wait-at"></time></li>'
            + '<li data-status-field="inbox" data-bind="aria-label:inbox-label title:inbox-label"><span data-text="inbox">0</span></li>'
            + '<li data-status-field="preparation" data-text="preparation"></li>'
            + '<li data-status-field="activity" data-text="activity" data-bind="title:activity-message"></li>'
            + "</ul>"
            + '<details id="session-usage"><summary aria-label="Session usage and cost" title="Session usage and cost"><span aria-hidden="true">ⓘ</span> <span data-usage-context data-text="context-high"></span></summary>'
            + '<ul aria-label="Session statistics">'
            + '<li data-status-field="usage" data-bind="aria-label:usage-label title:usage-label"><span data-text="input">?</span> <span data-text="output">?</span></li>'
            + '<li data-status-field="context" data-bind="aria-label:context-label title:context-label"><span data-text="context"></span></li>'
            + '<li data-status-field="cost" data-text="cost" data-bind="aria-label:cost-label title:cost-label">?</li>'
            + "</ul></details></div></div></footer>";
        const content = '<article id="session-connection" role="alert"><header><span><span aria-hidden="true">⚠️</span> <span data-text="connection-label">Not connected.</span></span>'
            + `<form id="session-reconnect" action="${escapeHtml(path)}" data-bind="action:session-path" data-reconnect><button type="submit" data-i18n="reconnect">Reconnect</button></form>`
            + `<a data-sign-in href="${escapeHtml(`/auth/login?return=${encodeURIComponent(path)}`)}" data-bind="href:sign-in-path" data-i18n="sign-in">Sign in</a></header>`
            + '<p data-text="connection-detail">Displayed values are no longer live.</p></article>'
            + '<section id="session-diagnostics" aria-label="Diagnostics"><ul></ul></section>'
            + '<section id="session-conversation" aria-label="Conversation">'
            + '<p data-empty-conversation data-i18n="no-messages">No messages.</p>'
            + '<noscript><p data-i18n="conversation-needs-js">Conversation requires JavaScript.</p></noscript>'
            + '<ul data-messages></ul></section>';
        return { content, footer };
    }

    /** {§web-workspace-tabs} Unified browser-style session tab strip across mobile, tablet, and desktop.
     * @param {DirectoryWorkspace} workspace
     * @param {readonly DirectorySession[]} sessions
     * @param {ReadonlyMap<number, DirectorySession>} byId
     * @param {ReadonlyMap<number, DirectoryOverviewSession>} overviewById
     * @param {string | null} selectedSession
     * @param {boolean} authenticated
     * @param {boolean} live
     * @param {boolean} automatic
     * @param {boolean} needsOnboarding
     * @param {boolean} creationsAvailable
     */
    #workspaceTabs(workspace, sessions, byId, overviewById, selectedSession, authenticated, live, automatic, needsOnboarding, creationsAvailable) {
        const workspacePath = directoryPath({ kind: "workspace", workspace: workspace.name });
        if (workspacePath === null) return "";
        const enriched = sessions
            .filter(({ origin }) => origin === "model")
            .map((entry) => {
                const info = overviewById.get(entry.id);
                const resolvedTitle = info?.title ?? entry.title;
                return {
                    ...entry,
                    kind: info?.kind ?? entry.kind ?? (entry.parentSessionId === null ? "root" : "work"),
                    gates: info?.gates ?? entry.gates ?? 0,
                    ...(typeof resolvedTitle === "string" ? { title: resolvedTitle } : {}),
                    reply: info?.reply ?? entry.reply ?? null,
                };
            });
        const unarchived = enriched.filter((entry) => {
            if (entry.archived_at !== null) return false;
            const visited = new Set([entry.id]);
            /** @type {DirectorySession} */
            let cursor = entry;
            while (cursor.parentSessionId !== null) {
                if (visited.has(cursor.parentSessionId)) return false;
                visited.add(cursor.parentSessionId);
                const parent = byId.get(cursor.parentSessionId);
                if (!parent || parent.archived_at !== null) return false;
                cursor = parent;
            }
            return true;
        }).toSorted((a, b) => a.id - b.id);
        const unarchivedIds = new Set(unarchived.map(({ id }) => id));
        const childrenByParent = Map.groupBy(
            unarchived,
            (entry) => entry.parentSessionId !== null && unarchivedIds.has(entry.parentSessionId) ? entry.parentSessionId : null,
        );
        /** @type {typeof enriched} */
        const ordered = [];
        /** @param {number | null} parentId */
        const visit = (parentId) => {
            for (const entry of childrenByParent.get(parentId) ?? []) {
                ordered.push(entry);
                visit(entry.id);
            }
        };
        visit(null);
        const hasChildrenSet = new Set(unarchived.flatMap(({ parentSessionId }) => parentSessionId === null ? [] : [parentSessionId]));
        const visible = ordered.filter((entry) => {
            if (entry.name === selectedSession) return true;
            if (isUntouchedDraftSession(entry, hasChildrenSet.has(entry.id))) return false;
            if (entry.parentSessionId === null || entry.kind === "root" || entry.kind === "fork") return true;
            return ["queued", "running", "parked", "failed"].includes(entry.lifecycle) || (entry.gates ?? 0) > 0;
        });
        if (selectedSession !== null && !visible.some(({ name }) => name === selectedSession)) {
            const direct = enriched.find(({ name }) => name === selectedSession);
            if (direct) visible.push(direct);
        }
        /** @param {(typeof ordered)[number]} entry */
        const renderTabItem = (entry) => {
            const sessionPath = directoryPath({ kind: "session", workspace: workspace.name, session: entry.name });
            if (sessionPath === null) return [];
            const name = escapeHtml(entry.name);
            const kind = escapeHtml(entry.kind);
            const lifecycle = escapeHtml(entry.lifecycle);
            const current = entry.name === selectedSession ? ' aria-current="true"' : "";
            const gates = entry.gates ?? 0;
            const gatesBadge = gates > 0
                ? `<small data-session-gates="${gates}" aria-label="${gates} awaiting input" title="${gates} awaiting input">${gates}</small>`
                : "";
            const parent = this.#parent(entry, byId);
            const parentAttr = entry.parentSessionId !== null
                ? ` data-parent-id="${entry.parentSessionId}"`
                    + (parent ? ` data-parent-name="${escapeHtml(parent.name)}" data-parent-origin="${escapeHtml(parent.origin)}"` : "")
                : "";
            const isDraft = isUntouchedDraftSession(entry, hasChildrenSet.has(entry.id));
            const draftAttr = isDraft ? ' data-tab-draft="true"' : "";
            const sessionTitle = typeof entry.title === "string" && entry.title.trim() !== "" ? entry.title.trim() : null;
            const titleAttr = sessionTitle !== null ? ` data-session-title="${escapeHtml(sessionTitle)}"` : "";
            const tabLabel = sessionTitle ?? `#${entry.name}`;
            const hoverTitle = sessionTitle !== null
                ? `${sessionTitle} (#${entry.name} · ${entry.lifecycle})`
                : `#${entry.name} (${entry.lifecycle})`;
            const replyAttr = entry.reply !== null ? ` data-reply-id="${entry.reply.id}"` : "";
            const archivedAttr = entry.archived_at !== null ? ' data-archived="true"' : "";
            return [`<li data-tab-id="${workspace.id}:${entry.id}" data-session-kind="${kind}"${draftAttr}${titleAttr}${parentAttr}${replyAttr}${archivedAttr}>`
                + `<a href="#${encodeURIComponent(entry.name)}" data-workspace-route="session" data-tab-session="${name}" title="${escapeHtml(hoverTitle)}"${current}>`
                + `<span data-lifecycle="${lifecycle}" aria-hidden="true"></span>`
                + `<span data-tab-label>${escapeHtml(tabLabel)}</span>${gatesBadge}</a></li>`];
        };
        const visibleSet = new Set(visible.map(({ id }) => id));
        const items = visible.flatMap(renderTabItem);
        const archivedEntries = enriched.filter(({ id }) => !unarchivedIds.has(id) && !visibleSet.has(id));
        const folded = [...ordered.filter(({ id }) => !visibleSet.has(id)), ...archivedEntries].map((entry) => {
            const parent = this.#parent(entry, byId);
            const isArchived = !unarchivedIds.has(entry.id) || entry.archived_at !== null;
            return {
                id: entry.id,
                name: entry.name,
                parentSessionId: entry.parentSessionId,
                parentName: parent?.name ?? null,
                parentOrigin: parent?.origin ?? null,
                kind: entry.kind,
                lifecycle: entry.lifecycle,
                gates: entry.gates ?? 0,
                ...(typeof entry.title === "string" && entry.title.trim() !== "" ? { title: entry.title.trim() } : {}),
                replyId: entry.reply?.id ?? null,
                ...(isArchived ? { archived: true } : {}),
            };
        });
        const foldedAttr = folded.length > 0 ? ` data-folded-sessions="${escapeHtml(JSON.stringify(folded))}"` : "";
        const wsArchivedAttr = workspace.archived_at !== null ? ' data-workspace-archived="true"' : "";
        const newTabForm = creationsAvailable && workspace.archived_at === null
            ? `<form method="post" action="/sessions/new" data-tab-new><input type="hidden" name="token" value="${randomUUID()}"><input type="hidden" name="workspace" value="${escapeHtml(workspace.name)}"><button type="submit" data-action="new-session" aria-label="New session" title="New session">+</button></form>`
            : "";
        const archivesButton = '<button type="button" data-open-sessions aria-label="Sessions and archives" title="Sessions and archives (Ctrl+K)">☰</button>';
        return `<nav id="workspace-tabs" aria-label="Workspace sessions" data-workspace-id="${workspace.id}" data-workspace-name="${escapeHtml(workspace.name)}" data-auth="${authenticated ? "session" : "none"}" data-tab-count="${items.length}" data-initial-yolo="${automatic}"${needsOnboarding ? ' data-needs-onboarding="true"' : ""}${live ? ' data-live="true"' : ""}${wsArchivedAttr}${foldedAttr}>`
            + `${newTabForm}${archivesButton}<ul>${items.join("")}</ul>`
            + "</nav>";
    }

    /**
     * {§web-directory-documents} Render the workspace chat workbench (`GET /~/<workspace>`).
     * @param {import("./directory-addresses.js").Directory & { kind: "workspace" | "session" }} directory
     * @param {{
     *   listWorkspaces(): Promise<readonly DirectoryWorkspace[]>,
     *   listSessions(workspaceId: number): Promise<readonly DirectorySession[]>,
     *   readSessionOverview?: (args: { workspaceId?: number, limit: number, excerptChars: number }) => Promise<DirectoryOverview>,
     *   listProviders?: () => { readonly aliases: readonly unknown[] },
     *   listModels?: (args: { limit?: number }) => { readonly total: number },
     *   readOperatorEnvironment?: () => Promise<unknown>,
     * }} port
     * @param {boolean} authenticated
     * @param {{ own?: boolean, preferredSessionId?: number | null, creationsAvailable?: boolean, onSelected?: (workspace: DirectoryWorkspace, selectedSession: DirectorySession | null) => void }} [options]
     * @returns {Promise<Buffer | null>}
     */
    async read(directory, port, authenticated, { own = false, preferredSessionId = null, creationsAvailable = true, onSelected } = {}) {
        const workspaces = await port.listWorkspaces();
        const workspace = workspaces.find(({ name }) => name === directory.workspace);
        if (workspace === undefined) return null;
        if (this.#yolo === null) {
            throw new RequestError(503, "Session pages are unavailable because their configuration is invalid.");
        }
        const sessions = await port.listSessions(workspace.id);
        const byId = new Map(sessions.map((entry) => [entry.id, entry]));
        if (byId.size !== sessions.length) throw new Error("Session directory contains duplicate identities.");
        for (const entry of sessions) {
            const visited = new Set([entry.id]);
            /** @type {DirectorySession} */
            let cursor = entry;
            while (cursor.parentSessionId !== null) {
                if (visited.has(cursor.parentSessionId)) {
                    throw new Error("Session directory holds shown model sessions that no shown root reaches.");
                }
                visited.add(cursor.parentSessionId);
                const next = this.#parent(cursor, byId);
                if (next === null) break;
                cursor = next;
            }
        }
        const live = typeof port.readSessionOverview === "function";
        const overview = typeof port.readSessionOverview === "function" && this.#overviewExcerptChars !== null
            ? await port.readSessionOverview({ workspaceId: workspace.id, limit: Number.MAX_SAFE_INTEGER, excerptChars: this.#overviewExcerptChars })
            : null;
        const overviewById = new Map(overview?.sessions.map((entry) => [entry.id, entry]) ?? []);
        const modelSessions = sessions
            .filter(({ origin }) => origin === "model")
            .map((entry) => {
                const info = overviewById.get(entry.id);
                const resolvedTitle = info?.title ?? entry.title;
                return {
                    ...entry,
                    kind: info?.kind ?? entry.kind ?? (entry.parentSessionId === null ? "root" : "work"),
                    gates: info?.gates ?? entry.gates ?? 0,
                    ...(typeof resolvedTitle === "string" ? { title: resolvedTitle } : {}),
                    reply: info?.reply ?? entry.reply ?? null,
                };
            });

        /** @type {DirectorySession | undefined} */
        let selected;
        if (directory.kind === "session") {
            selected = modelSessions.find(({ name }) => name === directory.session);
            if (selected === undefined) return null;
        } else {
            if (preferredSessionId !== null) {
                selected = modelSessions.find(({ id, archived_at }) => id === preferredSessionId && archived_at === null);
            }
            if (selected === undefined) {
                const unarchivedModel = modelSessions.filter(({ archived_at }) => archived_at === null);
                const childParents = new Set(unarchivedModel.flatMap(({ parentSessionId }) => parentSessionId === null ? [] : [parentSessionId]));
                const unarchivedRoots = unarchivedModel
                    .filter(({ parentSessionId }) => parentSessionId === null)
                    .toSorted((a, b) => orderByReply(a, b) || a.id - b.id);
                const nonDraftRoots = unarchivedRoots.filter((entry) => !isUntouchedDraftSession(entry, childParents.has(entry.id)));
                const candidateRoots = nonDraftRoots.length > 0 ? nonDraftRoots : unarchivedRoots;
                selected = candidateRoots.find(({ reply }) => reply != null)
                    ?? candidateRoots.find(({ name }) => name === "session1")
                    ?? candidateRoots[0]
                    ?? unarchivedModel.toSorted((a, b) => orderByReply(a, b) || a.id - b.id)[0]
                    ?? modelSessions[0];
            }
        }

        // {§web-workspace-folder}
        const effectiveProject = workspace.project_label ?? workspace.project_root;
        const folder = workspace.project_label !== null && workspace.project_label !== workspace.name ? workspace.project_label : "";
        const iconLabel = effectiveProject === null ? "Folderless workspace" : "Project workspace";
        const iconGlyph = effectiveProject !== null ? "🗂️" : "☁️";
        const marker = `<span role="img" aria-label="${iconLabel}" data-bind="aria-label:workspace-icon-label" data-text="workspace-icon">${iconGlyph}</span>`;
        const switcherTrigger = `<button type="button" data-dialog-target="dialog-workspaces" aria-label="Change workspace" title="Change workspace">${WORKSPACES_ICON}</button>`;
        const settingsHref = workspaceSettingsPath(workspace.name, selected?.name ?? null);
        const workspaceSettingsTrigger = settingsHref !== null
            ? `<a id="session-workspace" href="${escapeHtml(settingsHref)}" data-bind="href:workspace-settings-path" aria-label="Workspace settings" title="Workspace settings">${marker} <span data-text="workspace-name">${escapeHtml(workspace.name)}</span></a>`
            : `<span id="session-workspace">${marker} <span data-text="workspace-name">${escapeHtml(workspace.name)}</span></span>`;
        const placeHtml = `<div id="header-place">${switcherTrigger}${workspaceSettingsTrigger}</div>`;
        const headerLead = this.#headerLead({ placeHtml });
        const sharedWsDialogs = this.#workspacesDialog(workspaces, workspace.name, creationsAvailable)
            + (creationsAvailable ? this.#creationForm() : "");
        const needsOnboarding = detectNeedsOnboarding(port);
        const automatic = Boolean(this.#yolo && own);

        if (selected === undefined) {
            const tabs = this.#workspaceTabs(workspace, sessions, byId, overviewById, null, authenticated, live, automatic, needsOnboarding, creationsAvailable);
            const startForm = creationsAvailable && workspace.archived_at === null
                ? `<form method="post" action="/sessions/new" data-workspace-empty-new><input type="hidden" name="token" value="${randomUUID()}"><input type="hidden" name="workspace" value="${escapeHtml(workspace.name)}"><button type="submit" data-i18n="start-conversation">New session</button></form>`
                : "";
            const body = `<p id="session-folder" data-project-label="${escapeHtml(folder)}"><span role="img" aria-label="Project folder">🗂️</span> <span data-text="project-label">${escapeHtml(folder)}</span></p>`
                + `<article id="workspace-empty"><p data-i18n="no-sessions">No sessions in this workspace yet.</p>${startForm}</article>`;
            const dialogs = sharedWsDialogs + (creationsAvailable ? this.#sessionCreationForm(workspace) : "");
            onSelected?.(workspace, null);
            return this.#render(workspace.name, body, "workspace", authenticated, { headerLead, footer: tabs, dialogs });
        }

        const parent = this.#parent(selected, byId);
        const parentLabel = parent === null ? "" : parent.origin === "model"
            ? this.#link(parent.name, { kind: "session", workspace: workspace.name, session: parent.name })
            : `<span data-text="name">${escapeHtml(parent.name)}</span>`;
        const parentLine = parent === null ? "" : `<span data-i18n="parent-session">Parent:</span> ${parentLabel}`;
        const title = `${workspace.name}#${selected.name}`;
        const sessionDir = /** @type {const} */ ({ kind: "session", workspace: workspace.name, session: selected.name });
        const status = this.#sessionStatus(sessionDir, workspace.id, authenticated, automatic, needsOnboarding);
        const tabs = this.#workspaceTabs(workspace, sessions, byId, overviewById, selected.name, authenticated, live, automatic, needsOnboarding, creationsAvailable);
        const dialogs = sharedWsDialogs
            + this.#sessionManageDialog(workspace, selected, parentLine)
            + (creationsAvailable ? this.#sessionCreationForm(workspace) : "");
        const body = `<p id="session-folder" data-project-label="${escapeHtml(folder)}"><span role="img" aria-label="Project folder">🗂️</span> <span data-text="project-label">${escapeHtml(folder)}</span></p>`
            + status.content;
        onSelected?.(workspace, selected);
        return this.#render(title, body, "session", authenticated, {
            headerLead,
            footer: status.footer + tabs,
            dialogs,
            mainAttributes: ` data-session-name="${escapeHtml(selected.name)}"`,
        });
    }

    /**
     * {§web-workspace-settings} {§web-workspace-rename} {§web-workspace-archive} Dedicated workspace settings page (`GET /settings/?workspace=<name>`).
     * @param {string} workspaceName
     * @param {string | null} requestedSessionName
     * @param {{
     *   listWorkspaces(): Promise<readonly DirectoryWorkspace[]>,
     *   listSessions(workspaceId: number): Promise<readonly DirectorySession[]>,
     *   readSessionOverview?: unknown,
     * }} port
     * @param {boolean} authenticated
     * @returns {Promise<Buffer | null>}
     */
    async settings(workspaceName, requestedSessionName, port, authenticated) {
        const workspaces = await port.listWorkspaces();
        const workspace = workspaces.find(({ name }) => name === workspaceName);
        if (workspace === undefined) return null;
        if (directoryPath({ kind: "workspace", workspace: workspace.name }) === null) return null;
        const sessions = await port.listSessions(workspace.id);
        const activeSession = requestedSessionName
            ? (sessions.find(({ name, origin }) => name === requestedSessionName && origin === "model") ?? null)
            : null;
        const effectiveProject = workspace.project_label ?? workspace.project_root;
        const iconLabel = effectiveProject === null ? "Folderless workspace" : "Project workspace";
        const iconGlyph = effectiveProject !== null ? "🗂️" : "☁️";
        const marker = `<span role="img" aria-label="${iconLabel}" data-bind="aria-label:workspace-icon-label" data-text="workspace-icon">${iconGlyph}</span>`;
        const backPath = activeSession !== null
            ? directoryPath({ kind: "session", workspace: workspace.name, session: activeSession.name })
            : directoryPath({ kind: "workspace", workspace: workspace.name });
        const backItem = backPath !== null
            ? `<a href="${escapeHtml(backPath)}" data-settings-back data-bind="href:workspace-back-path">${marker} <span data-text="workspace-name">${escapeHtml(workspace.name)}</span></a>`
            : `<span>${marker} <span data-text="workspace-name">${escapeHtml(workspace.name)}</span></span>`;
        const placeHtml = '<nav id="header-place" aria-label="breadcrumb"><ul>'
            + `<li>${backItem}</li>`
            + '<li><span aria-current="page" data-i18n="settings">Settings</span></li></ul></nav>';
        const headerLead = this.#headerLead({ placeHtml });

        const folderLine = workspace.project_label !== null
            ? `<p data-settings-folder><span role="img" aria-label="Project folder">🗂️</span> <code data-text="project-label">${escapeHtml(workspace.project_label)}</code></p>`
            : "";
        const archiveSection = workspace.archived_at === null
            ? '<section aria-labelledby="settings-archive-heading">'
                + '<h2 id="settings-archive-heading" data-i18n="archive-workspace">Archive workspace</h2>'
                + '<form id="workspace-archive" method="post" action="/workspaces/archive">'
                + `<input type="hidden" name="workspace" value="${escapeHtml(workspace.name)}" data-bind="value:workspace-name">`
                + '<p data-i18n="archive-workspace-detail">Archiving removes the workspace from active views while keeping its files and history intact.</p>'
                + '<footer><button type="submit" data-i18n="archive-workspace">Archive workspace</button></footer></form></section>'
            : '<section aria-labelledby="settings-unarchive-heading">'
                + '<h2 id="settings-unarchive-heading" data-i18n="unarchive-workspace">Unarchive workspace</h2>'
                + '<form id="workspace-unarchive" method="post" action="/workspaces/unarchive">'
                + `<input type="hidden" name="workspace" value="${escapeHtml(workspace.name)}" data-bind="value:workspace-name">`
                + '<footer><button type="submit" data-i18n="unarchive">Unarchive</button></footer></form></section>';

        const navHtml = '<nav aria-label="Settings sections"><ul data-settings-nav>'
            + '<li><a href="#general" data-settings-section="general" aria-current="true" data-i18n="ws-settings-tab-general">General</a></li>'
            + '<li><a href="#models" data-settings-section="models" data-i18n="ws-settings-tab-models">Models</a></li>'
            + '<li><a href="#mcp" data-settings-section="mcp" data-i18n="ws-settings-tab-mcp">MCP</a></li>'
            + '<li><a href="#skills" data-settings-section="skills" data-i18n="ws-settings-tab-skills">Skills</a></li>'
            + '<li><a href="#schedule" data-settings-section="schedule" data-i18n="ws-settings-tab-schedule">Schedule</a></li>'
            + '<li><a href="#personas" data-settings-section="personas" data-i18n="ws-settings-tab-personas">Personas</a></li>'
            + '<li><a href="#members" data-settings-section="members" data-i18n="ws-settings-tab-members">Members</a></li>'
            + '<li><a href="#env" data-settings-section="env" data-i18n="ws-settings-tab-env">Environment</a></li>'
            + '<li><a href="#help" data-settings-section="help" data-i18n="ws-settings-tab-help">Help</a></li>'
            + "</ul></nav>";

        const generalPanel = '<section data-settings-panel="general" aria-label="General">'
            + folderLine
            + '<section aria-labelledby="settings-rename-heading">'
            + '<h2 id="settings-rename-heading" data-i18n="rename-workspace">Rename workspace</h2>'
            + this.#renameFields(workspace.name, workspace.name, "", activeSession?.name ?? "")
            + "</section>"
            + archiveSection
            + "</section>";

        const body = '<article id="workspace-settings" aria-labelledby="workspace-settings-title" data-bind="aria-busy:ws-settings-busy">'
            + '<header><h1 id="workspace-settings-title" data-i18n="settings">Settings</h1></header>'
            + navHtml
            + '<p role="status" data-text="ws-settings-message"></p>'
            + '<p data-text="ws-settings-recovery"></p>'
            + generalPanel
            + '<div data-settings-subsystems></div>'
            + "</article>";

        const live = typeof port.readSessionOverview === "function";
        const mainAttributes = ` data-workspace-id="${workspace.id}" data-workspace-name="${escapeHtml(workspace.name)}"`
            + (activeSession !== null ? ` data-session-name="${escapeHtml(activeSession.name)}"` : "")
            + ` data-auth="${authenticated ? "session" : "none"}"`
            + (live ? ' data-live="true"' : "");

        return this.#render(`${workspace.name} · Settings`, body, "settings", authenticated, {
            headerLead,
            mainAttributes,
        });
    }
}
