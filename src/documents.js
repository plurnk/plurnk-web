import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { directoryPath } from "./directory-addresses.js";
import { escapeHtml, RequestError } from "./http.js";

// A dialog's dismissal; a form offered again on an error page has none.
const CANCEL = '<button type="button" data-dialog-close data-i18n="cancel">Cancel</button>';
const WORKSPACES_ICON = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>';
const PLUS_ICON = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M3 8h10"/></svg>';
const RENAME_ICON = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5a1.4 1.4 0 0 1 2 2L5.5 12.5 2.5 13.5l1-3 8-8Z"/></svg>';
const ARCHIVE_ICON = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="3" rx="0.75"/><path d="M3.5 6v6.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6M6.5 9h3"/></svg>';
const SWITCHER_ICON = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h10M3 8h10M3 11h6"/></svg>';
/** @typedef {{ readonly id: number, readonly name: string, readonly project_root: string | null, readonly project_label: string | null, readonly archived_at: string | null }} DirectoryWorkspace */
/** @typedef {{ readonly id: number, readonly coordinate: string, readonly completion: 200 | 499, readonly at?: number, readonly excerpt?: string, readonly continued?: boolean }} DirectoryReply */
/** @typedef {{ readonly id: number, readonly name: string, readonly parentSessionId: number | null, readonly origin: string, readonly kind?: string, readonly lifecycle: string, readonly gates?: number, readonly title?: string | null, readonly archived_at: string | null, readonly reply?: DirectoryReply | null, readonly workspaceId?: number }} DirectorySession */
/** @typedef {{ readonly id: number, readonly name: string, readonly projectRoot: string | null }} DirectoryOverviewWorkspace */
/** @typedef {{ readonly id: number, readonly workspaceId: number, readonly name: string, readonly parentSessionId: number | null, readonly kind?: string, readonly lifecycle: string, readonly gates?: number, readonly title?: string | null, readonly reply: DirectoryReply | null }} DirectoryOverviewSession */
/** @typedef {{ readonly workspaces: readonly DirectoryOverviewWorkspace[], readonly sessions: readonly DirectoryOverviewSession[], readonly omitted?: number }} DirectoryOverview */

