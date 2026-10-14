import { directoryPath } from "./directory-addresses.js";
import { escapeHtml } from "./http.js";

/** {§web-directory-documents} One compiled document supplies the complete HTML/OTM substrate. */
export default class Documents {
    #before;
    #after;

    /** @param {string} document */
    constructor(document) {
        const parts = document.split(/<main>|<\/main>/u);
        if (parts.length !== 3) throw new Error("The web document must contain exactly one main element.");
        [this.#before, , this.#after] = parts;
    }

    /** @param {string} title @param {string} body @param {boolean} authenticated */
    #render(title, body, authenticated) {
        const logout = authenticated
            ? '<form method="post" action="/auth/logout"><button type="submit" data-i18n="sign-out">Sign out</button></form>' : "";
        return Buffer.from(`${this.#before}<main><h1 data-text="directory-title">${escapeHtml(title)}</h1>${body}${logout}</main>${this.#after}`);
    }

    /** @param {string} label @param {import("./directory-addresses.js").Directory} directory */
    #link(label, directory) {
        const path = directoryPath(directory);
        return path === null ? `<span data-text="name">${escapeHtml(label)}</span>`
            : `<a href="${escapeHtml(path)}" data-text="name">${escapeHtml(label)}</a>`;
    }

    /**
     * @param {import("./directory-addresses.js").Directory} directory
     * @param {Pick<import("@plurnk/plurnk-contracts").ApplicationPort, "listWorkspaces" | "listWorkers">} port
     * @param {boolean} authenticated
     */
    async read(directory, port, authenticated) {
        const workspaces = await port.listWorkspaces();
        if (directory.kind === "daemon") {
            const items = workspaces.map(({ name }) => `<li>${this.#link(name, { kind: "workspace", workspace: name })}</li>`).join("");
            return this.#render("Workspaces", `<ul>${items}</ul>`, authenticated);
        }
        const workspace = workspaces.find(({ name }) => name === directory.workspace);
        if (workspace === undefined) return null;
        const workers = await port.listWorkers(workspace.id);
        const parent = directory.kind === "workspace" ? { kind: "daemon" } : { kind: "workspace", workspace: workspace.name };
        const up = `<p>${this.#link("Parent directory", /** @type {import("./directory-addresses.js").Directory} */ (parent))}</p>`;
        if (directory.kind === "workspace") {
            const items = workers.map(({ name }) => `<li>${this.#link(name, { kind: "worker", workspace: workspace.name, worker: name })}</li>`).join("");
            return this.#render(workspace.name, `${up}<ul>${items}</ul>`, authenticated);
        }
        if (!workers.some(({ name }) => name === directory.worker)) return null;
        return this.#render(`${workspace.name}@${directory.worker}`, up, authenticated);
    }
}
