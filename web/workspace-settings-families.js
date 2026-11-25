import { $, $$, on, the } from "on_the_money";
import { EFFORTS } from "@plurnk/plurnk-contracts";
import { attachModelCombobox } from "./combobox.js";
import { populateStaticEffortSelect } from "./effort-select.js";
import { populateEnvPanel } from "./env-panel.js";
import { isRecord } from "./session-translator.js";
import {
    mountCandidatePager,
    mountCollectionBar,
    mountMembersLivePreview,
} from "./workspace-collection.js";

/** @typedef {"mcp" | "skills" | "schedule" | "personas" | "members"} WorkspaceFamily */
/** @typedef {WorkspaceFamily | "env"} BrowsableFamily */
/** @typedef {"mcp" | "skills" | "personas" | "env"} DiscoverableFamily */
/** @typedef {import("./workspace-dialogs.js").WorkspaceSettingsContext} WorkspaceSettingsContext */
/** @typedef {ReturnType<typeof import("./session-models.js").createModelSearchCache>} ModelSearchCache */

const FAMILIES = /** @type {const} */ (["mcp", "skills", "schedule", "personas", "members"]);
const DISCOVERABLE_FAMILIES = /** @type {const} */ (["mcp", "skills", "personas", "env"]);
const COLLECTION_LABELS = /** @type {Readonly<Record<BrowsableFamily, string>>} */ ({
    mcp: "MCP servers",
    skills: "skills",
    schedule: "schedules",
    personas: "personas",
    members: "member rules",
    env: "environment variables",
});

/** @param {unknown} value @returns {value is WorkspaceFamily} */
export const isWorkspaceFamily = (value) =>
    typeof value === "string" && /** @type {readonly string[]} */ (FAMILIES).includes(value);

/** @param {unknown} value @returns {value is DiscoverableFamily} */
const isDiscoverableFamily = (value) =>
    typeof value === "string" && /** @type {readonly string[]} */ (DISCOVERABLE_FAMILIES).includes(value);

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
 * {§web-workspace-settings} Table-driven Functionality save contracts across workspace families.
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
 * {§web-workspace-settings} Mount table-driven `#mcp`, `#skills`, `#personas`, `#members`, and `#env` panels.
 * @param {HTMLElement} article
 * @param {{
 *   readonly getContext: () => WorkspaceSettingsContext,
 *   readonly invoke: (kind: string, params?: Record<string, unknown>, opts?: { requireSession?: boolean, signal?: AbortSignal }) => Promise<unknown>,
 *   readonly runMutation: (work: (signal: AbortSignal) => Promise<string>) => Promise<void>,
 *   readonly setFeedback: (busy: boolean, message?: string, recovery?: string) => void,
 *   readonly isBusy: () => boolean,
 *   readonly modelSearchCache: ModelSearchCache,
 *   readonly envPanel: Element | null,
 *   readonly initialEnvScope?: "workspace" | "session",
 *   readonly onRenderScheduleList: (res: unknown) => void,
 *   readonly onRefreshSection: (section: WorkspaceFamily) => Promise<void>,
 *   readonly onRefreshEnv: () => Promise<void>,
 * }} host
 */
