import { $, on, the } from "on_the_money";
import { listModels, sessionModel, sessionEffort, modelLabel } from "./session-models.js";
import describeFailure from "./failure.js";

/** {§web-session-settings} Native suggestions are an aid, never a route admission policy.
 * @param {Element} main @param {Element} status
 * @param {import("./session-models.js").Action} call
 * @param {() => AbortSignal} lifetime
 */
export default function sessionSettings(main, status, call, lifetime) {
    const panels = [
        { kind: "model", article: $.clone(main, "#model-settings") },
        { kind: "effort", article: $.clone(main, "#effort-settings") },
    ].map(({ kind, article }) => {
        const button = $(status, `#session-${kind}`);
        const field = $(article, '[name="selection"]');
        if (!(article instanceof HTMLElement) || !(button instanceof HTMLButtonElement)
            || !(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) {
            throw new Error("Session settings template is incomplete.");
        }
        return { kind, article, button, field, close() {} };
    });
    for (const panel of panels) {
        const { kind, article, button, field } = panel;
        /** @type {AbortController | undefined} */
        let lookup;
        const available = () => field instanceof HTMLInputElement || [...field.options].some(({ value }) => value);
        const clear = () => the(article, { settingsMessage: "", settingsRecovery: "" });
        panel.close = () => { lookup?.abort(); article.hidden = true; the(button, "expanded", false); };
        /** @param {unknown} error @param {AbortSignal} signal */
        const failure = async (error, signal) => {
            const { message, recovery } = await describeFailure(error);
            return { settingsMessage: signal.aborted ? "Response not confirmed." : message, settingsRecovery: recovery };
        };
        const load = async () => {
            lookup?.abort();
            const request = lookup = new AbortController();
            const signal = AbortSignal.any([lifetime(), request.signal]);
            const invoke = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ params = {}) => call(kind, params, signal);
            clear();
            try {
                if (field instanceof HTMLInputElement) {
                    const options = $(article, "datalist");
                    if (!options) throw new Error("Model suggestions are missing.");
                    options.replaceChildren();
                    const { aliases, catalog } = await listModels(invoke, field.value);
                    signal.throwIfAborted();
                    $.cloneEach(options, "#setting-option", [
                        ...aliases.map((model) => ({ value: model.alias, label: modelLabel(model) })),
                        ...catalog.items.map((model) => ({ value: model.selector, label: `${model.modelName}${model.readiness.ready ? "" : " — Not configured"}` })),
                    ], (option, { value, label }) => the(option, { optionValue: value, optionLabel: label }));
                } else {
                    the(article, "selection-unavailable", "");
                    const { supported } = await sessionEffort(invoke);
                    signal.throwIfAborted();
                    $.cloneEach(field, "#setting-option", ["", ...supported], (option, value) => the(option, {
                        optionValue: value, optionLabel: value || "Reasoning Effort", optionDisabled: value ? null : "",
                    }));
                    field.value = "";
                    the(article, { selectionUnavailable: supported.length ? null : "", settingsMessage: supported.length ? "" : "No supported efforts." });
                    if (document.activeElement === article) field.focus();
                }
            } catch (error) {
                // Closing or superseding suggestions intentionally discards only a read, never a mutation.
                const message = await failure(error, signal);
                if (!request.signal.aborted) the(article, message);
            }
        };
        on(status, "click", `#session-${kind}`, async () => {
            if (panels.some(({ article }) => the(article, "settings-pending") !== null)) return;
            if (!article.hidden) { panel.close(); return; }
            for (const other of panels) other.close();
            article.hidden = false;
            the(button, "expanded", true);
            field.value = "";
            if (field instanceof HTMLInputElement) field.focus();
            else article.focus();
            await load();
        });
        on(article, "click", "[data-cancel-settings]", () => { button.focus(); panel.close(); });
        on(article, "keydown", "article", (event) => {
            if (!(event instanceof KeyboardEvent) || event.key !== "Escape" || event.isComposing || event.repeat
                || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
            if (the(article, "settings-pending") !== null) return;
            event.preventDefault();
            button.focus();
            panel.close();
        });
        if (field instanceof HTMLInputElement) on(article, "input", 'input[name="selection"]', load);
        on(article, "submit", "form", async (event) => {
            event.preventDefault();
            if (the(article, "settings-pending") !== null) return;
            lookup?.abort();
            clear();
            const signal = lifetime();
            the(article, { settingsPending: "true", selectionUnavailable: "" });
            try {
                const invoke = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ params = {}) => call(kind, params, signal);
                if (kind === "model") await sessionModel(invoke, field.value);
                else await sessionEffort(invoke, field.value);
                signal.throwIfAborted();
                button.focus();
                panel.close();
            } catch (error) { the(article, await failure(error, signal)); }
            finally { the(article, { settingsPending: null, selectionUnavailable: available() ? null : "" }); }
        });
    }
    return () => {
        const openPanel = panels.find(({ article }) => !article.hidden && the(article, "settings-pending") === null);
        if (!openPanel) return false;
        openPanel.button.focus();
        openPanel.close();
        return true;
    };
}
