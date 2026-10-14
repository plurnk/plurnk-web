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
        return this.#render(title, '<article aria-labelledby="error-title"><header><h1 id="error-title">'
            + `<span aria-hidden="true">⚠️</span> <span data-text="error-title">${escapeHtml(title)}</span></h1></header>`
            + `<p data-text="error-message">${escapeHtml(message)}</p>`
            + '<footer><a href="/" data-i18n="home">Home</a></footer></article>', "error", authenticated);
    }

    /** {§web-account} Account navigation stays separate from session management. */
    account() {
        return this.#render("Account", '<article aria-labelledby="account-title"><header><h1 id="account-title" data-i18n="account">Account</h1></header>'
            + '<nav aria-label="Account"><ul><li><a href="/account/sessions/" data-i18n="sessions">Sessions</a></li></ul></nav></article>', "account", true);
    }

    /** {§web-account} Only authority-supplied facts are presented as session information.
     * @param {{ family: string, sessions: readonly import("@plurnk/plurnk-contracts").CredentialSession[] }} account
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
        return this.#render("Sessions", '<nav aria-label="breadcrumb"><ul><li><a href="/account/" data-i18n="account">Account</a></li>'
            + '<li><span aria-current="page" data-i18n="sessions">Sessions</span></li></ul></nav>'
            + '<article aria-labelledby="sessions-title"><header><h1 id="sessions-title" data-i18n="sessions">Sessions</h1></header>'
            + '<figure><table><thead><tr><th scope="col" data-i18n="session">Session</th><th scope="col" data-i18n="started">Started</th>'
            + '<th scope="col" data-i18n="expires">Expires</th><th scope="col" data-i18n="actions">Actions</th></tr></thead>'
            + `<tbody>${entries}</tbody></table></figure>${others ? `<footer>${others}</footer>` : ""}</article>`, "account", true);
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
