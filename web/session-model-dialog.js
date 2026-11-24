import { $, on, the } from "on_the_money";
import { workspaceSettingsPath } from "../src/directory-addresses.js";
import { attachModelCombobox } from "./combobox.js";
import { createModelEffortSync } from "./effort-select.js";
import describeFailure from "./failure.js";
import { flattenSelectOptions, sessionEffort, sessionModel } from "./session-models.js";
import { isRecord } from "./session-translator.js";

/** @typedef {ReturnType<typeof import("./session-models.js").createModelSearchCache>} ModelSearchCache */
/** @typedef {import("@plurnk/plurnk-acp/client").AcpSessionStatus} AcpSessionStatus */

/**
 * {§web-workspace-settings} {§web-session-commands} In-place quick model & effort picker dialog (`#dialog-session-model`) from the session status footer.
 * @param {{
 *   readonly footer: HTMLElement,
 *   readonly getWorkspaceName: () => string,
 *   readonly getAgentState: () => Record<string, unknown>,
 *   readonly getStatus: () => AcpSessionStatus | undefined,
 *   readonly getResourcesSignal: () => AbortSignal,
 *   readonly modelSearchCache: ModelSearchCache,
 *   readonly action: (kind: string, params?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
 *   readonly onFocusComposer: () => void,
 * }} options
 */
