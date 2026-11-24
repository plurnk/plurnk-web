import { $, on, the } from "on_the_money";
import { attachListCombobox } from "./combobox.js";
import { createScheduleReceiptController, renderScheduleList } from "./schedule-receipts.js";
import { createScheduleStepList, extractGuidedFields } from "./schedule-steps.js";
import {
    createSchedulePreviewController,
    parseRuleToTimingState,
    readTimingState,
    syncScheduleFormAttributes,
    synthesizeScheduleRule,
    writeTimingState,
} from "./schedule-timing.js";
import { isRecord } from "./session-translator.js";

/** @typedef {import("./schedule-timing.js").ScheduleTimingState} ScheduleTimingState */
export { extractGuidedFields, parseRuleToTimingState, synthesizeScheduleRule };

/**
 * {§web-workspace-settings} Mount the interactive Schedule & Macro Control Panel inside `[data-settings-panel="schedule"]`.
 * @param {HTMLElement} panel
 * @param {{
 *   getContext: () => { readonly workspaceId: number, readonly workspaceName: string, readonly sessionName: string | null, readonly signal: AbortSignal },
 *   invoke: (kind: string, params?: Record<string, unknown>, opts?: { requireSession?: boolean }) => Promise<unknown>,
 *   invokeForSession: (kind: string, params: Record<string, unknown>, sessionName: string, signal?: AbortSignal) => Promise<unknown>,
 *   runMutation: (work: (signal: AbortSignal) => Promise<string>) => Promise<void>,
 *   setFeedback: (busy: boolean, message?: string, recovery?: string) => void,
 *   refreshList?: () => Promise<void>,
 * }} host
 */
