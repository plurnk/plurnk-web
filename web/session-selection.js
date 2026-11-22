/**
 * Order sessions most-recent-reply-first (`reply.id` descending), then sessions with a reply ahead of sessions without one.
 * @param {{ readonly reply?: { readonly id: number } | null }} a
 * @param {{ readonly reply?: { readonly id: number } | null }} b
 */
export function orderByReply(a, b) {
    const aReply = a.reply ?? null;
    const bReply = b.reply ?? null;
    return aReply !== null && bReply !== null ? bReply.id - aReply.id
        : aReply !== null ? -1 : bReply !== null ? 1 : 0;
}

/**
 * {§web-workspace-tabs} {§web-search} Untouched 0-loop root leaf sessions are ephemeral drafts.
 * @param {{
 *   readonly parentSessionId: number | null,
 *   readonly kind?: string,
 *   readonly lifecycle: string,
 *   readonly reply?: unknown,
 *   readonly title?: string | null,
 *   readonly gates?: number,
 * }} entry
 * @param {boolean} [hasModelChildren]
 */
export function isUntouchedDraftSession(entry, hasModelChildren = false) {
    const kind = entry.kind ?? (entry.parentSessionId === null ? "root" : "work");
    return entry.parentSessionId === null
        && kind === "root"
        && entry.lifecycle === "idle"
        && (entry.reply ?? null) === null
        && !(typeof entry.title === "string" && entry.title.trim() !== "")
        && (entry.gates ?? 0) === 0
        && !hasModelChildren;
}

/**
 * Truncate a single-line preview excerpt to at most `maxChars` characters.
 * @param {string} raw
 * @param {number} maxChars
 */
export function truncateSingleLine(raw, maxChars) {
    const clean = raw.replaceAll(/\s+/gu, " ").trim();
    if (clean.length <= maxChars) return clean;
    return `${clean.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

/**
 * Center a matched substring snippet around `qLower` within `maxChars` characters.
 * @param {string} raw
 * @param {string} qLower
 * @param {number} maxChars
 */
export function matchSnippet(raw, qLower, maxChars) {
    const clean = raw.replaceAll(/\s+/gu, " ").trim();
    if (clean.length <= maxChars) return clean;
    const idx = clean.toLowerCase().indexOf(qLower);
    if (idx <= 0) return truncateSingleLine(clean, maxChars);
    const half = Math.max(0, Math.floor((maxChars - qLower.length) / 2));
    const start = Math.max(0, idx - half);
    const slice = clean.slice(start, start + maxChars).trim();
    return `${start > 0 ? "…" : ""}${slice}${start + maxChars < clean.length ? "…" : ""}`;
}
