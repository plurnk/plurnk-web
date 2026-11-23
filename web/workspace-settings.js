import { $, $$, on, the } from "on_the_money";
import { EFFORTS } from "@plurnk/plurnk-contracts";
import { directoryPath, nextSequentialName, workspaceSettingsPath } from "../src/directory-addresses.js";
import { onServiceVersion, serviceVersion, webVersion } from "./endpoints.js";
import renderInPageError from "./error-view.js";
import describeFailure from "./failure.js";
import { populateEnvPanel } from "./env-panel.js";
import managementAction from "./management-action.js";
import { primaryModifierLabel } from "./session-commands.js";
import { createModelSearchCache, listModels, modelLabel, sessionConfigOption, sessionEffort, sessionModel } from "./session-models.js";
import { attachModelCombobox } from "./model-combobox.js";
import { mountSchedulePanel } from "./schedule-panel.js";
import { isUntouchedDraftSession, orderByReply } from "./session-selection.js";
import { isRecord } from "./session-translator.js";
import { parseWorkspaceList, wireWorkspaceCreateDialog } from "./workspace-dialogs.js";
import { subscribeWorkspaceNotifications } from "./workspace-notifications.js";

/**
 * @typedef {"workspace" | "session" | "models" | "mcp" | "skills" | "schedule" | "personas" | "members" | "env" | "help" | "about"} SettingsSection
 */

/**
 * @typedef {"mcp" | "skills" | "schedule" | "personas" | "members"} WorkspaceFamily
 */

/**
 * @typedef {{
 *   readonly workspaceId: number,
 *   readonly workspaceName: string,
 *   readonly sessionName: string | null,
 *   readonly signal: AbortSignal,
 * }} WorkspaceSettingsContext
 */

const SECTIONS = /** @type {const} */ (["workspace", "session", "models", "mcp", "skills", "schedule", "personas", "members", "env", "help", "about"]);
const FAMILIES = /** @type {const} */ (["mcp", "skills", "schedule", "personas", "members"]);

/** @param {unknown} value @returns {value is SettingsSection} */
export const isSettingsSection = (value) =>
    typeof value === "string" && /** @type {readonly string[]} */ (SECTIONS).includes(value);

/** @param {unknown} value @returns {value is WorkspaceFamily} */
const isWorkspaceFamily = (value) =>
    typeof value === "string" && /** @type {readonly string[]} */ (FAMILIES).includes(value);

/**
 * @param {WorkspaceFamily} family
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
            const rule = typeof def.rule === "string" ? def.rule : "manual";
            const action = typeof def.prompt === "string"
                ? def.prompt
                : Array.isArray(def.run)
                    ? `${def.run.length} ${def.run.length === 1 ? "step" : "steps"}`
                    : "";
            return [target, rule, action].filter((part) => part.length > 0).join(" · ");
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
 * {§web-workspace-settings} Table-driven Functionality save contracts across all five workspace families.
 * @type {readonly {
 *   readonly family: WorkspaceFamily,
 *   readonly selector: string,
 *   readonly action: string,
 *   readonly build: (form: HTMLFormElement) => { readonly label: string, readonly payload: Record<string, unknown> },
 *   readonly clear: (form: HTMLFormElement) => void,
 * }[]}
 */
const FAMILY_SAVE_SPECS = [
    {
        family: "mcp",
        selector: "[data-mcp-save-form]",
        action: "workspace.mcp.replace",
        build(form) {
            const data = new FormData(form);
            const transport = String(data.get("transport") ?? "stdio");
            const alias = String(data.get("alias") ?? "").trim();
            if (!alias) throw new Error("Enter a server alias.");
            if (transport === "streamable-http") {
                const url = String(data.get("url") ?? "").trim();
                if (!url) throw new Error("Enter an HTTP(S) endpoint URL.");
                const authMode = String(data.get("authMode") ?? "none");
                const bearerToken = String(data.get("bearerToken") ?? "").trim();
                return {
                    label: alias,
                    payload: {
                        alias,
                        type: "streamable-http",
                        url,
                        ...(authMode === "bearer"
                            ? { authorization: { type: "bearer", token: bearerToken } }
                            : authMode === "oauth"
                                ? { authorization: { type: "oauth" } }
                                : {}),
                    },
                };
            }
            const command = String(data.get("command") ?? "").trim();
            if (!command) throw new Error("Enter a server command.");
            const rawArgs = String(data.get("args") ?? "").trim();
            const args = rawArgs ? rawArgs.split(/\s+/u) : [];
            const cwd = String(data.get("cwd") ?? "").trim();
            return {
                label: alias,
                payload: {
                    alias,
                    type: "stdio",
                    command,
                    ...(args.length > 0 ? { args } : {}),
                    ...(cwd ? { cwd } : {}),
                },
            };
        },
        clear(form) {
            for (const input of $$(form, "input")) {
                if (input instanceof HTMLInputElement) input.value = "";
            }
        },
    },
    {
        family: "skills",
        selector: "[data-skills-save-form]",
        action: "workspace.skills.replace",
        build(form) {
            const data = new FormData(form);
            const alias = String(data.get("alias") ?? "").trim();
            const source = String(data.get("source") ?? "").trim();
            const ref = String(data.get("ref") ?? "").trim();
            if (!alias || !source) throw new Error("Enter both a skill name and source.");
            return {
                label: alias,
                payload: { alias, source, ...(ref ? { ref } : {}) },
            };
        },
        clear(form) {
            for (const input of $$(form, "input")) {
                if (input instanceof HTMLInputElement) input.value = "";
            }
        },
    },
    {
        family: "personas",
        selector: "[data-personas-save-form]",
        action: "workspace.personas.replace",
        build(form) {
            const data = new FormData(form);
            const mode = String(data.get("personaMode") ?? "inline");
            const alias = String(data.get("alias") ?? "").trim();
            const model = String(data.get("model") ?? "").trim();
            const effort = String(data.get("effort") ?? "").trim();
            if (!alias) throw new Error("Enter a persona name.");
            if (mode === "source") {
                const source = String(data.get("source") ?? "").trim();
                if (!source) throw new Error("Enter a Markdown file path.");
                return {
                    label: alias,
                    payload: {
                        alias,
                        source,
                        ...(model ? { model } : {}),
                        ...(effort ? { effort } : {}),
                    },
                };
            }
            const description = String(data.get("description") ?? "").trim();
            const body = String(data.get("body") ?? "").trim();
            if (!description || !body) {
                throw new Error("Enter both a persona description and instructions.");
            }
            return {
                label: alias,
                payload: {
                    alias,
                    description,
                    body,
                    ...(model ? { model } : {}),
                    ...(effort ? { effort } : {}),
                },
            };
        },
        clear(form) {
            for (const field of $$(form, "input, textarea")) {
                if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.value = "";
            }
            const effortField = $(form, 'select[name="effort"]');
            if (effortField instanceof HTMLSelectElement) effortField.value = "";
        },
    },
    {
        family: "members",
        selector: "[data-members-save-form]",
        action: "workspace.members.add",
        build(form) {
            const rawFiles = String(new FormData(form).get("files") ?? "").trim();
            const files = rawFiles.split(/\s+/u).filter((p) => p.length > 0);
            if (files.length === 0) throw new Error("Enter at least one file path or glob pattern.");
            return {
                label: files.join(", "),
                payload: { files },
            };
        },
        clear(form) {
            for (const input of $$(form, "input")) {
                if (input instanceof HTMLInputElement) input.value = "";
            }
        },
    },
];

