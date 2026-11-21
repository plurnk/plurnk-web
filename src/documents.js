import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { directoryPath } from "./directory-addresses.js";
import { escapeHtml, RequestError } from "./http.js";

// A dialog's dismissal; a form offered again on an error page has none.
const CANCEL = '<button type="button" data-dialog-close data-i18n="cancel">Cancel</button>';
const FOLDER_PLUS_ICON = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-8Z"/><path d="M8 7.25v3.5M6.25 9h3.5"/></svg>';
const CHAT_PLUS_ICON = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H6l-3.5 2.5v-10Z"/><path d="M8 5v3.5M6.25 6.75h3.5"/></svg>';
const SWITCHER_ICON = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h10M3 8h10M3 11h6"/></svg>';

/** @typedef {{ readonly id: number, readonly name: string, readonly project_root: string | null, readonly project_label: string | null, readonly archived_at: string | null }} DirectoryWorkspace */
/** @typedef {{ readonly id: number, readonly coordinate: string, readonly completion: 200 | 499, readonly at?: number, readonly excerpt?: string, readonly continued?: boolean }} DirectoryReply */
/** @typedef {{ readonly id: number, readonly name: string, readonly parentSessionId: number | null, readonly origin: string, readonly kind?: string, readonly lifecycle: string, readonly gates?: number, readonly title?: string | null, readonly archived_at: string | null, readonly reply?: DirectoryReply | null, readonly workspaceId?: number }} DirectorySession */
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

    /** @param {string} document @param {boolean | null} yolo @param {number | null} [overviewSessions] @param {number | null} [overviewExcerptChars] */
    constructor(document, yolo, overviewSessions = 200, overviewExcerptChars = 160) {
        this.#yolo = yolo;
        this.#overviewSessions = overviewSessions;
        this.#overviewExcerptChars = overviewExcerptChars;
        this.#template = compileDocumentSlots(document);
    }

    /**
     * @param {string} title
     * @param {string} body
     * @param {"home" | "search" | "workspace" | "session" | "error" | "account"} kind
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
     * {§web-page-shell} {§web-workspace-creation} {§web-session-creation} Header creation forms and center place display.
     * @param {{ canCreate?: boolean, workspaceName?: string | null, placeHtml?: string }} [options]
     */
    #headerLead({ canCreate = false, workspaceName = null, placeHtml = "" } = {}) {
        const newWorkspace = canCreate
            ? `<form method="post" action="/workspaces/new" data-header-form><input type="hidden" name="token" value="${randomUUID()}">`
                + `<button type="submit" data-action="new-workspace" aria-label="New workspace" title="New workspace">${FOLDER_PLUS_ICON} <span data-header-label data-i18n="new-workspace">New workspace</span></button></form>`
            : "";
        const newSession = canCreate && workspaceName !== null
            ? `<form method="post" action="/sessions/new" data-header-form data-new-session-form><input type="hidden" name="token" value="${randomUUID()}">`
                + `<input type="hidden" name="workspace" value="${escapeHtml(workspaceName)}" data-bind="value:workspace-name">`
                + `<button type="submit" data-action="new-session" aria-label="New session" title="New session">${CHAT_PLUS_ICON} <span data-header-label data-i18n="new-session">New session</span></button></form>`
            : "";
        const actions = newWorkspace || newSession ? `<div data-header-create>${newWorkspace}${newSession}</div>` : "";
        return actions + placeHtml;
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

    /** {§web-workspace-creation} The creation form a refused submission offers again, with its draft and a fresh token. @param {string} name @param {string} [projectRoot] */
    retryCreation(name, projectRoot = "") { return this.#creationFields(name, projectRoot, ""); }

    /** {§web-workspace-rename} @param {string} workspace @param {string} name @param {string} [session] */
    retryRename(workspace, name, session = "") { return this.#renameFields(workspace, name, "", session); }

    /** {§web-session-creation} @param {string} workspace @param {string} name */
    retrySession(workspace, name) { return this.#sessionFields(workspace, name, ""); }

    /** {§web-account} Account navigation stays separate from session management. */
    account() {
        const headerLead = this.#headerLead({ placeHtml: '<div id="header-place"><span aria-current="page" data-i18n="profile">Profile</span></div>' });
        return this.#render("Profile", '<article aria-labelledby="account-title"><header><h1 id="account-title" data-i18n="account">Account</h1></header>'
            + '<nav aria-label="Account"><ul><li><a href="/account/sessions/" data-i18n="sessions">Sessions</a></li></ul></nav></article>', "account", true, { headerLead });
    }

    /** {§web-account} Only authority-supplied facts are presented as session information.
     * @param {{ family: string, sessions: readonly Pick<import("@plurnk/plurnk-contracts").CredentialSession, "family" | "createdAt" | "expiresAt" | "clients">[] }} account
     */
    sessions({ family, sessions }) {
        const time = (/** @type {number} */ timestamp) => {
            const iso = new Date(timestamp).toISOString();
            return `<time datetime="${iso}" data-text="session-time">${iso.replace("T", " ").replace(/\.\d{3}Z$/u, " UTC")}</time>`;
        };
        const entries = sessions.map((entry) => {
            const current = entry.family === family;
            const action = current ? "/auth/logout" : `/account/sessions/${encodeURIComponent(entry.family)}/revoke`;
            return `<tr data-session="${escapeHtml(entry.family)}"><th scope="row"><span data-i18n="${current ? "this-session" : "another-session"}">${current ? "This session" : "Another session"}</span>`
                + `<br><small data-text="session-clients">${entry.clients.map(escapeHtml).join(", ")}</small></th>`
                + `<td>${time(entry.createdAt)}</td><td>${time(entry.expiresAt)}</td>`
                + `<td><form method="post" action="${escapeHtml(action)}"><button type="submit" data-i18n="${current ? "end-this-session" : "revoke-session"}">${current ? "End this session" : "Revoke session"}</button></form></td></tr>`;
        }).join("");
        const others = sessions.some((entry) => entry.family !== family)
            ? '<form method="post" action="/account/sessions/revoke-others"><button type="submit" data-i18n="revoke-others">Revoke other sessions</button></form>' : "";
        const placeHtml = '<nav id="header-place" aria-label="breadcrumb"><ul>'
            + '<li><a href="/account/" data-i18n="account">Account</a></li>'
            + '<li><span aria-current="page" data-i18n="sessions">Sessions</span></li></ul></nav>';
        return this.#render("Sessions", '<article aria-labelledby="sessions-title"><header><h1 id="sessions-title" data-i18n="sessions">Sessions</h1></header>'
            + '<figure><table><thead><tr><th scope="col" data-i18n="session">Session</th><th scope="col" data-i18n="started">Started</th>'
            + '<th scope="col" data-i18n="expires">Expires</th><th scope="col" data-i18n="actions">Actions</th></tr></thead>'
            + `<tbody>${entries}</tbody></table></figure>${others ? `<footer>${others}</footer>` : ""}</article>`, "account", true, { headerLead: this.#headerLead({ placeHtml }) });
    }

    /** @param {string} label @param {import("./directory-addresses.js").Directory} directory */
    #link(label, directory) {
        const path = directoryPath(directory);
        return path === null ? `<span data-text="name">${escapeHtml(label)}</span>`
            : `<a href="${escapeHtml(path)}" data-text="name"${directory.kind === "session" ? ` data-session-name="${escapeHtml(directory.session)}" data-bind="href:session-path"` : ""}>${escapeHtml(label)}</a>`;
    }

    /** {§web-workspace-creation} Native dialog modal for workspace creation (including local project folder binding). */
    #creationForm() {
        return '<dialog id="dialog-workspace-create"><article>'
            + '<header><p><strong data-i18n="new-workspace">New workspace</strong></p>'
            + '<button type="button" aria-label="Close" rel="prev" data-dialog-close></button></header>'
            + this.#creationFields("", "", CANCEL)
            + "</article></dialog>";
    }

    /** @param {string} name @param {string} projectRoot @param {string} cancel */
    #creationFields(name, projectRoot, cancel) {
        return '<form id="workspace-create" method="post" action="/workspaces/new">'
            + `<input type="hidden" name="token" value="${randomUUID()}">`
            + `<input type="text" name="name" value="${escapeHtml(name)}" placeholder="Workspace name (optional)" aria-label="Workspace name" aria-describedby="workspace-name-hint">`
            + '<small id="workspace-name-hint" data-i18n="workspace-name-hint">Leave it empty and the daemon names the workspace.</small>'
            + `<input type="text" name="projectRoot" value="${escapeHtml(projectRoot)}" placeholder="/path/to/project (optional)" aria-label="Project path" aria-describedby="workspace-project-hint">`
            + '<small id="workspace-project-hint" data-i18n="workspace-project-hint">Leave it empty for a folderless workspace, or enter a local directory path on the daemon host.</small>'
            + `<footer>${cancel}<button type="submit" data-i18n="confirm">Confirm</button></footer></form>`;
    }

    /**
     * {§web-workspace-rename} Native dialog modal for workspace rename with pre-populated current name.
     * @param {{name: string}} workspace
     * @param {string} [sessionName]
     */
    #renameForm(workspace, sessionName = "") {
        return '<dialog id="dialog-workspace-rename"><article>'
            + '<header><p><strong data-i18n="rename-workspace">Rename workspace</strong></p>'
            + '<button type="button" aria-label="Close" rel="prev" data-dialog-close></button></header>'
            + this.#renameFields(workspace.name, workspace.name, CANCEL, sessionName)
            + "</article></dialog>";
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
     * {§web-session-creation} Native dialog modal for named session creation.
     * @param {{name: string}} workspace
     */
    #sessionCreationForm(workspace) {
        return '<dialog id="dialog-session-create"><article>'
            + '<header><p><strong data-i18n="new-session">New session</strong></p>'
            + '<button type="button" aria-label="Close" rel="prev" data-dialog-close></button></header>'
            + this.#sessionFields(workspace.name, "", CANCEL)
            + "</article></dialog>";
    }

    /** @param {string} workspace @param {string} name @param {string} cancel */
    #sessionFields(workspace, name, cancel) {
        return '<form id="session-create" method="post" action="/sessions/new">'
            + `<input type="hidden" name="token" value="${randomUUID()}">`
            + `<input type="hidden" name="workspace" value="${escapeHtml(workspace)}" data-bind="value:workspace-name">`
            + `<input type="text" name="name" value="${escapeHtml(name)}" placeholder="Session name (optional)" aria-label="Session name" aria-describedby="session-name-hint">`
            + '<small id="session-name-hint" data-i18n="session-name-hint">Leave it empty and the daemon names the session.</small>'
            + `<footer>${cancel}<button type="submit" data-i18n="confirm">Confirm</button></footer></form>`;
    }

    /**
     * {§web-workspace-archive} Native dialog modal to archive the workspace.
     * @param {{name: string}} workspace
     */
    #workspaceArchiveForm(workspace) {
        return '<dialog id="dialog-workspace-archive"><article>'
            + '<header><p><strong data-i18n="archive-workspace">Archive workspace</strong></p>'
            + '<button type="button" aria-label="Close" rel="prev" data-dialog-close></button></header>'
            + '<form id="workspace-archive" method="post" action="/workspaces/archive">'
            + `<input type="hidden" name="workspace" value="${escapeHtml(workspace.name)}" data-bind="value:workspace-name">`
            + '<p data-i18n="archive-workspace-detail">Archiving removes the workspace from active views while keeping its files and history intact.</p>'
            + `<footer>${CANCEL}<button type="submit" data-i18n="confirm">Confirm</button></footer></form>`
            + "</article></dialog>";
    }

    /**
     * {§web-session-archive} Native dialog modal to archive the session and its subtree.
     * @param {{name: string}} workspace
     * @param {{name: string}} session
     */
    #sessionArchiveForm(workspace, session) {
        return '<dialog id="dialog-session-archive"><article>'
            + '<header><p><strong data-i18n="archive-session">Archive session</strong></p>'
            + '<button type="button" aria-label="Close" rel="prev" data-dialog-close></button></header>'
            + '<form id="session-archive" method="post" action="/sessions/archive">'
            + `<input type="hidden" name="workspace" value="${escapeHtml(workspace.name)}" data-bind="value:workspace-name">`
            + `<input type="hidden" name="session" value="${escapeHtml(session.name)}" data-bind="value:active-session-name">`
            + '<p data-i18n="archive-session-detail">Archiving removes the session and its descendants from active views without destroying history.</p>'
            + `<footer>${CANCEL}<button type="submit" data-i18n="confirm">Confirm</button></footer></form>`
            + "</article></dialog>";
    }

    /**
     * {§web-page-shell} Session management dialog opened by clicking `#<session>` in the header.
     * @param {{name: string}} workspace
     * @param {{name: string}} session
     * @param {string} parentLine
     */
    #sessionManageDialog(workspace, session, parentLine) {
        return '<dialog id="dialog-session-manage" aria-label="Session actions"><article>'
            + `<header><p><strong>#<span data-text="active-session-name">${escapeHtml(session.name)}</span></strong></p>`
            + '<button type="button" aria-label="Close" rel="prev" data-dialog-close></button></header>'
            + (parentLine ? `<p data-session-parent-line>${parentLine}</p>` : '<p data-session-parent-line hidden></p>')
            + '<div data-session-manage-actions>'
            + '<button type="button" data-session-fork data-i18n="fork-session">Fork session</button>'
            + '<button type="button" data-dialog-target="dialog-session-create" data-i18n="named-session">New named session…</button>'
            + '<button type="button" data-dialog-target="dialog-workspace-rename" data-i18n="rename-workspace">Rename workspace…</button>'
            + '<button type="button" data-dialog-target="dialog-session-archive" data-i18n="archive-session">Archive session…</button>'
            + '<button type="button" data-dialog-target="dialog-workspace-archive" data-i18n="archive-workspace">Archive workspace…</button>'
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

    /** {§web-session-directory} The same identity is a leaf header or a native disclosure summary.
     * @param {{name: string, project_root: string | null}} workspace
     * @param {DirectorySession} session
     * @param {DirectorySession | null} parent
     * @param {number} [childrenCount]
     */
    #sessionIdentity(workspace, session, parent, childrenCount = 0) {
        const path = directoryPath({ kind: "session", workspace: workspace.name, session: session.name });
        const name = escapeHtml(session.name);
        const ant = path === null ? '<span data-session-link role="img" aria-label="Session"></span>'
            : `<a data-session-link href="${escapeHtml(path)}" aria-label="${name}" title="Open #${name}"></a>`;
        const parentName = parent === null ? "" : parent.origin === "model"
            ? this.#link(parent.name, { kind: "session", workspace: workspace.name, session: parent.name })
            : `<span>${escapeHtml(parent.name)}</span>`;
        const lineage = parent === null ? "" : `<span data-session-parent>${parentName} &gt; </span>`;
        const lifecycle = escapeHtml(session.lifecycle);
        const title = typeof session.title === "string" && session.title !== ""
            ? `<small data-session-title>${escapeHtml(session.title)}</small>` : "";
        const gates = (session.gates ?? 0) > 0
            ? `<small data-session-gates="${session.gates}" aria-label="${session.gates} awaiting input" title="${session.gates} awaiting input">${session.gates}</small>` : "";
        const children = childrenCount > 0
            ? `<small data-session-children="${childrenCount}" aria-label="${childrenCount} ${childrenCount === 1 ? "child" : "children"}" title="${childrenCount} ${childrenCount === 1 ? "child" : "children"}">${childrenCount}</small>` : "";
        const folder = workspace.project_root !== null;
        const replyAt = typeof session.reply?.at === "number" && Number.isFinite(session.reply.at) ? new Date(session.reply.at).toISOString() : null;
        const time = replyAt === null ? "" : `<time data-session-time datetime="${replyAt}" title="${replyAt}">${replyAt.slice(0, 16).replace("T", " ")} UTC</time>`;
        const excerptText = typeof session.reply?.excerpt === "string" && session.reply.excerpt !== ""
            ? `${session.reply.excerpt}${session.reply.continued ? "…" : ""}` : "";
        const excerpt = excerptText === "" ? "" : `<small data-session-excerpt>${escapeHtml(excerptText)}</small>`;
        const unarchive = session.archived_at !== null
            ? `<form method="post" action="/sessions/unarchive" data-inline-unarchive><input type="hidden" name="workspace" value="${escapeHtml(workspace.name)}"><input type="hidden" name="session" value="${name}"><button type="submit" data-i18n="unarchive">Unarchive</button></form>`
            : "";
        return `<span data-session-identity>${ant} <span data-lifecycle="${lifecycle}" role="img" aria-label="${lifecycle}" title="${lifecycle}"></span> `
            + `${lineage}<span>#${name}</span>${title}${gates}${children}</span>`
            + `<span data-session-workspace><span data-folder="${folder}" role="img" aria-label="${folder ? "Project workspace" : "Folderless workspace"}"></span> `
            + `${this.#link(workspace.name, { kind: "workspace", workspace: workspace.name })}${time}${unarchive}</span>`
            + excerpt;
    }

    /** {§web-session-directory} A finished reply adds a disclosure body outlet addressed at its ACP entry resource.
     * @param {number} workspaceId
     * @param {DirectorySession} session
     */
    #replyOutlet(workspaceId, session) {
        const reply = session.reply ?? null;
        if (reply === null) return "";
        const target = encodeURIComponent(`log:///${reply.coordinate}`);
        return `<div data-session-reply="/acp/${workspaceId}/${session.id}/entry?target=${escapeHtml(target)}"></div>`;
    }

    /** {§web-session-directory}
     * @param {ReadonlyMap<number, { readonly id: number, readonly name: string, readonly project_root: string | null }>} workspaces
     * @param {ReadonlyMap<number, DirectorySession & { readonly workspaceId: number }>} sessions
     * @param {{ includeArchived?: boolean }} [options]
     */
    #sessionTree(workspaces, sessions, { includeArchived = false } = {}) {
        const models = [...sessions.values()]
            .filter(({ origin, archived_at }) => origin === "model" && (includeArchived ? archived_at !== null : archived_at === null))
            .toSorted(orderByReply);
        if (models.length === 0) return '<p data-i18n="no-sessions">No matching sessions.</p>';
        const visibleIds = new Set(models.map(({ id }) => id));
        const children = Map.groupBy(
            models,
            ({ parentSessionId }) => parentSessionId !== null && visibleIds.has(parentSessionId) ? parentSessionId : null,
        );
        const background = models.filter((session) => {
            if (session.parentSessionId === null || visibleIds.has(session.parentSessionId)) return false;
            const parent = sessions.get(session.parentSessionId) ?? null;
            return parent !== null && parent.origin !== "model";
        });
        const backgroundIds = new Set(background.map(({ id }) => id));
        const seenInTree = new Set();
        /** @param {readonly (DirectorySession & { readonly workspaceId: number })[]} entries @returns {string} */
        const list = (entries) => entries.length === 0 ? ""
            : `<ul>${entries.map((session) => {
                if (seenInTree.has(session.id)) throw new Error("Session directory holds shown model sessions that no shown root reaches.");
                seenInTree.add(session.id);
                const workspace = workspaces.get(session.workspaceId);
                if (workspace === undefined) throw new Error(`Session ${session.id} belongs to an absent workspace ${session.workspaceId}.`);
                const descendants = children.get(session.id) ?? [];
                const parent = session.parentSessionId !== null ? (sessions.get(session.parentSessionId) ?? null) : null;
                const identity = this.#sessionIdentity(workspace, session, parent, descendants.length);
                const reply = this.#replyOutlet(workspace.id, session);
                const kind = escapeHtml(session.kind ?? (session.parentSessionId === null ? "root" : "work"));
                const replyAttr = session.reply ? ` data-reply-id="${session.reply.id}"` : "";
                const archivedAttr = session.archived_at !== null ? ' data-archived="true"' : "";
                const content = descendants.length === 0 && reply === "" ? `<header>${identity}</header>`
                    : `<details><summary>${identity}</summary>${list(descendants)}${reply}</details>`;
                return `<li data-directory-entry="session" data-session-key="${workspace.id}:${session.id}" data-session-kind="${kind}" data-workspace-name="${escapeHtml(workspace.name)}" data-lifecycle-state="${escapeHtml(session.lifecycle)}" data-gate-count="${session.gates ?? 0}"${replyAttr}${archivedAttr}><article aria-label="Session">${content}</article></li>`;
            }).join("")}</ul>`;
        const rootEntries = (children.get(null) ?? []).filter(({ id }) => !backgroundIds.has(id));
        const roots = list(rootEntries);
        const other = background.length === 0 ? "" : '<details><summary data-i18n="background-work">Background work</summary>'
            + `${list(background)}</details>`;
        if (seenInTree.size !== models.length) {
            throw new Error("Session directory holds shown model sessions that no shown root reaches.");
        }
        return roots + other;
    }

    /**
     * {§web-search} Full-page Search & Directory document (`/search/`).
     * @param {boolean} authenticated
     * @param {{
     *   listWorkspaces(): Promise<readonly DirectoryWorkspace[]>,
     *   listSessions(workspaceId: number): Promise<readonly DirectorySession[]>,
     *   readSessionOverview?: (args: { workspaceId?: number, limit: number, excerptChars: number }) => Promise<DirectoryOverview>,
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
        const q = (query.q ?? "").trim();
        const qLower = q.toLowerCase();
        const wsFilter = query.workspace ?? "";
        const statusFilter = ["all", "active", "gated", "failed", "archived"].includes(query.status ?? "") ? (query.status ?? "all") : "all";
        const kindFilter = ["all", "chats", "work"].includes(query.kind ?? "") ? (query.kind ?? "all") : "all";
        const showArchived = statusFilter === "archived";

        const allWorkspaces = await port.listWorkspaces();
        const wsById = new Map(allWorkspaces.map((ws) => [ws.id, ws]));
        const overview = typeof port.readSessionOverview === "function" && !showArchived
            ? await port.readSessionOverview({ limit: this.#overviewSessions, excerptChars: this.#overviewExcerptChars })
            : null;

        /** @type {Map<number, DirectorySession & { readonly workspaceId: number }>} */
        const sessionById = new Map();
        if (overview !== null && wsFilter === "") {
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
                    ? await port.readSessionOverview({ workspaceId: ws.id, limit: Number.MAX_SAFE_INTEGER, excerptChars: this.#overviewExcerptChars })
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

        const suggestionTerms = new Set();
        for (const ws of allWorkspaces) {
            if (showArchived ? ws.archived_at !== null : ws.archived_at === null) suggestionTerms.add(ws.name);
        }
        for (const s of sessionById.values()) {
            if (s.origin !== "model") continue;
            if (showArchived ? s.archived_at === null : s.archived_at !== null) continue;
            suggestionTerms.add(s.name);
            if (typeof s.title === "string" && s.title) suggestionTerms.add(s.title);
        }

        /** @type {Map<number, DirectorySession & { readonly workspaceId: number }>} */
        const filteredSessions = new Map();
        for (const [id, s] of sessionById) {
            if (s.origin !== "model") {
                filteredSessions.set(id, s);
                continue;
            }
            const ws = wsById.get(s.workspaceId);
            if (!ws) continue;
            if (wsFilter && ws.name !== wsFilter) continue;
            const isArchived = s.archived_at !== null || ws.archived_at !== null;
            if (showArchived ? !isArchived : isArchived) continue;
            if (statusFilter === "active" && !["queued", "running", "parked"].includes(s.lifecycle)) continue;
            if (statusFilter === "gated" && (s.gates ?? 0) === 0) continue;
            if (statusFilter === "failed" && s.lifecycle !== "failed") continue;
            const kind = s.kind ?? (s.parentSessionId === null ? "root" : "work");
            if (kindFilter === "chats" && kind === "work") continue;
            if (kindFilter === "work" && kind !== "work") continue;
            if (qLower) {
                const hay = [ws.name, ws.project_label ?? "", s.name, s.title ?? "", s.reply?.excerpt ?? ""].join("\n").toLowerCase();
                if (!hay.includes(qLower)) continue;
            }
            filteredSessions.set(id, { ...s, archived_at: isArchived ? (s.archived_at ?? ws.archived_at ?? "archived") : null });
        }

        const filteredWorkspaces = allWorkspaces.filter((ws) => {
            if (wsFilter && ws.name !== wsFilter) return false;
            const isArchived = ws.archived_at !== null;
            if (showArchived ? !isArchived : isArchived) return false;
            if (qLower) {
                const hay = `${ws.name}\n${ws.project_label ?? ""}`.toLowerCase();
                if (!hay.includes(qLower)) return false;
            }
            return true;
        });

        const wsOptions = [
            '<option value="" data-i18n="all-workspaces">All workspaces</option>',
            ...allWorkspaces
                .filter((ws) => showArchived || ws.archived_at === null || ws.name === wsFilter)
                .map((ws) => `<option value="${escapeHtml(ws.name)}"${ws.name === wsFilter ? " selected" : ""}>${escapeHtml(ws.name)}</option>`),
        ].join("");
        const statusOption = (/** @type {string} */ val, /** @type {string} */ label) =>
            `<option value="${val}"${statusFilter === val ? " selected" : ""}>${label}</option>`;
        const kindOption = (/** @type {string} */ val, /** @type {string} */ label) =>
            `<option value="${val}"${kindFilter === val ? " selected" : ""}>${label}</option>`;
        const datalistOptions = [...suggestionTerms].slice(0, 100)
            .map((term) => `<option value="${escapeHtml(term)}"></option>`).join("");

        const controlsHtml = '<form id="search-controls" method="get" action="/search/" aria-label="Search workspaces and sessions">'
            + `<input type="search" name="q" list="search-suggestions" data-overview-search value="${escapeHtml(q)}" placeholder="Search workspaces, sessions, titles, or replies…" aria-label="Search workspaces and sessions" autocomplete="off">`
            + `<datalist id="search-suggestions">${datalistOptions}</datalist>`
            + `<select name="workspace" data-search-workspace aria-label="Workspace filter">${wsOptions}</select>`
            + `<select name="status" data-overview-scope aria-label="Status filter">${statusOption("all", "All statuses")}${statusOption("active", "Active")}${statusOption("gated", "Needs input")}${statusOption("failed", "Failed")}${statusOption("archived", "Archived")}</select>`
            + `<select name="kind" data-search-kind aria-label="Kind filter">${kindOption("all", "All kinds")}${kindOption("chats", "Chats")}${kindOption("work", "Subagents")}</select>`
            + '<button type="submit" data-search-submit data-i18n="filter">Filter</button>'
            + (creationsAvailable ? '<button type="button" data-dialog-target="dialog-workspace-create" data-i18n="open-project-folder">Open project folder…</button>' : "")
            + "</form>";

        const workspaceItems = filteredWorkspaces.map((ws) => {
            // {§web-workspace-folder}
            const separateFolder = ws.project_label !== null && ws.project_label !== ws.name;
            const folderNote = separateFolder ? ` <small data-text="project-label">${escapeHtml(ws.project_label)}</small>` : "";
            const unarchive = ws.archived_at !== null
                ? `<form method="post" action="/workspaces/unarchive" data-inline-unarchive><input type="hidden" name="workspace" value="${escapeHtml(ws.name)}"><button type="submit" data-i18n="unarchive">Unarchive</button></form>`
                : "";
            return `<li data-directory-entry="workspace" data-workspace-name="${escapeHtml(ws.name)}" data-folder="${ws.project_root !== null}"${ws.archived_at !== null ? ' data-archived="true"' : ""}>`
                + `<article aria-label="${ws.project_root === null ? "Folderless workspace" : "Project workspace"}">`
                + `<header>${this.#link(ws.name, { kind: "workspace", workspace: ws.name })}${folderNote}${unarchive}</header></article></li>`;
        }).join("");
        const workspacesSection = `<section id="search-workspaces" aria-label="Workspaces">${workspaceItems ? `<ul>${workspaceItems}</ul>` : '<p data-i18n="no-workspaces">No matching workspaces.</p>'}</section>`;

        const omitted = (overview?.omitted ?? 0) > 0 && !qLower && !wsFilter && statusFilter === "all" && kindFilter === "all"
            ? `<p data-overview-omitted><small><span data-text="overview-omitted">${overview?.omitted}</span> <span data-i18n="older-sessions-omitted">older sessions omitted — filter by workspace or search to narrow.</span></small></p>`
            : "";
        const sessionsSection = `<section id="search-sessions" aria-label="Sessions">${this.#sessionTree(wsById, filteredSessions, { includeArchived: showArchived })}${omitted}</section>`;

        const needsOnboarding = detectNeedsOnboarding(port);
        const headerLead = this.#headerLead({
            canCreate: creationsAvailable,
            placeHtml: '<div id="header-place"><span aria-current="page" data-i18n="search">Search</span></div>',
        });
        const live = typeof port.readSessionOverview === "function";
        const mainAttributes = `${live ? ` data-auth="${authenticated ? "session" : "none"}" data-connection="initial"` : ""}${needsOnboarding ? ' data-needs-onboarding="true"' : ""}`;
        return this.#render("Search", controlsHtml + workspacesSection + sessionsSection, "search", authenticated, {
            headerLead,
            dialogs: creationsAvailable ? this.#creationForm() : "",
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
        const footer = `<footer id="session-status" aria-label="Session status" data-workspace-id="${workspaceId}" data-session-id="${workspaceId}#${escapeHtml(directory.session)}"`
            + ` data-session-name="${escapeHtml(directory.session)}" data-auth="${authenticated ? "session" : "none"}" data-connection="initial"${needsOnboarding ? ' data-needs-onboarding="true"' : ""}>`
            + '<p role="status" data-text="connection-label">Not connected.</p><noscript><p data-i18n="live-status-needs-js">Live status requires JavaScript.</p></noscript>'
            + '<div data-status-line><ul aria-label="Model controls">'
            + `<li data-status-field="yolo"><button type="button" id="session-yolo" aria-pressed="${automatic}" aria-label="Automatic approval" title="${automatic ? "Auto" : "Manual"} Approval (Shift+Tab · /yolo)"><span data-text="yolo-label">${automatic ? "Auto-approve" : "Review"}</span></button></li>`
            + '<li data-status-field="model" data-bind="aria-label:model-label title:model-label"><button type="button" id="session-model" aria-label="Model" aria-expanded="false" aria-controls="dialog-session-model"><span data-text="model">No model</span></button><button type="button" id="session-effort" aria-label="Effort" aria-expanded="false" aria-controls="dialog-session-effort"><span data-text="effort"></span></button></li></ul>'
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

    /** {§web-workspace-tabs} Progressive-disclosure desktop session tabs (hidden when only 1 session is visible).
     * @param {DirectoryWorkspace} workspace
     * @param {readonly DirectorySession[]} sessions
     * @param {ReadonlyMap<number, DirectorySession>} byId
     * @param {ReadonlyMap<number, DirectoryOverviewSession>} overviewById
     * @param {string | null} selectedSession
     * @param {boolean} authenticated
     * @param {boolean} live
     * @param {boolean} automatic
     * @param {boolean} needsOnboarding
     */
    #workspaceTabs(workspace, sessions, byId, overviewById, selectedSession, authenticated, live, automatic, needsOnboarding) {
        const workspacePath = directoryPath({ kind: "workspace", workspace: workspace.name });
        if (workspacePath === null) return "";
        const enriched = sessions
            .filter(({ origin }) => origin === "model")
            .map((entry) => {
                const info = overviewById.get(entry.id);
                return {
                    ...entry,
                    kind: info?.kind ?? entry.kind ?? (entry.parentSessionId === null ? "root" : "work"),
                    gates: info?.gates ?? entry.gates ?? 0,
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
        }).toSorted(orderByReply);
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
        const visible = ordered.filter((entry) => {
            if (entry.name === selectedSession) return true;
            if (entry.parentSessionId === null || entry.kind === "root" || entry.kind === "fork") return true;
            return ["queued", "running", "parked", "failed"].includes(entry.lifecycle) || (entry.gates ?? 0) > 0;
        });
        if (selectedSession !== null && !visible.some(({ name }) => name === selectedSession)) {
            const direct = enriched.find(({ name }) => name === selectedSession);
            if (direct) visible.push(direct);
        }
        let activeCount = 0;
        let gatedCount = 0;
        for (const entry of unarchived) {
            if (["queued", "running", "parked"].includes(entry.lifecycle)) activeCount++;
            if ((entry.gates ?? 0) > 0) gatedCount += entry.gates ?? 0;
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
            const replyAttr = entry.reply !== null ? ` data-reply-id="${entry.reply.id}"` : "";
            const archivedAttr = entry.archived_at !== null ? ' data-archived="true"' : "";
            return [`<li data-tab-id="${workspace.id}:${entry.id}" data-session-kind="${kind}"${parentAttr}${replyAttr}${archivedAttr}>`
                + `<a href="#${encodeURIComponent(entry.name)}" data-workspace-route="session" data-tab-session="${name}" title="#${name} (${lifecycle})"${current}>`
                + `<span data-lifecycle="${lifecycle}" aria-hidden="true"></span>`
                + `<span data-tab-label>#${name}</span>${gatesBadge}</a></li>`];
        };
        const visibleSet = new Set(visible.map(({ id }) => id));
        const items = visible.flatMap(renderTabItem);
        const folded = ordered.filter(({ id }) => !visibleSet.has(id)).map((entry) => {
            const parent = this.#parent(entry, byId);
            return {
                id: entry.id,
                name: entry.name,
                parentSessionId: entry.parentSessionId,
                parentName: parent?.name ?? null,
                parentOrigin: parent?.origin ?? null,
                kind: entry.kind,
                lifecycle: entry.lifecycle,
                gates: entry.gates ?? 0,
                replyId: entry.reply?.id ?? null,
            };
        });
        const foldedAttr = folded.length > 0 ? ` data-folded-sessions="${escapeHtml(JSON.stringify(folded))}"` : "";
        const currentLabel = selectedSession === null ? workspace.name : `#${selectedSession}`;
        const switcherBadges = (gatedCount > 0 ? `<small data-session-gates="${gatedCount}" aria-label="${gatedCount} awaiting input">${gatedCount}</small>` : "")
            + (activeCount > 0 ? `<small data-switcher-active="${activeCount}" aria-label="${activeCount} active">${activeCount}</small>` : "");
        return `<nav id="workspace-tabs" aria-label="Workspace sessions" data-workspace-id="${workspace.id}" data-workspace-name="${escapeHtml(workspace.name)}" data-auth="${authenticated ? "session" : "none"}" data-tab-count="${items.length}" data-initial-yolo="${automatic}"${needsOnboarding ? ' data-needs-onboarding="true"' : ""}${live ? ' data-live="true"' : ""}${foldedAttr}>`
            + `<button type="button" data-workspace-switcher aria-label="Switch session" title="Switch session">${SWITCHER_ICON}<span data-switcher-current>${escapeHtml(currentLabel)}</span>${switcherBadges}</button>`
            + `<ul>${items.join("")}</ul>`
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
                return {
                    ...entry,
                    kind: info?.kind ?? entry.kind ?? (entry.parentSessionId === null ? "root" : "work"),
                    gates: info?.gates ?? entry.gates ?? 0,
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
                const unarchivedRoots = modelSessions
                    .filter(({ archived_at, parentSessionId }) => archived_at === null && parentSessionId === null)
                    .toSorted(orderByReply);
                selected = unarchivedRoots.find(({ reply }) => reply !== null)
                    ?? unarchivedRoots.find(({ name }) => name === "user")
                    ?? unarchivedRoots[0]
                    ?? modelSessions.filter(({ archived_at }) => archived_at === null).toSorted(orderByReply)[0]
                    ?? modelSessions[0];
            }
        }

        // {§web-workspace-folder}
        const effectiveProject = workspace.project_label ?? workspace.project_root;
        const folder = workspace.project_label !== null && workspace.project_label !== workspace.name ? workspace.project_label : "";
        const iconLabel = effectiveProject === null ? "Folderless workspace" : folder ? "Workspace" : "Project workspace";
        const iconGlyph = effectiveProject !== null && !folder ? "🗂️" : "☁️";
        const marker = `<span role="img" aria-label="${iconLabel}" data-bind="aria-label:workspace-icon-label" data-text="workspace-icon">${iconGlyph}</span>`;
        const needsOnboarding = detectNeedsOnboarding(port);
        const automatic = Boolean(this.#yolo && own);

        if (selected === undefined) {
            const tabs = this.#workspaceTabs(workspace, sessions, byId, overviewById, null, authenticated, live, automatic, needsOnboarding);
            const placeHtml = `<div id="header-place"><button type="button" id="session-workspace" data-workspace-settings aria-label="Workspace settings" title="Workspace settings">${marker} <span data-text="workspace-name">${escapeHtml(workspace.name)}</span></button></div>`;
            const headerLead = this.#headerLead({
                canCreate: creationsAvailable,
                workspaceName: workspace.archived_at === null ? workspace.name : null,
                placeHtml,
            });
            const startForm = creationsAvailable && workspace.archived_at === null
                ? `<form method="post" action="/sessions/new"><input type="hidden" name="token" value="${randomUUID()}"><input type="hidden" name="workspace" value="${escapeHtml(workspace.name)}"><button type="submit" data-i18n="start-conversation">New session</button></form>`
                : "";
            const body = `<p id="session-folder" data-project-label="${escapeHtml(folder)}"><span role="img" aria-label="Project folder">🗂️</span> <span data-text="project-label">${escapeHtml(folder)}</span></p>`
                + `<article id="workspace-empty"><p data-i18n="no-sessions">No sessions in this workspace yet.</p>${startForm}</article>`;
            const dialogs = this.#renameForm(workspace) + this.#workspaceArchiveForm(workspace) + this.#sessionCreationForm(workspace);
            onSelected?.(workspace, null);
            return this.#render(workspace.name, body, "workspace", authenticated, { headerLead, beforeMain: tabs, dialogs });
        }

        const parent = this.#parent(selected, byId);
        const parentLabel = parent === null ? "" : parent.origin === "model"
            ? this.#link(parent.name, { kind: "session", workspace: workspace.name, session: parent.name })
            : `<span data-text="name">${escapeHtml(parent.name)}</span>`;
        const parentLine = parent === null ? "" : `<span data-i18n="parent-session">Parent:</span> ${parentLabel}`;
        const title = `${workspace.name}#${selected.name}`;
        const sessionDir = /** @type {const} */ ({ kind: "session", workspace: workspace.name, session: selected.name });
        const status = this.#sessionStatus(sessionDir, workspace.id, authenticated, automatic, needsOnboarding);
        const tabs = this.#workspaceTabs(workspace, sessions, byId, overviewById, selected.name, authenticated, live, automatic, needsOnboarding);
        const placeHtml = `<div id="header-place">`
            + `<button type="button" id="session-workspace" data-workspace-settings aria-label="Workspace settings" title="Workspace settings">${marker} <span data-text="workspace-name">${escapeHtml(workspace.name)}</span></button>`
            + `<span data-place-hash aria-hidden="true">#</span>`
            + `<button type="button" id="header-session" data-dialog-target="dialog-session-manage" aria-label="Session actions" title="Session actions"><span data-text="active-session-name">${escapeHtml(selected.name)}</span></button>`
            + `<small data-header-gates="" hidden></small></div>`;
        const headerLead = this.#headerLead({
            canCreate: creationsAvailable,
            workspaceName: workspace.archived_at === null ? workspace.name : null,
            placeHtml,
        });
        const dialogs = this.#sessionManageDialog(workspace, selected, parentLine)
            + this.#renameForm(workspace, selected.name)
            + this.#workspaceArchiveForm(workspace)
            + this.#sessionArchiveForm(workspace, selected)
            + this.#sessionCreationForm(workspace);
        const body = `<p id="session-folder" data-project-label="${escapeHtml(folder)}"><span role="img" aria-label="Project folder">🗂️</span> <span data-text="project-label">${escapeHtml(folder)}</span></p>`
            + status.content;
        onSelected?.(workspace, selected);
        return this.#render(title, body, "session", authenticated, {
            headerLead,
            beforeMain: tabs,
            footer: status.footer,
            dialogs,
            mainAttributes: ` data-session-name="${escapeHtml(selected.name)}"`,
        });
    }
}
