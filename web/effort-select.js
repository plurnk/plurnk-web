import { $, the } from "on_the_money";

/** @typedef {ReturnType<typeof import("./session-models.js").createModelSearchCache>} ModelSearchCache */

/**
 * {§web-workspace-settings} {§web-session-commands} Populate a native reasoning-effort `<select>` from supported catalog efforts.
 * @param {HTMLSelectElement} effortSelect
 * @param {readonly string[]} supported
 * @param {string} defaultEffort
 * @param {string} preferredEffort
 * @param {{ readonly optionalLabel?: string }} [options]
 * @returns {string}
 */
export function populateEffortSelect(effortSelect, supported, defaultEffort, preferredEffort, { optionalLabel } = {}) {
    if (supported.length === 0) {
        const placeholder = optionalLabel ?? "Not applicable";
        $.cloneEach(effortSelect, "#setting-option", [{ value: "", label: placeholder }], (optEl, choice) => {
            the(optEl, { "option-value": choice.value, "option-label": choice.label, "option-disabled": optionalLabel ? null : "" });
        });
        effortSelect.disabled = !optionalLabel;
        effortSelect.value = "";
        return "";
    }
    const choices = [
        ...(optionalLabel ? [{ value: "", label: optionalLabel }] : []),
        ...supported.map((v) => ({ value: v, label: v })),
    ];
    $.cloneEach(effortSelect, "#setting-option", choices, (optEl, choice) => {
        the(optEl, { "option-value": choice.value, "option-label": choice.label, "option-disabled": null });
    });
    effortSelect.disabled = false;
    const resolved = preferredEffort && supported.includes(preferredEffort)
        ? preferredEffort
        : optionalLabel
            ? ""
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
 *   readonly optionalLabel?: string,
 *   readonly fallbackEfforts?: readonly string[],
 * }} options
 */
export function createModelEffortSync({ getSelect, getCache, getSelectedModel, getSignal, optionalLabel, fallbackEfforts }) {
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
        const trimmed = selectedModel.trim();
        if (!trimmed && optionalLabel && fallbackEfforts) {
            abort();
            return populateEffortSelect(select, fallbackEfforts, "", preferredEffort, { optionalLabel });
        }
        if (knownEfforts !== undefined && knownEfforts.length > 0) {
            abort();
            return populateEffortSelect(select, knownEfforts, knownDefaultEffort ?? "", preferredEffort, { optionalLabel });
        }
        const cache = getCache();
        const entry = cache?.getCachedEfforts(trimmed);
        const resolved = populateEffortSelect(
            select,
            entry?.efforts ?? [],
            entry?.defaultEffort ?? "",
            preferredEffort,
            { optionalLabel },
        );
        if ((!entry || entry.efforts.length === 0) && trimmed && trimmed !== "none" && cache) {
            abort();
            const req = activeLookup = new AbortController();
            const parentSignal = getSignal();
            const lookupSignal = AbortSignal.any([parentSignal, req.signal]);
            void cache.resolveEfforts(trimmed, lookupSignal).then((fetched) => {
                if (req.signal.aborted || parentSignal.aborted) return;
                const liveSelect = getSelect();
                if (!(liveSelect instanceof HTMLSelectElement)) return;
                if (getSelectedModel().trim() !== trimmed) return;
                if (fetched.efforts.length > 0) {
                    populateEffortSelect(
                        liveSelect,
                        fetched.efforts,
                        fetched.defaultEffort,
                        liveSelect.value || preferredEffort,
                        { optionalLabel },
                    );
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