export function createSessionModelDialogController({
    footer,
    getWorkspaceName,
    getAgentState,
    getStatus,
    getResourcesSignal,
    modelSearchCache,
    action,
    onFocusComposer,
}) {
    /** @type {(() => void) | null} */
    let cleanupModelDialog = null;

    /** @param {"model" | "effort"} initialFocus */
    function openSessionModelDialog(initialFocus) {
        cleanupModelDialog?.();
        const existing = $("#dialog-session-model");
        if (existing instanceof HTMLDialogElement) existing.remove();
        const cloned = $.clone(document.body, "#session-model-dialog");
        if (!(cloned instanceof HTMLDialogElement)) return;
        const dialog = cloned;
        const dialogLifetime = new AbortController();
        const combinedSignal = AbortSignal.any([getResourcesSignal(), dialogLifetime.signal]);
        const rawForm = $(dialog, "[data-session-model-quick-form]");
        const rawComboboxRoot = $(dialog, '[data-model-combobox="quickModel"]');
        const rawEffortSelect = $(dialog, 'select[name="effort"]');
        if (!(rawForm instanceof HTMLFormElement) || !(rawComboboxRoot instanceof HTMLElement) || !(rawEffortSelect instanceof HTMLSelectElement)) {
            dialog.remove();
            return;
        }
        const comboboxRoot = rawComboboxRoot;
        const effortSelect = rawEffortSelect;

        const wsName = getWorkspaceName()
            || $('#session-workspace [data-text="workspace-name"]')?.textContent?.trim()
            || "";
        const sessName = footer.dataset.sessionName || null;
        const catalogHref = wsName
            ? (workspaceSettingsPath(wsName, sessName, "models") ?? "/settings/#models")
            : "/settings/#models";
        the(dialog, {
            "model-dialog-error": "",
            "model-dialog-busy": null,
            "model-dialog-catalog-path": catalogHref,
        });

        let initialModelValue = "";
        let initialEffortValue = "";
        let initialPersistedModel = false;
        /** @type {ReturnType<typeof attachModelCombobox> | null} */
        let combobox = null;

        const effortSync = createModelEffortSync({
            getSelect: () => effortSelect,
            getCache: () => modelSearchCache,
            getSelectedModel: () => combobox?.getValue() ?? "",
            getSignal: () => combinedSignal,
        });

        const mountedCombobox = attachModelCombobox(comboboxRoot, {
            getCache: () => modelSearchCache,
            inline: true,
            signal: combinedSignal,
            onSelect: (selector, choice) => {
                effortSync.sync(selector, effortSelect.value, choice?.efforts, choice?.defaultEffort);
            },
            onInput: (selector) => {
                const cached = modelSearchCache.getCachedEfforts(selector);
                if (cached) effortSync.sync(selector, effortSelect.value, cached.efforts, cached.defaultEffort);
            },
        });
        combobox = mountedCombobox;

        const cleanup = () => {
            if (cleanupModelDialog === cleanup) cleanupModelDialog = null;
            effortSync.dispose();
            dialogLifetime.abort();
            mountedCombobox.dispose();
            if (dialog.open) dialog.close();
            dialog.remove();
        };
        cleanupModelDialog = cleanup;

        on(dialog, "close", "dialog", () => {
            cleanup();
        });

        on(dialog, "submit", "[data-session-model-quick-form]", (event) => {
            event.preventDefault();
            mountedCombobox.close();
            const selectedModel = mountedCombobox.getValue();
            const selectedEffort = effortSelect.disabled ? "" : effortSelect.value.trim();
            if (!selectedModel || selectedModel === "none") {
                the(dialog, "model-dialog-error", "Select a configured model or alias.");
                return;
            }
            the(dialog, { "model-dialog-error": "", "model-dialog-busy": "true" });
            void (async () => {
                try {
                    const modelChanged = selectedModel !== initialModelValue || !initialPersistedModel;
                    const effortChanged = Boolean(selectedEffort && selectedEffort !== initialEffortValue);
                    if (modelChanged) {
                        await sessionModel(
                            (kind, params = {}) => action(kind, params, combinedSignal),
                            selectedModel,
                            selectedEffort || undefined,
                        );
                    } else if (effortChanged) {
                        await sessionEffort(
                            (kind, params = {}) => action(kind, params, combinedSignal),
                            selectedEffort,
                        );
                    }
                    if (!combinedSignal.aborted) {
                        dialog.close();
                        onFocusComposer();
                    }
                } catch (error) {
                    if (combinedSignal.aborted) return;
                    const { message, recovery } = await describeFailure(error);
                    the(dialog, {
                        "model-dialog-busy": null,
                        "model-dialog-error": [message, recovery].filter(Boolean).join(" "),
                    });
                }
            })();
        });

        // Pre-seed immediately from live session state so the dialog opens in 0ms.
        const agentState = getAgentState();
        const status = getStatus();
        const plurnk = /** @type {Record<string, unknown> | undefined} */ (agentState.plurnk);
        const liveOptions = Array.isArray(plurnk?.configOptions) ? plurnk.configOptions : [];
        const liveModelOpt = liveOptions.find((entry) => isRecord(entry) && entry.configId === "model");
        const liveThoughtOpt = liveOptions.find((entry) => isRecord(entry) && entry.configId === "thought_level");
        const liveModelVal = isRecord(liveModelOpt) && typeof liveModelOpt.currentValue === "string" && liveModelOpt.currentValue !== "none"
            ? liveModelOpt.currentValue
            : (status?.model ? (status.model.alias || `${status.model.provider}/${status.model.model}`) : "");
        const liveEffortVal = isRecord(liveThoughtOpt) && typeof liveThoughtOpt.currentValue === "string"
            ? liveThoughtOpt.currentValue
            : (status?.model?.effort ?? "");
        const liveSupportedEfforts = isRecord(liveThoughtOpt)
            ? flattenSelectOptions(liveThoughtOpt.options).flatMap((entry) => typeof entry.value === "string" && entry.value ? [entry.value] : [])
            : [];
        if (liveModelVal && liveSupportedEfforts.length > 0) {
            modelSearchCache.seedEfforts(liveModelVal, liveSupportedEfforts);
        }
        initialModelValue = liveModelVal;
        initialPersistedModel = Boolean(status?.model);
        mountedCombobox.setValue(liveModelVal);
        initialEffortValue = effortSync.sync(liveModelVal, liveEffortVal, liveSupportedEfforts.length > 0 ? liveSupportedEfforts : undefined);

        dialog.showModal();
        mountedCombobox.open();
        if (initialFocus === "effort" && !effortSelect.disabled) {
            effortSelect.focus();
        } else {
            mountedCombobox.input.focus();
        }

        // Hydrate authoritative options & aliases side-effect-free via session/options + providers/list.
        void Promise.all([
            action("session/options", {}, combinedSignal),
            modelSearchCache.loadAliases(combinedSignal),
        ]).then(([optRes, aliases]) => {
            if (combinedSignal.aborted || !dialog.open) return;
            const opts = isRecord(optRes) && Array.isArray(optRes.configOptions) ? optRes.configOptions : [];
            const modelOpt = opts.find((entry) => isRecord(entry) && entry.configId === "model");
            const thoughtOpt = opts.find((entry) => isRecord(entry) && entry.configId === "thought_level");
            const optMeta = isRecord(optRes) && isRecord(optRes._meta) && isRecord(optRes._meta.plurnk) ? optRes._meta.plurnk : null;
            const optStatus = isRecord(optMeta?.status) ? optMeta.status : null;
            const currentModel = isRecord(modelOpt) && typeof modelOpt.currentValue === "string" && modelOpt.currentValue !== "none"
                ? modelOpt.currentValue
                : (aliases.find((a) => a.active)?.alias ?? "");
            const currentEffort = isRecord(thoughtOpt) && typeof thoughtOpt.currentValue === "string" ? thoughtOpt.currentValue : "";
            const supported = isRecord(thoughtOpt)
                ? flattenSelectOptions(thoughtOpt.options).flatMap((entry) => typeof entry.value === "string" && entry.value ? [entry.value] : [])
                : [];
            if (currentModel && supported.length > 0) {
                modelSearchCache.seedEfforts(currentModel, supported);
            }
            initialPersistedModel = optStatus !== null && Object.hasOwn(optStatus, "model")
                ? optStatus.model !== null
                : Boolean(currentModel);
            const untouched = mountedCombobox.getValue() === initialModelValue;
            initialModelValue = currentModel;
            if (untouched) {
                mountedCombobox.setValue(currentModel);
                initialEffortValue = effortSync.sync(currentModel, currentEffort, supported.length > 0 ? supported : undefined);
            }
            mountedCombobox.refresh();
        }).catch(async (error) => {
            if (combinedSignal.aborted || !dialog.open) return;
            const { message, recovery } = await describeFailure(error);
            the(dialog, "model-dialog-error", [message, recovery].filter(Boolean).join(" "));
        });
    }

    on(footer, "click", "#session-model, #session-effort", (event, link) => {
        if (!(event instanceof MouseEvent)) return;
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        openSessionModelDialog(link.id === "session-effort" ? "effort" : "model");
    });

    return {
        dispose() {
            cleanupModelDialog?.();
        },
    };
}
