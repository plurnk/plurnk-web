import { STATUS_CODES } from "node:http";
import { directoryPath } from "./directory-addresses.js";
import { escapeHtml } from "./http.js";

/** {§web-directory-documents} One compiled document supplies the complete HTML/OTM substrate. */
export default class Documents {
    #beforeTitle;
    #beforeMain;
    #afterMain;
    #home;

    /** @param {string} document */
    constructor(document) {
        const parts = document.split(/<main\b[^>]*>|<\/main>/u);
        if (parts.length !== 3) throw new Error("The web document must contain exactly one main element.");
        const title = parts[0].split(/<title\b[^>]*>|<\/title>/u);
        if (title.length !== 3) throw new Error("The web document must contain exactly one title element before main.");
        this.#beforeTitle = title[0];
        this.#beforeMain = title[2].split(/<template id="session-navigation"[^>]*>|<\/template>/u);
        if (this.#beforeMain.length !== 3) throw new Error("The web document must contain exactly one session-navigation template before main.");
        this.#home = parts[1];
        this.#afterMain = parts[2];
    }

    /** @param {string} title @param {string} body @param {"home" | "daemon" | "workspace" | "worker" | "error" | "account"} kind @param {boolean} [authenticated] */
    #render(title, body, kind, authenticated = false) {
        const [before, navigation, after] = this.#beforeMain;
        const label = kind === "home" ? title : `${title} — Plurnk`;
        return Buffer.from(`${this.#beforeTitle}<title data-text="page-title">${escapeHtml(label)}</title>${before}${authenticated ? navigation : ""}${after}<main id="main" tabindex="-1" data-page="${kind}">${body}</main>${this.#afterMain}`);
    }

    /** @param {boolean} authenticated */
    home(authenticated) { return this.#render("Plurnk", this.#home, "home", authenticated); }

    /** {§web-page-shell} HTTP failures keep native navigation without disclosing request data.
     * @param {number} status @param {string} message @param {boolean} [authenticated]
     */
    error(status, message, authenticated = false) {
        const reason = STATUS_CODES[status];
        if (reason === undefined) throw new Error(`Unknown HTTP status: ${status}`);
        const title = `${status} ${reason}`;
        return this.#render(title, `<h1 data-text="error-title">${escapeHtml(title)}</h1><p data-text="error-message">${escapeHtml(message)}</p>`, "error", authenticated);
    }

    /** {§web-account} Only authority-supplied facts are presented as session information.
     * @param {{ subject: string, family: string, sessions: readonly import("@plurnk/plurnk-contracts").CredentialSession[] }} account
     */
    account({ subject, family, sessions }) {
        const time = (/** @type {number} */ timestamp) => {
            const iso = new Date(timestamp).toISOString();
            return `<time datetime="${iso}" data-text="session-time">${iso.replace("T", " ").replace(/\.\d{3}Z$/u, " UTC")}</time>`;
        };
        const entries = sessions.map((entry) => {
            const current = entry.family === family;
            const action = current ? "/auth/logout" : `/account/sessions/${encodeURIComponent(entry.family)}/revoke`;
            return `<li data-session="${escapeHtml(entry.family)}"><h3 data-i18n="${current ? "this-session" : "another-session"}">${current ? "This session" : "Another session"}</h3>`
                + `<dl><dt data-i18n="started">Started</dt><dd>${time(entry.createdAt)}</dd>`
                + `<dt data-i18n="expires">Expires</dt><dd>${time(entry.expiresAt)}</dd>`
                + `<dt data-i18n="clients">Clients</dt><dd data-text="session-clients">${entry.clients.map(escapeHtml).join(", ")}</dd></dl>`
                + `<form method="post" action="${escapeHtml(action)}"><button type="submit" data-i18n="${current ? "end-this-session" : "revoke-session"}">${current ? "End this session" : "Revoke session"}</button></form></li>`;
        }).join("");
        const others = sessions.some((entry) => entry.family !== family)
            ? '<form method="post" action="/account/sessions/revoke-others"><button type="submit" data-i18n="revoke-others">Revoke other sessions</button></form>' : "";
        return this.#render("Account", '<h1 data-i18n="account">Account</h1>'
            + `<dl><dt data-i18n="signed-in-as">Signed in as</dt><dd data-text="subject">${escapeHtml(subject)}</dd></dl>`
            + `<section aria-labelledby="sign-ins"><h2 id="sign-ins" data-i18n="sign-ins">Sign-ins</h2><ul>${entries}</ul>${others}</section>`, "account", true);
    }

    /** @param {string} label @param {import("./directory-addresses.js").Directory} directory */
    #link(label, directory) {
        const path = directoryPath(directory);
        return path === null ? `<span data-text="name">${escapeHtml(label)}</span>`
            : `<a href="${escapeHtml(path)}" data-text="name">${escapeHtml(label)}</a>`;
    }

    /** @param {import("./directory-addresses.js").Directory} directory */
    #breadcrumbs(directory) {
        const current = (/** @type {string} */ name) => `<span aria-current="page" data-text="name">${escapeHtml(name)}</span>`;
        const items = ['<a href="/" data-i18n="home">Home</a>'];
        items.push(directory.kind === "daemon" ? current("Workspaces") : this.#link("Workspaces", { kind: "daemon" }));
        if (directory.kind === "workspace") items.push(current(directory.workspace));
        if (directory.kind === "worker") {
            items.push(this.#link(directory.workspace, { kind: "workspace", workspace: directory.workspace }), current(directory.worker));
        }
        return `<nav aria-label="breadcrumb"><ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul></nav>`;
    }

    /**
     * @param {import("./directory-addresses.js").Directory} directory
     * @param {Pick<import("@plurnk/plurnk-contracts").ApplicationPort, "listWorkspaces" | "listWorkers">} port
     * @param {boolean} authenticated
     */
    async read(directory, port, authenticated) {
        const render = (/** @type {string} */ title, /** @type {string} */ body) => this.#render(title,
            `${this.#breadcrumbs(directory)}<h1 data-text="directory-title">${escapeHtml(title)}</h1>${body}`, directory.kind, authenticated);
        const workspaces = await port.listWorkspaces();
        if (directory.kind === "daemon") {
            const items = workspaces.map(({ name }) => `<li>${this.#link(name, { kind: "workspace", workspace: name })}</li>`).join("");
            return render("Workspaces", items ? `<ul>${items}</ul>` : '<p data-i18n="no-workspaces">No workspaces.</p>');
        }
        const workspace = workspaces.find(({ name }) => name === directory.workspace);
        if (workspace === undefined) return null;
        const workers = await port.listWorkers(workspace.id);
        if (directory.kind === "workspace") {
            const items = workers.map(({ name }) => `<li>${this.#link(name, { kind: "worker", workspace: workspace.name, worker: name })}</li>`).join("");
            return render(workspace.name, items ? `<ul>${items}</ul>` : '<p data-i18n="no-workers">No workers.</p>');
        }
        if (!workers.some(({ name }) => name === directory.worker)) return null;
        return render(`${workspace.name}@${directory.worker}`, "");
    }
}
