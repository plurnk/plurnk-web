import { $, on, the } from "on_the_money";
import { listModels, workerModel, workerEffort, modelLabel } from "./worker-models.js";

/** {§web-worker-settings} Native suggestions are an aid, never a route admission policy.
 * @param {Element} main @param {Element} status
 * @param {import("./worker-models.js").Action} call
 * @param {() => AbortSignal} lifetime
 */
export default function workerSettings(main, status, call, lifetime) {
    const panels = [
        { kind: "model", article: $.clone(main, "#model-settings") },
        { kind: "effort", article: $.clone(main, "#effort-settings") },
    ].map(({ kind, article }) => {
        const button = $(status, `#worker-${kind}`);
        const field = $(article, '[name="selection"]');
        if (!(article instanceof HTMLElement) || !(button instanceof HTMLButtonElement)
            || !(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) {
            throw new Error("Worker settings template is incomplete.");
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
            const { Validator } = await import("@plurnk/plurnk-contracts");
            const cause = error instanceof Error ? error.cause : undefined;
            const recovery = cause !== undefined && Validator.validateProblemDetails(cause).valid ? Validator.assertProblemDetails(cause).recovery : undefined;
            return { settingsMessage: signal.aborted ? "Response not confirmed." : error instanceof Error ? error.message : String(error),
                settingsRecovery: typeof recovery === "string" ? recovery : "" };
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
                    const { supported } = await workerEffort(invoke);
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
        on(status, "click", `#worker-${kind}`, async () => {
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
        on(article, "click", "[data-cancel-settings]", () => { panel.close(); button.focus(); });
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
                if (kind === "model") await workerModel(invoke, field.value);
                else await workerEffort(invoke, field.value);
                signal.throwIfAborted();
                panel.close();
                button.focus();
            } catch (error) { the(article, await failure(error, signal)); }
            finally { the(article, { settingsPending: null, selectionUnavailable: available() ? null : "" }); }
        });
    }
}
