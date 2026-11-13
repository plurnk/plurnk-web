import { $, $$, on, the } from "on_the_money";
import { EFFORTS, isRecord, Validator } from "@plurnk/plurnk-contracts";
import describeFailure from "./failure.js";
import { populateEnvPanel } from "./env-panel.js";
import managementAction from "./management-action.js";

/**
 * @typedef {"capabilities" | "mcp" | "skills" | "schedule" | "personas" | "env"} SettingsSection
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

const SECTIONS = /** @type {const} */ (["capabilities", "mcp", "skills", "schedule", "personas", "env"]);
const FAMILIES = /** @type {const} */ (["mcp", "skills", "schedule", "personas"]);
const CAPABILITY_BUCKETS = /** @type {const} */ (["allow", "only", "deny"]);

/** @param {unknown} value @returns {value is SettingsSection} */
export const isSettingsSection = (value) =>
    typeof value === "string" && /** @type {readonly string[]} */ (SECTIONS).includes(value);

/**
 * @param {Record<string, unknown>} selector
 * @returns {string}
 */
function formatSelectorSummary(selector) {
    return Object.entries(selector)
        .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : String(value)}`)
        .join(" · ");
}

/**
 * @param {"mcp" | "skills" | "schedule" | "personas"} family
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
            const rule = typeof def.rule === "string" ? def.rule : "";
            const prompt = typeof def.prompt === "string" ? def.prompt : "";
            return [target, rule, prompt].filter((part) => part.length > 0).join(" · ");
        }
        return provSource;
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
 * {§web-workspace-settings} Creates a lazy modal controller for workspace subsystem management.
 * @param {() => WorkspaceSettingsContext} getContext
 */
export function createWorkspaceSettingsController(getContext) {
    /** @type {HTMLDialogElement | null} */
    let dialog = null;
    /** @type {HTMLElement | null} */
    let article = null;
    /** @type {Element | null} */
    let envPanel = null;
    /** @type {SettingsSection} */
    let activeSection = "capabilities";
    /** @type {"workspace" | "session"} */
    let envListScope = "workspace";
    let busy = false;
    /** @type {import("@plurnk/plurnk-contracts").CapabilityPolicy} */
    let currentWorkspacePolicy = {};
    /** @type {WeakMap<Element, { family: "mcp" | "skills" | "personas", alias: string, definition: Record<string, unknown> }>} */
    const candidateData = new WeakMap();

    /** @param {boolean} nextBusy @param {string} [message] @param {string} [recovery] */
    function setFeedback(nextBusy, message = "", recovery = "") {
        busy = nextBusy;
        if (!article) return;
        the(article, {
            wsSettingsBusy: nextBusy ? "true" : null,
            wsSettingsMessage: message,
            wsSettingsRecovery: recovery,
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

    /** @param {import("@plurnk/plurnk-contracts").CapabilityProjection} result */
    function renderCapabilities(result) {
        if (!dialog) return;
        const panel = $(dialog, '[data-settings-panel="capabilities"]');
        const tbody = panel ? $(panel, "[data-cap-rows]") : null;
        if (!panel || !tbody) return;
        for (const layer of /** @type {const} */ (["service", "workspace", "effective"])) {
            Validator.assertCapabilityPolicy(Reflect.get(Object(result), layer));
            const code = $(panel, `[data-ws-capability="${layer}"]`);
            if (code) code.textContent = JSON.stringify(result[layer], null, 2);
        }
        currentWorkspacePolicy = result.workspace;
        const presetSelect = $(panel, '[data-cap-preset-form] select[name="preset"]');
        if (presetSelect instanceof HTMLSelectElement) {
            presetSelect.value = Array.isArray(currentWorkspacePolicy.deny) && currentWorkspacePolicy.deny.length > 0
                ? "deny"
                : Array.isArray(currentWorkspacePolicy.allow) && currentWorkspacePolicy.allow.length > 0
                    ? "allow"
                    : "propose";
        }
        /** @type {{ bucket: "allow" | "only" | "deny", index: number, summary: string }[]} */
        const rows = [];
        for (const bucket of CAPABILITY_BUCKETS) {
            const list = currentWorkspacePolicy[bucket];
            if (!Array.isArray(list)) continue;
            for (const [index, selector] of list.entries()) {
                if (!isRecord(selector)) continue;
                rows.push({ bucket, index, summary: formatSelectorSummary(selector) });
            }
        }
        $.cloneEach(tbody, "#workspace-cap-rule-row", rows, (tr, row) => {
            the(tr, {
                capBucket: row.bucket,
                capIndex: String(row.index),
                capSummary: row.summary,
            });
        });
        the(panel, { capCount: rows.length });
    }

    /**
     * @param {"mcp" | "skills" | "schedule" | "personas"} family
     * @param {unknown} res
     */
    function renderFamilyList(family, res) {
        if (!dialog) return;
        const panel = $(dialog, `[data-settings-panel="${family}"]`);
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
            the(tr, {
                familyAlias: alias,
                familyOrigin: origin,
                familySummary: formatFamilyDetails(family, item),
                familyStatus: statusText,
                familyRemovable: origin === "workspace" ? "true" : "false",
                familyEnabled: state !== "disabled" ? "true" : "false",
                familyAuth: supportsOAuth ? "true" : "false",
            });
        });
        the(panel, { familyCount: items.length });
    }

    /**
     * @param {"mcp" | "skills" | "schedule" | "personas"} family
     * @param {unknown} res
     */
    function renderCandidates(family, res) {
        if (!dialog) return;
        const panel = $(dialog, `[data-settings-panel="${family}"]`);
        const list = panel ? $(panel, "ul[data-candidate-rows]") : null;
        if (!panel || !list) return;
        const rawCandidates = isRecord(res) && Array.isArray(res.candidates) ? res.candidates : [];
        const candidates = rawCandidates.filter(isRecord);
        $.cloneEach(list, "#workspace-candidate-row", candidates, (li, item) => {
            const alias = typeof item.alias === "string" ? item.alias : "";
            const summary = typeof item.summary === "string" ? item.summary : "";
            const def = isRecord(item.definition) ? item.definition : null;
            const addable = family !== "schedule" && alias.length > 0 && def !== null;
            the(li, {
                candidateAlias: alias || family,
                candidateSummary: summary,
                candidateAddable: addable ? "true" : "false",
            });
            const form = $(li, "form[data-candidate-add-form]");
            if (addable && form && def) {
                candidateData.set(form, {
                    family: /** @type {"mcp" | "skills" | "personas"} */ (family),
                    alias,
                    definition: def,
                });
            }
        });
        the(panel, { candidateCount: candidates.length });
    }

    /** @param {unknown} resumeOrSetResult */
    function renderSessionPersonaOptions(resumeOrSetResult) {
        if (!dialog) return;
        const form = $(dialog, "form[data-session-persona-form]");
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
                optionValue: choice.value,
                optionLabel: choice.label,
                optionDisabled: null,
            });
        });
        if (typeof personaOption.currentValue === "string") {
            select.value = personaOption.currentValue;
        }
        form.hidden = false;
    }

    function syncEnvScopeControls() {
        if (!dialog || !envPanel) return;
        const ctx = getContext();
        const scopeForm = $(dialog, "form[data-ws-env-scope-form]");
        const listSelect = scopeForm ? $(scopeForm, 'select[name="listScope"]') : null;
        const setSelect = $(envPanel, '[data-env-set-form] select[name="scope"]');
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
        const ctx = getContext();
        setFeedback(true, "", "");
        try {
            if (section === "capabilities") {
                const res = /** @type {import("@plurnk/plurnk-contracts").CapabilityProjection} */ (
                    await invoke("workspace.capabilities.get", {})
                );
                ctx.signal.throwIfAborted();
                renderCapabilities(res);
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
                const personaSessionForm = dialog ? $(dialog, "form[data-session-persona-form]") : null;
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
            const { message, recovery } = await describeFailure(error);
            setFeedback(false, ctx.signal.aborted ? "Response not confirmed." : message, recovery);
        }
    }

    /** @param {SettingsSection} section */
    function selectSection(section) {
        activeSection = section;
        if (!dialog) return;
        for (const btn of $$(dialog, "[data-settings-section]")) {
            btn.setAttribute("aria-pressed", btn.getAttribute("data-settings-section") === section ? "true" : "false");
        }
        for (const panel of $$(dialog, "[data-settings-panel]")) {
            if (panel instanceof HTMLElement) {
                panel.hidden = panel.dataset.settingsPanel !== section;
            }
        }
        const scheduleTarget = $(dialog, '[data-schedule-save-form] input[name="target"]');
        const ctx = getContext();
        if (section === "schedule" && scheduleTarget instanceof HTMLInputElement && scheduleTarget.value === "" && ctx.sessionName) {
            scheduleTarget.value = ctx.sessionName;
        }
        void refreshSection(section);
    }

    function ensureDialog() {
        if (dialog instanceof HTMLDialogElement) return dialog;
        const cloned = $.clone(document.body, "#workspace-settings-dialog");
        if (!(cloned instanceof HTMLDialogElement)) {
            throw new Error("Workspace settings dialog template is invalid.");
        }
        dialog = cloned;
        article = $(dialog, ":scope > article");
        const envOutlet = $(dialog, "[data-ws-env-outlet]");
        if (envOutlet) {
            envPanel = $.clone(envOutlet, "#command-env");
        }
        const effortSelect = $(dialog, '[data-personas-save-form] select[name="effort"]');
        if (effortSelect instanceof HTMLSelectElement) {
            for (const level of EFFORTS) {
                const opt = $.clone(effortSelect, "#setting-option");
                the(opt, { optionValue: level, optionLabel: level, optionDisabled: null });
            }
        }

        on(dialog, "click", "[data-dialog-close]", () => {
            if (dialog?.open) dialog.close();
        });
        on(document.body, "click", "#dialog-workspace-settings", (event, modal) => {
            if (event.target === modal && modal instanceof HTMLDialogElement && modal.open) modal.close();
        });
        on(dialog, "click", "[data-settings-section]", (_event, btn) => {
            const raw = btn.getAttribute("data-settings-section");
            if (isSettingsSection(raw)) {
                selectSection(raw);
            }
        });

        on(dialog, "change", '[data-mcp-save-form] select[name="transport"]', (_event, select) => {
            const form = select.closest("form[data-mcp-save-form]");
            if (form instanceof HTMLFormElement && select instanceof HTMLSelectElement) {
                form.dataset.mcpTransport = select.value;
            }
        });
        on(dialog, "change", '[data-mcp-save-form] select[name="authMode"]', (_event, select) => {
            const form = select.closest("form[data-mcp-save-form]");
            if (form instanceof HTMLFormElement && select instanceof HTMLSelectElement) {
                form.dataset.mcpAuth = select.value;
            }
        });
        on(dialog, "change", '[data-personas-save-form] select[name="personaMode"]', (_event, select) => {
            const form = select.closest("form[data-personas-save-form]");
            if (form instanceof HTMLFormElement && select instanceof HTMLSelectElement) {
                form.dataset.personaMode = select.value;
            }
        });
        on(dialog, "change", '[data-ws-env-scope-form] select[name="listScope"]', (_event, select) => {
            if (!(select instanceof HTMLSelectElement)) return;
            envListScope = select.value === "session" ? "session" : "workspace";
            syncEnvScopeControls();
            void refreshSection("env");
        });

        on(dialog, "submit", "[data-cap-preset-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const preset = String(new FormData(form).get("preset") ?? "propose");
            /** @type {import("@plurnk/plurnk-contracts").CapabilityPolicy} */
            const policy = preset === "allow"
                ? {
                    allow: [
                        { access: "observe" },
                        { access: "mutate" },
                        { access: "execute" },
                        { access: "interact" },
                        { access: "control" },
                    ],
                }
                : preset === "deny"
                    ? { deny: [{ access: "mutate" }, { access: "execute" }, { access: "control" }] }
                    : {};
            void runMutation(async () => {
                const res = /** @type {import("@plurnk/plurnk-contracts").CapabilityProjection} */ (
                    await invoke("workspace.capabilities.set", { policy })
                );
                renderCapabilities(res);
                return "Workspace capability posture updated.";
            });
        });

        on(dialog, "submit", "[data-cap-remove-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const data = new FormData(form);
            const bucket = String(data.get("bucket") ?? "");
            const targetIndex = Number(data.get("index"));
            if (!["allow", "only", "deny"].includes(bucket) || !Number.isInteger(targetIndex)) return;
            const bucketKey = /** @type {"allow" | "only" | "deny"} */ (bucket);
            const existing = currentWorkspacePolicy[bucketKey] ?? [];
            const updatedList = existing.filter((_, idx) => idx !== targetIndex);
            /** @type {Record<string, unknown>} */
            const nextPolicy = { ...currentWorkspacePolicy };
            if (updatedList.length > 0) nextPolicy[bucketKey] = updatedList;
            else delete nextPolicy[bucketKey];
            void runMutation(async () => {
                Validator.assertCapabilityPolicy(nextPolicy);
                const res = /** @type {import("@plurnk/plurnk-contracts").CapabilityProjection} */ (
                    await invoke("workspace.capabilities.set", { policy: nextPolicy })
                );
                renderCapabilities(res);
                return "Removed workspace capability rule.";
            });
        });

        on(dialog, "submit", "[data-cap-rule-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const data = new FormData(form);
            const rawBucket = String(data.get("bucket") ?? "allow");
            const bucketKey = rawBucket === "only" || rawBucket === "deny" ? rawBucket : "allow";
            /** @type {Record<string, unknown>} */
            const selector = {};
            for (const field of ["access", "operation", "runtime", "scheme", "tool"]) {
                const val = String(data.get(field) ?? "").trim();
                if (val.length > 0) selector[field] = val;
            }
            const rawTraits = String(data.get("traits") ?? "")
                .split(",")
                .map((part) => part.trim())
                .filter((part) => part.length > 0);
            if (rawTraits.length > 0) selector.traits = rawTraits;
            void runMutation(async () => {
                if (Object.keys(selector).length === 0) {
                    throw new Error("Specify at least one capability selector field.");
                }
                const nextPolicy = {
                    ...currentWorkspacePolicy,
                    [bucketKey]: [...(currentWorkspacePolicy[bucketKey] ?? []), selector],
                };
                Validator.assertCapabilityPolicy(nextPolicy);
                const res = /** @type {import("@plurnk/plurnk-contracts").CapabilityProjection} */ (
                    await invoke("workspace.capabilities.set", { policy: nextPolicy })
                );
                renderCapabilities(res);
                for (const input of $$(form, "input")) {
                    if (input instanceof HTMLInputElement) input.value = "";
                }
                const accessSelect = $(form, 'select[name="access"]');
                if (accessSelect instanceof HTMLSelectElement) accessSelect.value = "";
                return `Added ${bucketKey} rule (${formatSelectorSummary(selector)}).`;
            });
        });

        on(dialog, "submit", "[data-family-row-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const panel = form.closest("[data-settings-panel]");
            const rawFamily = panel instanceof HTMLElement ? panel.dataset.settingsPanel : "";
            if (!rawFamily || !/** @type {readonly string[]} */ (FAMILIES).includes(rawFamily)) return;
            const family = /** @type {"mcp" | "skills" | "schedule" | "personas"} */ (rawFamily);
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
                    const oauthBox = dialog ? $(dialog, "[data-mcp-oauth-box]") : null;
                    if (isRecord(beginRes) && isRecord(beginRes.authorization) && typeof beginRes.authorization.url === "string") {
                        const url = beginRes.authorization.url;
                        if (oauthBox instanceof HTMLElement && /^https?:\/\//iu.test(url)) {
                            the(oauthBox, { mcpOauthUrl: url, mcpOauthAlias: alias });
                            oauthBox.hidden = false;
                        }
                        return `${alias}: open authorization link and submit the callback URL.`;
                    }
                    const fresh = await invoke("workspace.mcp.list", {});
                    renderFamilyList("mcp", fresh);
                    return `${alias}  active`;
                }
                await invoke(`workspace.${family}.${operation}`, { alias });
                const fresh = await invoke(`workspace.${family}.list`, {});
                renderFamilyList(family, fresh);
                if (family === "personas" && getContext().sessionName !== null) {
                    const sessionRes = await invoke("session/resume", {}, { requireSession: true }).catch(() => null);
                    if (sessionRes !== null) renderSessionPersonaOptions(sessionRes);
                }
                const verbLabel = operation === "remove" ? "removed" : `${operation}d`;
                return `${alias}  ${verbLabel}`;
            });
        });

        on(dialog, "submit", "[data-mcp-oauth-complete-form]", (event, form) => {
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
                const oauthBox = dialog ? $(dialog, "[data-mcp-oauth-box]") : null;
                if (oauthBox instanceof HTMLElement) oauthBox.hidden = true;
                const cbInput = $(form, 'input[name="callbackUrl"]');
                if (cbInput instanceof HTMLInputElement) cbInput.value = "";
                return `${alias}  active`;
            });
        });

        on(dialog, "submit", "[data-family-discover-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const rawFamily = form.dataset.family ?? "";
            if (!/** @type {readonly string[]} */ (FAMILIES).includes(rawFamily)) return;
            const family = /** @type {"mcp" | "skills" | "schedule" | "personas"} */ (rawFamily);
            const data = new FormData(form);
            /** @type {Record<string, unknown>} */
            const params = {};
            if (family === "mcp") {
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

        on(dialog, "submit", "[data-candidate-add-form]", (event, form) => {
            event.preventDefault();
            if (!(form instanceof HTMLFormElement)) return;
            const meta = candidateData.get(form);
            if (!meta) return;
            void runMutation(async () => {
                /** @type {Record<string, unknown>} */
                const payload = { alias: meta.alias, ...meta.definition };
                if (meta.family === "skills") delete payload.commit;
                await invoke(`workspace.${meta.family}.replace`, payload);
                const fresh = await invoke(`workspace.${meta.family}.list`, {});
                renderFamilyList(meta.family, fresh);
                if (meta.family === "personas" && getContext().sessionName !== null) {
                    const sessionRes = await invoke("session/resume", {}, { requireSession: true }).catch(() => null);
                    if (sessionRes !== null) renderSessionPersonaOptions(sessionRes);
                }
                return `${meta.alias}  active`;
            });
        });

        on(dialog, "submit", "[data-mcp-save-form]", (event, form) => {
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
                return `${alias}  saved`;
            });
        });

        on(dialog, "submit", "[data-skills-save-form]", (event, form) => {
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
                return `${alias}  saved`;
            });
        });

        on(dialog, "submit", "[data-schedule-save-form]", (event, form) => {
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
                return `${alias}  saved`;
            });
        });

        on(dialog, "submit", "[data-session-persona-form]", (event, form) => {
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

        on(dialog, "submit", "[data-personas-save-form]", (event, form) => {
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
                return `${alias}  saved`;
            });
        });

        on(dialog, "submit", "[data-env-row-form]", (event, form) => {
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

        on(dialog, "submit", "[data-env-set-form]", (event, form) => {
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
                return `${alias}  active`;
            });
        });

        on(dialog, "input", '[data-env-set-form] input[name="alias"]', (_event, target) => {
            if (target instanceof HTMLInputElement) target.setCustomValidity("");
        });

        return dialog;
    }

    return {
        /** @param {SettingsSection} [initialSection] */
        open(initialSection = activeSection) {
            const modal = ensureDialog();
            const targetSection = isSettingsSection(initialSection) ? initialSection : "capabilities";
            selectSection(targetSection);
            if (!modal.open) modal.showModal();
            const activeTab = $(modal, `[data-settings-section="${targetSection}"]`);
            if (activeTab instanceof HTMLElement) activeTab.focus();
        },
    };
}
