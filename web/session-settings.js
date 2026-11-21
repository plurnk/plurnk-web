import { $, on, the } from "on_the_money";
import { listModels, sessionModel, sessionEffort, modelLabel } from "./session-models.js";
import describeFailure from "./failure.js";

/** {§web-session-settings} Native modal dialogs and suggestions are an aid, never a route admission policy.
 * @param {Element} main @param {Element} status
 * @param {import("./session-models.js").Action} call
 * @param {() => AbortSignal} lifetime
 * @param {{ openOnboarding?: () => Promise<void> | void }} [options]
 */
export default function sessionSettings(main, status, call, lifetime, options = {}) {
    const panels = [
        { kind: "model", dialog: $.clone(main, "#model-settings") },
        { kind: "effort", dialog: $.clone(main, "#effort-settings") },
    ].map(({ kind, dialog }) => {
        const article = dialog instanceof HTMLElement ? $(dialog, "article") : null;
        const button = $(status, `#session-${kind}`);
        const field = dialog instanceof HTMLElement ? $(dialog, '[name="selection"]') : null;
        if (!(dialog instanceof HTMLDialogElement) || !(article instanceof HTMLElement)
            || !(button instanceof HTMLButtonElement)
            || !(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) {
            throw new Error("Session settings template is incomplete.");
        }
        const onboardingFooter = $(article, "footer:has([data-open-model-onboarding])");
        if (onboardingFooter instanceof HTMLElement && !options.openOnboarding) {
            onboardingFooter.hidden = true;
        }
        return { kind, dialog, article, button, field, close() {} };
    });
    for (const panel of panels) {
        const { kind, dialog, article, button, field } = panel;
        const aliasList = kind === "model" ? $(article, "[data-alias-choices]") : null;
        /** @type {AbortController | undefined} */
        let lookup;
        const available = () => field instanceof HTMLInputElement || [...field.options].some(({ value }) => value);
        const clear = () => the(article, { "settings-message": "", "settings-recovery": "" });
        panel.close = () => {
            lookup?.abort();
            if (dialog.open) dialog.close();
            the(button, "expanded", false);
        };
        dialog.onclose = () => {
            lookup?.abort();
            the(button, "expanded", false);
        };
        dialog.oncancel = (event) => {
            if (the(article, "settings-pending") !== null) {
                event.preventDefault();
            }
        };
        /** @param {unknown} error @param {AbortSignal} signal */
        const failure = async (error, signal) => {
            const { message, recovery } = await describeFailure(error);
            return { "settings-message": signal.aborted ? "Response not confirmed." : message, "settings-recovery": recovery };
        };
        const load = async () => {
            lookup?.abort();
            const request = lookup = new AbortController();
            const signal = AbortSignal.any([lifetime(), request.signal]);
            const invoke = (/** @type {string} */ actionKind, /** @type {Record<string, unknown>} */ params = {}) => call(actionKind, params, signal);
            clear();
            try {
                if (field instanceof HTMLInputElement) {
                    const datalist = $(article, "datalist");
                    if (!datalist) throw new Error("Model suggestions are missing.");
                    datalist.replaceChildren();
                    const { aliases, catalog } = await listModels(invoke, field.value);
                    signal.throwIfAborted();
                    if (aliasList instanceof HTMLUListElement) {
                        $.cloneEach(aliasList, "#alias-choice-item", aliases, (item, model) => {
                            const btn = $(item, "[data-select-alias]");
                            if (btn instanceof HTMLButtonElement) btn.dataset.selectAlias = model.alias;
                            the(item, {
                                "alias-name": model.alias,
                                "alias-route": `${model.provider}/${model.model}${model.effort ? ` (${model.effort})` : ""}`,
                            });
                        });
                    }
                    $.cloneEach(datalist, "#setting-option", [
                        ...aliases.map((model) => ({ value: model.alias, label: modelLabel(model) })),
                        ...catalog.items.map((model) => ({ value: model.selector, label: `${model.modelName}${model.readiness.ready ? "" : " — Not configured"}` })),
                    ], (option, { value, label }) => the(option, { "option-value": value, "option-label": label }));
                } else {
                    the(article, "selection-unavailable", "");
                    const { supported } = await sessionEffort(invoke);
                    signal.throwIfAborted();
                    $.cloneEach(field, "#setting-option", ["", ...supported], (option, value) => the(option, {
                        "option-value": value, "option-label": value || "Reasoning Effort", "option-disabled": value ? null : "",
                    }));
                    field.value = "";
                    the(article, { "selection-unavailable": supported.length ? null : "", "settings-message": supported.length ? "" : "No supported efforts." });
                    if (document.activeElement === article) field.focus();
                }
            } catch (error) {
                // Closing or superseding suggestions intentionally discards only a read, never a mutation.
                const message = await failure(error, signal);
                if (!request.signal.aborted) the(article, message);
            }
        };
        /** @param {string} selection */
        const applySelection = async (selection) => {
            if (the(article, "settings-pending") !== null) return;
            lookup?.abort();
            clear();
            const signal = lifetime();
            the(article, { "settings-pending": "true", "selection-unavailable": "" });
            try {
                const invoke = (/** @type {string} */ actionKind, /** @type {Record<string, unknown>} */ params = {}) => call(actionKind, params, signal);
                if (kind === "model") await sessionModel(invoke, selection);
                else await sessionEffort(invoke, selection);
                signal.throwIfAborted();
                panel.close();
                button.focus();
            } catch (error) {
                the(article, await failure(error, signal));
            } finally {
                the(article, { "settings-pending": null, "selection-unavailable": available() ? null : "" });
            }
        };
        on(status, "click", `#session-${kind}`, async () => {
            if (panels.some(({ article: a }) => the(a, "settings-pending") !== null)) return;
            if (dialog.open) { panel.close(); return; }
            for (const other of panels) other.close();
            dialog.showModal();
            the(button, "expanded", true);
            field.value = "";
            if (field instanceof HTMLInputElement) field.focus();
            else article.focus();
            await load();
        });
        on(dialog, "click", "[data-cancel-settings]", () => {
            if (the(article, "settings-pending") !== null) return;
            panel.close();
            button.focus();
        });
        on(dialog, "click", "[data-select-alias]", (_event, btn) => {
            const alias = btn instanceof HTMLButtonElement ? btn.dataset.selectAlias : "";
            if (alias) void applySelection(alias);
        });
        on(dialog, "click", "[data-open-model-onboarding]", () => {
            if (the(article, "settings-pending") !== null) return;
            panel.close();
            void options.openOnboarding?.();
        });
        if (field instanceof HTMLInputElement) on(dialog, "input", 'input[name="selection"]', load);
        on(dialog, "submit", "form", async (event) => {
            event.preventDefault();
            await applySelection(field.value);
        });
    }
    return () => {
        const openPanel = panels.find(({ dialog, article }) => dialog.open && the(article, "settings-pending") === null);
        if (!openPanel) return false;
        openPanel.close();
        openPanel.button.focus();
        return true;
    };
}
