/** @typedef {import("./session-agent.js").Message} Message */
/** @typedef {{messages: readonly Message[], older: string | null, final: boolean}} Page */
/** @typedef {Page & {url: string | null}} Part */

/** @param {readonly Message[]} older @param {readonly Message[]} newer */
const merge = (older, newer) => [...new Map([...older, ...newer].map((message) => [message.id, message])).values()];
/** @param {readonly Message[]} messages */
function unique(messages) {
    if (new Set(messages.map(({ id }) => id)).size !== messages.length) throw new Error("Conversation has duplicate message identities.");
}

/** {§web-session-history} Read-only server projections; no event reduction or SDK mutation. */
export default class HistoryPages {
    /** @type {Part} */
    #window = { url: null, messages: [], older: null, final: false };
    /** @type {Part[]} Newest first, in the order reached through daemon boundaries. */
    #pages = [];

    /**
     * @param {{ messages: readonly Message[], older?: unknown, _meta?: { plurnk?: { history?: { older?: unknown } } } }} event
     * @param {boolean} reading
     */
    snapshot(event, reading) {
        const history = event._meta?.plurnk?.history;
        const older = event.older !== undefined
            ? event.older
            : (history !== undefined && "older" in history ? (history.older ?? null) : (event._meta?.plurnk !== undefined ? null : undefined));
        if (older !== null && (typeof older !== "string" || !older.trim())) throw new TypeError("History boundary must be a URL or null.");
        unique(event.messages);
        const incoming = new Set(event.messages.map(({ id }) => id));
        if (!reading) this.follow();
        else if (this.#window.messages.some(({ id }) => !incoming.has(id))) {
            this.#pages.unshift(this.#window);
        }
        this.#window = { url: null, messages: event.messages, older, final: false };
    }

    /** @param {readonly Message[]} messages */
    live(messages) {
        unique(messages);
        this.#window.messages = messages;
        for (const page of this.#pages) {
            if (page.final) continue;
            const ids = new Set(page.messages.map(({ id }) => id));
            const calls = new Set(page.messages.flatMap((message) => message.role === "assistant" ? message.toolCalls?.map(({ toolCallId }) => toolCallId) ?? [] : []));
            const observed = messages.filter((message) => ids.has(message.id)
                || (message.role === "tool" && !message._meta?.plurnk && calls.has(message.toolCallId)));
            page.messages = merge(page.messages, observed);
        }
    }

    follow() { this.#pages = this.#pages.filter(({ url }) => url !== null); }

    mutable() { return this.#pages.flatMap(({ url, final }) => url !== null && !final ? [url] : []); }

    /** @param {string} url */
    first(url) { return this.#pages.find((part) => part.url === url)?.messages[0]?.id ?? null; }

    /** @param {string} url @param {Page} page */
    accept(url, page) {
        if (page.older === url) throw new Error("History page repeats its own cursor.");
        const links = new Map(this.#pages.flatMap(({ url, older }) => url === null ? [] : [[url, older]]));
        links.set(url, page.older);
        const visited = new Set([url]);
        for (let next = page.older; next !== null && links.has(next); next = links.get(next) ?? null) {
            if (visited.has(next)) throw new Error("History page cursors form a cycle.");
            visited.add(next);
        }
        const existing = this.#pages.findIndex((part) => part.url === url);
        if (existing >= 0) {
            this.#pages[existing] = { ...page, url, messages: merge(this.#pages[existing].messages, page.messages) };
            return true;
        }
        const parts = [this.#window, ...this.#pages];
        const index = parts.findIndex((part) => part.older === url);
        if (index < 0) return false;
        this.#pages.splice(index, 0, { ...page, url });
        return true;
    }

    view() {
        const parts = [this.#window, ...this.#pages];
        // First occurrence owns placement; the newest observation owns its value.
        const messages = new Map(parts.toReversed().flatMap(({ messages }) => messages.map((message) => [message.id, message])));
        const ordered = [...messages.values()];
        // A delayed immediate receipt belongs beside its archived invocation, not at the live tail.
        const calls = new Map(this.#pages.flatMap(({ messages }) => messages).flatMap((message) => message.role === "assistant"
            ? (message.toolCalls ?? []).map(({ toolCallId }) => [toolCallId, message]) : []));
        /** @type {Map<string, Message[]>} */
        const results = new Map();
        const placed = new Set();
        for (const message of ordered) {
            if (message.role !== "tool" || message._meta?.plurnk) continue;
            const call = calls.get(message.toolCallId);
            if (!call) continue;
            const group = results.get(call.id) ?? [];
            group.push(message);
            results.set(call.id, group);
            placed.add(message.id);
        }
        /** @type {{url: string, before: string | null}[]} */
        const gaps = [];
        for (const [index, part] of parts.entries()) {
            if (part.older === null) continue;
            const following = parts.slice(index + 1);
            const next = following[0];
            if (following.some(({ url }) => url === part.older)) continue;
            const present = new Set(part.messages.map(({ id }) => id));
            if (next && (next.older === part.older || next.messages.some(({ id }) => present.has(id)))) continue;
            if (gaps.some(({ url }) => url === part.older)) continue;
            const preceding = new Set(following.flatMap(({ messages }) => messages.map(({ id }) => id)));
            gaps.unshift({ url: part.older, before: part.messages.find(({ id }) => !preceding.has(id))?.id ?? null });
        }
        return { messages: ordered.filter(({ id }) => !placed.has(id)).flatMap((message) => [message, ...(results.get(message.id) ?? [])]), gaps };
    }
}
