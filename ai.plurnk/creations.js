import { randomUUID } from "node:crypto";
import { directoryPath } from "./directory-addresses.js";
import { RequestError } from "./http.js";

/** @typedef {{ kind: "minted", expires: number } | { kind: "flight", creation: Promise<string> } | { kind: "done", path: string, expires: number } | { kind: "failed", error: Error, expires: number }} CreationEntry */

/** {§web-workspace-creation} Owns form-token convergence at the module's HTTP boundary;
 * the daemon's creation contract has no idempotency key of its own.
 */
export default class Creations {
    #ttl;
    #tokens;
    /** @type {Map<string, CreationEntry>} */
    #entries = new Map();

    /** @param {{ ttl: number, tokens: number }} limits */
    constructor({ ttl, tokens }) {
        this.#ttl = ttl;
        this.#tokens = tokens;
    }

    /** @param {number} now */
    #prune(now) {
        for (const [key, entry] of this.#entries) if (entry.kind !== "flight" && entry.expires <= now) this.#entries.delete(key);
    }

    /** Mints the hidden token of one rendered creation form.
     * @returns {string}
     */
    mint() {
        const now = Date.now();
        this.#prune(now);
        while (this.#entries.size >= this.#tokens) {
            // Unsubmitted forms are expendable, then the oldest settled outcome; an
            // all-in-flight registry may briefly exceed the bound rather than fail a page render.
            const idle = [...this.#entries].find(([, entry]) => entry.kind === "minted");
            const victim = idle ?? [...this.#entries].find(([, entry]) => entry.kind !== "flight");
            if (victim === undefined) break;
            this.#entries.delete(victim[0]);
        }
        const token = randomUUID();
        this.#entries.set(token, { kind: "minted", expires: now + this.#ttl * 1000 });
        return token;
    }

    /**
     * @param {string} token The form's hidden token.
     * @param {() => Promise<{ workspaceName: string, projectRoot: string | null }>} create
     * @returns {Promise<string>} The canonical address of the created workspace.
     */
    async submit(token, create) {
        this.#prune(Date.now());
        const entry = this.#entries.get(token);
        // A token the module never minted is a stale form, never a silent second creation.
        if (entry === undefined) throw new RequestError(400, "This creation form expired. Reload the workspace page and try again.");
        if (entry.kind === "minted") {
            const creation = (async () => {
                let envelope;
                try { envelope = await create(); }
                catch (cause) { throw new RequestError(502, "The daemon could not create the workspace.", { cause }); }
                if (envelope.projectRoot !== null) throw new Error("The daemon created a workspace with a project folder from a folderless request.");
                const path = directoryPath({ kind: "workspace", workspace: envelope.workspaceName });
                if (path === null) throw new Error("The daemon returned a workspace name without a directory address.");
                return path;
            })();
            this.#entries.set(token, { kind: "flight", creation });
            // Retain both outcomes: racing or retried posts converge; a settled failure is not blindly re-executed.
            creation.then((path) => { this.#entries.set(token, { kind: "done", path, expires: Date.now() + this.#ttl * 1000 }); },
                (error) => { this.#entries.set(token, { kind: "failed", error, expires: Date.now() + this.#ttl * 1000 }); });
            return creation;
        }
        if (entry.kind === "flight") return entry.creation;
        if (entry.kind === "done") return entry.path;
        throw entry.error;
    }
}