export function mountSchedulePanel(panel, host) {
    const rawForm = $(panel, "form[data-schedule-save-form]");
    const rawDisclosure = $(panel, 'details[data-family-disclosure="schedule"]');
    const rawTbody = $(panel, "[data-family-rows]");
    const rawStepsList = $(panel, "[data-schedule-steps-list]");
    const rawReceiptBox = $(panel, "[data-schedule-receipt]");
    if (
        !(rawForm instanceof HTMLFormElement)
        || !(rawDisclosure instanceof HTMLDetailsElement)
        || !(rawTbody instanceof HTMLTableSectionElement)
        || !(rawStepsList instanceof HTMLOListElement)
        || !(rawReceiptBox instanceof HTMLElement)
    ) {
        throw new Error("Schedule panel markup is incomplete.");
    }
    const form = rawForm;
    const disclosure = rawDisclosure;
    const tbody = rawTbody;
    const stepsList = rawStepsList;
    const receiptBox = rawReceiptBox;

    /** @type {Map<string, Record<string, unknown>>} */
    const scheduleByAlias = new Map();
    /** @type {string[]} */
    let workspaceSessions = [];
    /** @type {{ alias: string, description: string }[]} */
    let workspacePersonas = [];
    /** @type {string | null} */
    let readSessionName = null;
    let activated = false;
    /** @type {string | null} */
    let editingAlias = null;

    const targetBox = $(form, '[data-schedule-combobox="target"]');
    const targetCombobox = targetBox instanceof HTMLElement
        ? attachListCombobox(targetBox, {
            emptyHint: "Type a new or existing session name.",
            getChoices: () => {
                const ctx = host.getContext();
                const names = new Set(workspaceSessions);
                if (ctx.sessionName) names.add(ctx.sessionName);
                return [...names].map((name) => ({
                    value: name,
                    primary: name,
                    secondary: name === ctx.sessionName ? "Active session" : "Workspace session",
                    kind: "session",
                }));
            },
        })
        : null;

    const preview = createSchedulePreviewController(form, host);
    const stepList = createScheduleStepList(stepsList, {
        getContext: host.getContext,
        invokeForSession: host.invokeForSession,
        getReadSessionName: () => readSessionName,
        isActivated: () => activated,
    });

    /** @param {unknown} res */
    const renderList = (res) => {
        renderScheduleList(panel, tbody, res, scheduleByAlias);
    };

    const reloadScheduleList = async () => {
        if (host.refreshList) {
            await host.refreshList();
            return;
        }
        const fresh = await host.invoke("workspace.schedule.list", {});
        renderList(fresh);
    };

    const receipts = createScheduleReceiptController(receiptBox, {
        getContext: host.getContext,
        invoke: host.invoke,
        runMutation: host.runMutation,
        renderList,
        refreshList: reloadScheduleList,
    });

    function updatePersonaChoices() {
        const personaSelect = $(form, 'select[name="persona"]');
        if (!(personaSelect instanceof HTMLSelectElement)) return;
        const previous = personaSelect.value;
        const choices = [
            { value: "", label: "None (default)" },
            ...workspacePersonas.map((p) => ({
                value: p.alias,
                label: p.description ? `${p.alias} — ${p.description}` : p.alias,
            })),
        ];
        $.cloneEach(personaSelect, "#setting-option", choices, (optEl, choice) => {
            the(optEl, { "option-value": choice.value, "option-label": choice.label, "option-disabled": null });
        });
        personaSelect.value = choices.some((c) => c.value === previous) ? previous : "";
    }

    function prefillTarget() {
        const ctx = host.getContext();
        if (targetCombobox && targetCombobox.getValue() === "" && ctx.sessionName) {
            targetCombobox.setValue(ctx.sessionName);
        }
    }

    function resetBuilder() {
        editingAlias = null;
        const aliasInput = $(form, 'input[name="alias"]');
        if (aliasInput instanceof HTMLInputElement) aliasInput.value = "";
        const kindSelect = $(form, 'select[name="kind"]');
        if (kindSelect instanceof HTMLSelectElement) kindSelect.value = "prompt";
        const catchupSelect = $(form, 'select[name="catchup"]');
        if (catchupSelect instanceof HTMLSelectElement) catchupSelect.value = "default";
        const personaSelect = $(form, 'select[name="persona"]');
        if (personaSelect instanceof HTMLSelectElement) personaSelect.value = "";
        const promptArea = $(form, 'textarea[name="prompt"]');
        if (promptArea instanceof HTMLTextAreaElement) promptArea.value = "";
        targetCombobox?.setValue(host.getContext().sessionName ?? "");
        writeTimingState(form, parseRuleToTimingState("manual"), editingAlias);
        stepList.setSteps([{ server: "plurnk", tool: "" }]);
        preview.schedule();
    }

    /** @param {Record<string, unknown>} item */
    function loadForEdit(item) {
        const alias = typeof item.alias === "string" ? item.alias : "";
        const def = isRecord(item.definition) ? item.definition : {};
        editingAlias = alias || null;
        const aliasInput = $(form, 'input[name="alias"]');
        if (aliasInput instanceof HTMLInputElement) aliasInput.value = alias;

        const isRun = Array.isArray(def.run);
        const kindSelect = $(form, 'select[name="kind"]');
        if (kindSelect instanceof HTMLSelectElement) kindSelect.value = isRun ? "run" : "prompt";

        const catchupSelect = $(form, 'select[name="catchup"]');
        if (catchupSelect instanceof HTMLSelectElement) {
            catchupSelect.value = def.catchup === true ? "true" : def.catchup === false ? "false" : "default";
        }

        const ruleStr = typeof def.rule === "string" ? def.rule : "manual";
        writeTimingState(form, parseRuleToTimingState(ruleStr), editingAlias);

        if (isRun) {
            const steps = /** @type {unknown[]} */ (def.run)
                .filter(isRecord)
                .map((s) => ({
                    server: typeof s.server === "string" ? s.server : "plurnk",
                    tool: typeof s.tool === "string" ? s.tool : "",
                    ...(isRecord(s.arguments) ? { arguments: s.arguments } : {}),
                    ...(typeof s.aside === "string" ? { aside: s.aside } : {}),
                }));
            stepList.setSteps(steps);
        } else {
            const rawTarget = typeof def.target === "string" ? def.target.replace(/^session:\/\//u, "") : "";
            targetCombobox?.setValue(rawTarget || host.getContext().sessionName || "");
            const personaSelect = $(form, 'select[name="persona"]');
            if (personaSelect instanceof HTMLSelectElement) {
                personaSelect.value = typeof def.persona === "string" ? def.persona : "";
            }
            const promptArea = $(form, 'textarea[name="prompt"]');
            if (promptArea instanceof HTMLTextAreaElement) {
                promptArea.value = typeof def.prompt === "string" ? def.prompt : "";
            }
            if (!stepList.hasSteps()) stepList.setSteps([{ server: "plurnk", tool: "" }]);
        }

        syncScheduleFormAttributes(form, editingAlias);
        disclosure.open = true;
        preview.schedule({ immediate: true });
        if (aliasInput instanceof HTMLInputElement) aliasInput.focus();
    }

    async function refreshAuxiliaryData() {
        activated = true;
        const ctx = host.getContext();
        if (ctx.workspaceId <= 0) return;
        const [mcpRes, sessionsRes, personasRes, clockRes] = await Promise.all([
            host.invoke("workspace.mcp.list", {}).catch(() => null),
            host.invoke("workspace.sessions", { workspaceId: ctx.workspaceId }).catch(() => null),
            host.invoke("workspace.personas.list", {}).catch(() => null),
            host.invoke("workspace.schedule.discover", {}).catch(() => null),
        ]);
        if (ctx.signal.aborted) return;

        if (isRecord(sessionsRes) && Array.isArray(sessionsRes.sessions)) {
            const activeModelSessions = sessionsRes.sessions
                .filter((row) => isRecord(row) && typeof row.name === "string" && row.origin === "model" && !row.archivedAt)
                .map((row) => String(/** @type {Record<string, unknown>} */ (row).name));
            workspaceSessions = activeModelSessions;
            readSessionName = ctx.sessionName ?? activeModelSessions[0] ?? null;
            targetCombobox?.refresh();
        } else {
            readSessionName = ctx.sessionName;
        }

        if (isRecord(personasRes) && Array.isArray(personasRes.definitions)) {
            workspacePersonas = personasRes.definitions
                .filter((entry) => isRecord(entry) && typeof entry.alias === "string" && entry.state !== "disabled")
                .map((entry) => {
                    const def = isRecord(entry.definition) ? entry.definition : null;
                    return {
                        alias: String(entry.alias),
                        description: def && typeof def.description === "string" ? def.description : "",
                    };
                });
            updatePersonaChoices();
        }

        if (isRecord(clockRes) && Array.isArray(clockRes.candidates) && isRecord(clockRes.candidates[0])) {
            const summary = typeof clockRes.candidates[0].summary === "string" ? clockRes.candidates[0].summary : "";
            if (summary) the(panel, "schedule-clock", summary);
        }

        stepList.refreshMcpCatalog(mcpRes);
    }

    /** @returns {{ readonly alias: string, readonly payload: Record<string, unknown> }} */
    function buildPayload() {
        const aliasInput = $(form, 'input[name="alias"]');
        const kindEl = $(form, 'select[name="kind"]');
        const catchupEl = $(form, 'select[name="catchup"]');
        const alias = aliasInput instanceof HTMLInputElement ? aliasInput.value.trim() : "";
        if (!alias) throw new Error("Enter a schedule alias.");
        const timing = readTimingState(form);
        const rule = synthesizeScheduleRule(timing);
        const catchupRaw = catchupEl instanceof HTMLSelectElement ? catchupEl.value : "default";
        const catchupPart = timing.mode !== "manual" && timing.mode !== "once" && (catchupRaw === "true" || catchupRaw === "false")
            ? { catchup: catchupRaw === "true" }
            : {};
        const kind = kindEl instanceof HTMLSelectElement && kindEl.value === "run" ? "run" : "prompt";
        if (kind === "run") {
            const run = stepList.collectSteps();
            return {
                alias,
                payload: { alias, rule, run, ...catchupPart },
            };
        }
        const rawTarget = targetCombobox?.getValue() ?? "";
        const promptArea = $(form, 'textarea[name="prompt"]');
        const prompt = promptArea instanceof HTMLTextAreaElement ? promptArea.value.trim() : "";
        if (!rawTarget || !prompt) throw new Error("Enter both a target session and a prompt.");
        const target = rawTarget.startsWith("session://") ? rawTarget : `session://${rawTarget}`;
        const personaEl = $(form, 'select[name="persona"]');
        const persona = personaEl instanceof HTMLSelectElement ? personaEl.value.trim() : "";
        return {
            alias,
            payload: {
                alias,
                rule,
                target,
                prompt,
                ...(persona ? { persona } : {}),
                ...catchupPart,
            },
        };
    }

    resetBuilder();

    on(form, "change", 'select[name="kind"], select[name="scheduleMode"], select[name="repeatPreset"], select[name="relativeUnit"], input[name="repeatDay"], input[name="atLocal"], input[name="repeatTime"]', () => {
        syncScheduleFormAttributes(form, editingAlias);
        preview.schedule();
    });

    on(form, "input", 'input[name="relativeAmount"], input[name="repeatInterval"], input[name="repeatDayOfMonth"], input[name="rule"]', () => {
        preview.schedule();
    });

    on(form, "click", "[data-schedule-preview-btn]", () => {
        preview.schedule({ immediate: true });
    });

    on(form, "click", "[data-schedule-cancel-edit], [data-schedule-reset]", () => {
        resetBuilder();
        host.setFeedback(false, "", "");
    });

    on(form, "click", "[data-schedule-add-step]", () => {
        const ctrl = stepList.addStepRow({ server: "plurnk", tool: "" });
        ctrl.toolCombo.input.focus();
    });

    on(form, "submit", "form", (event) => {
        event.preventDefault();
        targetCombobox?.close();
        stepList.closeComboboxes();
        let built;
        try {
            built = buildPayload();
        } catch (error) {
            host.setFeedback(false, error instanceof Error ? error.message : String(error), "");
            return;
        }
        void host.runMutation(async () => {
            await host.invoke("workspace.schedule.replace", built.payload);
            await reloadScheduleList();
            resetBuilder();
            disclosure.open = false;
            return `${built.alias}  saved`;
        });
    });

    on(panel, "submit", "[data-schedule-row-form]", (event, rowForm) => {
        event.preventDefault();
        if (!(rowForm instanceof HTMLFormElement)) return;
        const submitter = event instanceof SubmitEvent && event.submitter instanceof HTMLButtonElement ? event.submitter : null;
        const operation = submitter?.value ?? "";
        const alias = String(new FormData(rowForm).get("alias") ?? "").trim();
        if (!alias) return;

        if (operation === "edit") {
            const item = scheduleByAlias.get(alias);
            if (item) {
                loadForEdit(item);
                host.setFeedback(false, "", "");
            }
            return;
        }

        if (operation === "run") {
            const existing = scheduleByAlias.get(alias);
            const existingDef = isRecord(existing?.definition) ? existing.definition : null;
            const sessionTarget = existingDef && typeof existingDef.target === "string"
                ? existingDef.target.replace(/^session:\/\//u, "")
                : null;
            receipts.runScheduleNow(alias, sessionTarget);
            return;
        }

        if (operation === "done" || operation === "reopen") {
            const nextStatus = operation === "done" ? "done" : "open";
            void host.runMutation(async () => {
                await host.invoke("workspace.schedule.status", { alias, status: nextStatus });
                await reloadScheduleList();
                return `${alias}  ${nextStatus}`;
            });
            return;
        }

        if (["enable", "disable", "remove"].includes(operation)) {
            void host.runMutation(async () => {
                await host.invoke(`workspace.schedule.${operation}`, { alias });
                await reloadScheduleList();
                const isRetry = submitter?.hasAttribute("data-family-retry") === true;
                const verbLabel = operation === "remove" ? "removed" : isRetry ? "retried" : `${operation}d`;
                return `${alias}  ${verbLabel}`;
            });
        }
    });

    const cleanup = () => {
        preview.dispose();
        targetCombobox?.dispose();
        stepList.dispose();
    };
    on.target(host.getContext().signal, "abort", cleanup);

    return {
        renderList,
        prefillTarget,
        refreshAuxiliaryData,
        dispose: cleanup,
    };
}
