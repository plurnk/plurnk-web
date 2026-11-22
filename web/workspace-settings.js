import { $, $$, on, the } from "on_the_money";
import { EFFORTS } from "@plurnk/plurnk-contracts";
import { directoryPath, workspaceSettingsPath } from "../src/directory-addresses.js";
import describeFailure from "./failure.js";
import { populateEnvPanel } from "./env-panel.js";
import managementAction from "./management-action.js";
import { createOnboardingController } from "./onboarding.js";
import { primaryModifierLabel } from "./session-commands.js";
import { listModels, modelLabel, sessionEffort, sessionModel } from "./session-models.js";
import { isRecord } from "./session-translator.js";
import { subscribeWorkspaceNotifications } from "./workspace-notifications.js";

/**
 * @typedef {"general" | "models" | "mcp" | "skills" | "schedule" | "personas" | "members" | "env" | "help"} SettingsSection
 */

/**
 * @typedef {{
 *   readonly workspaceId: number,
 *   readonly workspaceName: string,
 *   readonly sessionName: string | null,
 *   readonly auth: "session" | "none",
 *   readonly signal: AbortSignal,
 * }} WorkspaceSettingsContext
 */

const SECTIONS = /** @type {const} */ (["general", "models", "mcp", "skills", "schedule", "personas", "members", "env", "help"]);
const FAMILIES = /** @type {const} */ (["mcp", "skills", "schedule", "personas", "members"]);

/** @param {unknown} value @returns {value is SettingsSection} */
export const isSettingsSection = (value) =>
    typeof value === "string" && /** @type {readonly string[]} */ (SECTIONS).includes(value);

/**
 * @param {"mcp" | "skills" | "schedule" | "personas" | "members"} family
 * @param {Record<string, unknown>} item
 * @returns {string}
 */
function formatFamilyDetails(family, item) {
    const def = isRecord(item.definition) ? item.definition : null;
    const provSource = isRecord(item.provenance) && typeof item.provenance.source === "string"
        ? item.provenance.source
        : "";
    if (family === "mcp") {
        let base = provSource;
        if (def?.type === "stdio" && typeof def.command === "string") {
            const args = Array.isArray(def.args) ? def.args.filter((a) => typeof a === "string") : [];
            base = [def.command, ...args].join(" ");
        } else if (def?.type === "streamable-http" && typeof def.url === "string") {
            const authType = isRecord(def.authorization) && typeof def.authorization.type === "string"
                ? ` (${def.authorization.type})`
                : "";
            base = `${def.url}${authType}`;
        }
        const toolCount = isRecord(item.detail) && Array.isArray(item.detail.tools)
            ? ` · ${item.detail.tools.length} tools`
            : "";
        return `${base}${toolCount}`;
    }
    if (family === "skills") {
        if (def && typeof def.source === "string") {
            const ref = typeof def.ref === "string" && def.ref.length > 0 ? `@${def.ref}` : "";
            return `${def.source}${ref}`;
        }
        return provSource;
    }
    if (family === "schedule") {
        if (def) {
            const target = typeof def.target === "string" ? def.target : "";
            const rule = typeof def.rule === "string" ? def.rule : def.rule === null ? "unscheduled" : "";
            const prompt = typeof def.prompt === "string" ? def.prompt : typeof def.run === "string" ? def.run : "";
            return [target, rule, prompt].filter((part) => part.length > 0).join(" · ");
        }
        return provSource;
    }
    if (family === "members") {
        const detail = isRecord(item.detail) ? item.detail : null;
        const effect = detail && typeof detail.effect === "string" ? detail.effect : "";
        const matched = detail && typeof detail.matched === "number" ? `${detail.matched} ${detail.matched === 1 ? "file" : "files"}` : "";
        const ignored = detail && typeof detail.ignored === "number" && detail.ignored > 0 ? `${detail.ignored} ignored` : "";
        return [effect, matched, ignored, provSource].filter((part) => part.length > 0).join(" · ");
    }
    if (def) {
        const desc = typeof def.description === "string" ? def.description
            : typeof def.source === "string" ? def.source : provSource;
        const defaults = [
            typeof def.model === "string" ? def.model : "",
            typeof def.effort === "string" ? def.effort : "",
        ].filter((part) => part.length > 0).join(", ");
        return defaults ? `${desc} [${defaults}]` : desc;
    }
    return provSource;
}

/**
 * {§web-workspace-settings} Mounts workspace subsystem management inside `<article id="workspace-settings">`.
 * @param {HTMLElement} article
 * @param {() => WorkspaceSettingsContext} getContext
 * @param {{ updateHash?: boolean, initialQuery?: string, initialHelpFilter?: string, initialEnvScope?: "workspace" | "session" }} [options]
 */
