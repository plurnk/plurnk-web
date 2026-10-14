import { STATUS_CODES } from "node:http";
import { directoryPath } from "./directory-addresses.js";
import { escapeHtml } from "./http.js";

/** {§web-directory-documents} One compiled document supplies the complete HTML/OTM substrate. */
export default class Documents {
    #beforeTitle;
    #beforeMain;
    #afterMain;

    /** @param {string} document */
    constructor(document) {
        const parts = document.split(/<main\b[^>]*>|<\/main>/u);
        if (parts.length !== 3) throw new Error("The web document must contain exactly one main element.");
        const title = parts[0].split(/<title\b[^>]*>|<\/title>/u);
        if (title.length !== 3) throw new Error("The web document must contain exactly one title element before main.");
        [this.#beforeTitle, , this.#beforeMain] = title;
        this.#afterMain = parts[2];
    }

    /** @param {string} title @param {string} body @param {"daemon" | "workspace" | "worker" | "error"} kind @param {boolean} [authenticated] */
    #render(title, body, kind, authenticated = false) {
        const logout = authenticated
            ? '<footer><form method="post" action="/auth/logout"><button type="submit" data-i18n="sign-out">Sign out</button></form></footer>' : "";
        return Buffer.from(`${this.#beforeTitle}<title data-text="page-title">${escapeHtml(title)} — Plurnk</title>${this.#beforeMain}<main id="main" tabindex="-1" data-page="${kind}">${body}</main>${logout}${this.#afterMain}`);
    }

    /** {§web-page-shell} HTTP failures keep native navigation without disclosing request data.
     * @param {number} status @param {string} message
     */
    error(status, message) {
        const reason = STATUS_CODES[status];
        if (reason === undefined) throw new Error(`Unknown HTTP status: ${status}`);
        const title = `${status} ${reason}`;
        return this.#render(title, `<h1 data-text="error-title">${escapeHtml(title)}</h1><p data-text="error-message">${escapeHtml(message)}</p>`, "error");
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
