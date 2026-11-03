import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { directoryPath } from "./directory-addresses.js";
import { escapeHtml, RequestError } from "./http.js";

// A dialog's dismissal; a form offered again on an error page has none.
const CANCEL = '<button type="button" data-dialog-close data-i18n="cancel">Cancel</button>';
/** @typedef {{ readonly id: number, readonly name: string, readonly project_root: string | null, readonly project_label: string | null, readonly archived_at: string | null }} DirectoryWorkspace */
/** @typedef {{ readonly id: number, readonly coordinate: string, readonly completion: 200 | 499 }} DirectoryReply */
/** @typedef {{ readonly id: number, readonly name: string, readonly parentSessionId: number | null, readonly origin: string, readonly lifecycle: string, readonly archived_at: string | null, readonly reply?: DirectoryReply | null, readonly workspaceId?: number }} DirectorySession */
/** @typedef {{ readonly id: number, readonly name: string, readonly projectRoot: string | null }} DirectoryOverviewWorkspace */
/** @typedef {{ readonly id: number, readonly workspaceId: number, readonly name: string, readonly parentSessionId: number | null, readonly lifecycle: string, readonly reply: DirectoryReply | null }} DirectoryOverviewSession */
/** @typedef {{ readonly workspaces: readonly DirectoryOverviewWorkspace[], readonly sessions: readonly DirectoryOverviewSession[] }} DirectoryOverview */

/** @param {DirectorySession} a @param {DirectorySession} b */
const orderByReply = (a, b) => {
    const aReply = a.reply ?? null;
    const bReply = b.reply ?? null;
    return aReply !== null && bReply !== null ? bReply.id - aReply.id
        : aReply !== null ? -1 : bReply !== null ? 1 : 0;
};
/** {§web-document} {§web-directory-documents} One compiled document supplies the complete HTML/OTM substrate. */
export default class Documents {
    #beforeTitle;
    #beforeMain;
    #afterMain;
    #home;
    #yolo;
    #reasoningPreviewChars;

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

    /** @param {string} document @param {boolean | null} yolo @param {number | null} reasoningPreviewChars */
    constructor(document, yolo, reasoningPreviewChars) {
        this.#yolo = yolo;
        this.#reasoningPreviewChars = reasoningPreviewChars;
        const parts = document.split(/<main\b[^>]*>|<\/main>/u);
        if (parts.length !== 3) throw new Error("The web document must contain exactly one main element.");
        const title = parts[0].split(/<title\b[^>]*>|<\/title>/u);
        if (title.length !== 3) throw new Error("The web document must contain exactly one title element before main.");
        this.#beforeTitle = title[0];
        const navigation = title[2].split(/<template id="session-navigation"[^>]*>|<\/template>/u);
        if (navigation.length !== 3) throw new Error("The web document must contain exactly one session-navigation template before main.");
        const header = navigation[2].split("</header>");
        if (header.length !== 2) throw new Error("The web document must close its header once after session navigation and before main.");
        this.#beforeMain = [navigation[0], navigation[1], ...header];
        this.#home = parts[1];
        this.#afterMain = parts[2];
    }