export function createWorkspaceSettingsController(article, getContext, { updateHash = false, initialQuery = "", initialHelpFilter = "", initialEnvScope = "workspace" } = {}) {
    /** @type {Element | null} */
    let envPanel = null;
    /** @type {SettingsSection} */
    let activeSection = "general";
    /** @type {"workspace" | "session"} */
    let envListScope = initialEnvScope === "session" ? "session" : "workspace";
    let modelsSearchQuery = initialQuery;
    let helpFilterQuery = initialHelpFilter;
    let busy = false;
    let mounted = false;
    /** @type {AbortController | null} */
    let modelsLookup = null;
    /** @type {WeakMap<Element, { family: "mcp" | "skills" | "personas" | "members", alias: string, definition: Record<string, unknown> }>} */
    const candidateData = new WeakMap();

    const onboarding = createOnboardingController(() => ({
        auth: getContext().auth,
        signal: getContext().signal,
        onConfigured: async (alias) => {
            if (getContext().sessionName !== null) {
                await invoke("session/set_config_option", { configId: "model", value: alias }, { requireSession: true }).catch(() => {});
            }
            await refreshSection("models");
        },
    }));

    /** @param {boolean} nextBusy @param {string} [message] @param {string} [recovery] */
    function setFeedback(nextBusy, message = "", recovery = "") {
        busy = nextBusy;
        the(article, {
            "ws-settings-busy": nextBusy ? "true" : null,
            "ws-settings-message": message,
            "ws-settings-recovery": recovery,
            "env-busy": nextBusy ? "" : null,
        });
        if (envPanel) {
            the(envPanel, "env-busy", nextBusy ? "" : null);
        }
    }

    /**
     * @param {string} kind
     * @param {Record<string, unknown>} [params]
     * @param {{ requireSession?: boolean }} [opts]
     */
    async function invoke(kind, params = {}, opts = {}) {
        const ctx = getContext();
        ctx.signal.throwIfAborted();
        const sessionId = ctx.sessionName !== null ? `${ctx.workspaceId}#${ctx.sessionName}` : "";
        if (opts.requireSession && !sessionId) {
            throw new Error("Open a session tab to manage session-scoped settings.");
        }
        return managementAction(kind, params, sessionId, ctx.auth, ctx.signal, {
            workspaceId: ctx.workspaceId,
        });
    }

    /**
     * @param {(signal: AbortSignal) => Promise<string>} work
     */
    async function runMutation(work) {
        if (busy) return;
        const ctx = getContext();
        setFeedback(true, "Running…", "");
        try {
            ctx.signal.throwIfAborted();
            const summary = await work(ctx.signal);
            ctx.signal.throwIfAborted();
            setFeedback(false, summary, "");
        } catch (error) {
            const { message, recovery } = await describeFailure(error);
            setFeedback(false, ctx.signal.aborted ? "Response not confirmed." : message, recovery);
        }
    }

    /**
     * @param {"mcp" | "skills" | "schedule" | "personas" | "members"} family
     * @param {unknown} res
     */
    function renderFamilyList(family, res) {
        const panel = $(article, `[data-settings-panel="${family}"]`);
        const tbody = panel ? $(panel, "[data-family-rows]") : null;
        if (!panel || !tbody) return;
        const rawItems = isRecord(res) && Array.isArray(res.definitions) ? res.definitions
            : isRecord(res) && Array.isArray(res.items) ? res.items : [];
        const items = rawItems.filter(isRecord);
        $.cloneEach(tbody, "#workspace-family-row", items, (tr, item) => {
            const alias = typeof item.alias === "string" ? item.alias : "";
            const origin = typeof item.origin === "string" ? item.origin : "workspace";
            const state = typeof item.state === "string" ? item.state : "active";
            const problemDetail = state === "unavailable" && isRecord(item.problem)
                ? (typeof item.problem.detail === "string" ? item.problem.detail
                    : typeof item.problem.title === "string" ? item.problem.title : "")
                : "";
            const statusText = problemDetail ? `${state}: ${problemDetail}` : state;
            const def = isRecord(item.definition) ? item.definition : null;
            const supportsOAuth = family === "mcp" && (
                state === "authorization-required"
                || (def?.type === "streamable-http" && isRecord(def.authorization) && def.authorization.type === "oauth")
            );
            const rowState = state === "disabled" ? "disabled"
                : (state === "unavailable" || state === "authorization-required") ? "retryable"
                : "active";
            the(tr, {
                "family-alias": alias,
                "family-origin": origin,
                "family-summary": formatFamilyDetails(family, item),
                "family-status": statusText,
                "family-removable": origin === "workspace" ? "true" : "false",
                "family-state": rowState,
                "family-auth": supportsOAuth ? "true" : "false",
            });
        });
        the(panel, { "family-count": items.length });
    }

    /**
     * @param {"mcp" | "skills" | "schedule" | "personas" | "members"} family
     * @param {unknown} res
     */
    function renderCandidates(family, res) {
        const panel = $(article, `[data-settings-panel="${family}"]`);
        const list = panel ? $(panel, "ul[data-candidate-rows]") : null;
        if (!panel || !list) return;
        const rawCandidates = isRecord(res) && Array.isArray(res.candidates) ? res.candidates : [];
        const candidates = rawCandidates.filter(isRecord);
        $.cloneEach(list, "#workspace-candidate-row", candidates, (li, item) => {
            const alias = typeof item.alias === "string" ? item.alias : "";
            const summary = typeof item.summary === "string" ? item.summary : "";
            const def = isRecord(item.definition) ? item.definition : null;
            const provKind = isRecord(item.provenance) && typeof item.provenance.kind === "string" ? item.provenance.kind : "";
            const addable = family === "members"
                ? alias.length > 0 && def !== null && ["preview", "candidate", "ignored"].includes(provKind)
                : family !== "schedule" && alias.length > 0 && def !== null;
            the(li, {
                "candidate-alias": alias || family,
                "candidate-summary": summary,
                "candidate-addable": addable ? "true" : "false",
            });
            const form = $(li, "form[data-candidate-add-form]");
            if (addable && form && def) {
                candidateData.set(form, {
                    family: /** @type {"mcp" | "skills" | "personas" | "members"} */ (family),
                    alias,
                    definition: def,
                });
            }
        });
        the(panel, { "candidate-count": candidates.length });
    }

    /** @param {unknown} resumeOrSetResult */
    function renderSessionPersonaOptions(resumeOrSetResult) {
        const form = $(article, "form[data-session-persona-form]");
        const select = form ? $(form, 'select[name="persona"]') : null;
        if (!(form instanceof HTMLFormElement) || !(select instanceof HTMLSelectElement)) return;
        const optionsList = isRecord(resumeOrSetResult) && Array.isArray(resumeOrSetResult.configOptions)
            ? resumeOrSetResult.configOptions
            : [];
        const personaOption = optionsList.find((opt) => isRecord(opt) && opt.configId === "persona");
        if (!isRecord(personaOption) || !Array.isArray(personaOption.options)) {
            form.hidden = true;
            return;
        }
        const choices = personaOption.options.flatMap((entry) => {
            if (!isRecord(entry) || typeof entry.value !== "string" || typeof entry.name !== "string") return [];
            const desc = typeof entry.description === "string" && entry.description.length > 0 ? ` — ${entry.description}` : "";
            return [{ value: entry.value, label: `${entry.name}${desc}` }];
        });
        $.cloneEach(select, "#setting-option", choices, (optEl, choice) => {
            the(optEl, {
                "option-value": choice.value,
                "option-label": choice.label,
                "option-disabled": null,
            });
        });
        if (typeof personaOption.currentValue === "string") {
            select.value = personaOption.currentValue;
        }
        form.hidden = false;
    }

    /**
     * @param {unknown} sessionRes
     * @param {readonly { readonly alias: string, readonly provider: string, readonly model: string }[]} aliases
     * @param {readonly { readonly selector: string, readonly modelName: string, readonly readiness: { readonly ready: boolean } }[]} catalogItems
     */
    function renderSessionModelControls(sessionRes, aliases, catalogItems) {
        const form = $(article, "form[data-session-model-form]");
        const modelSelect = form ? $(form, 'select[name="model"]') : null;
        const effortSelect = form ? $(form, 'select[name="effort"]') : null;
        if (!(form instanceof HTMLFormElement) || !(modelSelect instanceof HTMLSelectElement) || !(effortSelect instanceof HTMLSelectElement)) {
            return;
        }
        if (getContext().sessionName === null || !isRecord(sessionRes) || !Array.isArray(sessionRes.configOptions)) {
            form.hidden = true;
            return;
        }
        const modelOption = sessionRes.configOptions.find((entry) => isRecord(entry) && entry.configId === "model");
        const thoughtOption = sessionRes.configOptions.find((entry) => isRecord(entry) && entry.configId === "thought_level");
        const seen = new Set();
        /** @type {Array<{ value: string, label: string }>} */
        const modelChoices = [];
        const addChoice = (/** @type {string} */ value, /** @type {string} */ label) => {
            if (!value || seen.has(value)) return;
            seen.add(value);
            modelChoices.push({ value, label });
        };
        if (isRecord(modelOption) && Array.isArray(modelOption.options)) {
            for (const entry of modelOption.options) {
                if (isRecord(entry) && typeof entry.value === "string" && typeof entry.name === "string") {
                    addChoice(entry.value, entry.name);
                }
            }
        }
        for (const a of aliases) {
            addChoice(a.alias, `${a.alias} — ${a.provider}/${a.model}`);
        }
        for (const m of catalogItems) {
            if (m.readiness.ready) {
                addChoice(m.selector, `${m.selector} (${m.modelName})`);
            }
        }
        const currentModel = isRecord(modelOption) && typeof modelOption.currentValue === "string" ? modelOption.currentValue : "";
        if (currentModel) addChoice(currentModel, currentModel);
        if (modelChoices.length === 0) {
            form.hidden = true;
            return;
        }
        $.cloneEach(modelSelect, "#setting-option", modelChoices, (optEl, choice) => {
            the(optEl, { "option-value": choice.value, "option-label": choice.label, "option-disabled": null });
        });
        if (currentModel) modelSelect.value = currentModel;

        const supportedEfforts = isRecord(thoughtOption) && Array.isArray(thoughtOption.options)
            ? thoughtOption.options.flatMap((entry) => isRecord(entry) && typeof entry.value === "string" && entry.value ? [entry.value] : [])
            : [];
        const currentEffort = isRecord(thoughtOption) && typeof thoughtOption.currentValue === "string" ? thoughtOption.currentValue : "";
        const effortChoices = [{ value: "", label: "Effort (default)" }, ...supportedEfforts.map((v) => ({ value: v, label: v }))];
        $.cloneEach(effortSelect, "#setting-option", effortChoices, (optEl, choice) => {
            the(optEl, { "option-value": choice.value, "option-label": choice.label, "option-disabled": null });
        });
        effortSelect.disabled = supportedEfforts.length === 0;
        effortSelect.value = supportedEfforts.includes(currentEffort) ? currentEffort : "";
        form.hidden = false;
    }

    function applyHelpFilter() {
        const helpPanel = $(article, '[data-settings-panel="help"]');
        if (!helpPanel) return;
        const needle = helpFilterQuery.trim().replace(/^\//u, "").toLowerCase();
        for (const item of $$(helpPanel, "[data-command-name]")) {
            if (!(item instanceof HTMLElement)) continue;
            const name = (item.getAttribute("data-command-name") ?? "").toLowerCase();
            const summary = (item.textContent ?? "").toLowerCase();
            item.hidden = needle !== "" && !name.includes(needle) && !summary.includes(needle);
        }
    }

    function syncEnvScopeControls() {
        if (!envPanel) return;
        const ctx = getContext();
        const scopeForm = $(article, "form[data-ws-env-scope-form]");
        const listSelect = scopeForm ? $(scopeForm, 'select[name="listScope"]') : null;
        const setSelect = $(article, '[data-env-set-form] select[name="scope"]');
        const sessionOption = setSelect ? $(setSelect, 'option[value="session"]') : null;
        if (ctx.sessionName === null) {
            envListScope = "workspace";
            if (scopeForm instanceof HTMLElement) scopeForm.hidden = true;
            if (sessionOption instanceof HTMLOptionElement) sessionOption.disabled = true;
            if (setSelect instanceof HTMLSelectElement) setSelect.value = "workspace";
        } else {
            if (scopeForm instanceof HTMLElement) scopeForm.hidden = false;
            if (listSelect instanceof HTMLSelectElement) listSelect.value = envListScope;
            if (sessionOption instanceof HTMLOptionElement) sessionOption.disabled = false;
            if (setSelect instanceof HTMLSelectElement) setSelect.value = envListScope;
        }
    }

    /** @param {SettingsSection} section */
    async function refreshSection(section) {
        if (section === "general" || section === "help") {
            if (section === "help") applyHelpFilter();
            setFeedback(false, "", "");
            return;
        }
        const ctx = getContext();
        setFeedback(true, "", "");
        try {
            if (section === "models") {
                modelsLookup?.abort();
                const req = modelsLookup = new AbortController();
                const signal = AbortSignal.any([ctx.signal, req.signal]);
                const callModels = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ params = {}) =>
                    managementAction(kind, params, ctx.sessionName !== null ? `${ctx.workspaceId}#${ctx.sessionName}` : "", ctx.auth, signal, {
                        workspaceId: ctx.workspaceId,
                    });
                const [{ aliases, catalog }, sessionRes] = await Promise.all([
                    listModels(callModels, modelsSearchQuery),
                    ctx.sessionName !== null
                        ? callModels("session/resume", { replayFrom: null }).catch(() => null)
                        : Promise.resolve(null),
                ]);
                signal.throwIfAborted();
                const modelsPanel = $(article, '[data-settings-panel="models"]');
                const aliasBody = modelsPanel ? $(modelsPanel, "[data-models-alias-rows]") : null;
                const catalogBody = modelsPanel ? $(modelsPanel, "[data-models-catalog-rows]") : null;
                if (modelsPanel && aliasBody && catalogBody) {
                    const sessionUsable = ctx.sessionName !== null ? "true" : "false";
                    $.cloneEach(aliasBody, "#workspace-model-alias-row", aliases, (tr, item) => {
                        the(tr, {
                            "alias-name": item.alias,
                            "alias-route": `${item.provider}/${item.model}`,
                            "alias-effort": item.effort ?? "Unspecified",
                            "alias-active": item.active ? "Default" : "Configured",
                            "model-session-usable": sessionUsable,
                        });
                    });
                    $.cloneEach(catalogBody, "#command-model", catalog.items, (tr, model) => {
                        the(tr, {
                            "model-selector": model.selector,
                            "model-name": model.modelName,
                            "model-context": model.limits.contextTokens,
                            "model-efforts": model.capabilities.efforts.join(", "),
                            "model-readiness": model.readiness.ready ? "Configured" : "Not configured",
                        });
                    });
                    the(modelsPanel, {
                        "alias-count": aliases.length,
                        "model-offset": catalog.offset,
                        "model-count": catalog.items.length,
                        "model-total": catalog.total,
                        "model-more": catalog.nextOffset === undefined ? "" : "More matches are available; narrow the search.",
                    });
                }
                renderSessionModelControls(sessionRes, aliases, catalog.items);
                setFeedback(false, "", "");
                return;
            }
            if (section === "env") {
                syncEnvScopeControls();
                const res = await invoke(`${envListScope}.env.list`, {}, {
                    requireSession: envListScope === "session",
                });
                ctx.signal.throwIfAborted();
                if (envPanel) populateEnvPanel(envPanel, res, envListScope);
                setFeedback(false, "", "");
                return;
            }
            if (section === "personas") {
                const personaSessionForm = $(article, "form[data-session-persona-form]");
                if (ctx.sessionName === null && personaSessionForm instanceof HTMLElement) {
                    personaSessionForm.hidden = true;
                }
                const [listRes, sessionRes] = await Promise.all([
                    invoke("workspace.personas.list", {}),
                    ctx.sessionName !== null
                        ? invoke("session/resume", {}, { requireSession: true }).catch(() => null)
                        : Promise.resolve(null),
                ]);
                ctx.signal.throwIfAborted();
                renderFamilyList("personas", listRes);
                if (sessionRes !== null) renderSessionPersonaOptions(sessionRes);
                setFeedback(false, "", "");
                return;
            }
            const res = await invoke(`workspace.${section}.list`, {});
            ctx.signal.throwIfAborted();
            renderFamilyList(section, res);
            setFeedback(false, "", "");
        } catch (error) {
            if (modelsLookup?.signal.aborted && section === "models") return;
            const { message, recovery } = await describeFailure(error);
            setFeedback(false, ctx.signal.aborted ? "Response not confirmed." : message, recovery);
        }
    }

    /** @param {SettingsSection} section @param {boolean} [pushHash] */
    function selectSection(section, pushHash = false) {
        ensureMounted();
        activeSection = section;
        for (const item of $$(article, "[data-settings-section]")) {
            if (item.getAttribute("data-settings-section") === section) {
                item.setAttribute("aria-current", "true");
            } else {
                item.removeAttribute("aria-current");
            }
        }
        for (const panel of $$(article, "[data-settings-panel]")) {
            if (panel instanceof HTMLElement) {
                panel.hidden = panel.dataset.settingsPanel !== section;
            }
        }
        if (pushHash && updateHash && typeof history === "object") {
            const nextUrl = section === "general"
                ? `${location.pathname}${location.search}`
                : `${location.pathname}${location.search}#${section}`;
            if (`${location.pathname}${location.search}${location.hash}` !== nextUrl) {
                history.replaceState(null, "", nextUrl);
            }
        }
        const scheduleTarget = $(article, '[data-schedule-save-form] input[name="target"]');
        const ctx = getContext();
        if (section === "schedule" && scheduleTarget instanceof HTMLInputElement && scheduleTarget.value === "" && ctx.sessionName) {
            scheduleTarget.value = ctx.sessionName;
        }
        void refreshSection(section);
    }

    function ensureMounted() {
        if (mounted) return;
        mounted = true;
        if (!$(article, '[data-settings-panel="mcp"]')) {
            const host = $(article, "[data-settings-subsystems]") ?? article;
            $.clone(host, "#workspace-settings-subsystems");
        }
        const envOutlet = $(article, "[data-ws-env-outlet]");
        if (envOutlet && !envPanel) {
            envPanel = $.clone(envOutlet, "#command-env");
            const envSetForm = $(envPanel, "form[data-env-set-form]");
            const envFormOutlet = $(article, "[data-ws-env-form-outlet]");
            if (envSetForm && envFormOutlet) {
                envFormOutlet.replaceWith(envSetForm);
            }
        }
        const effortSelect = $(article, '[data-personas-save-form] select[name="effort"]');
        if (effortSelect instanceof HTMLSelectElement && effortSelect.options.length <= 1) {
            for (const level of EFFORTS) {
                const opt = $.clone(effortSelect, "#setting-option");
                the(opt, { "option-value": level, "option-label": level, "option-disabled": null });
            }
        }

        const shortcutsOutlet = $(article, "[data-help-shortcuts-outlet]");
        if (shortcutsOutlet && shortcutsOutlet.children.length === 0) {
            const shortcuts = $.clone(shortcutsOutlet, "#command-shortcuts");
            the(shortcuts, "shortcut-mod", primaryModifierLabel());
        }
        const commandsOutlet = $(article, "[data-help-commands-outlet]");
        if (commandsOutlet && commandsOutlet.children.length === 0) {
            $.clone(commandsOutlet, "#command-help");
        }
        const helpFilterInput = $(article, "[data-help-filter]");
        if (helpFilterInput instanceof HTMLInputElement && helpFilterQuery) {
            helpFilterInput.value = helpFilterQuery;
        }
        const modelsSearchInput = $(article, '[data-models-search-form] input[name="q"]');
        if (modelsSearchInput instanceof HTMLInputElement && modelsSearchQuery) {
            modelsSearchInput.value = modelsSearchQuery;
        }
        applyHelpFilter();

        on(article, "click", "[data-open-model-setup]", () => {
            if (!busy) setFeedback(false, "", "");
            void onboarding.open();
        });

        on(article, "submit", "[data-models-search-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            modelsSearchQuery = String(new FormData(form).get("q") ?? "").trim();
            void refreshSection("models");
        });

        on(article, "input", '[data-models-search-form] input[name="q"]', (_event, input) => {
            if (!(input instanceof HTMLInputElement)) return;
            modelsSearchQuery = input.value.trim();
            void refreshSection("models");
        });

        on(article, "submit", "[data-model-alias-row-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const alias = String(new FormData(form).get("alias") ?? "").trim();
            if (!alias) return;
            void runMutation(async () => {
                const route = await sessionModel(
                    (kind, params = {}) => invoke(kind, params, { requireSession: true }),
                    alias,
                );
                await refreshSection("models");
                return `Model: ${modelLabel(route)}${route?.effort ? ` (${route.effort})` : ""}.`;
            });
        });

        on(article, "submit", "[data-session-model-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const data = new FormData(form);
            const selectedModel = String(data.get("model") ?? "").trim();
            const selectedEffort = String(data.get("effort") ?? "").trim();
            if (!selectedModel) return;
            void runMutation(async () => {
                const callSession = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ params = {}) =>
                    invoke(kind, params, { requireSession: true });
                const route = await sessionModel(callSession, selectedModel, selectedEffort || undefined);
                if (!selectedEffort && route?.effort) {
                    await sessionEffort(callSession).catch(() => {});
                }
                await refreshSection("models");
                return `Model: ${modelLabel(route)}${route?.effort ? ` (${route.effort})` : ""}.`;
            });
        });

        on(article, "input", "[data-help-filter]", (_event, input) => {
            if (!(input instanceof HTMLInputElement)) return;
            helpFilterQuery = input.value;
            applyHelpFilter();
        });

        on(article, "click", '[data-dialog-target^="dialog-settings-"]', (_event, btn) => {
            if (!busy) setFeedback(false, "", "");
            if (btn.getAttribute("data-dialog-target") === "dialog-settings-schedule") {
                const scheduleTarget = $(article, '[data-schedule-save-form] input[name="target"]');
                const ctx = getContext();
                if (scheduleTarget instanceof HTMLInputElement && scheduleTarget.value === "" && ctx.sessionName) {
                    scheduleTarget.value = ctx.sessionName;
                }
            }
        });

        on(article, "click", "[data-settings-section]", (event, link) => {
            const raw = link.getAttribute("data-settings-section");
            if (isSettingsSection(raw)) {
                event.preventDefault();
                selectSection(raw, true);
            }
        });

        on(article, "change", '[data-mcp-save-form] select[name="transport"]', (_event, select) => {
            const form = select.closest("form[data-mcp-save-form]");
            if (form instanceof HTMLFormElement && select instanceof HTMLSelectElement) {
                form.dataset.mcpTransport = select.value;
            }
        });
        on(article, "change", '[data-mcp-save-form] select[name="authMode"]', (_event, select) => {
            const form = select.closest("form[data-mcp-save-form]");
            if (form instanceof HTMLFormElement && select instanceof HTMLSelectElement) {
                form.dataset.mcpAuth = select.value;
            }
        });
        on(article, "change", '[data-personas-save-form] select[name="personaMode"]', (_event, select) => {
            const form = select.closest("form[data-personas-save-form]");
            if (form instanceof HTMLFormElement && select instanceof HTMLSelectElement) {
                form.dataset.personaMode = select.value;
            }
        });
        on(article, "change", '[data-ws-env-scope-form] select[name="listScope"]', (_event, select) => {
            if (!(select instanceof HTMLSelectElement)) return;
            envListScope = select.value === "session" ? "session" : "workspace";
            syncEnvScopeControls();
            void refreshSection("env");
        });

        on(article, "submit", "[data-family-row-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const panel = form.closest("[data-settings-panel]");
            const rawFamily = panel instanceof HTMLElement ? panel.dataset.settingsPanel : "";
            if (!rawFamily || !/** @type {readonly string[]} */ (FAMILIES).includes(rawFamily)) return;
            const family = /** @type {"mcp" | "skills" | "schedule" | "personas" | "members"} */ (rawFamily);
            const submitter = event instanceof SubmitEvent && event.submitter instanceof HTMLButtonElement ? event.submitter : null;
            const operation = submitter?.value ?? "";
            const alias = String(new FormData(form).get("alias") ?? "").trim();
            if (!alias || !["enable", "disable", "remove", "oauth"].includes(operation)) return;
            void runMutation(async () => {
                if (operation === "oauth" && family === "mcp") {
                    let redirectUrl = "http://127.0.0.1/callback";
                    const listed = await invoke("workspace.mcp.list", {}).catch(() => null);
                    if (isRecord(listed) && Array.isArray(listed.definitions)) {
                        const found = listed.definitions.find((entry) => isRecord(entry) && entry.alias === alias);
                        const def = isRecord(found) && isRecord(found.definition) ? found.definition : null;
                        const auth = def?.type === "streamable-http" && isRecord(def.authorization) ? def.authorization : null;
                        if (auth?.type === "oauth" && typeof auth.redirectUrl === "string" && auth.redirectUrl.length > 0) {
                            redirectUrl = auth.redirectUrl;
                        }
                    }
                    const beginRes = await invoke("workspace.mcp.oauth.begin", { alias, redirectUrl });
                    const oauthBox = $(article, "[data-mcp-oauth-box]");
                    if (isRecord(beginRes) && isRecord(beginRes.authorization) && typeof beginRes.authorization.url === "string") {
                        const url = beginRes.authorization.url;
                        if (oauthBox instanceof HTMLElement && /^https?:\/\//iu.test(url)) {
                            the(oauthBox, { "mcp-oauth-url": url, "mcp-oauth-alias": alias });
                            oauthBox.hidden = false;
                        }
                        return `${alias}: open authorization link and submit the callback URL.`;
                    }
                    const fresh = await invoke("workspace.mcp.list", {});
                    renderFamilyList("mcp", fresh);
                    return `${alias}  active`;
                }
                await invoke(`workspace.${family}.${operation}`, family === "members" ? { file: alias } : { alias });
                const fresh = await invoke(`workspace.${family}.list`, {});
                renderFamilyList(family, fresh);
                if (family === "personas" && getContext().sessionName !== null) {
                    const sessionRes = await invoke("session/resume", {}, { requireSession: true }).catch(() => null);
                    if (sessionRes !== null) renderSessionPersonaOptions(sessionRes);
                }
                const isRetry = submitter?.hasAttribute("data-family-retry") === true;
                const verbLabel = operation === "remove" ? "removed" : isRetry ? "retried" : `${operation}d`;
                return `${alias}  ${verbLabel}`;
            });
        });

        on(article, "submit", "[data-mcp-oauth-complete-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const data = new FormData(form);
            const alias = String(data.get("alias") ?? "").trim();
            const callbackUrl = String(data.get("callbackUrl") ?? "").trim();
            if (!alias || !callbackUrl) return;
            void runMutation(async () => {
                await invoke("workspace.mcp.oauth.complete", { alias, callbackUrl });
                const fresh = await invoke("workspace.mcp.list", {});
                renderFamilyList("mcp", fresh);
                const oauthBox = $(article, "[data-mcp-oauth-box]");
                if (oauthBox instanceof HTMLElement) oauthBox.hidden = true;
                const cbInput = $(form, 'input[name="callbackUrl"]');
                if (cbInput instanceof HTMLInputElement) cbInput.value = "";
                return `${alias}  active`;
            });
        });

        on(article, "submit", "[data-family-discover-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const rawFamily = form.dataset.family ?? "";
            if (!/** @type {readonly string[]} */ (FAMILIES).includes(rawFamily)) return;
            const family = /** @type {"mcp" | "skills" | "schedule" | "personas" | "members"} */ (rawFamily);
            const data = new FormData(form);
            /** @type {Record<string, unknown>} */
            const params = {};
            if (family === "mcp" || family === "members") {
                const query = String(data.get("query") ?? "").trim();
                if (query) params.query = query;
            } else if (family === "skills") {
                const source = String(data.get("source") ?? "").trim();
                if (source) params.source = source;
            } else if (family === "schedule") {
                const rule = String(data.get("rule") ?? "").trim();
                if (rule) params.rule = rule;
            } else {
                const source = String(data.get("source") ?? "").trim();
                if (source) params.source = source;
            }
            void runMutation(async () => {
                const res = await invoke(`workspace.${family}.discover`, params);
                renderCandidates(family, res);
                const count = isRecord(res) && Array.isArray(res.candidates) ? res.candidates.length : 0;
                return count === 0 ? `${family} discover: none` : `Found ${count} ${count === 1 ? "result" : "results"}.`;
            });
        });

        on(article, "submit", "[data-candidate-add-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const meta = candidateData.get(form);
            if (!meta) return;
            void runMutation(async () => {
                if (meta.family === "members") {
                    await invoke("workspace.members.add", { files: [meta.alias] });
                } else {
                    /** @type {Record<string, unknown>} */
                    const payload = { alias: meta.alias, ...meta.definition };
                    if (meta.family === "skills") delete payload.commit;
                    await invoke(`workspace.${meta.family}.replace`, payload);
                }
                const fresh = await invoke(`workspace.${meta.family}.list`, {});
                renderFamilyList(meta.family, fresh);
                if (meta.family === "personas" && getContext().sessionName !== null) {
                    const sessionRes = await invoke("session/resume", {}, { requireSession: true }).catch(() => null);
                    if (sessionRes !== null) renderSessionPersonaOptions(sessionRes);
                }
                const enclosing = form.closest("dialog");
                if (enclosing instanceof HTMLDialogElement && enclosing.open) enclosing.close();
                return `${meta.alias}  active`;
            });
        });

        on(article, "submit", "[data-mcp-save-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const data = new FormData(form);
            const transport = String(data.get("transport") ?? "stdio");
            const alias = String(data.get("alias") ?? "").trim();
            void runMutation(async () => {
                if (!alias) throw new Error("Enter a server alias.");
                /** @type {Record<string, unknown>} */
                let payload;
                if (transport === "streamable-http") {
                    const url = String(data.get("url") ?? "").trim();
                    if (!url) throw new Error("Enter an HTTP(S) endpoint URL.");
                    const authMode = String(data.get("authMode") ?? "none");
                    const bearerToken = String(data.get("bearerToken") ?? "").trim();
                    payload = {
                        alias,
                        type: "streamable-http",
                        url,
                        ...(authMode === "bearer"
                            ? { authorization: { type: "bearer", token: bearerToken } }
                            : authMode === "oauth"
                                ? { authorization: { type: "oauth" } }
                                : {}),
                    };
                } else {
                    const command = String(data.get("command") ?? "").trim();
                    if (!command) throw new Error("Enter a server command.");
                    const rawArgs = String(data.get("args") ?? "").trim();
                    const args = rawArgs ? rawArgs.split(/\s+/u) : [];
                    const cwd = String(data.get("cwd") ?? "").trim();
                    payload = {
                        alias,
                        type: "stdio",
                        command,
                        ...(args.length > 0 ? { args } : {}),
                        ...(cwd ? { cwd } : {}),
                    };
                }
                await invoke("workspace.mcp.replace", payload);
                const fresh = await invoke("workspace.mcp.list", {});
                renderFamilyList("mcp", fresh);
                for (const input of $$(form, "input")) {
                    if (input instanceof HTMLInputElement) input.value = "";
                }
                const enclosing = form.closest("dialog");
                if (enclosing instanceof HTMLDialogElement && enclosing.open) enclosing.close();
                return `${alias}  saved`;
            });
        });

        on(article, "submit", "[data-skills-save-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const data = new FormData(form);
            const alias = String(data.get("alias") ?? "").trim();
            const source = String(data.get("source") ?? "").trim();
            const ref = String(data.get("ref") ?? "").trim();
            void runMutation(async () => {
                if (!alias || !source) throw new Error("Enter both a skill name and source.");
                await invoke("workspace.skills.replace", {
                    alias,
                    source,
                    ...(ref ? { ref } : {}),
                });
                const fresh = await invoke("workspace.skills.list", {});
                renderFamilyList("skills", fresh);
                for (const input of $$(form, "input")) {
                    if (input instanceof HTMLInputElement) input.value = "";
                }
                const enclosing = form.closest("dialog");
                if (enclosing instanceof HTMLDialogElement && enclosing.open) enclosing.close();
                return `${alias}  saved`;
            });
        });

        on(article, "submit", "[data-schedule-save-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const data = new FormData(form);
            const alias = String(data.get("alias") ?? "").trim();
            const rawTarget = String(data.get("target") ?? "").trim();
            const rule = String(data.get("rule") ?? "").trim();
            const prompt = String(data.get("prompt") ?? "").trim();
            const target = rawTarget.startsWith("session://") ? rawTarget : `session://${rawTarget}`;
            void runMutation(async () => {
                if (!alias || !rawTarget || !rule || !prompt) {
                    throw new Error("Complete name, target session, rule, and prompt.");
                }
                await invoke("workspace.schedule.replace", { alias, target, rule, prompt });
                const fresh = await invoke("workspace.schedule.list", {});
                renderFamilyList("schedule", fresh);
                for (const field of $$(form, 'input[name="alias"], input[name="rule"], textarea[name="prompt"]')) {
                    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.value = "";
                }
                const enclosing = form.closest("dialog");
                if (enclosing instanceof HTMLDialogElement && enclosing.open) enclosing.close();
                return `${alias}  saved`;
            });
        });

        on(article, "submit", "[data-session-persona-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const persona = String(new FormData(form).get("persona") ?? "none");
            void runMutation(async () => {
                const res = await invoke("session/set_config_option", {
                    configId: "persona",
                    value: persona,
                }, { requireSession: true });
                renderSessionPersonaOptions(res);
                return `Session persona: ${persona}.`;
            });
        });

        on(article, "submit", "[data-personas-save-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const data = new FormData(form);
            const mode = String(data.get("personaMode") ?? "inline");
            const alias = String(data.get("alias") ?? "").trim();
            const model = String(data.get("model") ?? "").trim();
            const effort = String(data.get("effort") ?? "").trim();
            void runMutation(async () => {
                if (!alias) throw new Error("Enter a persona name.");
                /** @type {Record<string, unknown>} */
                let payload;
                if (mode === "source") {
                    const source = String(data.get("source") ?? "").trim();
                    if (!source) throw new Error("Enter a Markdown file path.");
                    payload = {
                        alias,
                        source,
                        ...(model ? { model } : {}),
                        ...(effort ? { effort } : {}),
                    };
                } else {
                    const description = String(data.get("description") ?? "").trim();
                    const body = String(data.get("body") ?? "").trim();
                    if (!description || !body) {
                        throw new Error("Enter both a persona description and instructions.");
                    }
                    payload = {
                        alias,
                        description,
                        body,
                        ...(model ? { model } : {}),
                        ...(effort ? { effort } : {}),
                    };
                }
                await invoke("workspace.personas.replace", payload);
                const [fresh, sessionRes] = await Promise.all([
                    invoke("workspace.personas.list", {}),
                    getContext().sessionName !== null
                        ? invoke("session/resume", {}, { requireSession: true }).catch(() => null)
                        : Promise.resolve(null),
                ]);
                renderFamilyList("personas", fresh);
                if (sessionRes !== null) renderSessionPersonaOptions(sessionRes);
                for (const field of $$(form, "input, textarea")) {
                    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.value = "";
                }
                const effortField = $(form, 'select[name="effort"]');
                if (effortField instanceof HTMLSelectElement) effortField.value = "";
                const enclosing = form.closest("dialog");
                if (enclosing instanceof HTMLDialogElement && enclosing.open) enclosing.close();
                return `${alias}  saved`;
            });
        });

        on(article, "submit", "[data-members-save-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const rawFiles = String(new FormData(form).get("files") ?? "").trim();
            const files = rawFiles.split(/\s+/u).filter((p) => p.length > 0);
            void runMutation(async () => {
                if (files.length === 0) throw new Error("Enter at least one file path or glob pattern.");
                await invoke("workspace.members.add", { files });
                const fresh = await invoke("workspace.members.list", {});
                renderFamilyList("members", fresh);
                for (const input of $$(form, "input")) {
                    if (input instanceof HTMLInputElement) input.value = "";
                }
                const enclosing = form.closest("dialog");
                if (enclosing instanceof HTMLDialogElement && enclosing.open) enclosing.close();
                return `${files.join(", ")}  saved`;
            });
        });

        on(article, "submit", "[data-env-row-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement) || !envPanel) return;
            const submitter = event instanceof SubmitEvent && event.submitter instanceof HTMLButtonElement ? event.submitter : null;
            const operation = submitter?.value ?? "";
            if (operation !== "enable" && operation !== "disable" && operation !== "remove") return;
            const data = new FormData(form);
            const alias = String(data.get("alias") ?? "").trim();
            const origin = String(data.get("origin") ?? "workspace");
            if (!alias) return;
            const targetScope = operation === "remove"
                ? (origin === "workspace" ? "workspace" : "session")
                : envListScope;
            void runMutation(async () => {
                await invoke(`${targetScope}.env.${operation}`, { alias }, {
                    requireSession: targetScope === "session",
                });
                const fresh = await invoke(`${envListScope}.env.list`, {}, {
                    requireSession: envListScope === "session",
                });
                if (envPanel) populateEnvPanel(envPanel, fresh, envListScope);
                const verbLabel = operation === "remove" ? "unset" : `${operation}d`;
                return `${alias}  ${verbLabel}`;
            });
        });

        on(article, "submit", "[data-env-set-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement) || !envPanel) return;
            const aliasInput = $(form, 'input[name="alias"]');
            const valueInput = $(form, 'input[name="value"]');
            const scopeSelect = $(form, 'select[name="scope"]');
            if (!(aliasInput instanceof HTMLInputElement) || !(valueInput instanceof HTMLInputElement)) return;
            const alias = aliasInput.value.trim();
            if (!alias) {
                aliasInput.setCustomValidity("Enter a variable name.");
                aliasInput.reportValidity();
                return;
            }
            const value = valueInput.value;
            const targetScope = scopeSelect instanceof HTMLSelectElement && scopeSelect.value === "session" && getContext().sessionName !== null
                ? "session"
                : "workspace";
            void runMutation(async () => {
                await invoke(`${targetScope}.env.replace`, { alias, value }, {
                    requireSession: targetScope === "session",
                });
                const fresh = await invoke(`${envListScope}.env.list`, {}, {
                    requireSession: envListScope === "session",
                });
                if (envPanel) populateEnvPanel(envPanel, fresh, envListScope);
                aliasInput.value = "";
                valueInput.value = "";
                const enclosing = form.closest("dialog");
                if (enclosing instanceof HTMLDialogElement && enclosing.open) enclosing.close();
                return `${alias}  active`;
            });
        });

        on(article, "input", '[data-env-set-form] input[name="alias"]', (_event, target) => {
            if (target instanceof HTMLInputElement) target.setCustomValidity("");
        });
    }

    ensureMounted();

    return {
        /** @param {SettingsSection} [initialSection] */
        open(initialSection = activeSection) {
            const targetSection = isSettingsSection(initialSection) ? initialSection : "general";
            selectSection(targetSection, false);
        },
        /** @param {SettingsSection} section @param {boolean} [pushHash] */
        selectSection(section, pushHash = false) {
            selectSection(section, pushHash);
        },
        /** @param {string} familyOrTopic */
        notifyChanged(familyOrTopic) {
            if (busy || activeSection === "general" || activeSection === "help") return;
            if (
                familyOrTopic === "resync"
                || familyOrTopic === activeSection
                || (familyOrTopic === "policy" && (activeSection === "personas" || activeSection === "models"))
            ) {
                void refreshSection(activeSection);
            }
        },
        openModelSetup() {
            void onboarding.open();
        },
    };
}

