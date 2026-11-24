import { $, on, the } from "on_the_money";
import { attachListCombobox } from "./combobox.js";
import {
    BUILTIN_PLURNK_TOOLS,
    applyGuidedFieldChange,
    extractGuidedFields,
    parseToolCatalogEntry,
    readArgsJson,
    renderGuidedFields,
} from "./schedule-schema-form.js";
import { isRecord } from "./session-translator.js";

export { extractGuidedFields };

/** @typedef {import("./schedule-schema-form.js").GuidedArgField} GuidedArgField */
/** @typedef {import("./schedule-schema-form.js").ToolCatalogEntry} ToolCatalogEntry */
/** @typedef {import("./schedule-schema-form.js").ServerCatalogEntry} ServerCatalogEntry */
/** @typedef {import("./schedule-schema-form.js").ScheduledToolCall} ScheduledToolCall */

/**
 * {§web-workspace-settings} Ordered macro step builder with live Server + Tool comboboxes and guided JSON-Schema argument inputs.
 * @param {HTMLOListElement} stepsList
 * @param {{
 *   getContext: () => { readonly workspaceId: number, readonly sessionName: string | null, readonly signal: AbortSignal },
 *   invokeForSession: (kind: string, params: Record<string, unknown>, sessionName: string, signal?: AbortSignal) => Promise<unknown>,
 *   getReadSessionName: () => string | null,
 *   isActivated: () => boolean,
 * }} options
 */