    /** @param {string} title @param {string} body @param {"home" | "daemon" | "workspace" | "session" | "error" | "account"} kind @param {boolean} [authenticated] @param {string} [breadcrumb] @param {string} [footer] @param {string} [dialogs] @param {string} [mainAttributes] */
    #render(title, body, kind, authenticated = false, breadcrumb = this.#breadcrumb(), footer = "", dialogs = "", mainAttributes = "") {
        const [before, navigation, afterNavigation, afterHeader] = this.#beforeMain;
        const label = kind === "home" ? title : `${title} — Plurnk`;
        return Buffer.from(`${this.#beforeTitle}<title data-text="page-title">${escapeHtml(label)}</title>${before}${authenticated ? navigation : ""}${afterNavigation}${breadcrumb}</header>${afterHeader}<main id="main" data-page="${kind}"${mainAttributes}>${body}${dialogs}</main>${footer}${this.#afterMain}`);
    }
    /** @param {boolean} authenticated @param {{ readSessionOverview?: (args: { workspaceId?: number, limit: number, excerptChars: number }) => Promise<DirectoryOverview> }} [port] */
    home(authenticated, port) {
        if (typeof port?.readSessionOverview !== "function") return this.#render("Plurnk", this.#home, "home", authenticated);
        return port.readSessionOverview({ limit: Number.MAX_SAFE_INTEGER, excerptChars: 1 }).then((overview) =>
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

    /** {§web-workspace-creation} The creation form a refused submission offers again, with its draft and a fresh token. @param {string} name */
    retryCreation(name) { return this.#creationFields(name, ""); }

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
            + this.#creationFields("", CANCEL)
            + '</article></dialog>';
    }

    /** @param {string} name @param {string} cancel */
    #creationFields(name, cancel) {
        return '<form id="workspace-create" method="post" action="/workspaces/new">'
            + `<input type="hidden" name="token" value="${randomUUID()}">`
            + `<input type="text" name="name" value="${escapeHtml(name)}" placeholder="Workspace name" aria-label="Workspace name" aria-describedby="workspace-name-hint">`
            + '<small id="workspace-name-hint" data-i18n="workspace-name-hint">Leave it empty and the daemon names the workspace.</small>'
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
            ? '<span role="img" aria-current="page" aria-label="Workspaces" title="Workspaces">🗃️</span> <button type="button" data-dialog-target="dialog-workspace-create" aria-label="New workspace" title="New workspace">➕</button>'
            : '<a href="/~/" aria-label="Workspaces" title="Workspaces">🗃️</a>';
        return `<nav aria-label="breadcrumb"><ul>${[root, ...items].map((item) => `<li>${item}</li>`).join("")}</ul></nav>`;
    }

    /** @param {import("./directory-addresses.js").Directory} directory @param {string} marker */
    #breadcrumbs(directory, marker) {
        const current = (/** @type {string} */ name) => `<span aria-current="page" data-text="name">${escapeHtml(name)}</span>`;
        const items = [];
        if (directory.kind === "workspace") {
            items.push(`${marker} ${current(directory.workspace)} <button type="button" data-dialog-target="dialog-workspace-rename" aria-label="Rename workspace" title="Rename workspace">✏️</button> <button type="button" data-dialog-target="dialog-workspace-archive" aria-label="Archive workspace" title="Archive workspace">🗑️</button> <button type="button" data-dialog-target="dialog-session-create" aria-label="New session" title="New session">➕</button>`);
        }
        if (directory.kind === "session") {
            const path = directoryPath({ kind: "workspace", workspace: directory.workspace });
            if (path === null) throw new Error("An admitted session must have a workspace directory address.");
            items.push(`<span id="session-workspace">${marker} <a href="${escapeHtml(path)}" data-bind="href:workspace-path" data-text="workspace-name">${escapeHtml(directory.workspace)}</a></span>`, `${current(directory.session)} <button type="button" data-dialog-target="dialog-session-archive" aria-label="Archive session" title="Archive session">🗑️</button>`);
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
     */
    #sessionIdentity(workspace, session, parent) {
        const path = directoryPath({ kind: "session", workspace: workspace.name, session: session.name });
        const name = escapeHtml(session.name);
        const ant = path === null ? '<span data-session-link role="img" aria-label="Session"></span>'
            : `<a data-session-link href="${escapeHtml(path)}" aria-label="${name}" title="Open session ${name}"></a>`;
        const parentName = parent === null ? "" : parent.origin === "model"
            ? this.#link(parent.name, { kind: "session", workspace: workspace.name, session: parent.name })
            : `<span>${escapeHtml(parent.name)}</span>`;
        const lineage = parent === null ? "" : `<span data-session-parent>${parentName} &gt; </span>`;
        const lifecycle = escapeHtml(session.lifecycle);
        const folder = workspace.project_root !== null;
        return `<span data-session-identity>${ant} <span data-lifecycle="${lifecycle}" role="img" aria-label="${lifecycle}" title="${lifecycle}"></span> `
            + `${lineage}<span>${name}</span></span>`
            + `<span data-session-workspace><span data-folder="${folder}" role="img" aria-label="${folder ? "Project workspace" : "Folderless workspace"}"></span> `
            + `${this.#link(workspace.name, { kind: "workspace", workspace: workspace.name })}</span>`;
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
                const identity = this.#sessionIdentity(workspace, session, this.#parent(session, sessions));
                const reply = this.#replyOutlet(workspace.id, session);
                const content = descendants.length === 0 && reply === "" ? `<header>${identity}</header>`
                    : `<details><summary>${identity}</summary>${list(descendants)}${reply}</details>`;
                return `<li data-directory-entry="session"><article aria-label="Session">${content}</article></li>`;
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
            lifecycle: session.lifecycle,
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
        return this.#sessionTree(workspaces, byId);
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
            + `<li data-status-field="yolo"><button type="button" id="session-yolo" aria-pressed="${automatic}" aria-label="Automatic approval" title="${automatic ? "Auto" : "Manual"} Approval (/yolo)"></button></li>`
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
        const content = '<article id="session-connection" role="alert"><header><span aria-hidden="true">⚠️</span> <span data-text="connection-label">Not connected.</span></header>'
            + '<p data-text="connection-detail">Displayed values are no longer live.</p>'
            + `<form id="session-reconnect" action="${escapeHtml(path)}" data-bind="action:session-path" data-reconnect><button type="submit" data-i18n="reconnect">Reconnect</button></form><p>`
            + `<a data-sign-in href="${escapeHtml(`/auth/login?return=${encodeURIComponent(path)}`)}" data-bind="href:sign-in-path" data-i18n="sign-in">Sign in</a>`
            + '</p></article>'
            + '<details id="session-streams" data-stream-outcomes><summary data-i18n="stream-outcomes">Observed stream outcomes</summary>'
            + '<p data-i18n="stream-outcomes-scope">Conclusions observed on this page, not a complete execution history.</p><ul></ul></details>'
            + '<section id="session-diagnostics" aria-label="Observed diagnostics"><p data-i18n="observed-diagnostics">Observed diagnostics</p><ul></ul></section>'
            + '<details id="session-activity"><summary data-i18n="observed-activity">Observed activity</summary>'
            + '<p data-i18n="activity-scope">Non-conversation evidence observed on this page, not a complete history.</p><ul></ul></details>'
            + '<section id="session-conversation" aria-label="Conversation">'
            + '<p data-empty-conversation data-i18n="no-messages">No messages.</p>'
            + '<noscript><p data-i18n="conversation-needs-js">Conversation requires JavaScript.</p></noscript>'
            + '<ul data-messages></ul></section>';
        return { content, footer };
    }
    /**
     * @param {import("./directory-addresses.js").Directory} directory
     * @param {{ listWorkspaces(): Promise<readonly DirectoryWorkspace[]>, listSessions(workspaceId: number): Promise<readonly DirectorySession[]>, readSessionOverview?: (args: { workspaceId?: number, limit: number, excerptChars: number }) => Promise<DirectoryOverview> }} port
     * @param {boolean} authenticated
     * @param {boolean} [own] {§web-session-approval} whether the person reached the page by their own navigation; only then
     * does a session page start with the configured automatic approval
     */
    async read(directory, port, authenticated, own = false) {
        const render = (/** @type {string} */ title, /** @type {string} */ body, marker = "", footer = "", dialogs = "", mainAttributes = "") =>
            this.#render(title, body, directory.kind, authenticated, this.#breadcrumbs(directory, marker), footer, dialogs, mainAttributes);
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
        if (directory.kind === "workspace") {
            // {§web-workspace-folder}
            const separateFolder = workspace.project_label !== null && workspace.project_label !== workspace.name;
            const folder = separateFolder ? '<p><span role="img" aria-label="Project folder">🗂️</span> '
                + `<span data-text="project-label">${escapeHtml(workspace.project_label)}</span></p>` : "";
            const marker = separateFolder ? '<span role="img" aria-label="Workspace">☁️</span>' : this.#workspaceMarker(workspace.project_root);
            const dialogs = this.#renameForm(workspace) + this.#workspaceArchiveForm(workspace) + this.#sessionCreationForm(workspace);
            const live = typeof port.readSessionOverview === "function";
            const overview = typeof port.readSessionOverview === "function"
                ? await port.readSessionOverview({ workspaceId: workspace.id, limit: Number.MAX_SAFE_INTEGER, excerptChars: 1 })
                : null;
            const replies = new Map(overview?.sessions.map((entry) => [entry.id, entry.reply]) ?? []);
            const treeSessions = new Map(sessions.map((entry) => [entry.id, {
                ...entry,
                workspaceId: workspace.id,
                reply: replies.get(entry.id) ?? entry.reply ?? null,
            }]));
            const mainAttributes = live ? ` data-workspace-id="${workspace.id}" data-auth="${authenticated ? "session" : "none"}" data-connection="initial"` : "";
            return render(workspace.name, folder + this.#sessionTree(new Map([[workspace.id, workspace]]), treeSessions), marker, "", dialogs, mainAttributes);
        }
        const session = sessions.find(({ name, origin }) => name === directory.session && origin === "model");
        if (session === undefined) return null;
        if (this.#yolo === null || this.#reasoningPreviewChars === null) {
            throw new RequestError(503, "Session pages are unavailable because their configuration is invalid.");
        }
        const parent = this.#parent(session, byId);
        const label = parent === null ? "" : parent.origin === "model"
            ? this.#link(parent.name, { kind: "session", workspace: workspace.name, session: parent.name })
            : `<span data-text="name">${escapeHtml(parent.name)}</span>`;
        const title = `${workspace.name}@${directory.session}`;
        const folder = workspace.project_label !== null && workspace.project_label !== workspace.name ? workspace.project_label : "";
        const iconLabel = workspace.project_label === null ? "Folderless workspace" : folder ? "Workspace" : "Project workspace";
        const marker = `<span role="img" aria-label="${iconLabel}" data-bind="aria-label:workspace-icon-label" data-text="workspace-icon">${workspace.project_label !== null && !folder ? "🗂️" : "☁️"}</span>`;
        const status = this.#sessionStatus(directory, workspace.id, authenticated, this.#yolo && own);
        const dialogs = this.#sessionArchiveForm(workspace, session);
        return render(title, `<p id="session-folder" data-project-label="${escapeHtml(folder)}"><span role="img" aria-label="Project folder">🗂️</span> <span data-text="project-label">${escapeHtml(folder)}</span></p>`
            + (parent === null ? "" : `<p><span data-i18n="parent-session">Parent:</span> ${label}</p>`)
            + status.content, marker, status.footer, dialogs);
    }
}
