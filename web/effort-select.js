import { $, the } from "on_the_money";

/** @typedef {ReturnType<typeof import("./session-models.js").createModelSearchCache>} ModelSearchCache */

/**
 * {§web-workspace-settings} {§web-session-commands} Populate a native reasoning-effort `<select>` from supported catalog efforts.
 * @param {HTMLSelectElement} effortSelect
 * @param {readonly string[]} supported
 * @param {string} defaultEffort
 * @param {string} preferredEffort
 * @returns {string}
 */
export function populateEffortSelect(effortSelect, supported, defaultEffort, preferredEffort) {
    if (supported.length === 0) {
        $.cloneEach(effortSelect, "#setting-option", [{ value: "", label: "Not applicable" }], (optEl, choice) => {
            the(optEl, { "option-value": choice.value, "option-label": choice.label, "option-disabled": "" });
        });
        effortSelect.disabled = true;
        effortSelect.value = "";
        return "";
    }
    const choices = supported.map((v) => ({ value: v, label: v }));
    $.cloneEach(effortSelect, "#setting-option", choices, (optEl, choice) => {
        the(optEl, { "option-value": choice.value, "option-label": choice.label, "option-disabled": null });
    });
    effortSelect.disabled = false;
    const resolved = preferredEffort && supported.includes(preferredEffort)
        ? preferredEffort
        : defaultEffort && supported.includes(defaultEffort)
            ? defaultEffort
            : (supported[0] ?? "");
    effortSelect.value = resolved;
    return resolved;
}

/**
 * {§web-workspace-settings} Seed static optional effort options (e.g. persona defaults) onto a `<select>` retaining its leading blank option.
 * @param {HTMLSelectElement | null} effortSelect
 * @param {readonly string[]} efforts
 */
export function populateStaticEffortSelect(effortSelect, efforts) {
    if (!(effortSelect instanceof HTMLSelectElement) || effortSelect.options.length > 1) return;
    for (const level of efforts) {
        const opt = $.clone(effortSelect, "#setting-option");
        the(opt, { "option-value": level, "option-label": level, "option-disabled": null });
    }
}

/**
 * {§web-workspace-settings} {§web-session-commands} Synchronize a `<select name="effort">` with a model combobox, resolving off-page catalog metadata on demand.
 * @param {{
 *   readonly getSelect: () => HTMLSelectElement | null,
 *   readonly getCache: () => ModelSearchCache | null,
 *   readonly getSelectedModel: () => string,
 *   readonly getSignal: () => AbortSignal,
 * }} options
 */
export function createModelEffortSync({ getSelect, getCache, getSelectedModel, getSignal }) {
    /** @type {AbortController | null} */
    let activeLookup = null;

    function abort() {
        activeLookup?.abort();
        activeLookup = null;
    }

    /**
     * @param {string} selectedModel
     * @param {string} preferredEffort
     * @param {readonly string[]} [knownEfforts]
     * @param {string} [knownDefaultEffort]
     * @returns {string}
     */
    function sync(selectedModel, preferredEffort, knownEfforts, knownDefaultEffort) {
        const select = getSelect();
        if (!(select instanceof HTMLSelectElement)) return "";
        if (knownEfforts !== undefined && knownEfforts.length > 0) {
            abort();
            return populateEffortSelect(select, knownEfforts, knownDefaultEffort ?? "", preferredEffort);
        }
        const cache = getCache();
        const entry = cache?.getCachedEfforts(selectedModel);
        const resolved = populateEffortSelect(select, entry?.efforts ?? [], entry?.defaultEffort ?? "", preferredEffort);
        if ((!entry || entry.efforts.length === 0) && selectedModel && selectedModel !== "none" && cache) {
            abort();
            const req = activeLookup = new AbortController();
            const parentSignal = getSignal();
            const lookupSignal = AbortSignal.any([parentSignal, req.signal]);
            void cache.resolveEfforts(selectedModel, lookupSignal).then((fetched) => {
                if (req.signal.aborted || parentSignal.aborted) return;
                const liveSelect = getSelect();
                if (!(liveSelect instanceof HTMLSelectElement)) return;
                if (getSelectedModel() !== selectedModel) return;
                if (fetched.efforts.length > 0) {
                    populateEffortSelect(liveSelect, fetched.efforts, fetched.defaultEffort, liveSelect.value || preferredEffort);
                }
            }).catch(() => {});
        }
        return resolved;
    }

    return {
        sync,
        abort,
        dispose: abort,
    };
}
