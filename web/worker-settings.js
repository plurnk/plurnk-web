import { $, on, the } from "on_the_money";
import { listModels, workerModel, workerEffort, modelLabel } from "./worker-models.js";

/** {§web-worker-settings} Forms own presentation; the daemon owns admitted configuration.
 * @param {Element} main @param {Element} status
 * @param {import("./worker-models.js").Action} call
 * @param {() => AbortSignal} lifetime
 */
export default function workerSettings(main, status, call, lifetime) {
    const panels = [
        { kind: "model", article: $.clone(main, "#model-settings", { position: "afterbegin" }) },
        { kind: "effort", article: $.clone(main, "#effort-settings", { position: "afterbegin" }) },
    ].map(({ kind, article }) => {
        const button = $(status, `#worker-${kind}`);
        const select = $(article, 'select[name="selection"]');
        if (!(article instanceof HTMLElement) || !(button instanceof HTMLButtonElement) || !(select instanceof HTMLSelectElement)) {
            throw new Error("Worker settings template is incomplete.");
        }
        return { kind, article, button, select };
    });
    for (const { kind, article, button, select } of panels) {
        const close = () => { article.hidden = true; the(button, "expanded", false); };
        /** @param {(invoke: import("./worker-models.js").Action) => Promise<string>} action */
        const perform = async (action) => {
            if (the(article, "settings-pending") !== null) return;
            const signal = lifetime();
            the(article, { settingsPending: "", selectionUnavailable: "", settingsMessage: "Loading…", settingsRecovery: "" });
            try {
                const message = await action((kind, params) => call(kind, params, signal));
                signal.throwIfAborted();
                the(article, "settings-message", message);
            } catch (error) {
                const cause = error instanceof Error ? error.cause : undefined;
                const { Validator } = await import("@plurnk/plurnk-contracts");
                const recovery = Validator.validateProblemDetails(cause).valid ? Validator.assertProblemDetails(cause).recovery : undefined;
                the(article, { settingsMessage: signal.aborted ? "Response not confirmed." : error instanceof Error ? error.message : String(error),
                    settingsRecovery: typeof recovery === "string" ? recovery : "" });
            } finally {
                the(article, { settingsPending: null, selectionUnavailable: [...select.options].some(({ value }) => value) ? null : "" });
            }
        };
        /** @param {import("./worker-models.js").Action} invoke @param {string} [search] */
        const models = async (invoke, search = "") => {
            const { aliases, catalog } = await listModels(invoke, search);
            const aliasOptions = $(article, "[data-alias-options]");
            const catalogOptions = $(article, "[data-catalog-options]");
            if (!aliasOptions || !catalogOptions) throw new Error("Model choices are incomplete.");
            $.cloneEach(aliasOptions, "#setting-option", aliases, (option, model) => the(option, {
                optionValue: model.alias, optionLabel: `${modelLabel(model)}${model.effort ? ` (${model.effort})` : ""}${model.active ? " — Default" : ""}`,
            }));
            $.cloneEach(catalogOptions, "#setting-option", catalog.items, (option, model) => the(option, {
                optionValue: model.selector, optionLabel: `${model.selector} — ${model.modelName}${model.readiness.ready ? "" : " — Not configured"}`,
            }));
            the(article, "catalog-summary", `Aliases: ${aliases.length}. Catalog: ${catalog.items.length} of ${catalog.total}, offset ${catalog.offset}.${catalog.nextOffset === undefined ? "" : " Narrow the search for more matches."}`);
        };
        on(status, "click", `#worker-${kind}`, async () => {
            if (!article.hidden) { close(); return; }
            for (const other of panels) { other.article.hidden = true; the(other.button, "expanded", false); }
            article.hidden = false;
            the(button, "expanded", true);
            const focus = kind === "model" ? $(article, 'input[type="search"]') : article;
            if (!(focus instanceof HTMLElement)) throw new Error("Settings focus target is missing.");
            focus.focus();
            await perform(async (invoke) => {
                if (kind === "model") {
                    await models(invoke);
                    const current = await workerModel(invoke);
                    const value = current?.alias ?? (current ? `${current.provider}/${current.model}` : "");
                    select.value = [...select.options].some((option) => option.value === value) ? value : "";
                    return `Model: ${modelLabel(current)}.`;
                }
                const { effort, source, supported } = await workerEffort(invoke);
                $.cloneEach(select, "#setting-option", supported, (option, value) => the(option, { optionValue: value, optionLabel: value }));
                select.value = effort ?? "";
                return supported.length ? `Effort: ${effort ?? "Unavailable"} (${source}).` : "No supported efforts.";
            });
            if (document.activeElement === article && !article.hidden) select.focus();
        });
        on(article, "click", "[data-close-settings]", () => { close(); button.focus(); });
        on(article, "submit", "form", async (event) => {
            event.preventDefault();
            const form = event.target;
            if (!(form instanceof HTMLFormElement)) throw new Error("Settings submission has no form.");
            const input = new FormData(form);
            await perform(async (invoke) => {
                if (form.hasAttribute("data-model-search")) {
                    await models(invoke, String(input.get("search") ?? ""));
                    return "";
                }
                const selection = String(input.get("selection") ?? "");
                if (!selection) throw new Error("Choose a value.");
                if (kind === "model") return `Model: ${modelLabel(await workerModel(invoke, selection))}.`;
                const { effort, source } = await workerEffort(invoke, selection);
                return `Effort: ${effort ?? "Unavailable"} (${source}).`;
            });
        });
    }
}