/** @param {DirectorySession} a @param {DirectorySession} b */
const orderByReply = (a, b) => {
    const aReply = a.reply ?? null;
    const bReply = b.reply ?? null;
    return aReply !== null && bReply !== null ? bReply.id - aReply.id
        : aReply !== null ? -1 : bReply !== null ? 1 : 0;
};
/** @typedef {"title" | "sessionNavigation" | "headerTail" | "beforeMain" | "main" | "afterMain"} DocumentSlotName */
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
    const headerCloseIndex = navSpan.end + headerCloses[0].index;

    /** @type {readonly { readonly name: DocumentSlotName, readonly start: number, readonly end: number }[]} */
    const spans = [
        { name: /** @type {const} */ ("title"), start: title.start, end: title.end },
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

/** {§web-document} {§web-directory-documents} One compiled document supplies the complete HTML/OTM substrate. */
export default class Documents {
    #template;
    #yolo;
    #reasoningPreviewChars;
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

    /** @param {string} document @param {boolean | null} yolo @param {number | null} reasoningPreviewChars @param {number | null} [overviewSessions] @param {number | null} [overviewExcerptChars] */
    constructor(document, yolo, reasoningPreviewChars, overviewSessions = reasoningPreviewChars, overviewExcerptChars = reasoningPreviewChars) {
        this.#yolo = yolo;
        this.#reasoningPreviewChars = reasoningPreviewChars;
        this.#overviewSessions = overviewSessions;
        this.#overviewExcerptChars = overviewExcerptChars;
        this.#template = compileDocumentSlots(document);
    }

    /** @param {string} title @param {string} body @param {"home" | "daemon" | "workspace" | "session" | "error" | "account"} kind @param {boolean} [authenticated] @param {string} [breadcrumb] @param {string} [footer] @param {string} [dialogs] @param {string} [mainAttributes] @param {string} [beforeMain] */
    #render(title, body, kind, authenticated = false, breadcrumb = this.#breadcrumb(), footer = "", dialogs = "", mainAttributes = "", beforeMain = "") {
        const label = kind === "home" ? title : `${title} — Plurnk`;
        return Buffer.from(this.#template.render({
            title: `<title data-text="page-title">${escapeHtml(label)}</title>`,
            sessionNavigation: authenticated ? this.#template.sessionNavigation : "",
            headerTail: breadcrumb,
            beforeMain,
            main: `<main id="main" data-page="${kind}"${mainAttributes}>${body}${dialogs}</main>`,
            afterMain: footer,
        }));
    }
    /** @param {boolean} authenticated @param {{ readSessionOverview?: (args: { workspaceId?: number, limit: number, excerptChars: number }) => Promise<DirectoryOverview> }} [port] */
    home(authenticated, port) {
        if (typeof port?.readSessionOverview !== "function") return this.#render("Plurnk", this.#template.home, "home", authenticated);
        if (this.#overviewSessions === null || this.#overviewExcerptChars === null) {
            throw new RequestError(503, "Session overview is unavailable because its configuration is invalid.");
        }
        return port.readSessionOverview({ limit: this.#overviewSessions, excerptChars: this.#overviewExcerptChars }).then((overview) =>
            this.#render("Plurnk", this.#overviewTree(overview), "home", authenticated, this.#breadcrumb(), "", "", ` data-auth="${authenticated ? "session" : "none"}" data-connection="initial"`));
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

    /** {§web-workspace-rename} @param {string} workspace @param {string} name */
    retryRename(workspace, name) { return this.#renameFields(workspace, name, ""); }

    /** {§web-session-creation} @param {string} workspace @param {string} name */
    retrySession(workspace, name) { return this.#sessionFields(workspace, name, ""); }

    /** {§web-account} Account navigation stays separate from session management. */
    account() {
        return this.#render("Account", '<article aria-labelledby="account-title"><header><h1 id="account-title" data-i18n="account">Account</h1></header>'
            + '<nav aria-label="Account"><ul><li><a href="/account/sessions/" data-i18n="sessions">Sessions</a></li></ul></nav></article>', "account", true);
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
        const breadcrumb = this.#breadcrumb([
            '<a href="/account/" data-i18n="account">Account</a>',
            '<span aria-current="page" data-i18n="sessions">Sessions</span>',
        ]);
        return this.#render("Sessions", '<article aria-labelledby="sessions-title"><header><h1 id="sessions-title" data-i18n="sessions">Sessions</h1></header>'
            + '<figure><table><thead><tr><th scope="col" data-i18n="session">Session</th><th scope="col" data-i18n="started">Started</th>'
            + '<th scope="col" data-i18n="expires">Expires</th><th scope="col" data-i18n="actions">Actions</th></tr></thead>'
            + `<tbody>${entries}</tbody></table></figure>${others ? `<footer>${others}</footer>` : ""}</article>`, "account", true, breadcrumb);
    }

    /** @param {string} label @param {import("./directory-addresses.js").Directory} directory */
    #link(label, directory) {
        const path = directoryPath(directory);
        return path === null ? `<span data-text="name">${escapeHtml(label)}</span>`
            : `<a href="${escapeHtml(path)}" data-text="name"${directory.kind === "session" ? ` data-session-name="${escapeHtml(directory.session)}" data-bind="href:session-path"` : ""}>${escapeHtml(label)}</a>`;
    }

    /** {§web-workspace-creation} Native dialog modal for workspace creation; the daemon names an unnamed workspace. */
    #creationForm() {
        return '<dialog id="dialog-workspace-create"><article>'
            + '<header><p><strong data-i18n="new-workspace">New workspace</strong></p>'
            + '<button type="button" aria-label="Close" rel="prev" data-dialog-close></button></header>'
            + this.#creationFields("", "", CANCEL)
            + '</article></dialog>';
    }

    /** @param {string} name @param {string} projectRoot @param {string} cancel */
    #creationFields(name, projectRoot, cancel) {
        return '<form id="workspace-create" method="post" action="/workspaces/new">'
            + `<input type="hidden" name="token" value="${randomUUID()}">`
            + `<input type="text" name="name" value="${escapeHtml(name)}" placeholder="Workspace name" aria-label="Workspace name" aria-describedby="workspace-name-hint">`
            + '<small id="workspace-name-hint" data-i18n="workspace-name-hint">Leave it empty and the daemon names the workspace.</small>'
            + `<input type="text" name="projectRoot" value="${escapeHtml(projectRoot)}" placeholder="/path/to/project (optional)" aria-label="Project path" aria-describedby="workspace-project-hint">`
            + '<small id="workspace-project-hint" data-i18n="workspace-project-hint">Leave it empty for a folderless workspace, or enter a local directory path on the daemon host.</small>'
            + `<footer>${cancel}<button type="submit" data-i18n="confirm">Confirm</button></footer></form>`;
    }

    /**
     * {§web-workspace-rename} Native dialog modal for workspace rename with pre-populated current name.
     * @param {{name: string}} workspace
     */
    #renameForm(workspace) {
        return '<dialog id="dialog-workspace-rename"><article>'
            + '<header><p><strong data-i18n="rename-workspace">Rename workspace</strong></p>'
            + '<button type="button" aria-label="Close" rel="prev" data-dialog-close></button></header>'
            + this.#renameFields(workspace.name, workspace.name, CANCEL)
            + '</article></dialog>';
    }

    /** @param {string} workspace @param {string} name @param {string} cancel */
    #renameFields(workspace, name, cancel) {
        return '<form id="workspace-rename" method="post" action="/workspaces/rename">'
            + `<input type="hidden" name="workspace" value="${escapeHtml(workspace)}">`
            + `<input type="text" name="name" value="${escapeHtml(name)}" placeholder="New name" aria-label="Rename workspace" required>`
            + `<footer>${cancel}<button type="submit" data-i18n="confirm">Confirm</button></footer></form>`;
    }

    /**
     * {§web-session-creation} Native dialog modal for session creation; the daemon names an unnamed session.
     * @param {{name: string}} workspace
     */
    #sessionCreationForm(workspace) {
        return '<dialog id="dialog-session-create"><article>'
            + '<header><p><strong data-i18n="new-session">New session</strong></p>'
            + '<button type="button" aria-label="Close" rel="prev" data-dialog-close></button></header>'
            + this.#sessionFields(workspace.name, "", CANCEL)
            + '</article></dialog>';
    }

    /** @param {string} workspace @param {string} name @param {string} cancel */
    #sessionFields(workspace, name, cancel) {
        return '<form id="session-create" method="post" action="/sessions/new">'
            + `<input type="hidden" name="token" value="${randomUUID()}">`
            + `<input type="hidden" name="workspace" value="${escapeHtml(workspace)}">`
            + `<input type="text" name="name" value="${escapeHtml(name)}" placeholder="Session name" aria-label="Session name" aria-describedby="session-name-hint">`
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
            + this.#workspaceArchiveFields(workspace.name, CANCEL)
            + '</article></dialog>';
    }

    /** @param {string} workspace @param {string} cancel */
    #workspaceArchiveFields(workspace, cancel) {
        return '<form id="workspace-archive" method="post" action="/workspaces/archive">'
            + `<input type="hidden" name="workspace" value="${escapeHtml(workspace)}">`
            + '<p data-i18n="archive-workspace-detail">Archiving removes the workspace from directory lists while keeping its files and history intact.</p>'
            + `<footer>${cancel}<button type="submit" data-i18n="confirm">Confirm</button></footer></form>`;
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
            + this.#sessionArchiveFields(workspace.name, session.name, CANCEL)
            + '</article></dialog>';
    }

    /** @param {string} workspace @param {string} session @param {string} cancel */
    #sessionArchiveFields(workspace, session, cancel) {
        return '<form id="session-archive" method="post" action="/sessions/archive">'
            + `<input type="hidden" name="workspace" value="${escapeHtml(workspace)}">`
            + `<input type="hidden" name="session" value="${escapeHtml(session)}">`
            + '<p data-i18n="archive-session-detail">Archiving removes the session and its descendants from directory overviews without destroying history.</p>'
            + `<footer>${cancel}<button type="submit" data-i18n="confirm">Confirm</button></footer></form>`;
    }
    /** @param {string | null} projectRoot */
    #workspaceMarker(projectRoot) {
        const folder = projectRoot !== null;
        return `<span role="img" aria-label="${folder ? "Project workspace" : "Folderless workspace"}">${folder ? "🗂️" : "☁️"}</span>`;
    }

    /** @param {string[]} [items] @param {boolean} [current] */
    #breadcrumb(items = [], current = false) {
        const root = current
            ? `<span role="img" aria-current="page" aria-label="Workspaces" title="Workspaces">${WORKSPACES_ICON}</span> <button type="button" data-dialog-target="dialog-workspace-create" aria-label="New workspace" title="New workspace">${PLUS_ICON}</button>`
            : `<a href="/~/" aria-label="Workspaces" title="Workspaces">${WORKSPACES_ICON}</a>`;
        return `<nav aria-label="breadcrumb"><ul>${[root, ...items].map((item) => `<li>${item}</li>`).join("")}</ul></nav>`;
    }

    /** @param {import("./directory-addresses.js").Directory} directory @param {string} marker */
    #breadcrumbs(directory, marker) {
        const current = (/** @type {string} */ name) => `<span aria-current="page" data-text="name">${escapeHtml(name)}</span>`;
        const items = [];
        if (directory.kind === "workspace") {
            items.push(`${marker} ${current(directory.workspace)} <button type="button" data-dialog-target="dialog-workspace-rename" aria-label="Rename workspace" title="Rename workspace">${RENAME_ICON}</button> <button type="button" data-dialog-target="dialog-workspace-archive" aria-label="Archive workspace" title="Archive workspace">${ARCHIVE_ICON}</button> <button type="button" data-dialog-target="dialog-session-create" aria-label="New session" title="New session">${PLUS_ICON}</button>`);
        }
        if (directory.kind === "session") {
            const path = directoryPath({ kind: "workspace", workspace: directory.workspace });
            if (path === null) throw new Error("An admitted session must have a workspace directory address.");
            items.push(`<span id="session-workspace">${marker} <a href="${escapeHtml(path)}" data-bind="href:workspace-path" data-text="workspace-name">${escapeHtml(directory.workspace)}</a></span>`, `${current(directory.session)} <button type="button" data-dialog-target="dialog-session-archive" aria-label="Archive session" title="Archive session">${ARCHIVE_ICON}</button>`);
        }
        return this.#breadcrumb(items, directory.kind === "daemon");
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
            : `<a data-session-link href="${escapeHtml(path)}" aria-label="${name}" title="Open session ${name}"></a>`;
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
        return `<span data-session-identity>${ant} <span data-lifecycle="${lifecycle}" role="img" aria-label="${lifecycle}" title="${lifecycle}"></span> `
            + `${lineage}<span>${name}</span>${title}${gates}${children}</span>`
            + `<span data-session-workspace><span data-folder="${folder}" role="img" aria-label="${folder ? "Project workspace" : "Folderless workspace"}"></span> `
            + `${this.#link(workspace.name, { kind: "workspace", workspace: workspace.name })}${time}</span>`
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
     */
    #sessionTree(workspaces, sessions) {
        // {§web-directory-documents} An archived session leaves the tree; its page still opens by its address.
        const models = [...sessions.values()]
            .filter(({ origin, archived_at }) => origin === "model" && archived_at === null)
            .toSorted(orderByReply);
        if (models.length === 0) return '<p data-i18n="no-sessions">No sessions.</p>';
        const children = Map.groupBy(models, ({ parentSessionId }) => parentSessionId);
        const background = models.filter((session) => {
            const parent = this.#parent(session, sessions);
            return parent !== null && parent.origin !== "model";
        });
        let rendered = 0;
        /** @param {readonly (DirectorySession & { readonly workspaceId: number })[]} entries @returns {string} */
        const list = (entries) => entries.length === 0 ? ""
            : `<ul>${entries.map((session) => {
                rendered++;
                const workspace = workspaces.get(session.workspaceId);
                if (workspace === undefined) throw new Error(`Session ${session.id} belongs to an absent workspace ${session.workspaceId}.`);
                const descendants = children.get(session.id) ?? [];
                const identity = this.#sessionIdentity(workspace, session, this.#parent(session, sessions), descendants.length);
                const reply = this.#replyOutlet(workspace.id, session);
                const kind = escapeHtml(session.kind ?? (session.parentSessionId === null ? "root" : "work"));
                const replyAttr = session.reply ? ` data-reply-id="${session.reply.id}"` : "";
                const content = descendants.length === 0 && reply === "" ? `<header>${identity}</header>`
                    : `<details><summary>${identity}</summary>${list(descendants)}${reply}</details>`;
                return `<li data-directory-entry="session" data-session-key="${workspace.id}:${session.id}" data-session-kind="${kind}"${replyAttr}><article aria-label="Session">${content}</article></li>`;
            }).join("")}</ul>`;
        const roots = list(children.get(null) ?? []);
        const other = background.length === 0 ? "" : '<details><summary data-i18n="background-work">Background work</summary>'
            + `${list(background)}</details>`;
        if (rendered !== models.length) throw new Error("Session directory holds shown model sessions that no shown root reaches.");
        return roots + other;
    }

    /** {§web-session-directory}
     * @param {DirectoryOverview} overview
     */
    #overviewTree(overview) {
        const workspaces = new Map(overview.workspaces.map(({ id, name, projectRoot }) => [id, { id, name, project_root: projectRoot }]));
        /** @type {Map<number, DirectorySession & { readonly workspaceId: number }>} */
        const byId = new Map(overview.sessions.map((session) => [session.id, {
            id: session.id,
            workspaceId: session.workspaceId,
            name: session.name,
            parentSessionId: session.parentSessionId,
            origin: "model",
            kind: session.kind ?? (session.parentSessionId === null ? "root" : "work"),
            lifecycle: session.lifecycle,
            gates: session.gates ?? 0,
            ...(typeof session.title === "string" ? { title: session.title } : {}),
            archived_at: null,
            reply: session.reply,
        }]));
        if (byId.size !== overview.sessions.length) throw new Error("Session directory contains duplicate identities.");
        for (const session of overview.sessions) {
            if (session.parentSessionId !== null && !byId.has(session.parentSessionId)) {
                byId.set(session.parentSessionId, {
                    id: session.parentSessionId,
                    workspaceId: session.workspaceId,
                    name: "_plurnk",
                    parentSessionId: null,
                    origin: "_plurnk",
                    lifecycle: "idle",
                    archived_at: null,
                });
            }
        }
        const omitted = (overview.omitted ?? 0) > 0
            ? `<p data-overview-omitted><small><span data-text="overview-omitted">${overview.omitted}</span> <span data-i18n="older-sessions-omitted">older sessions omitted — browse all in</span> <a href="/~/" data-i18n="workspaces">Workspaces</a>.</small></p>`
            : "";
        return this.#sessionTree(workspaces, byId) + omitted;
    }

    /** {§web-session-observer} Identity and navigation belong to the document; status arrives through ACP.
     * @param {import("./directory-addresses.js").Directory & {kind: "session"}} directory @param {number} workspaceId @param {boolean} authenticated
     * @param {boolean} automatic
     */
    #sessionStatus(directory, workspaceId, authenticated, automatic) {
        const path = directoryPath(directory);
        if (path === null) throw new Error("An admitted session must have a directory address.");
        const footer = `<footer id="session-status" aria-label="Session status" data-session-id="${workspaceId}#${escapeHtml(directory.session)}"`
            + ` data-session-name="${escapeHtml(directory.session)}" data-auth="${authenticated ? "session" : "none"}" data-reasoning-preview-chars="${this.#reasoningPreviewChars}" data-connection="initial">`
            + '<p role="status" data-text="connection-label">Not connected.</p><noscript><p data-i18n="live-status-needs-js">Live status requires JavaScript.</p></noscript>'
            + '<div data-status-line><ul aria-label="Model controls">'
            + `<li data-status-field="yolo"><button type="button" id="session-yolo" aria-pressed="${automatic}" aria-label="Automatic approval" title="${automatic ? "Auto" : "Manual"} Approval (Shift+Tab · /yolo)"><span data-text="yolo-label">${automatic ? "YOLO" : "Review"}</span></button></li>`
            + '<li data-status-field="model" data-bind="aria-label:model-label title:model-label"><button type="button" id="session-model" aria-label="Model" aria-expanded="false" aria-controls="session-model-settings"><span data-text="model">No model</span></button><button type="button" id="session-effort" aria-label="Effort" aria-expanded="false" aria-controls="session-effort-settings"><span data-text="effort"></span></button></li></ul>'
            + '<ul aria-label="Session statistics"><li data-status-field="lifecycle" data-bind="aria-label:lifecycle title:lifecycle"></li>'
            + '<li data-status-field="elapsed" aria-label="Latest loop elapsed time" title="Latest loop elapsed time"><time data-text="elapsed"></time></li>'
            + '<li data-status-field="usage" data-bind="aria-label:usage-label title:usage-label"><span data-text="input">?</span> <span data-text="output">?</span></li>'
            + '<li data-status-field="context" data-bind="aria-label:context-label title:context-label"><span data-text="context"></span></li>'
            + '<li data-status-field="descendants"><details id="session-descendants"><summary data-bind="aria-label:descendants-label title:descendants-label"><span data-text="descendants">0</span></summary><ul></ul></details></li>'
            + '<li data-status-field="gated" data-bind="aria-label:gated-label title:gated-label"><span data-text="gated">0</span></li>'
            + '<li data-status-field="wait"><span data-i18n="wait-remaining">updates in</span> <time data-text="wait" data-bind="datetime:wait-at title:wait-at"></time></li>'
            + '<li data-status-field="inbox" data-bind="aria-label:inbox-label title:inbox-label"><span data-text="inbox">0</span></li>'
            + '<li data-status-field="preparation" data-text="preparation"></li>'
            + '<li data-status-field="activity" data-text="activity" data-bind="title:activity-message"></li>'
            + '<li data-status-field="cost" data-text="cost" data-bind="aria-label:cost-label title:cost-label">?</li></ul></div></footer>';
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
    /** {§web-workspace-tabs} Daemon-truth workspace tab strip and compact switcher trigger.
     * @param {DirectoryWorkspace} workspace
     * @param {readonly DirectorySession[]} sessions
     * @param {ReadonlyMap<number, DirectorySession>} byId
     * @param {ReadonlyMap<number, DirectoryOverviewSession>} overviewById
     * @param {string | null} selectedSession
     * @param {boolean} authenticated
     * @param {boolean} live
     */
    #workspaceTabs(workspace, sessions, byId, overviewById, selectedSession, authenticated, live) {
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
        const overviewCurrent = selectedSession === null ? ' aria-current="true"' : "";
        const items = [
            `<li><a href="${escapeHtml(workspacePath)}" data-workspace-route="overview"${overviewCurrent} data-i18n="overview">Overview</a></li>`,
            ...visible.flatMap((entry) => {
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
                const parentAttr = entry.parentSessionId !== null ? ` data-parent-id="${entry.parentSessionId}"` : "";
                const replyAttr = entry.reply !== null ? ` data-reply-id="${entry.reply.id}"` : "";
                const archivedAttr = entry.archived_at !== null ? ' data-archived="true"' : "";
                return [`<li data-tab-id="${workspace.id}:${entry.id}" data-session-kind="${kind}"${parentAttr}${replyAttr}${archivedAttr}>`
                    + `<a href="${escapeHtml(sessionPath)}" data-workspace-route="session" data-tab-session="${name}" title="@${name} (${lifecycle})"${current}>`
                    + `<span data-lifecycle="${lifecycle}" aria-hidden="true"></span>`
                    + `<span data-tab-label>@${name}</span>${gatesBadge}</a></li>`];
            }),
        ];
        const currentLabel = selectedSession === null ? "Overview" : `@${selectedSession}`;
        const switcherBadges = (gatedCount > 0 ? `<small data-session-gates="${gatedCount}" aria-label="${gatedCount} awaiting input">${gatedCount}</small>` : "")
            + (activeCount > 0 ? `<small data-switcher-active="${activeCount}" aria-label="${activeCount} active">${activeCount}</small>` : "");
        return `<nav id="workspace-tabs" aria-label="Workspace sessions" data-workspace-id="${workspace.id}" data-workspace-name="${escapeHtml(workspace.name)}" data-auth="${authenticated ? "session" : "none"}"${live ? ' data-live="true"' : ""}>`
            + `<button type="button" data-workspace-switcher aria-label="Switch session" title="Switch session">${SWITCHER_ICON}<span data-switcher-current>${escapeHtml(currentLabel)}</span>${switcherBadges}</button>`
            + `<ul>${items.join("")}</ul>`
            + `<button type="button" data-dialog-target="dialog-session-create" aria-label="New session" title="New session">${PLUS_ICON}</button>`
            + "</nav>";
    }

    /**
     * @param {import("./directory-addresses.js").Directory} directory
     * @param {{ listWorkspaces(): Promise<readonly DirectoryWorkspace[]>, listSessions(workspaceId: number): Promise<readonly DirectorySession[]>, readSessionOverview?: (args: { workspaceId?: number, limit: number, excerptChars: number }) => Promise<DirectoryOverview> }} port
     * @param {boolean} authenticated
     * @param {boolean} [own] {§web-session-approval} whether the person reached the page by their own navigation; only then
     * does a session page start with the configured automatic approval
     */
    async read(directory, port, authenticated, own = false) {
        const render = (/** @type {string} */ title, /** @type {string} */ body, marker = "", footer = "", dialogs = "", mainAttributes = "", beforeMain = "") =>
            this.#render(title, body, directory.kind, authenticated, this.#breadcrumbs(directory, marker), footer, dialogs, mainAttributes, beforeMain);
        const workspaces = await port.listWorkspaces();
        if (directory.kind === "daemon") {
            // {§web-directory-documents} An archived workspace leaves the list; its page still opens by its address.
            const items = workspaces.filter(({ archived_at }) => archived_at === null).map(({ name, project_root }) =>
                `<li data-directory-entry="workspace" data-folder="${project_root !== null}"><article aria-label="${project_root === null ? "Folderless workspace" : "Project workspace"}"><header>${this.#link(name, { kind: "workspace", workspace: name })}</header></article></li>`).join("");
            const list = items ? `<ul>${items}</ul>` : '<p data-i18n="no-workspaces">No workspaces.</p>';
            return render("Workspaces", list, "", "", this.#creationForm());
        }
        const workspace = workspaces.find(({ name }) => name === directory.workspace);
        if (workspace === undefined) return null;
        const sessions = await port.listSessions(workspace.id);
        const byId = new Map(sessions.map((session) => [session.id, session]));
        if (byId.size !== sessions.length) throw new Error("Session directory contains duplicate identities.");
        const live = typeof port.readSessionOverview === "function";
        if (directory.kind === "workspace") {
            // {§web-workspace-folder}
            const separateFolder = workspace.project_label !== null && workspace.project_label !== workspace.name;
            const folder = separateFolder ? '<p><span role="img" aria-label="Project folder">🗂️</span> '
                + `<span data-text="project-label">${escapeHtml(workspace.project_label)}</span></p>` : "";
            const marker = separateFolder ? '<span role="img" aria-label="Workspace">☁️</span>' : this.#workspaceMarker(workspace.project_root);
            const dialogs = this.#renameForm(workspace) + this.#workspaceArchiveForm(workspace) + this.#sessionCreationForm(workspace);
            if (live && (this.#overviewSessions === null || this.#overviewExcerptChars === null)) {
                throw new RequestError(503, "Session overview is unavailable because its configuration is invalid.");
            }
            const overview = typeof port.readSessionOverview === "function" && this.#overviewExcerptChars !== null
                ? await port.readSessionOverview({ workspaceId: workspace.id, limit: Number.MAX_SAFE_INTEGER, excerptChars: this.#overviewExcerptChars })
                : null;
            const overviewById = new Map(overview?.sessions.map((entry) => [entry.id, entry]) ?? []);
            const treeSessions = new Map(sessions.map((entry) => {
                const info = overviewById.get(entry.id);
                const sessionTitle = info?.title ?? entry.title;
                return [entry.id, {
                    ...entry,
                    workspaceId: workspace.id,
                    kind: info?.kind ?? entry.kind,
                    gates: info?.gates ?? entry.gates ?? 0,
                    ...(typeof sessionTitle === "string" ? { title: sessionTitle } : {}),
                    reply: info?.reply ?? entry.reply ?? null,
                }];
            }));
            const body = folder + this.#sessionTree(new Map([[workspace.id, workspace]]), treeSessions);
            const tabs = this.#workspaceTabs(workspace, sessions, byId, overviewById, null, authenticated, live);
            const mainAttributes = live ? ` data-workspace-id="${workspace.id}" data-auth="${authenticated ? "session" : "none"}" data-connection="initial"` : "";
            return render(workspace.name, body, marker, "", dialogs, mainAttributes, tabs);
        }
        const session = sessions.find(({ name, origin }) => name === directory.session && origin === "model");
        if (session === undefined) return null;
        if (this.#yolo === null || this.#reasoningPreviewChars === null) {
            throw new RequestError(503, "Session pages are unavailable because their configuration is invalid.");
        }
        const overview = typeof port.readSessionOverview === "function" && this.#overviewExcerptChars !== null
            ? await port.readSessionOverview({ workspaceId: workspace.id, limit: Number.MAX_SAFE_INTEGER, excerptChars: this.#overviewExcerptChars })
            : null;
        const overviewById = new Map(overview?.sessions.map((entry) => [entry.id, entry]) ?? []);
        const parent = this.#parent(session, byId);
        const label = parent === null ? "" : parent.origin === "model"
            ? this.#link(parent.name, { kind: "session", workspace: workspace.name, session: parent.name })
            : `<span data-text="name">${escapeHtml(parent.name)}</span>`;
        const title = `${workspace.name}@${directory.session}`;
        const folder = workspace.project_label !== null && workspace.project_label !== workspace.name ? workspace.project_label : "";
        const iconLabel = workspace.project_label === null ? "Folderless workspace" : folder ? "Workspace" : "Project workspace";
        const marker = `<span role="img" aria-label="${iconLabel}" data-bind="aria-label:workspace-icon-label" data-text="workspace-icon">${workspace.project_label !== null && !folder ? "🗂️" : "☁️"}</span>`;
        const status = this.#sessionStatus(directory, workspace.id, authenticated, this.#yolo && own);
        const dialogs = this.#sessionArchiveForm(workspace, session) + this.#sessionCreationForm(workspace);
        const tabs = this.#workspaceTabs(workspace, sessions, byId, overviewById, session.name, authenticated, live);
        return render(title, `<p id="session-folder" data-project-label="${escapeHtml(folder)}"><span role="img" aria-label="Project folder">🗂️</span> <span data-text="project-label">${escapeHtml(folder)}</span></p>`
            + (parent === null ? "" : `<p><span data-i18n="parent-session">Parent:</span> ${label}</p>`)
            + status.content, marker, status.footer, dialogs, "", tabs);
    }
}