/** @param {Element} form */
function collapseEnclosingDisclosure(form) {
    const disclosure = form.closest("details[data-family-disclosure]");
    if (disclosure instanceof HTMLDetailsElement) {
        disclosure.open = false;
    }
}

/**
 * {§web-workspace-settings} Mounts workspace and session management inside `<article id="workspace-settings">`.
 * @param {HTMLElement} article
 * @param {() => WorkspaceSettingsContext} getContext
 * @param {{ updateHash?: boolean, initialQuery?: string, initialHelpFilter?: string, initialEnvScope?: "workspace" | "session" }} [options]
 */
export function createWorkspaceSettingsController(article, getContext, { updateHash = false, initialQuery = "", initialHelpFilter = "", initialEnvScope = "workspace" } = {}) {
    /** @type {Element | null} */
    let envPanel = null;
    /** @type {SettingsSection} */
    let activeSection = "workspace";
    /** @type {"workspace" | "session"} */
    let envListScope = initialEnvScope === "session" ? "session" : "workspace";
    let modelsSearchQuery = initialQuery;
    let modelsProviderFilter = "";
    let modelsOffset = 0;
    /** @type {number | undefined} */
    let modelsNextOffset;
    /** @type {Set<string>} */
    const knownCatalogProviders = new Set();
    let helpFilterQuery = initialHelpFilter;
    let busy = false;
    let refreshDepth = 0;
    let mounted = false;
    /** @type {AbortController | null} */
    let modelsLookup = null;
    /** @type {AbortController | null} */
    let effortLookup = null;
    /** @type {WeakMap<Element, { family: "mcp" | "skills" | "personas" | "members", alias: string, definition: Record<string, unknown> }>} */
    const candidateData = new WeakMap();
    /** @type {ReturnType<typeof attachModelCombobox> | null} */
    let sessionModelCombobox = null;
    /** @type {ReturnType<typeof attachModelCombobox> | null} */
    let sessionSpawnCombobox = null;
    /** @type {ReturnType<typeof attachModelCombobox> | null} */
    let personaModelCombobox = null;
    /** @type {ReturnType<typeof mountSchedulePanel> | null} */
    let schedulePanelController = null;
    const modelSearchCache = createModelSearchCache((kind, params = {}, signal) => {
        const ctx = getContext();
        const combinedSignal = signal ? AbortSignal.any([ctx.signal, signal]) : ctx.signal;
        return managementAction(kind, params, ctx.sessionName !== null ? `${ctx.workspaceId}#${ctx.sessionName}` : "", combinedSignal, {
            workspaceId: ctx.workspaceId,
        });
    });

    function syncLoadingState() {
        the(article, "ws-settings-loading", busy || refreshDepth > 0 ? "true" : null);
    }

    /** @param {boolean} nextBusy @param {string} [message] @param {string} [recovery] */
    function setFeedback(nextBusy, message = "", recovery = "") {
        busy = nextBusy;
        the(article, {
            "ws-settings-loading": nextBusy || refreshDepth > 0 ? "true" : null,
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
        return managementAction(kind, params, sessionId, ctx.signal, {
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
     * @param {WorkspaceFamily} family
     * @param {unknown} res
     */
    function renderFamilyList(family, res) {
        if (family === "schedule" && schedulePanelController) {
            schedulePanelController.renderList(res);
            return;
        }
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
     * @param {WorkspaceFamily} family
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

    /** @type {{ model: string, effort: string, spawnModel: string, persona: string, mode: string }} */
    let currentSessionValues = { model: "", effort: "", spawnModel: "inherit", persona: "none", mode: "review" };
    let hasPersistedSessionModel = false;

    /**
     * @param {HTMLSelectElement} effortSelect
     * @param {readonly string[]} supported
     * @param {string} defaultEffort
     * @param {string} preferredEffort
     * @returns {string}
     */
    function populateEffortSelect(effortSelect, supported, defaultEffort, preferredEffort) {
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
     * @param {HTMLSelectElement} effortSelect
     * @param {string} selectedModel
     * @param {string} preferredEffort
     * @param {readonly string[]} [knownEfforts]
     * @param {string} [knownDefaultEffort]
     * @returns {string}
     */
    function syncSessionEffortSelect(effortSelect, selectedModel, preferredEffort, knownEfforts, knownDefaultEffort) {
        if (knownEfforts !== undefined && knownEfforts.length > 0) {
            return populateEffortSelect(effortSelect, knownEfforts, knownDefaultEffort ?? "", preferredEffort);
        }
        const entry = modelSearchCache.getCachedEfforts(selectedModel);
        const resolved = populateEffortSelect(effortSelect, entry?.efforts ?? [], entry?.defaultEffort ?? "", preferredEffort);
        if ((!entry || entry.efforts.length === 0) && selectedModel && selectedModel !== "none") {
            effortLookup?.abort();
            const req = effortLookup = new AbortController();
            const ctx = getContext();
            const lookupSignal = AbortSignal.any([ctx.signal, req.signal]);
            void modelSearchCache.resolveEfforts(selectedModel, lookupSignal).then((fetched) => {
                if (req.signal.aborted || ctx.signal.aborted) return;
                if (sessionModelCombobox && sessionModelCombobox.getValue() !== selectedModel) return;
                if (fetched.efforts.length > 0) {
                    populateEffortSelect(effortSelect, fetched.efforts, fetched.defaultEffort, effortSelect.value || preferredEffort);
                }
            }).catch(() => {});
        }
        return resolved;
    }

    /**
     * @param {unknown} sessionRes
     * @param {readonly import("./session-models.js").ModelAliasEntry[]} aliases
     * @param {readonly import("@plurnk/plurnk-contracts").ModelCatalogEntry[]} catalogItems
     */
    function renderSessionConfigControls(sessionRes, aliases, catalogItems) {
        const form = $(article, "form[data-session-config-form]");
        const effortSelect = form ? $(form, 'select[name="effort"]') : null;
        const personaSelect = form ? $(form, 'select[name="persona"]') : null;
        const modeSelect = form ? $(form, 'select[name="mode"]') : null;
        if (!(form instanceof HTMLFormElement)
            || !sessionModelCombobox
            || !sessionSpawnCombobox
            || !(effortSelect instanceof HTMLSelectElement)
            || !(personaSelect instanceof HTMLSelectElement)
            || !(modeSelect instanceof HTMLSelectElement)) {
            return;
        }
        if (getContext().sessionName === null || !isRecord(sessionRes) || !Array.isArray(sessionRes.configOptions)) {
            form.hidden = true;
            return;
        }
        const modelOption = sessionRes.configOptions.find((entry) => isRecord(entry) && entry.configId === "model");
        const thoughtOption = sessionRes.configOptions.find((entry) => isRecord(entry) && entry.configId === "thought_level");
        const spawnOption = sessionRes.configOptions.find((entry) => isRecord(entry) && entry.configId === "spawn_model");
        const personaOption = sessionRes.configOptions.find((entry) => isRecord(entry) && entry.configId === "persona");
        const modeOption = sessionRes.configOptions.find((entry) => isRecord(entry) && entry.configId === "mode");

        modelSearchCache.recordAliases(aliases);
        modelSearchCache.recordCatalogItems(catalogItems);

        const thoughtSupported = isRecord(thoughtOption) && Array.isArray(thoughtOption.options)
            ? thoughtOption.options.flatMap((entry) => isRecord(entry) && typeof entry.value === "string" && entry.value ? [entry.value] : [])
            : [];
        const currentModel = isRecord(modelOption) && typeof modelOption.currentValue === "string" && modelOption.currentValue && modelOption.currentValue !== "none"
            ? modelOption.currentValue
            : "";
        if (currentModel && thoughtSupported.length > 0) {
            modelSearchCache.seedEfforts(currentModel, thoughtSupported);
        }

        const plurnkMeta = isRecord(sessionRes._meta) && isRecord(sessionRes._meta.plurnk) ? sessionRes._meta.plurnk : null;
        const metaStatus = isRecord(plurnkMeta?.status) ? plurnkMeta.status : null;
        hasPersistedSessionModel = metaStatus !== null && Object.hasOwn(metaStatus, "model")
            ? metaStatus.model !== null
            : Boolean(currentModel);

        const resolvedModel = currentModel || (aliases.find((a) => a.active)?.alias ?? aliases[0]?.alias ?? "");
        sessionModelCombobox.setValue(resolvedModel);

        const currentEffort = isRecord(thoughtOption) && typeof thoughtOption.currentValue === "string" ? thoughtOption.currentValue : "";
        const resolvedEffort = syncSessionEffortSelect(effortSelect, resolvedModel, currentEffort);

        const currentSpawn = isRecord(spawnOption) && typeof spawnOption.currentValue === "string" && spawnOption.currentValue
            ? spawnOption.currentValue
            : "inherit";
        sessionSpawnCombobox.setValue(currentSpawn);

        const personaChoices = isRecord(personaOption) && Array.isArray(personaOption.options) && personaOption.options.length > 0
            ? personaOption.options.flatMap((entry) => {
                if (!isRecord(entry) || typeof entry.value !== "string" || typeof entry.name !== "string") return [];
                const desc = typeof entry.description === "string" && entry.description.length > 0 ? ` — ${entry.description}` : "";
                return [{ value: entry.value, label: `${entry.name}${desc}` }];
            })
            : [{ value: "none", label: "None (default)" }];
        const currentPersona = isRecord(personaOption) && typeof personaOption.currentValue === "string" && personaOption.currentValue
            ? personaOption.currentValue
            : "none";
        $.cloneEach(personaSelect, "#setting-option", personaChoices, (optEl, choice) => {
            the(optEl, { "option-value": choice.value, "option-label": choice.label, "option-disabled": null });
        });
        personaSelect.value = personaChoices.some((c) => c.value === currentPersona) ? currentPersona : "none";

        const fallbackModes = [
            { value: "review", label: "Ask before external mutations (review)" },
            { value: "accept", label: "Auto-approve all operations (accept)" },
            { value: "reject", label: "Deny gated operations (reject)" },
        ];
        const modeChoices = isRecord(modeOption) && Array.isArray(modeOption.options) && modeOption.options.length > 0
            ? modeOption.options.flatMap((entry) =>
                isRecord(entry) && typeof entry.value === "string" && typeof entry.name === "string"
                    ? [{ value: entry.value, label: `${entry.name} (${entry.value})` }]
                    : [])
            : fallbackModes;
        $.cloneEach(modeSelect, "#setting-option", modeChoices, (optEl, choice) => {
            the(optEl, { "option-value": choice.value, "option-label": choice.label, "option-disabled": null });
        });
        const currentMode = isRecord(modeOption) && typeof modeOption.currentValue === "string" && modeOption.currentValue
            ? modeOption.currentValue
            : "review";
        const resolvedMode = modeChoices.some((c) => c.value === currentMode) ? currentMode : (modeChoices[0]?.value ?? "review");
        modeSelect.value = resolvedMode;

        currentSessionValues = {
            model: resolvedModel,
            effort: resolvedEffort,
            spawnModel: currentSpawn,
            persona: personaSelect.value,
            mode: resolvedMode,
        };
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

    /**
     * @param {SettingsSection} section
     */
    async function refreshSection(section) {
        if (section === "workspace") {
            if (!busy) setFeedback(false, "", "");
            return;
        }
        if (section === "help") {
            applyHelpFilter();
            if (!busy) setFeedback(false, "", "");
            return;
        }
        if (section === "about") {
            syncAboutPanel();
            if (serviceVersion() === null) {
                const ctx = getContext();
                await managementAction("workspace.list", {}, "", ctx.signal).catch(() => null);
                syncAboutPanel();
            }
            if (!busy) setFeedback(false, "", "");
            return;
        }
        const ctx = getContext();
        if (ctx.workspaceId <= 0) {
            if (!busy) setFeedback(false, "", "");
            return;
        }
        if (section === "session" && ctx.sessionName === null) {
            renderSessionConfigControls(null, [], []);
            if (!busy) setFeedback(false, "", "");
            return;
        }
        if (!busy) {
            the(article, { "ws-settings-message": "", "ws-settings-recovery": "" });
        }
        refreshDepth += 1;
        syncLoadingState();
        /** @type {AbortController | null} */
        let currentModelsReq = null;
        try {
            if (section === "session") {
                const callSession = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ params = {}) =>
                    managementAction(kind, params, `${ctx.workspaceId}#${ctx.sessionName}`, ctx.signal, {
                        workspaceId: ctx.workspaceId,
                    });
                const [{ aliases, catalog }, sessionRes] = await Promise.all([
                    listModels(callSession),
                    callSession("session/options"),
                ]);
                ctx.signal.throwIfAborted();
                renderSessionConfigControls(sessionRes, aliases, catalog.items);
                return;
            }
            if (section === "models") {
                modelsLookup?.abort();
                const req = modelsLookup = new AbortController();
                currentModelsReq = req;
                const signal = AbortSignal.any([ctx.signal, req.signal]);
                const callModels = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ params = {}) =>
                    managementAction(kind, params, ctx.sessionName !== null ? `${ctx.workspaceId}#${ctx.sessionName}` : "", signal, {
                        workspaceId: ctx.workspaceId,
                    });
                const { aliases, catalog } = await listModels(callModels, modelsSearchQuery, {
                    offset: modelsOffset,
                    limit: 100,
                    ...(modelsProviderFilter ? { provider: modelsProviderFilter } : {}),
                    signal,
                });
                signal.throwIfAborted();
                modelSearchCache.recordAliases(aliases);
                modelSearchCache.recordCatalogItems(catalog.items);
                for (const alias of aliases) {
                    if (alias.provider) knownCatalogProviders.add(alias.provider);
                }
                for (const item of catalog.items) {
                    if (item.provider) knownCatalogProviders.add(item.provider);
                }
                modelsNextOffset = catalog.nextOffset;
                const modelsPanel = $(article, '[data-settings-panel="models"]');
                const aliasBody = modelsPanel ? $(modelsPanel, "[data-models-alias-rows]") : null;
                const catalogBody = modelsPanel ? $(modelsPanel, "[data-models-catalog-rows]") : null;
                const providerSelect = modelsPanel ? $(modelsPanel, '[data-models-search-form] select[name="provider"]') : null;
                if (providerSelect instanceof HTMLSelectElement) {
                    const providerChoices = [
                        { value: "", label: "All providers" },
                        ...[...knownCatalogProviders].toSorted().map((name) => ({ value: name, label: name })),
                    ];
                    $.cloneEach(providerSelect, "#setting-option", providerChoices, (optEl, choice) => {
                        the(optEl, { "option-value": choice.value, "option-label": choice.label, "option-disabled": null });
                    });
                    providerSelect.value = modelsProviderFilter;
                }
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
                            "model-session-usable": sessionUsable,
                            "model-ready": model.readiness.ready ? "true" : "false",
                        });
                    });
                    const prevBtn = $(modelsPanel, "[data-models-prev]");
                    const nextBtn = $(modelsPanel, "[data-models-next]");
                    if (prevBtn instanceof HTMLButtonElement) prevBtn.disabled = catalog.offset <= 0;
                    if (nextBtn instanceof HTMLButtonElement) nextBtn.disabled = catalog.nextOffset === undefined;
                    the(modelsPanel, {
                        "alias-count": aliases.length,
                        "model-offset": catalog.offset,
                        "model-count": catalog.items.length,
                        "model-total": catalog.total,
                        "model-more": catalog.nextOffset === undefined ? "" : "More matches are available; narrow the search or paginate.",
                    });
                }
                return;
            }
            if (section === "env") {
                syncEnvScopeControls();
                const res = await invoke(`${envListScope}.env.list`, {}, {
                    requireSession: envListScope === "session",
                });
                ctx.signal.throwIfAborted();
                if (envPanel) populateEnvPanel(envPanel, res, envListScope);
                return;
            }
            const res = await invoke(`workspace.${section}.list`, {});
            ctx.signal.throwIfAborted();
            renderFamilyList(section, res);
            if (section === "schedule" && schedulePanelController) {
                void schedulePanelController.refreshAuxiliaryData();
            }
        } catch (error) {
            if (currentModelsReq?.signal.aborted && !ctx.signal.aborted) return;
            const { message, recovery } = await describeFailure(error);
            if (!busy) {
                setFeedback(false, ctx.signal.aborted ? "Response not confirmed." : message, recovery);
            }
        } finally {
            refreshDepth = Math.max(0, refreshDepth - 1);
            syncLoadingState();
        }
    }

    function syncAboutPanel() {
        const aboutPanel = $(article, '[data-settings-panel="about"]');
        if (!(aboutPanel instanceof HTMLElement)) return;
        the(aboutPanel, "about-web-version", webVersion());
        const svc = serviceVersion();
        const svcTerm = $(aboutPanel, "[data-about-service-term]");
        const svcVal = $(aboutPanel, "[data-about-service-value]");
        if (svc !== null) {
            if (svcTerm instanceof HTMLElement) svcTerm.hidden = false;
            if (svcVal instanceof HTMLElement) svcVal.hidden = false;
            the(aboutPanel, "about-service-version", svc);
        }
        const desktopMatch = /\bplurnk-desktop\/([^\s;()]+)/iu.exec(globalThis.navigator?.userAgent ?? "");
        const desktopTerm = $(aboutPanel, "[data-about-desktop-term]");
        const desktopVal = $(aboutPanel, "[data-about-desktop-value]");
        if (desktopMatch?.[1]) {
            if (desktopTerm instanceof HTMLElement) desktopTerm.hidden = false;
            if (desktopVal instanceof HTMLElement) desktopVal.hidden = false;
            the(aboutPanel, "about-desktop-version", desktopMatch[1]);
        } else {
            if (desktopTerm instanceof HTMLElement) desktopTerm.hidden = true;
            if (desktopVal instanceof HTMLElement) desktopVal.hidden = true;
        }
    }

    function prefillScheduleTarget() {
        schedulePanelController?.prefillTarget();
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
            const nextUrl = section === "workspace"
                ? `${location.pathname}${location.search}`
                : `${location.pathname}${location.search}#${section}`;
            if (`${location.pathname}${location.search}${location.hash}` !== nextUrl) {
                history.replaceState(null, "", nextUrl);
            }
        }
        if (section === "schedule") prefillScheduleTarget();
        void refreshSection(section);
    }

    function ensureMounted() {
        if (mounted) return;
        mounted = true;
        const sessionConfigOutlet = $(article, "[data-session-config-outlet]");
        if (sessionConfigOutlet) {
            const clonedSessionCfg = $.clone(sessionConfigOutlet, "#session-config-controls", { position: "beforebegin" });
            if (clonedSessionCfg) sessionConfigOutlet.remove();
        }
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
        syncAboutPanel();
        const sessionModelBox = $(article, '[data-session-config-form] [data-model-combobox="model"]');
        if (sessionModelBox instanceof HTMLElement) {
            sessionModelCombobox = attachModelCombobox(sessionModelBox, {
                getCache: () => modelSearchCache,
                signal: getContext().signal,
                onSelect: (selector, choice) => {
                    const effortField = $(article, '[data-session-config-form] select[name="effort"]');
                    if (effortField instanceof HTMLSelectElement) {
                        syncSessionEffortSelect(effortField, selector, effortField.value, choice?.efforts, choice?.defaultEffort);
                    }
                },
                onInput: (selector) => {
                    const effortField = $(article, '[data-session-config-form] select[name="effort"]');
                    if (effortField instanceof HTMLSelectElement && selector) {
                        const cached = modelSearchCache.getCachedEfforts(selector);
                        if (cached) {
                            syncSessionEffortSelect(effortField, selector, effortField.value, cached.efforts, cached.defaultEffort);
                        }
                    }
                },
            });
        }
        const sessionSpawnBox = $(article, '[data-session-config-form] [data-model-combobox="spawnModel"]');
        if (sessionSpawnBox instanceof HTMLElement) {
            sessionSpawnCombobox = attachModelCombobox(sessionSpawnBox, {
                getCache: () => modelSearchCache,
                includeInherit: true,
                signal: getContext().signal,
            });
        }
        const personaModelBox = $(article, '[data-personas-save-form] [data-model-combobox="personaModel"]');
        if (personaModelBox instanceof HTMLElement) {
            personaModelCombobox = attachModelCombobox(personaModelBox, {
                getCache: () => modelSearchCache,
                signal: getContext().signal,
            });
        }
        const schedulePanelEl = $(article, '[data-settings-panel="schedule"]');
        if (schedulePanelEl instanceof HTMLElement) {
            schedulePanelController = mountSchedulePanel(schedulePanelEl, {
                getContext,
                invoke,
                invokeForSession: (kind, params, targetSession, signal) => {
                    const ctx = getContext();
                    const combinedSignal = signal ? AbortSignal.any([ctx.signal, signal]) : ctx.signal;
                    return managementAction(kind, params, `${ctx.workspaceId}#${targetSession}`, combinedSignal, {
                        workspaceId: ctx.workspaceId,
                    });
                },
                runMutation,
                setFeedback,
            });
        }

        const offSvc = onServiceVersion(() => { syncAboutPanel(); });
        on.target(getContext().signal, "abort", () => {
            offSvc();
            effortLookup?.abort();
            sessionModelCombobox?.dispose();
            sessionSpawnCombobox?.dispose();
            personaModelCombobox?.dispose();
            schedulePanelController?.dispose();
        });

        // {§web-workspace-rename} {§web-workspace-archive} {§web-session-archive} Workspace and session lifecycle mutations dispatch over /acp.
        on(article, "submit", "form#workspace-rename", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const newName = String(new FormData(form).get("name") ?? "").trim();
            if (!newName) return;
            void runMutation(async () => {
                const ctx = getContext();
                const renamed = await invoke("workspace.rename", { workspaceId: ctx.workspaceId, name: newName });
                const resolvedName = isRecord(renamed) && typeof renamed.name === "string" && renamed.name !== ""
                    ? renamed.name
                    : newName;
                const dest = ctx.sessionName !== null
                    ? directoryPath({ kind: "session", workspace: resolvedName, session: ctx.sessionName })
                    : directoryPath({ kind: "workspace", workspace: resolvedName });
                if (dest === null) throw new Error("The daemon returned a workspace name without a directory address.");
                location.assign(dest);
                return `Renamed workspace to ${resolvedName}.`;
            });
        });

        on(article, "submit", "form#workspace-archive", (event) => {
            event.preventDefault();
            void runMutation(async () => {
                const ctx = getContext();
                await invoke("workspace.archive", { workspaceId: ctx.workspaceId, archived: true });
                location.assign("/");
                return "Workspace archived.";
            });
        });

        on(article, "submit", "form#workspace-unarchive", (event) => {
            event.preventDefault();
            void runMutation(async () => {
                const ctx = getContext();
                await invoke("workspace.archive", { workspaceId: ctx.workspaceId, archived: false });
                location.assign(directoryPath({ kind: "workspace", workspace: ctx.workspaceName }) ?? "/search/");
                return "Workspace unarchived.";
            });
        });

        on(article, "submit", "form#session-archive", (event) => {
            event.preventDefault();
            void runMutation(async () => {
                const ctx = getContext();
                if (!ctx.sessionName) throw new Error("No active session selected.");
                await invoke("session/archive", {}, { requireSession: true });
                const [overviewRes, sessionsRes] = await Promise.all([
                    managementAction("session/list", {
                        archived: "exclude",
                        _meta: { plurnk: { workspaceId: ctx.workspaceId, limit: 1000 } },
                    }, "", ctx.signal, { workspaceId: ctx.workspaceId }).catch(() => null),
                    managementAction("workspace.sessions", {
                        workspaceId: ctx.workspaceId,
                        includeArchived: true,
                    }, "", ctx.signal, { workspaceId: ctx.workspaceId }).catch(() => null),
                ]);
                /** @type {Map<number, { kind?: string, gates: number, title?: string, reply: { id: number } | null }>} */
                const overviewById = new Map();
                const rawOverview = isRecord(overviewRes) && Array.isArray(overviewRes.sessions) ? overviewRes.sessions : [];
                for (const item of rawOverview) {
                    if (!isRecord(item)) continue;
                    const meta = isRecord(item._meta) && isRecord(item._meta.plurnk) ? item._meta.plurnk : null;
                    if (!meta || typeof meta.id !== "number") continue;
                    const replyId = isRecord(meta.reply) && typeof meta.reply.id === "number" ? meta.reply.id : null;
                    overviewById.set(meta.id, {
                        ...(typeof meta.kind === "string" ? { kind: meta.kind } : {}),
                        gates: typeof meta.gates === "number" ? meta.gates : 0,
                        ...(typeof meta.title === "string" ? { title: meta.title } : {}),
                        reply: replyId !== null ? { id: replyId } : null,
                    });
                }
                const rawRows = isRecord(sessionsRes) && Array.isArray(sessionsRes.sessions) ? sessionsRes.sessions : [];
                /** @type {Set<string>} */
                const seenSessionNames = new Set();
                const unarchived = rawRows
                    .filter((row) => {
                        if (isRecord(row) && typeof row.name === "string") seenSessionNames.add(row.name);
                        return isRecord(row)
                            && typeof row.id === "number"
                            && typeof row.name === "string"
                            && row.origin === "model"
                            && (row.archived_at === null || row.archived_at === undefined);
                    })
                    .map((row) => {
                        const r = /** @type {Record<string, unknown>} */ (row);
                        const id = /** @type {number} */ (r.id);
                        const info = overviewById.get(id);
                        const parentSessionId = typeof r.parentSessionId === "number" ? r.parentSessionId : null;
                        const resolvedTitle = info?.title ?? (typeof r.title === "string" ? r.title : undefined);
                        return {
                            id,
                            name: /** @type {string} */ (r.name),
                            parentSessionId,
                            kind: info?.kind ?? (typeof r.kind === "string" ? r.kind : (parentSessionId === null ? "root" : "work")),
                            lifecycle: typeof r.lifecycle === "string" ? r.lifecycle : "idle",
                            gates: info?.gates ?? 0,
                            ...(typeof resolvedTitle === "string" ? { title: resolvedTitle } : {}),
                            reply: info?.reply ?? null,
                        };
                    })
                    .toSorted((a, b) => orderByReply(a, b) || a.id - b.id);
                const childParents = new Set(unarchived.flatMap(({ parentSessionId }) => parentSessionId === null ? [] : [parentSessionId]));
                const nonDraft = unarchived.filter((entry) => !isUntouchedDraftSession(entry, childParents.has(entry.id)));
                const topLevelNonDraft = nonDraft.filter((entry) => entry.parentSessionId === null || entry.kind === "fork");
                const remaining = topLevelNonDraft.length > 0 ? topLevelNonDraft : nonDraft.length > 0 ? nonDraft : unarchived;
                if (remaining.length > 0) {
                    const nextPath = directoryPath({ kind: "session", workspace: ctx.workspaceName, session: remaining[0].name });
                    if (nextPath !== null) {
                        location.assign(nextPath);
                        return "Session archived.";
                    }
                }
                const candidate = nextSequentialName("session", seenSessionNames);
                const fresh = await managementAction("session/new", {
                    _meta: { plurnk: { workspace: ctx.workspaceName, sessionName: candidate } },
                }, "", ctx.signal).catch(() => null);
                const freshId = isRecord(fresh) && typeof fresh.sessionId === "string" ? fresh.sessionId : "";
                const freshName = freshId.includes("#") ? (freshId.split("#")[1] || candidate) : null;
                if (freshName) {
                    const freshPath = directoryPath({ kind: "session", workspace: ctx.workspaceName, session: freshName });
                    if (freshPath !== null) {
                        location.assign(freshPath);
                        return "Session archived.";
                    }
                }
                location.assign("/");
                return "Session archived.";
            });
        });

        on(article, "submit", "form#session-unarchive", (event) => {
            event.preventDefault();
            void runMutation(async () => {
                const ctx = getContext();
                if (!ctx.sessionName) throw new Error("No active session selected.");
                await invoke("session/unarchive", {}, { requireSession: true });
                if (article.dataset.workspaceArchived === "true") {
                    await invoke("workspace.archive", { workspaceId: ctx.workspaceId, archived: false });
                }
                location.assign(directoryPath({ kind: "session", workspace: ctx.workspaceName, session: ctx.sessionName }) ?? "/search/");
                return "Session unarchived.";
            });
        });

        on(article, "submit", "[data-models-search-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const data = new FormData(form);
            modelsSearchQuery = String(data.get("q") ?? "").trim();
            modelsProviderFilter = String(data.get("provider") ?? "").trim();
            modelsOffset = 0;
            void refreshSection("models");
        });

        on(article, "input", '[data-models-search-form] input[name="q"]', (_event, input) => {
            if (!(input instanceof HTMLInputElement)) return;
            modelsSearchQuery = input.value.trim();
            modelsOffset = 0;
            void refreshSection("models");
        });

        on(article, "change", '[data-models-search-form] select[name="provider"]', (_event, select) => {
            if (!(select instanceof HTMLSelectElement)) return;
            modelsProviderFilter = select.value.trim();
            modelsOffset = 0;
            void refreshSection("models");
        });

        on(article, "click", "[data-models-prev]", () => {
            if (modelsOffset <= 0) return;
            modelsOffset = Math.max(0, modelsOffset - 100);
            void refreshSection("models");
        });

        on(article, "click", "[data-models-next]", () => {
            if (modelsNextOffset === undefined) return;
            modelsOffset = modelsNextOffset;
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

        on(article, "submit", "[data-model-catalog-row-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const submitter = event instanceof SubmitEvent && event.submitter instanceof HTMLButtonElement ? event.submitter : null;
            const operation = submitter?.value ?? "select";
            const selector = String(new FormData(form).get("selector") ?? "").trim();
            if (!selector) return;
            void runMutation(async () => {
                const callSession = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ params = {}) =>
                    invoke(kind, params, { requireSession: true });
                if (operation === "child") {
                    const { currentValue } = await sessionConfigOption(callSession, "spawn_model", selector);
                    await refreshSection("models");
                    return `Child model: ${currentValue || selector}.`;
                }
                const route = await sessionModel(callSession, selector);
                await refreshSection("models");
                return `Model: ${modelLabel(route)}${route?.effort ? ` (${route.effort})` : ""}.`;
            });
        });

        on(article, "submit", "form[data-session-title-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const rawTitle = String(new FormData(form).get("title") ?? "").trim();
            if (!rawTitle) return;
            void runMutation(async () => {
                await invoke("session/set_title", { title: rawTitle }, { requireSession: true });
                return `Title: ${rawTitle}.`;
            });
        });

        on(article, "click", "[data-session-fork]", () => {
            void runMutation(async () => {
                const forked = await invoke("session/fork", {}, { requireSession: true });
                const rawId = isRecord(forked) && typeof forked.sessionId === "string" ? forked.sessionId : "";
                const forkedName = rawId.includes("#") ? (rawId.split("#")[1] ?? "") : "";
                const ctx = getContext();
                if (forkedName) {
                    const dest = directoryPath({ kind: "session", workspace: ctx.workspaceName, session: forkedName });
                    if (dest !== null) {
                        location.assign(dest);
                        return `Forked #${forkedName}.`;
                    }
                }
                return "Session forked.";
            });
        });

        on(article, "submit", "[data-session-config-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            sessionModelCombobox?.close();
            sessionSpawnCombobox?.close();
            const data = new FormData(form);
            const selectedModel = String(data.get("model") ?? "").trim();
            const selectedEffort = String(data.get("effort") ?? "").trim();
            const selectedSpawn = String(data.get("spawnModel") ?? "inherit").trim() || "inherit";
            const selectedPersona = String(data.get("persona") ?? "none").trim() || "none";
            const selectedMode = String(data.get("mode") ?? "review").trim() || "review";
            void runMutation(async () => {
                const callSession = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ params = {}) =>
                    invoke(kind, params, { requireSession: true });
                /** @type {string[]} */
                const summaries = [];
                const modelChanged = Boolean(
                    selectedModel
                    && selectedModel !== "none"
                    && (selectedModel !== currentSessionValues.model || !hasPersistedSessionModel),
                );
                const effortChanged = Boolean(selectedEffort && selectedEffort !== currentSessionValues.effort);
                if (modelChanged) {
                    const route = await sessionModel(callSession, selectedModel, selectedEffort || undefined);
                    summaries.push(`Model: ${modelLabel(route)}${route?.effort ? ` (${route.effort})` : ""}`);
                } else if (effortChanged) {
                    const effRes = await sessionEffort(callSession, selectedEffort);
                    summaries.push(`Effort: ${effRes.effort ?? selectedEffort}`);
                }
                if (selectedSpawn !== currentSessionValues.spawnModel) {
                    const { currentValue } = await sessionConfigOption(callSession, "spawn_model", selectedSpawn);
                    summaries.push(`Child model: ${currentValue || selectedSpawn}`);
                }
                if (selectedPersona !== currentSessionValues.persona) {
                    const { currentValue } = await sessionConfigOption(callSession, "persona", selectedPersona);
                    summaries.push(`Persona: ${currentValue || selectedPersona}`);
                }
                if (selectedMode !== currentSessionValues.mode) {
                    const { currentValue } = await sessionConfigOption(callSession, "mode", selectedMode);
                    summaries.push(`Approval policy: ${currentValue || selectedMode}`);
                }
                await refreshSection("session");
                return summaries.length > 0 ? `${summaries.join(" · ")}.` : "Session settings saved.";
            });
        });

        on(article, "input", "[data-help-filter]", (_event, input) => {
            if (!(input instanceof HTMLInputElement)) return;
            helpFilterQuery = input.value;
            applyHelpFilter();
        });

        on(article, "click", "details[data-family-disclosure] > summary", (_event, summary) => {
            if (!busy) setFeedback(false, "", "");
            const details = summary.parentElement;
            if (details instanceof HTMLDetailsElement && details.dataset.familyDisclosure === "schedule" && !details.open) {
                prefillScheduleTarget();
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
            if (!isWorkspaceFamily(rawFamily)) return;
            const family = rawFamily;
            const submitter = event instanceof SubmitEvent && event.submitter instanceof HTMLButtonElement ? event.submitter : null;
            const operation = submitter?.value ?? "";
            const alias = String(new FormData(form).get("alias") ?? "").trim();
            if (!alias || !["enable", "disable", "remove", "oauth"].includes(operation)) return;
            void runMutation(async () => {
                if (operation === "oauth" && family === "mcp") {
                    let redirectUrl = "http://127.0.0.1/callback";
                    const listed = await invoke("workspace.mcp.list", {});
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
            if (!isWorkspaceFamily(rawFamily)) return;
            const family = rawFamily;
            const data = new FormData(form);
            /** @type {Record<string, unknown>} */
            const params = {};
            if (family === "mcp" || family === "members") {
                const query = String(data.get("query") ?? "").trim();
                if (query) params.query = query;
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
                collapseEnclosingDisclosure(form);
                return `${meta.alias}  active`;
            });
        });

        for (const spec of FAMILY_SAVE_SPECS) {
            on(article, "submit", spec.selector, (event, form) => {
                event.preventDefault();
                if (!(form instanceof HTMLFormElement) || busy) return;
                let built;
                try {
                    built = spec.build(form);
                } catch (error) {
                    setFeedback(false, error instanceof Error ? error.message : String(error), "");
                    return;
                }
                void runMutation(async () => {
                    await invoke(spec.action, built.payload);
                    const fresh = await invoke(`workspace.${spec.family}.list`, {});
                    renderFamilyList(spec.family, fresh);
                    spec.clear(form);
                    collapseEnclosingDisclosure(form);
                    return `${built.label}  saved`;
                });
            });
        }

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
                collapseEnclosingDisclosure(form);
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
            const targetSection = isSettingsSection(initialSection) ? initialSection : "workspace";
            selectSection(targetSection, false);
        },
        /** @param {SettingsSection} section @param {boolean} [pushHash] */
        selectSection(section, pushHash = false) {
            selectSection(section, pushHash);
        },
        /** @param {string} familyOrTopic */
        notifyChanged(familyOrTopic) {
            if (busy || activeSection === "help" || activeSection === "about") return;
            if (
                familyOrTopic === "resync"
                || familyOrTopic === activeSection
                || (familyOrTopic === "policy" && (activeSection === "session" || activeSection === "models"))
                || (familyOrTopic === "personas" && (activeSection === "session" || activeSection === "schedule"))
                || (familyOrTopic === "mcp" && activeSection === "schedule")
            ) {
                void refreshSection(activeSection);
            }
        },
    };
}