export function mountFamilyAndEnvSections(article, {
    getContext,
    invoke,
    runMutation,
    setFeedback,
    isBusy,
    modelSearchCache,
    envPanel,
    initialEnvScope = "workspace",
    onRenderScheduleList,
    onRefreshSection,
    onRefreshEnv,
}) {
    /** @type {"workspace" | "session"} */
    let envListScope = initialEnvScope === "session" ? "session" : "workspace";
    /** @type {WeakMap<Element, { family: DiscoverableFamily, alias: string, definition: Record<string, unknown> }>} */
    const candidateData = new WeakMap();
    /** @type {Map<BrowsableFamily, AbortController>} */
    const listLookups = new Map();
    /** @type {Map<BrowsableFamily, ReturnType<typeof mountCollectionBar>>} */
    const collectionBars = new Map();
    /** @type {Map<DiscoverableFamily, ReturnType<typeof mountCandidatePager>>} */
    const candidatePagers = new Map();

    const personaEffortEl = $(article, '[data-personas-save-form] select[name="effort"]');
    populateStaticEffortSelect(personaEffortEl instanceof HTMLSelectElement ? personaEffortEl : null, EFFORTS);

    const personaModelBox = $(article, '[data-personas-save-form] [data-model-combobox="personaModel"]');
    const personaModelCombobox = personaModelBox instanceof HTMLElement
        ? attachModelCombobox(personaModelBox, {
            getCache: () => modelSearchCache,
            signal: getContext().signal,
        })
        : null;

    const membersSaveForm = $(article, "form[data-members-save-form]");
    const membersPreview = membersSaveForm instanceof HTMLFormElement
        ? mountMembersLivePreview(membersSaveForm, {
            invokeWithSignal: (kind, params, signal) => invoke(kind, params, { signal }),
            signal: getContext().signal,
        })
        : null;

    for (const family of [...FAMILIES, /** @type {const} */ ("env")]) {
        const panel = $(article, `[data-settings-panel="${family}"]`);
        if (panel instanceof HTMLElement) {
            collectionBars.set(family, mountCollectionBar(panel, {
                label: COLLECTION_LABELS[family],
                onChange: () => {
                    if (family === "env") void onRefreshEnv();
                    else void onRefreshSection(family);
                },
                signal: getContext().signal,
            }));
        }
    }

    /**
     * @param {DiscoverableFamily} family
     * @param {Record<string, unknown>} params
     */
    async function runDiscovery(family, params) {
        const action = family === "env" ? `${envListScope}.env.discover` : `workspace.${family}.discover`;
        const res = await invoke(action, params, {
            requireSession: family === "env" && envListScope === "session",
        });
        renderCandidates(family, res);
        candidatePagers.get(family)?.applyResult(res);
        const count = isRecord(res) && Array.isArray(res.candidates) ? res.candidates.length : 0;
        return count === 0 ? `${family} discover: none` : `Found ${count} ${count === 1 ? "result" : "results"}.`;
    }

    for (const family of DISCOVERABLE_FAMILIES) {
        const panel = $(article, `[data-settings-panel="${family}"]`);
        if (panel instanceof HTMLElement) {
            candidatePagers.set(family, mountCandidatePager(panel, {
                onPageChange: (params) => {
                    void runMutation(() => runDiscovery(family, params));
                },
            }));
        }
    }

    /**
     * @param {WorkspaceFamily} family
     * @param {unknown} res
     */
    function renderFamilyList(family, res) {
        if (family === "schedule") {
            onRenderScheduleList(res);
            return;
        }
        const panel = $(article, `[data-settings-panel="${family}"]`);
        const tbody = panel ? $(panel, "[data-family-rows]") : null;
        if (!panel || !tbody) return;
        const rawItems = isRecord(res) && Array.isArray(res.definitions) ? res.definitions : [];
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
     * @param {DiscoverableFamily} family
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
            const addable = alias.length > 0 && def !== null;
            the(li, {
                "candidate-alias": alias || family,
                "candidate-summary": summary,
                "candidate-addable": addable ? "true" : "false",
            });
            const form = $(li, "form[data-candidate-add-form]");
            if (addable && form && def) {
                candidateData.set(form, {
                    family,
                    alias,
                    definition: def,
                });
            }
        });
        the(panel, { "candidate-count": candidates.length });
    }

    /** @param {WorkspaceFamily} family */
    async function loadFamilySection(family) {
        const ctx = getContext();
        listLookups.get(family)?.abort();
        const req = new AbortController();
        listLookups.set(family, req);
        const bar = collectionBars.get(family);
        try {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const params = bar ? bar.getParams() : {};
                const res = await invoke(`workspace.${family}.list`, params, { signal: req.signal });
                if (req.signal.aborted || ctx.signal.aborted) return;
                const applied = bar ? bar.applyResult(res) : { clamped: false };
                if (applied.clamped && attempt === 0) continue;
                renderFamilyList(family, res);
                return;
            }
        } catch (error) {
            if (req.signal.aborted && !ctx.signal.aborted) return;
            throw error;
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

    async function loadEnvSection() {
        syncEnvScopeControls();
        const ctx = getContext();
        listLookups.get("env")?.abort();
        const req = new AbortController();
        listLookups.set("env", req);
        const bar = collectionBars.get("env");
        try {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const params = bar ? bar.getParams() : {};
                const res = await invoke(`${envListScope}.env.list`, params, {
                    requireSession: envListScope === "session",
                    signal: req.signal,
                });
                if (req.signal.aborted || ctx.signal.aborted) return;
                const applied = bar ? bar.applyResult(res) : { clamped: false };
                if (applied.clamped && attempt === 0) continue;
                if (envPanel) populateEnvPanel(envPanel, res, envListScope);
                return;
            }
        } catch (error) {
            if (req.signal.aborted && !ctx.signal.aborted) return;
            throw error;
        }
    }

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
        collectionBars.get("env")?.resetOffset();
        syncEnvScopeControls();
        void onRefreshEnv();
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
                await loadFamilySection("mcp");
                return `${alias}  active`;
            }
            await invoke(`workspace.${family}.${operation}`, family === "members" ? { file: alias } : { alias });
            await loadFamilySection(family);
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
            await loadFamilySection("mcp");
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
        if (!isDiscoverableFamily(rawFamily)) return;
        const family = rawFamily;
        const data = new FormData(form);
        /** @type {Record<string, unknown>} */
        const baseParams = {};
        if (family === "mcp" || family === "env") {
            const query = String(data.get("query") ?? "").trim();
            if (query) baseParams.query = query;
        } else {
            const source = String(data.get("source") ?? "").trim();
            const query = String(data.get("query") ?? "").trim();
            if (source) baseParams.source = source;
            if (query) baseParams.query = query;
        }
        const pager = candidatePagers.get(family);
        const params = pager ? pager.startSearch(baseParams) : baseParams;
        void runMutation(() => runDiscovery(family, params));
    });

    on(article, "submit", "[data-candidate-add-form]", (event, form) => {
        event.preventDefault();
        if (!(form instanceof HTMLFormElement)) return;
        const meta = candidateData.get(form);
        if (!meta) return;
        if (meta.family === "env") {
            const envForm = $(article, "form[data-env-set-form]");
            const aliasInput = envForm ? $(envForm, 'input[name="alias"]') : null;
            const valueInput = envForm ? $(envForm, 'input[name="value"]') : null;
            if (aliasInput instanceof HTMLInputElement) {
                aliasInput.value = meta.alias;
                aliasInput.setCustomValidity("");
            }
            if (valueInput instanceof HTMLInputElement) {
                const defaultVal = typeof meta.definition.value === "string" ? meta.definition.value : "";
                valueInput.value = defaultVal;
                valueInput.focus();
            }
            setFeedback(false, `Filled ${meta.alias}; enter a value and click Set.`, "");
            return;
        }
        const targetFamily = meta.family;
        void runMutation(async () => {
            /** @type {Record<string, unknown>} */
            const payload = { alias: meta.alias, ...meta.definition };
            if (targetFamily === "skills") delete payload.commit;
            await invoke(`workspace.${targetFamily}.replace`, payload);
            await loadFamilySection(targetFamily);
            collapseEnclosingDisclosure(form);
            return `${meta.alias}  active`;
        });
    });

    for (const spec of FAMILY_SAVE_SPECS) {
        on(article, "submit", spec.selector, (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement) || isBusy()) return;
            let built;
            try {
                built = spec.build(form);
            } catch (error) {
                setFeedback(false, error instanceof Error ? error.message : String(error), "");
                return;
            }
            void runMutation(async () => {
                await invoke(spec.action, built.payload);
                await loadFamilySection(spec.family);
                spec.clear(form);
                if (spec.family === "members") membersPreview?.clear();
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
            await loadEnvSection();
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
            await loadEnvSection();
            aliasInput.value = "";
            valueInput.value = "";
            collapseEnclosingDisclosure(form);
            return `${alias}  active`;
        });
    });

    on(article, "input", '[data-env-set-form] input[name="alias"]', (_event, target) => {
        if (target instanceof HTMLInputElement) target.setCustomValidity("");
    });

    /**
     * {§web-workspace-settings} Adapt `#mcp`, `#skills`, and `#personas` creation/discovery forms to daemon policy.
     * @param {import("./endpoints.js").DaemonPolicy | null} policy
     */
    function applyDaemonPolicy(policy) {
        const projectRootMode = policy?.projectRoot ?? "unrestricted";
        const hasProjectRoot = getContext().hasProjectRoot;
        const localUsable = projectRootMode !== "none" && !(projectRootMode === "confined" && hasProjectRoot === false);

        // 1. MCP transport allowlist & publicOnly posture
        const mcpDisclosure = $(article, 'details[data-family-disclosure="mcp"]');
        const mcpForm = $(article, "form[data-mcp-save-form]");
        const transportSelect = mcpForm ? $(mcpForm, 'select[name="transport"]') : null;
        const mcpHttpNote = $(article, '[data-policy-note="mcp-http"]');
        const allowedTransports = policy?.mcp ? policy.mcp.workspaceTransports : /** @type {const} */ (["stdio", "streamable-http"]);
        if (allowedTransports.length === 0) {
            if (mcpDisclosure instanceof HTMLDetailsElement) {
                mcpDisclosure.hidden = true;
                mcpDisclosure.open = false;
            }
        } else {
            if (mcpDisclosure instanceof HTMLDetailsElement) mcpDisclosure.hidden = false;
            if (transportSelect instanceof HTMLSelectElement) {
                for (const opt of transportSelect.options) {
                    const admitted = /** @type {readonly string[]} */ (allowedTransports).includes(opt.value);
                    opt.hidden = !admitted;
                    opt.disabled = !admitted;
                }
                if (!/** @type {readonly string[]} */ (allowedTransports).includes(transportSelect.value)) {
                    transportSelect.value = allowedTransports[0];
                }
                if (mcpForm instanceof HTMLFormElement) {
                    mcpForm.dataset.mcpTransport = transportSelect.value;
                }
            }
        }
        if (mcpHttpNote instanceof HTMLElement) {
            const publicOnly = policy?.mcp?.publicOnly === true;
            mcpHttpNote.hidden = !publicOnly;
            mcpHttpNote.textContent = publicOnly
                ? "Public HTTP(S) endpoints only (private and loopback addresses are refused)."
                : "";
        }

        // 2. Skills source allowlist, publicOnly posture, and projectRoot local containment
        const admittedSources = policy?.skills ? policy.skills.workspaceSources : /** @type {const} */ (["mcp", "git", "local"]);
        const usableSources = admittedSources.filter((kind) => kind !== "local" || localUsable);
        const skillsDisclosure = $(article, 'details[data-family-disclosure="skills"]');
        const skillsNote = $(article, '[data-policy-note="skills"]');
        const skillsDiscoverSource = $(article, '[data-family-discover-form][data-family="skills"] input[name="source"]');
        const skillsSaveSource = $(article, '[data-skills-save-form] input[name="source"]');
        const skillsSaveRef = $(article, '[data-skills-save-form] input[name="ref"]');
        if (usableSources.length === 0) {
            if (skillsDisclosure instanceof HTMLDetailsElement) {
                skillsDisclosure.hidden = true;
                skillsDisclosure.open = false;
            }
        } else {
            if (skillsDisclosure instanceof HTMLDetailsElement) skillsDisclosure.hidden = false;
            const allowGit = usableSources.includes("git");
            const allowLocal = usableSources.includes("local");
            const allowMcp = usableSources.includes("mcp");
            const publicOnly = policy?.skills?.publicOnly === true;
            if (skillsSaveRef instanceof HTMLInputElement) {
                skillsSaveRef.hidden = !allowGit;
                if (!allowGit) skillsSaveRef.value = "";
            }
            const defaultUnrestricted = allowGit && allowLocal && allowMcp && projectRootMode === "unrestricted" && !publicOnly;
            if (skillsDiscoverSource instanceof HTMLInputElement) {
                if (defaultUnrestricted) {
                    skillsDiscoverSource.placeholder = "Git URL, folder, archive, or server:///skills";
                } else {
                    const parts = [
                        ...(allowGit ? [publicOnly ? "https://git.example/skills.git" : "Git URL"] : []),
                        ...(allowLocal ? [projectRootMode === "confined" ? "./skills/my-skill" : "folder or archive"] : []),
                        ...(allowMcp ? ["server:///skills"] : []),
                    ];
                    skillsDiscoverSource.placeholder = parts.join(" or ");
                }
            }
            if (skillsSaveSource instanceof HTMLInputElement) {
                if (defaultUnrestricted) {
                    skillsSaveSource.placeholder = "https://git.example/skills.git or /path/to/skill";
                } else {
                    const parts = [
                        ...(allowGit ? ["https://git.example/skills.git"] : []),
                        ...(allowLocal ? [projectRootMode === "confined" ? "./skills/my-skill" : "/path/to/skill"] : []),
                        ...(allowMcp ? ["server:///skills"] : []),
                    ];
                    skillsSaveSource.placeholder = parts.join(" or ");
                }
            }
            if (skillsNote instanceof HTMLElement) {
                /** @type {string[]} */
                const notes = [];
                if (allowGit && publicOnly) {
                    notes.push("Public HTTPS Git sources only.");
                }
                if (allowLocal && projectRootMode === "confined") {
                    notes.push("Local paths must stay inside this workspace's project folder (archives disabled).");
                } else if (!allowLocal && admittedSources.includes("local")) {
                    notes.push("Local filesystem skill sources are unavailable for this workspace.");
                }
                if (policy?.skills && usableSources.length < 3) {
                    notes.push(`Allowed skill sources: ${usableSources.join(", ")}.`);
                }
                skillsNote.hidden = notes.length === 0;
                skillsNote.textContent = notes.join(" ");
            }
        }

        // 3. Personas local file-path mode driven by projectRoot confinement
        const personaForm = $(article, "form[data-personas-save-form]");
        const personaModeSelect = personaForm ? $(personaForm, 'select[name="personaMode"]') : null;
        const personaSourceOpt = personaModeSelect ? $(personaModeSelect, 'option[value="source"]') : null;
        const personaDiscoverSource = $(article, '[data-family-discover-form][data-family="personas"] input[name="source"]');
        const personaSourceNote = $(article, '[data-policy-note="personas-source"]');
        if (!localUsable) {
            if (personaSourceOpt instanceof HTMLOptionElement) {
                personaSourceOpt.hidden = true;
                personaSourceOpt.disabled = true;
            }
            if (personaModeSelect instanceof HTMLSelectElement) personaModeSelect.value = "inline";
            if (personaForm instanceof HTMLFormElement) personaForm.dataset.personaMode = "inline";
            if (personaDiscoverSource instanceof HTMLInputElement) {
                personaDiscoverSource.hidden = true;
                personaDiscoverSource.value = "";
            }
            if (personaSourceNote instanceof HTMLElement) {
                personaSourceNote.hidden = true;
                personaSourceNote.textContent = "";
            }
        } else {
            if (personaSourceOpt instanceof HTMLOptionElement) {
                personaSourceOpt.hidden = false;
                personaSourceOpt.disabled = false;
            }
            if (personaDiscoverSource instanceof HTMLInputElement) {
                personaDiscoverSource.hidden = false;
                personaDiscoverSource.placeholder = projectRootMode === "confined"
                    ? "Project-relative folder or file (optional)"
                    : "Directory or file path (optional)";
            }
            if (personaSourceNote instanceof HTMLElement) {
                const confined = projectRootMode === "confined";
                personaSourceNote.hidden = !confined;
                personaSourceNote.textContent = confined
                    ? "Path must stay inside this workspace's project folder."
                    : "";
            }
        }
    }

    return {
        applyDaemonPolicy,
        renderFamilyList,
        loadFamilySection,
        loadEnvSection,
        dispose() {
            personaModelCombobox?.dispose();
            membersPreview?.dispose();
            for (const controller of listLookups.values()) controller.abort();
            listLookups.clear();
            for (const bar of collectionBars.values()) bar.dispose();
        },
    };
}