export function createScheduleStepList(stepsList, { getContext, invokeForSession, getReadSessionName, isActivated }) {
    /** @type {Map<string, ServerCatalogEntry>} */
    const serverCatalog = new Map([
        ["plurnk", {
            alias: "plurnk",
            description: "Built-in Plurnk VM operations, runtimes, and workspace families",
            kind: "builtin",
            tools: BUILTIN_PLURNK_TOOLS,
            hydrated: false,
        }],
    ]);
    /** @type {Set<string>} */
    const hydratingServers = new Set();

    /**
     * @typedef {{
     *   readonly li: HTMLLIElement,
     *   readonly serverCombo: ReturnType<typeof attachListCombobox>,
     *   readonly toolCombo: ReturnType<typeof attachListCombobox>,
     *   readonly guidedHost: HTMLElement,
     *   readonly argsArea: HTMLTextAreaElement,
     *   readonly asideInput: HTMLInputElement,
     *   readonly descEl: HTMLElement,
     * }} StepRowController
     */
    /** @type {StepRowController[]} */
    let stepControllers = [];

    /** @param {string} server */
    async function hydrateServerCatalog(server) {
        if (!isActivated()) return;
        const entry = serverCatalog.get(server);
        if (!entry || entry.hydrated || hydratingServers.has(server)) return;
        const ctx = getContext();
        const sessionForRead = ctx.sessionName ?? getReadSessionName();
        if (!sessionForRead || ctx.workspaceId <= 0) return;
        hydratingServers.add(server);
        try {
            const res = await invokeForSession("entry.read", { target: `mcp:///${server}.json` }, sessionForRead, ctx.signal);
            if (ctx.signal.aborted) return;
            const parsedTools = parseToolCatalogEntry(server, res);
            if (parsedTools && parsedTools.length > 0) {
                serverCatalog.set(server, {
                    ...entry,
                    tools: parsedTools,
                    hydrated: true,
                });
                for (const ctrl of stepControllers) {
                    if (ctrl.serverCombo.getValue() === server) {
                        ctrl.toolCombo.refresh();
                        syncStepToolSchema(ctrl);
                    }
                }
            }
        } catch {
            /* graceful fallback to workspace.mcp.list / curated schemas */
        } finally {
            hydratingServers.delete(server);
        }
    }

    /**
     * @param {StepRowController} ctrl
     */
    function syncStepToolSchema(ctrl) {
        const server = ctrl.serverCombo.getValue();
        const toolName = ctrl.toolCombo.getValue();
        const entry = serverCatalog.get(server)?.tools.find((t) => t.name === toolName);
        ctrl.descEl.textContent = entry?.description ?? "";
        ctrl.descEl.hidden = !entry?.description;
        const fields = extractGuidedFields(entry?.inputSchema);
        const currentArgs = readArgsJson(ctrl.argsArea) ?? {};
        renderGuidedFields(ctrl.guidedHost, fields, currentArgs);
    }

    function renumberSteps() {
        for (let i = 0; i < stepControllers.length; i += 1) {
            const ctrl = stepControllers[i];
            the(ctrl.li, "step-number", `Step ${i + 1}`);
            const upBtn = $(ctrl.li, "[data-step-up]");
            const downBtn = $(ctrl.li, "[data-step-down]");
            const removeBtn = $(ctrl.li, "[data-step-remove]");
            if (upBtn instanceof HTMLButtonElement) upBtn.disabled = i === 0;
            if (downBtn instanceof HTMLButtonElement) downBtn.disabled = i === stepControllers.length - 1;
            if (removeBtn instanceof HTMLButtonElement) removeBtn.disabled = stepControllers.length <= 1;
        }
    }

    /**
     * @param {Partial<ScheduledToolCall>} [initial]
     * @param {number} [insertAt]
     */
    function addStepRow(initial = {}, insertAt = stepControllers.length) {
        const li = $.clone(stepsList, "#schedule-step-card");
        if (!(li instanceof HTMLLIElement)) throw new Error("Schedule step card template is missing.");
        if (insertAt < stepControllers.length && stepControllers[insertAt]) {
            stepsList.insertBefore(li, stepControllers[insertAt].li);
        }
        const serverBox = $(li, '[data-schedule-combobox="server"]');
        const toolBox = $(li, '[data-schedule-combobox="tool"]');
        const guidedHost = $(li, "[data-step-guided-fields]");
        const argsArea = $(li, 'textarea[name="stepArguments"]');
        const asideInput = $(li, 'input[name="stepAside"]');
        const descEl = $(li, "[data-step-tool-desc]");
        if (
            !(serverBox instanceof HTMLElement)
            || !(toolBox instanceof HTMLElement)
            || !(guidedHost instanceof HTMLElement)
            || !(argsArea instanceof HTMLTextAreaElement)
            || !(asideInput instanceof HTMLInputElement)
            || !(descEl instanceof HTMLElement)
        ) {
            throw new Error("Schedule step card controls are incomplete.");
        }

        const findSelf = () => stepControllers.find((c) => c.li === li);
        let lastServer = (initial.server ?? "plurnk").trim();
        const serverCombo = attachListCombobox(serverBox, {
            emptyHint: "No matching server — type any active MCP alias.",
            getChoices: () => [...serverCatalog.values()].map((srv) => ({
                value: srv.alias,
                primary: srv.alias,
                secondary: srv.tools.length > 0
                    ? `${srv.tools.length} ${srv.tools.length === 1 ? "tool" : "tools"}${srv.description ? ` · ${srv.description}` : ""}`
                    : srv.description,
                kind: srv.kind,
            })),
            onSelect: (srvName) => {
                const nextServer = srvName.trim();
                const serverChanged = nextServer !== lastServer;
                lastServer = nextServer;
                void hydrateServerCatalog(nextServer);
                const self = findSelf();
                if (self) {
                    if (serverChanged) {
                        const curTool = self.toolCombo.getValue();
                        const hasCurTool = curTool !== ""
                            && (serverCatalog.get(nextServer)?.tools.some((t) => t.name === curTool) ?? false);
                        if (!hasCurTool) {
                            self.toolCombo.setValue("");
                            self.argsArea.value = "{}";
                            self.argsArea.removeAttribute("aria-invalid");
                        }
                    }
                    self.toolCombo.refresh();
                    syncStepToolSchema(self);
                }
            },
            onInput: (srvName) => {
                if (serverCatalog.has(srvName)) void hydrateServerCatalog(srvName);
                const self = findSelf();
                if (self) syncStepToolSchema(self);
            },
        });
        const toolCombo = attachListCombobox(toolBox, {
            emptyHint: "No matching tool — type any tool name for this server.",
            getChoices: () => {
                const srvName = serverCombo.getValue() || "plurnk";
                void hydrateServerCatalog(srvName);
                const tools = serverCatalog.get(srvName)?.tools ?? [];
                return tools.map((t) => ({
                    value: t.name,
                    primary: t.name,
                    secondary: t.description,
                    kind: "tool",
                }));
            },
            onSelect: () => {
                const self = findSelf();
                if (self) syncStepToolSchema(self);
            },
            onInput: () => {
                const self = findSelf();
                if (self) syncStepToolSchema(self);
            },
        });

        /** @type {StepRowController} */
        const ctrl = { li, serverCombo, toolCombo, guidedHost, argsArea, asideInput, descEl };
        serverCombo.setValue(initial.server ?? "plurnk");
        toolCombo.setValue(initial.tool ?? "");
        argsArea.value = initial.arguments && Object.keys(initial.arguments).length > 0
            ? JSON.stringify(initial.arguments, null, 2)
            : "{}";
        asideInput.value = initial.aside ?? "";
        stepControllers.splice(insertAt, 0, ctrl);
        void hydrateServerCatalog(serverCombo.getValue());
        syncStepToolSchema(ctrl);
        renumberSteps();
        return ctrl;
    }

    function clearSteps() {
        for (const ctrl of stepControllers) {
            ctrl.serverCombo.dispose();
            ctrl.toolCombo.dispose();
            ctrl.li.remove();
        }
        stepControllers = [];
    }

    /** @param {readonly ScheduledToolCall[]} steps */
    function setSteps(steps) {
        clearSteps();
        if (steps.length === 0) {
            addStepRow({ server: "plurnk", tool: "" });
            return;
        }
        for (const step of steps) {
            addStepRow(step);
        }
    }

    /** @returns {ScheduledToolCall[]} */
    function collectSteps() {
        /** @type {ScheduledToolCall[]} */
        const calls = [];
        for (let i = 0; i < stepControllers.length; i += 1) {
            const ctrl = stepControllers[i];
            const server = ctrl.serverCombo.getValue();
            const tool = ctrl.toolCombo.getValue();
            if (!server) throw new Error(`Step ${i + 1}: enter a server (e.g. plurnk or an MCP server alias).`);
            if (!tool) throw new Error(`Step ${i + 1}: select or enter a tool name.`);
            const parsedArgs = readArgsJson(ctrl.argsArea);
            if (parsedArgs === null) {
                ctrl.argsArea.setAttribute("aria-invalid", "true");
                throw new Error(`Step ${i + 1} (${server}.${tool}): arguments must be a valid JSON object.`);
            }
            ctrl.argsArea.removeAttribute("aria-invalid");
            const aside = ctrl.asideInput.value.trim();
            calls.push({
                server,
                tool,
                ...(Object.keys(parsedArgs).length > 0 ? { arguments: parsedArgs } : {}),
                ...(aside ? { aside } : {}),
            });
        }
        if (calls.length === 0) throw new Error("Add at least one tool step.");
        return calls;
    }

    /** @param {unknown} mcpRes */
    function refreshMcpCatalog(mcpRes) {
        if (isRecord(mcpRes) && Array.isArray(mcpRes.definitions)) {
            const keep = new Set(["plurnk"]);
            for (const entry of mcpRes.definitions) {
                if (!isRecord(entry) || typeof entry.alias !== "string" || entry.state === "disabled") continue;
                const alias = entry.alias;
                keep.add(alias);
                const detail = isRecord(entry.detail) ? entry.detail : null;
                const description = detail && typeof detail.description === "string" ? detail.description : "";
                const toolNames = detail && Array.isArray(detail.tools)
                    ? detail.tools.filter((t) => typeof t === "string" && t.length > 0)
                    : [];
                const prev = serverCatalog.get(alias);
                const prevMatches = prev?.hydrated === true
                    && prev.tools.length === toolNames.length
                    && toolNames.every((name) => prev.tools.some((t) => t.name === name));
                if (!prevMatches) {
                    serverCatalog.set(alias, {
                        alias,
                        description,
                        kind: "mcp",
                        tools: toolNames.map((name) => ({ name, description: "" })),
                        hydrated: false,
                    });
                }
            }
            for (const key of [...serverCatalog.keys()]) {
                if (!keep.has(key)) serverCatalog.delete(key);
            }
            for (const ctrl of stepControllers) {
                ctrl.serverCombo.refresh();
                ctrl.toolCombo.refresh();
            }
        }
        void hydrateServerCatalog("plurnk");
    }

    on(stepsList, "click", "[data-step-up], [data-step-down], [data-step-duplicate], [data-step-remove]", (_event, button) => {
        const li = button.closest("[data-schedule-step]");
        const idx = stepControllers.findIndex((c) => c.li === li);
        if (idx < 0) return;
        const current = stepControllers[idx];
        if (button.hasAttribute("data-step-up") && idx > 0) {
            const prev = stepControllers[idx - 1];
            stepsList.insertBefore(current.li, prev.li);
            stepControllers.splice(idx, 1);
            stepControllers.splice(idx - 1, 0, current);
            renumberSteps();
        } else if (button.hasAttribute("data-step-down") && idx < stepControllers.length - 1) {
            const next = stepControllers[idx + 1];
            stepsList.insertBefore(next.li, current.li);
            stepControllers.splice(idx, 1);
            stepControllers.splice(idx + 1, 0, current);
            renumberSteps();
        } else if (button.hasAttribute("data-step-duplicate")) {
            const parsedArgs = readArgsJson(current.argsArea) ?? {};
            addStepRow({
                server: current.serverCombo.getValue(),
                tool: current.toolCombo.getValue(),
                arguments: parsedArgs,
                aside: current.asideInput.value.trim(),
            }, idx + 1);
        } else if (button.hasAttribute("data-step-remove") && stepControllers.length > 1) {
            current.serverCombo.dispose();
            current.toolCombo.dispose();
            current.li.remove();
            stepControllers.splice(idx, 1);
            renumberSteps();
        }
    });

    on(stepsList, "input", "[data-step-guided-fields] input, [data-step-guided-fields] textarea", (_event, target) => {
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
        const fieldWrap = target.closest("[data-arg-name]");
        const li = target.closest("[data-schedule-step]");
        const ctrl = stepControllers.find((c) => c.li === li);
        if (ctrl && fieldWrap instanceof HTMLElement) {
            applyGuidedFieldChange(ctrl.argsArea, fieldWrap, target.value);
        }
    });

    on(stepsList, "change", "[data-step-guided-fields] select", (_event, target) => {
        if (!(target instanceof HTMLSelectElement)) return;
        const fieldWrap = target.closest("[data-arg-name]");
        const li = target.closest("[data-schedule-step]");
        const ctrl = stepControllers.find((c) => c.li === li);
        if (ctrl && fieldWrap instanceof HTMLElement) {
            applyGuidedFieldChange(ctrl.argsArea, fieldWrap, target.value);
        }
    });

    on(stepsList, "input", 'textarea[name="stepArguments"]', (_event, target) => {
        if (!(target instanceof HTMLTextAreaElement)) return;
        const li = target.closest("[data-schedule-step]");
        const ctrl = stepControllers.find((c) => c.li === li);
        if (!ctrl) return;
        const parsed = readArgsJson(target);
        if (parsed === null) {
            target.setAttribute("aria-invalid", "true");
        } else {
            target.removeAttribute("aria-invalid");
            syncStepToolSchema(ctrl);
        }
    });

    return {
        addStepRow,
        clearSteps,
        setSteps,
        collectSteps,
        refreshMcpCatalog,
        hasSteps: () => stepControllers.length > 0,
        closeComboboxes() {
            for (const ctrl of stepControllers) {
                ctrl.serverCombo.close();
                ctrl.toolCombo.close();
            }
        },
        dispose: clearSteps,
    };
}
