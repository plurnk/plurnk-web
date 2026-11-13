import { $, the } from "on_the_money";
import { isRecord } from "@plurnk/plurnk-contracts";

/**
 * {§web-session-commands} {§web-workspace-settings} Extracts effective environment entries without exposing secret values.
 * @param {unknown} res
 * @param {"session" | "workspace"} fallbackOrigin
 */
export function extractEnvEntries(res, fallbackOrigin) {
    if (!isRecord(res)) return [];
    const list = Array.isArray(res.definitions) ? res.definitions
        : Array.isArray(res.items) ? res.items : [];
    return list.flatMap((item) => {
        if (!isRecord(item)) return [];
        const alias = typeof item.alias === "string" ? item.alias
            : typeof item.name === "string" ? item.name : "";
        if (!alias) return [];
        const origin = item.origin === "session" || item.origin === "workspace" || item.origin === "service"
            ? item.origin
            : fallbackOrigin;
        const state = typeof item.state === "string" ? item.state : "active";
        const source = isRecord(item.provenance) && typeof item.provenance.source === "string" && item.provenance.source.length > 0
            ? item.provenance.source
            : "";
        return [{ alias, origin, state, source }];
    });
}

/**
 * {§web-session-commands} {§web-workspace-settings} Reconciles a `#command-env` panel in place.
 * @param {Element} panel
 * @param {unknown} res
 * @param {"session" | "workspace"} listScope
 */
export function populateEnvPanel(panel, res, listScope) {
    const tbody = $(panel, "tbody");
    if (!tbody) throw new Error("Environment panel template is incomplete.");
    const entries = extractEnvEntries(res, listScope);
    $.cloneEach(tbody, "#command-env-row", entries, (tr, entry) => {
        the(tr, {
            envAlias: entry.alias,
            envOrigin: entry.origin,
            envStatus: entry.source ? `${entry.state} (${entry.source})` : entry.state,
            envRemovable: entry.origin === "session" || entry.origin === "workspace" ? "true" : "false",
            envEnabled: entry.state !== "disabled" ? "true" : "false",
        });
    });
    the(panel, { envCount: entries.length, envBusy: null });
    return entries.length;
}