/** @param {string} hash @returns {SettingsSection} */
function parseSettingsHash(hash) {
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    try {
        const decoded = decodeURIComponent(raw);
        return isSettingsSection(decoded) ? decoded : "general";
    } catch {
        return "general";
    }
}

/**
 * {§web-workspace-settings} Dedicated `/settings/?workspace=<name>` page entrypoint.
 * @param {HTMLElement} main
 */
export default function observeWorkspaceSettings(main) {
    const rawWorkspaceId = main.dataset.workspaceId ?? "";
    const rawAuth = main.dataset.auth;
    if (!/^[1-9]\d*$/u.test(rawWorkspaceId) || (rawAuth !== "session" && rawAuth !== "none")) {
        throw new Error("Workspace settings metadata is incomplete.");
    }
    const workspaceId = Number(rawWorkspaceId);
    const auth = rawAuth;
    const live = main.dataset.live === "true";
    let currentWorkspaceName = main.dataset.workspaceName ?? String(workspaceId);
    const sessionName = main.dataset.sessionName || null;
    const article = $(main, "#workspace-settings");
    if (!(article instanceof HTMLElement)) {
        throw new Error("Workspace settings article is missing.");
    }

    const pageLifetime = new AbortController();
    on.target(window, "pagehide", (event) => {
        if (!(event instanceof PageTransitionEvent) || !event.persisted) {
            pageLifetime.abort();
        }
    });

    const queryParams = new URLSearchParams(location.search);
    const controller = createWorkspaceSettingsController(article, () => ({
        workspaceId,
        workspaceName: currentWorkspaceName,
        sessionName,
        auth,
        signal: pageLifetime.signal,
    }), {
        updateHash: true,
        initialQuery: queryParams.get("q") ?? "",
        initialHelpFilter: queryParams.get("cmd") ?? "",
        initialEnvScope: queryParams.get("envScope") === "session" ? "session" : "workspace",
    });

    controller.selectSection(parseSettingsHash(location.hash), false);
    if (queryParams.get("setup") === "1") {
        controller.openModelSetup();
    }

    on.target(window, "hashchange", () => {
        controller.selectSection(parseSettingsHash(location.hash), false);
    });

    if (!live) return;

    const notifications = subscribeWorkspaceNotifications({
        auth,
        workspaceId,
        onNotification(raw) {
            if (!isRecord(raw) || typeof raw.event !== "string" || !isRecord(raw.data)) return;
            const { event, data } = raw;
            const notifWorkspaceId = typeof raw.workspaceId === "number" ? raw.workspaceId : null;
            if (event === "workspace/renamed") {
                const id = typeof data.id === "number" ? data.id : notifWorkspaceId;
                const name = typeof data.name === "string" ? data.name : null;
                if (id !== workspaceId || name === null) return;
                currentWorkspaceName = name;
                main.dataset.workspaceName = name;
                the("page-title", `${name} · Settings — Plurnk`);
                const backLink = $("[data-settings-back]");
                const backPath = sessionName !== null
                    ? directoryPath({ kind: "session", workspace: name, session: sessionName })
                    : directoryPath({ kind: "workspace", workspace: name });
                if (backLink && backPath !== null) {
                    the(backLink, {
                        "workspace-name": name,
                        "workspace-back-path": backPath,
                    });
                }
                for (const input of $$('input[name="workspace"]')) {
                    if (input instanceof HTMLInputElement && input.type === "hidden") {
                        input.value = name;
                    }
                }
                const nextSettingsPath = workspaceSettingsPath(name, sessionName, location.hash.slice(1) || null);
                if (nextSettingsPath !== null && typeof history === "object") {
                    history.replaceState(null, "", nextSettingsPath);
                }
                return;
            }
            if (notifWorkspaceId !== workspaceId && event !== "notifications/resync") return;
            if (event === "functionality/changed" && typeof data.family === "string") {
                controller.notifyChanged(data.family);
            } else if (event === "session/policy") {
                controller.notifyChanged("policy");
            } else if (event === "notifications/resync") {
                controller.notifyChanged("resync");
            }
        },
    });
    on(document.body, "submit", 'form[action="/auth/logout"]', () => {
        notifications.unsubscribe();
    });
}