/** @param {string} hash @returns {SettingsSection} */
function parseSettingsHash(hash) {
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    try {
        const decoded = decodeURIComponent(raw);
        return isSettingsSection(decoded) ? decoded : "workspace";
    } catch {
        return "workspace";
    }
}

/**
 * {§web-workspace-settings} Dedicated `/settings/?workspace=<name>` page entrypoint loaded over `/acp`.
 * @param {HTMLElement} main
 */
export default async function observeWorkspaceSettings(main) {
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
    const preseededWorkspaceId = main.dataset.workspaceId ?? "";
    const isPreseededFixture = /^[1-9]\d*$/u.test(preseededWorkspaceId) && main.dataset.live !== "true";

    let workspaceId = isPreseededFixture ? Number(preseededWorkspaceId) : 0;
    let currentWorkspaceName = queryParams.get("workspace") ?? main.dataset.workspaceName ?? "";
    let sessionName = queryParams.get("session") || main.dataset.sessionName || null;
    /** @type {Set<string>} */
    const knownWorkspaceNames = new Set(currentWorkspaceName ? [currentWorkspaceName] : []);
    /** @type {Set<string>} */
    const knownSessionNames = new Set(sessionName ? [sessionName] : []);

    wireWorkspaceCreateDialog({
        signal: pageLifetime.signal,
        getKnownWorkspaceNames: () => knownWorkspaceNames,
    });

    const sessionDialog = $("#dialog-session-create");
    if (sessionDialog instanceof HTMLElement) {
        let newSessionBusy = false;
        on(sessionDialog, "submit", "form#session-create", (event, form) => {
            if (!(form instanceof HTMLFormElement) || !currentWorkspaceName) return;
            event.preventDefault();
            if (newSessionBusy) return;
            newSessionBusy = true;
            the(sessionDialog, "session-create-error", "");
            const data = new FormData(form);
            const rawName = String(data.get("name") ?? "").trim();
            const rawTitle = String(data.get("title") ?? "").trim();
            void (async () => {
                try {
                    /** @type {unknown} */
                    let created;
                    if (rawName) {
                        const existingSessions = await managementAction("workspace.sessions", {
                            workspace: currentWorkspaceName,
                            includeArchived: true,
                        }, "", pageLifetime.signal, { workspace: currentWorkspaceName });
                        const rows = isRecord(existingSessions) && Array.isArray(existingSessions.sessions) ? existingSessions.sessions : [];
                        if (rows.some((row) => isRecord(row) && row.name === rawName)) {
                            throw Object.assign(new Error(`Session '${rawName}' is already in use in workspace '${currentWorkspaceName}'.`), { status: 409 });
                        }
                        created = await managementAction("session/new", {
                            _meta: { plurnk: { workspace: currentWorkspaceName, sessionName: rawName } },
                        }, "", pageLifetime.signal);
                    } else {
                        const seen = new Set(knownSessionNames);
                        for (let attempt = 0; attempt < 8; attempt += 1) {
                            const candidate = nextSequentialName("session", seen);
                            try {
                                created = await managementAction("session/new", {
                                    _meta: { plurnk: { workspace: currentWorkspaceName, sessionName: candidate } },
                                }, "", pageLifetime.signal);
                                break;
                            } catch (error) {
                                if (Reflect.get(Object(error), "status") === 409 && attempt < 7) {
                                    seen.add(candidate);
                                    continue;
                                }
                                throw error;
                            }
                        }
                    }
                    const rawSessionId = isRecord(created) && typeof created.sessionId === "string" ? created.sessionId : "";
                    const freshName = rawSessionId.includes("#") ? (rawSessionId.split("#")[1] ?? "") : rawName;
                    if (freshName && rawTitle && workspaceId > 0) {
                        await managementAction("session/set_title", { title: rawTitle }, `${workspaceId}#${freshName}`, pageLifetime.signal);
                    }
                    if (sessionDialog instanceof HTMLDialogElement && sessionDialog.open) sessionDialog.close();
                    const dest = freshName
                        ? directoryPath({ kind: "session", workspace: currentWorkspaceName, session: freshName })
                        : directoryPath({ kind: "workspace", workspace: currentWorkspaceName });
                    location.assign(dest ?? "/");
                } catch (error) {
                    const { message, recovery } = await describeFailure(error);
                    the(sessionDialog, "session-create-error", [message, recovery].filter(Boolean).join(" "));
                } finally {
                    newSessionBusy = false;
                }
            })();
        });
    }

    if (!isPreseededFixture) {
        if (currentWorkspaceName !== "" && directoryPath({ kind: "workspace", workspace: currentWorkspaceName }) === null) {
            renderInPageError(main, 404, "Workspace not found.");
            return;
        }
        try {
            const listedWorkspaces = parseWorkspaceList(
                await managementAction("workspace.list", { includeArchived: true }, "", pageLifetime.signal),
            );
            if (pageLifetime.signal.aborted) return;
            for (const ws of listedWorkspaces) knownWorkspaceNames.add(ws.name);

            const matchedWorkspace = currentWorkspaceName !== ""
                ? listedWorkspaces.find(({ name }) => name === currentWorkspaceName)
                : (listedWorkspaces.find(({ archived_at }) => archived_at === null) ?? listedWorkspaces[0]);

            if (!matchedWorkspace) {
                const initialSec = parseSettingsHash(location.hash);
                if (currentWorkspaceName !== "" || (initialSec !== "about" && initialSec !== "help")) {
                    renderInPageError(main, 404, "Workspace not found.");
                    return;
                }
            } else {
                workspaceId = matchedWorkspace.id;
                currentWorkspaceName = matchedWorkspace.name;
                main.dataset.workspaceId = String(workspaceId);
                main.dataset.workspaceName = currentWorkspaceName;
                main.dataset.live = "true";

                const wsArchived = matchedWorkspace.archived_at !== null;
                if (wsArchived) article.dataset.workspaceArchived = "true";
                else delete article.dataset.workspaceArchived;

                const effectiveProject = matchedWorkspace.project_label ?? matchedWorkspace.project_root;
                const iconGlyph = effectiveProject !== null ? "🗂️" : "☁️";
                const iconLabel = effectiveProject !== null ? "Project workspace" : "Folderless workspace";

                const sessionsRes = await managementAction("workspace.sessions", {
                    workspaceId,
                    includeArchived: true,
                }, "", pageLifetime.signal, { workspaceId }).catch(() => null);
                if (pageLifetime.signal.aborted) return;

                const rawRows = isRecord(sessionsRes) && Array.isArray(sessionsRes.sessions) ? sessionsRes.sessions : [];
                /** @type {Map<number, Record<string, unknown>>} */
                const rowById = new Map();
                for (const row of rawRows) {
                    if (isRecord(row) && typeof row.id === "number") {
                        rowById.set(row.id, row);
                        if (typeof row.name === "string") knownSessionNames.add(row.name);
                    }
                }
                const activeRow = sessionName
                    ? (rawRows.find((r) => isRecord(r) && r.name === sessionName && r.origin === "model") ?? null)
                    : null;
                if (!activeRow) sessionName = null;
                main.dataset.sessionName = sessionName ?? "";

                the("page-title", `${currentWorkspaceName} · Settings — Plurnk`);
                const backLink = $("[data-settings-back]");
                const backPath = sessionName !== null
                    ? directoryPath({ kind: "session", workspace: currentWorkspaceName, session: sessionName })
                    : directoryPath({ kind: "workspace", workspace: currentWorkspaceName });
                if (backLink && backPath !== null) {
                    the(backLink, {
                        "workspace-name": currentWorkspaceName,
                        "workspace-back-path": backPath,
                        "workspace-icon": iconGlyph,
                        "workspace-icon-label": iconLabel,
                    });
                }

                const folderLine = $(article, "[data-settings-folder]");
                if (folderLine instanceof HTMLElement) {
                    if (matchedWorkspace.project_label !== null) {
                        folderLine.hidden = false;
                        the(folderLine, "project-label", matchedWorkspace.project_label);
                    } else {
                        folderLine.hidden = true;
                    }
                }

                const renameInput = $(article, 'form#workspace-rename input[name="name"]');
                if (renameInput instanceof HTMLInputElement) renameInput.value = currentWorkspaceName;
                const wsArchBtn = $(article, "[data-workspace-archive-btn]");
                const wsUnarchBtn = $(article, "[data-workspace-unarchive-btn]");
                if (wsArchBtn instanceof HTMLElement) wsArchBtn.hidden = wsArchived;
                if (wsUnarchBtn instanceof HTMLElement) wsUnarchBtn.hidden = !wsArchived;
                const addSessionBtn = $(article, "[data-settings-add-session]");
                if (addSessionBtn instanceof HTMLElement) addSessionBtn.hidden = wsArchived;

                for (const input of $$('input[name="workspace"]')) {
                    if (input instanceof HTMLInputElement && input.type === "hidden") {
                        input.value = currentWorkspaceName;
                    }
                }
                for (const input of $$('input[name="session"]')) {
                    if (input instanceof HTMLInputElement && input.type === "hidden") {
                        input.value = sessionName ?? "";
                    }
                }

                const headingHandle = $(article, "[data-session-heading-handle]");
                const parentLine = $(article, "[data-session-parent-line]");
                const parentSlot = $(article, "[data-session-parent-slot]");
                const titleForm = $(article, "form#session-title");
                const noSessionNote = $(article, "[data-no-active-session]");
                if (isRecord(activeRow) && sessionName !== null) {
                    if (headingHandle instanceof HTMLElement) {
                        headingHandle.hidden = false;
                        the(headingHandle, "session-heading-code", `#${sessionName}`);
                    }
                    if (noSessionNote instanceof HTMLElement) noSessionNote.hidden = true;
                    if (titleForm instanceof HTMLFormElement) {
                        titleForm.hidden = false;
                        const titleInput = $(titleForm, 'input[name="title"]');
                        if (titleInput instanceof HTMLInputElement) {
                            titleInput.value = typeof activeRow.title === "string" ? activeRow.title : "";
                        }
                        const sessArchived = activeRow.archived_at !== null && activeRow.archived_at !== undefined;
                        const sessArchBtn = $(titleForm, "[data-session-archive-btn]");
                        const sessUnarchBtn = $(titleForm, "[data-session-unarchive-btn]");
                        if (sessArchBtn instanceof HTMLElement) sessArchBtn.hidden = sessArchived;
                        if (sessUnarchBtn instanceof HTMLElement) sessUnarchBtn.hidden = !sessArchived;
                    }
                    const parentId = typeof activeRow.parentSessionId === "number" ? activeRow.parentSessionId : null;
                    const parentRow = parentId !== null ? rowById.get(parentId) : undefined;
                    if (parentLine instanceof HTMLElement && parentSlot instanceof HTMLElement && isRecord(parentRow) && typeof parentRow.name === "string") {
                        parentLine.hidden = false;
                        parentSlot.replaceChildren();
                        const parentHref = parentRow.origin === "model"
                            ? directoryPath({ kind: "session", workspace: currentWorkspaceName, session: parentRow.name })
                            : null;
                        if (parentHref !== null) {
                            const cloned = $.clone(parentSlot, "#session-parent-link");
                            const link = $(cloned, "a");
                            if (link instanceof HTMLAnchorElement) {
                                link.href = parentHref;
                                link.textContent = parentRow.name;
                                parentSlot.replaceChildren(link);
                            }
                        } else {
                            parentSlot.textContent = parentRow.name;
                        }
                    } else if (parentLine instanceof HTMLElement) {
                        parentLine.hidden = true;
                    }
                } else {
                    if (headingHandle instanceof HTMLElement) headingHandle.hidden = true;
                    if (parentLine instanceof HTMLElement) parentLine.hidden = true;
                    if (titleForm instanceof HTMLElement) titleForm.hidden = true;
                    if (noSessionNote instanceof HTMLElement) noSessionNote.hidden = false;
                }
            }
        } catch (error) {
            if (pageLifetime.signal.aborted || Reflect.get(Object(error), "status") === 401) return;
            const status = typeof Reflect.get(Object(error), "status") === "number"
                ? /** @type {number} */ (Reflect.get(Object(error), "status"))
                : 502;
            const { message, recovery } = await describeFailure(error);
            renderInPageError(main, status, message, recovery);
            return;
        }
    }

    const controller = createWorkspaceSettingsController(article, () => ({
        workspaceId,
        workspaceName: currentWorkspaceName,
        sessionName,
        signal: pageLifetime.signal,
    }), {
        updateHash: true,
        initialQuery: queryParams.get("q") ?? "",
        initialHelpFilter: queryParams.get("cmd") ?? "",
        initialEnvScope: queryParams.get("envScope") === "session" ? "session" : "workspace",
    });

    controller.selectSection(parseSettingsHash(location.hash), false);

    on.target(window, "hashchange", () => {
        controller.selectSection(parseSettingsHash(location.hash), false);
    });

    if (isPreseededFixture || workspaceId <= 0) return;

    const notifications = subscribeWorkspaceNotifications({
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
    on.target(pageLifetime.signal, "abort", () => {
        notifications.unsubscribe();
    });
}
