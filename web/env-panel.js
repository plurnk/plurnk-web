import { $, the } from "on_the_money";
import { isRecord } from "./session-translator.js";

/**
 * {§web-session-commands} {§web-workspace-settings} Extracts effective environment entries without exposing secret values.
 * @param {unknown} res
 * @param {"service" | "session" | "workspace"} fallbackOrigin
 */
export function extractEnvEntries(res, fallbackOrigin) {
    if (!isRecord(res)) return [];
    const list = Array.isArray(res.definitions) ? res.definitions : [];
    return list.flatMap((item) => {
        if (!isRecord(item)) return [];
        const alias = typeof item.alias === "string" ? item.alias : "";
        if (!alias) return [];
        const origin = item.origin === "session" || item.origin === "workspace" || item.origin === "service" || item.origin === "host"
            ? item.origin
            : fallbackOrigin;
        const state = typeof item.state === "string" ? item.state : "active";
        const source = isRecord(item.provenance) && typeof item.provenance.source === "string" && item.provenance.source.length > 0
            ? item.provenance.source
            : "";
        const secret = isRecord(item.definition) && item.definition.secret === true;
        return [{ alias, origin, state, source, secret }];
    });
}

/**
 * {§web-session-commands} {§web-workspace-settings} Reconciles a `#command-env` panel in place.
 * @param {Element} panel
 * @param {unknown} res
 * @param {"service" | "session" | "workspace"} listScope
 */
export function populateEnvPanel(panel, res, listScope) {
    const tbody = $(panel, "tbody");
    if (!tbody) throw new Error("Environment panel template is incomplete.");
    const entries = extractEnvEntries(res, listScope);
    $.cloneEach(tbody, "#command-env-row", entries, (tr, entry) => {
        const removable = entry.origin === listScope || (listScope === "session" && entry.origin === "workspace");
        const statusBase = entry.secret ? `secret · ${entry.state}` : entry.state;
        the(tr, {
            "env-alias": entry.alias,
            "env-origin": entry.origin,
            "env-status": entry.source ? `${statusBase} (${entry.source})` : statusBase,
            "env-secret": entry.secret ? "true" : "false",
            "env-removable": removable ? "true" : "false",
            "env-enabled": entry.state !== "disabled" ? "true" : "false",
        });
    });
    the(panel, { "env-count": entries.length, "env-busy": null });
    return entries.length;
}
