import { directoryPath } from "./directory-addresses.js";
import { RequestError } from "./http.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** @typedef {{ kind: "flight", creation: Promise<string>, expires: number } | { kind: "done", path: string, expires: number } | { kind: "failed", error: Error, expires: number }} CreationEntry */

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

    /**
     * @param {string} token The form's hidden token.
     * @param {() => Promise<string | { workspaceName: string, projectRoot: string | null }>} create
     * @returns {Promise<string>} The canonical address of the created workspace.
     */
    async submit(token, create) {
        if (!UUID_PATTERN.test(token)) throw new RequestError(400, "Invalid form token.");
        const now = Date.now();
        this.#prune(now);
        const existing = this.#entries.get(token);
        if (existing !== undefined) {
            if (existing.kind === "flight") return existing.creation;
            if (existing.kind === "done") return existing.path;
            throw existing.error;
        }

        while (this.#entries.size >= this.#tokens) {
            const completed = [...this.#entries].find(([, entry]) => entry.kind !== "flight");
            if (completed === undefined) break;
            this.#entries.delete(completed[0]);
        }

        const creation = (async () => {
            const result = await create();
            if (typeof result === "string") return result;
            if (result.projectRoot !== null) throw new Error("The daemon created a workspace with a project folder from a folderless request.");
            const path = directoryPath({ kind: "workspace", workspace: result.workspaceName });
            if (path === null) throw new Error("The daemon returned a workspace name without a directory address.");
            return path;
        })();
        this.#entries.set(token, { kind: "flight", creation, expires: now + this.#ttl * 1000 });
        creation.then(
            (path) => { this.#entries.set(token, { kind: "done", path, expires: Date.now() + this.#ttl * 1000 }); },
            (error) => { this.#entries.set(token, { kind: "failed", error, expires: Date.now() + this.#ttl * 1000 }); },
        );
        return creation;
    }
}