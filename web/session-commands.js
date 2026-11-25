import { $, on, the } from "on_the_money";
import { directoryPath, workspaceSettingsPath } from "../src/directory-addresses.js";
import describeFailure from "./failure.js";
import { authLogoutMethod, authLogoutUrl } from "./endpoints.js";
import { hasActiveOidcGrant, signOut } from "./oidc.js";
import {
    expandPromptCommand,
    extractOpenPaths,
    formatExecResults,
    formatFamilyResult,
    isCommand,
    isLocalExec,
    parseCommand,
    prepareComposerPrompt,
    resolvePromptCommand,
    selectGate,
} from "./session-command-parser.js";
import {
    FAMILY_COMMANDS,
    HELP_COMMANDS,
    SLASH_COMMAND_NAMES,
    acceptCommandSuggestion,
    computeCommandSuggestions,
    primaryModifierLabel,
} from "./session-command-suggestions.js";
import { modelLabel, sessionConfigOption, sessionEffort, sessionModel } from "./session-models.js";
import { allowOptionId, rejectOptionId } from "./session-review.js";
import { isRecord } from "./session-translator.js";

/** @typedef {import("./session-command-suggestions.js").SuggestionSources} SuggestionSources */
/** @typedef {import("./session-models.js").Action} Action */
/** @typedef {import("./session-agent.js").SessionGate} SessionGate */
/** @typedef {import("./session-agent.js").GateResolution} GateResolution */

export {
    SLASH_COMMAND_NAMES,
    acceptCommandSuggestion,
    computeCommandSuggestions,
    expandPromptCommand,
    extractOpenPaths,
    isCommand,
    isLocalExec,
    parseCommand,
    prepareComposerPrompt,
    primaryModifierLabel,
    resolvePromptCommand,
};

/**
 * {§web-session-commands} Route inspection commands to canonical UI surfaces, mutations to `#session-feedback`, and multi-line CLI output to `#dialog-command-output`.
 * @param {Element} main
 * @param {{
 *   call: Action,
 *   toggleYolo: () => Promise<boolean>,
 *   stop: () => Promise<string>,
 *   getContext?: () => { workspaceName: string, sessionName: string },
 *   getPendingGates?: () => readonly SessionGate[],
 *   resolveGate?: (resolution: GateResolution) => Promise<void> | void,
 *   navigate?: (path: string) => void,
 *   hasSession?: (name: string) => boolean,
 * }} actions
 */
export default function sessionCommands(main, actions) {
    const ensureFeedback = () => {
        const existing = $(main, '[aria-label="Message feedback"]');
        if (existing instanceof HTMLElement) return existing;
        const cloned = $.clone(main, "#session-feedback");
        if (!(cloned instanceof HTMLElement)) throw new Error("Session feedback template is incomplete.");
        return cloned;
    };

    /** @type {HTMLDialogElement | null} */
    let outputDialog = null;
    const ensureOutputDialog = () => {
        if (outputDialog && outputDialog.isConnected) return outputDialog;
        const existing = $("#dialog-command-output");
        if (existing instanceof HTMLDialogElement) {
            outputDialog = existing;
            return outputDialog;
        }
        const cloned = $.clone(document.body, "#command-output-dialog");
        if (!(cloned instanceof HTMLDialogElement)) throw new Error("Command output dialog template is incomplete.");
        on(cloned, "click", "[data-dialog-close]", () => {
            if (cloned.open) cloned.close();
        });
        outputDialog = cloned;
        return cloned;
    };

    /**
     * @param {string} title
     * @param {string} literal
     * @param {string} [message]
     */
    const showOutputModal = (title, literal, message = "") => {
        const dialog = ensureOutputDialog();
        the(dialog, {
            "command-title": title,
            "command-message": message,
            "command-literal": literal,
        });
        if (!dialog.open) dialog.showModal();
    };

    /** @param {string} message */
    const showStatus = (message) => {
        const feedback = ensureFeedback();
        the(feedback, { "message-status": message, "command-error": "" });
    };

    /** @param {string} errorText */
    const showError = (errorText) => {
        const feedback = ensureFeedback();
        the(feedback, { "message-status": "", "command-error": errorText });
    };

    const readIdentity = () => {
        if (actions.getContext) return actions.getContext();
        const workspaceName = $('#session-workspace [data-text="workspace-name"]')?.textContent?.trim()
            || $("#session-workspace")?.textContent?.trim()
            || "default";
        const sessionName = $("#session-status")?.getAttribute("data-session-name") || "session1";
        return { workspaceName, sessionName };
    };

    /**
     * @param {string} section
     * @param {Readonly<Record<string, string | null | undefined>>} [extra]
     */
    const navigateToSettings = (section, extra = undefined) => {
        const { workspaceName, sessionName } = readIdentity();
        const targetPath = workspaceSettingsPath(workspaceName, sessionName, section, extra);
        if (!targetPath) throw new Error(`Invalid workspace settings address: ${workspaceName}.`);
        if (actions.navigate) {
            actions.navigate(targetPath);
        } else {
            location.assign(targetPath);
        }
    };

    /** @param {string} text @param {AbortSignal} signal */
    const execute = async (text, signal) => {
        /** @type {Action} */
        const call = (kind, params) => actions.call(kind, params, signal);
        const feedback = ensureFeedback();
        the(feedback, { "command-error": "" });
        try {
            signal.throwIfAborted();
            if (isLocalExec(text)) {
                const trimmed = text.trimStart();
                const stmt = trimmed.startsWith("!")
                    ? (() => {
                        const shellCmd = trimmed.replace(/^!+\s*/u, "");
                        if (!shellCmd) throw new Error("Usage: ! <command>.");
                        return `plurnk.sh(${JSON.stringify({ command: shellCmd })})`;
                    })()
                    : text.trim();
                const res = await call("op.exec", { text: stmt });
                signal.throwIfAborted();
                const out = formatExecResults(res);
                if (out) {
                    showOutputModal(trimmed, out);
                } else {
                    showStatus("Completed.");
                }
                return true;
            }

            const { name, rest, args } = parseCommand(text);
            if (name === "help") {
                const selected = rest.replace(/^\//u, "");
                if (selected && !HELP_COMMANDS.has(selected)) throw new Error(`Unknown command ${rest}. Use /help.`);
                navigateToSettings("help", selected ? { cmd: selected } : undefined);
                return true;
            }
            if (name === "models") {
                navigateToSettings("models", rest ? { q: rest } : undefined);
                return true;
            }
            if (name === "yolo") {
                showStatus(`Approval policy: ${await actions.toggleYolo() ? "accept" : "review"}.`);
                return true;
            }
            if (name === "logout") {
                if (authLogoutUrl() !== null) {
                    signOut(actions.navigate && authLogoutMethod() === "GET"
                        ? { navigate: actions.navigate }
                        : {});
                    return true;
                }
                const hadGrant = hasActiveOidcGrant();
                signOut({ reload: false });
                if (hadGrant) {
                    if (actions.navigate) actions.navigate("/");
                    else location.assign("/");
                } else {
                    showStatus("No stored sign-in credentials.");
                }
                return true;
            }
            if (name === "stop") {
                showStatus(await actions.stop());
                return true;
            }
            if (FAMILY_COMMANDS.has(name)) {
                if (name === "schedule" && (args[0] === "inspect" || args[0] === "show")) {
                    const alias = (args[1] ?? "").trim();
                    if (!alias) throw new Error(`Usage: /schedule ${args[0]} <alias>.`);
                    const listed = await call("workspace.schedule.list", {});
                    signal.throwIfAborted();
                    const defs = isRecord(listed) && Array.isArray(listed.definitions) ? listed.definitions : [];
                    const found = defs.find((d) => isRecord(d) && d.alias === alias);
                    if (!isRecord(found)) throw new Error(`Schedule '${alias}' not found.`);
                    const detail = isRecord(found.detail) ? found.detail : {};
                    const def = isRecord(found.definition) ? found.definition : {};
                    const summaryParts = [
                        `${alias}`,
                        typeof detail.kind === "string" ? detail.kind : (Array.isArray(def.run) ? "run" : "prompt"),
                        typeof detail.status === "string" ? detail.status : (typeof found.state === "string" ? found.state : "open"),
                        typeof detail.rule === "string" ? detail.rule : (typeof def.rule === "string" ? def.rule : "manual"),
                    ];
                    showOutputModal(
                        text.trim(),
                        JSON.stringify({ alias, state: found.state, detail, definition: def }, null, 2),
                        summaryParts.join(" · "),
                    );
                    return true;
                }
                const { parseFamilyCommand } = await import("@plurnk/plurnk-contracts");
                const parsed = parseFamilyCommand(name, args);
                if (parsed.sub === "list") {
                    navigateToSettings(name, name === "env" && parsed.scopePrefix === "session" ? { envScope: "session" } : undefined);
                    return true;
                }
                let params = parsed.params;
                if (parsed.actionName === "workspace.mcp.oauth.begin") {
                    const alias = typeof params.alias === "string" ? params.alias : "";
                    const listed = await call("workspace.mcp.list", {});
                    if (isRecord(listed)) {
                        const defs = Array.isArray(listed.definitions) ? listed.definitions : [];
                        const entry = defs.find((d) => isRecord(d) && d.alias === alias);
                        const def = isRecord(entry) && isRecord(entry.definition) ? entry.definition : null;
                        const auth = def?.type === "streamable-http" && isRecord(def.authorization) ? def.authorization : null;
                        if (auth?.type === "oauth" && typeof auth.redirectUrl === "string" && auth.redirectUrl.length > 0) {
                            params = { ...params, redirectUrl: auth.redirectUrl };
                        }
                    }
                }
                const res = await call(parsed.actionName, params);
                signal.throwIfAborted();
                const formatted = formatFamilyResult(name, parsed, res);
                if (formatted.literal) {
                    showOutputModal(text.trim(), formatted.literal, formatted.message);
                } else {
                    showStatus(formatted.message);
                }
                return true;
            }
            if (name === "model") {
                if (!args[0]) {
                    navigateToSettings("session");
                    return true;
                }
                const model = await sessionModel(call, args[0], args[1]);
                showStatus(`Model: ${modelLabel(model)}${model?.effort === undefined ? "" : ` (${model.effort})`}.`);
                return true;
            }
            if (name === "effort") {
                if (!args[0]) {
                    navigateToSettings("session");
                    return true;
                }
                const { effort, source, supported } = await sessionEffort(call, args[0]);
                showStatus(`Effort: ${effort ?? "Unavailable"} (${source}). Supported: ${supported.join(", ") || "None"}.`);
                return true;
            }
            if (name === "persona") {
                if (!args[0]) {
                    navigateToSettings("session");
                    return true;
                }
                const { currentValue, supported } = await sessionConfigOption(call, "persona", args[0]);
                showStatus(`Persona: ${currentValue || "none"}. Supported: ${supported.join(", ") || "none"}.`);
                return true;
            }
            if (name === "child") {
                if (!args[0]) {
                    navigateToSettings("session");
                    return true;
                }
                const { currentValue } = await sessionConfigOption(call, "child", args[0]);
                showStatus(`Child model: ${currentValue || "inherit"}.`);
                return true;
            }
            if (name === "mode") {
                if (!args[0]) {
                    navigateToSettings("session");
                    return true;
                }
                const { currentValue } = await sessionConfigOption(call, "mode", args[0]);
                showStatus(`Approval policy: ${currentValue || "review"}.`);
                return true;
            }
            if (name === "update") {
                const [{ formatServiceUpdateReport }, res] = await Promise.all([
                    import("@plurnk/plurnk-contracts"),
                    call("service.update", {}),
                ]);
                signal.throwIfAborted();
                const report = formatServiceUpdateReport(isRecord(res) ? res : {});
                showOutputModal("/update", report);
                return true;
            }
            if (name === "share") {
                const res = await call("workspace.share", { folder: rest });
                const folder = isRecord(res) && typeof res.folder === "string" ? res.folder : rest;
                showStatus(`Shared digest: ${folder}.`);
                return true;
            }
            if (name === "rollback") {
                const res = await call("session.rollback", { to: args[0] });
                const restored = isRecord(res) && Array.isArray(res.restored) ? res.restored.length : 0;
                const skipped = isRecord(res) && Array.isArray(res.skipped) ? res.skipped.length : 0;
                const to = isRecord(res) && typeof res.to === "string" ? res.to : args[0];
                showStatus(`Rolled back to ${to} (${restored} restored, ${skipped} skipped).`);
                return true;
            }
            if (name === "workspaces" || (name === "workspace" && !rest)) {
                const wsDialog = $("#dialog-workspaces");
                if (wsDialog instanceof HTMLDialogElement) {
                    if (!wsDialog.open) wsDialog.showModal();
                    return true;
                }
                const res = await call("workspace.list", {});
                signal.throwIfAborted();
                const items = isRecord(res) && Array.isArray(res.workspaces) ? res.workspaces : [];
                if (items.length === 0) {
                    showStatus("workspaces: none");
                } else {
                    const lines = items.map((w) => {
                        if (!isRecord(w)) return String(w);
                        const wsName = typeof w.name === "string" ? w.name : "";
                        const root = typeof w.projectRoot === "string" ? w.projectRoot : "(folderless)";
                        return `${wsName}  ${root}`;
                    });
                    showOutputModal("/workspaces", lines.join("\n"));
                }
                return true;
            }
            if (name === "workspace") {
                const targetPath = directoryPath({ kind: "workspace", workspace: rest });
                if (!targetPath) throw new Error(`Invalid workspace address: ${rest}.`);
                if (actions.navigate) actions.navigate(targetPath);
                else location.assign(targetPath);
                return true;
            }
            if (name === "rename") {
                const { workspaceName, sessionName } = readIdentity();
                const res = await call("workspace.rename", { from: workspaceName, name: rest });
                const nextName = isRecord(res) && typeof res.name === "string" ? res.name : rest;
                showStatus(`Workspace: ${nextName}.`);
                const targetPath = directoryPath({ kind: "session", workspace: nextName, session: sessionName });
                if (targetPath) actions.navigate?.(targetPath);
                return true;
            }
            if (name === "sessions" || (name === "session" && !args[0])) {
                const openSessionsBtn = $("[data-open-sessions]");
                if (openSessionsBtn instanceof HTMLButtonElement) {
                    openSessionsBtn.click();
                    return true;
                }
                const { sessionName } = readIdentity();
                const res = await call("workspace.sessions", {});
                signal.throwIfAborted();
                const items = isRecord(res) && Array.isArray(res.sessions) ? res.sessions : [];
                if (items.length === 0) {
                    showStatus(`● ${sessionName}`);
                } else {
                    const lines = items.map((s) => {
                        if (!isRecord(s)) return String(s);
                        const sName = typeof s.name === "string" ? s.name : "";
                        const mark = sName === sessionName ? "●" : "○";
                        const lc = typeof s.lifecycle === "string" && s.lifecycle !== "idle" && s.lifecycle !== "completed"
                            ? ` (${s.lifecycle})`
                            : "";
                        return `${mark} ${sName}${lc}`;
                    });
                    showOutputModal("/sessions", lines.join("\n"));
                }
                return true;
            }
            if (name === "session") {
                const { workspaceName } = readIdentity();
                let exists = actions.hasSession?.(args[0]) === true;
                if (!exists && actions.hasSession !== undefined) {
                    const res = await call("workspace.sessions", {});
                    const items = isRecord(res) && Array.isArray(res.sessions) ? res.sessions : [];
                    exists = items.some((s) => isRecord(s) && s.name === args[0] && s.origin === "model" && !s.archivedAt);
                }
                if (!exists) {
                    await call("session/new", { _meta: { plurnk: { workspace: workspaceName, session: args[0] } } });
                }
                const targetPath = directoryPath({ kind: "session", workspace: workspaceName, session: args[0] });
                showStatus(`Session: ${args[0]}.`);
                if (targetPath) actions.navigate?.(targetPath);
                return true;
            }
            if (name === "fork") {
                const { workspaceName } = readIdentity();
                const res = await call("session/fork", args[0] ? { name: args[0] } : {});
                const rawSessionId = isRecord(res) && typeof res.sessionId === "string" ? res.sessionId : "";
                const forkedName = rawSessionId.includes("#") ? (rawSessionId.split("#")[1] ?? "") : (args[0] ?? "");
                if (!forkedName) throw new Error("Fork response returned no session name.");
                showStatus(`Forked session: ${forkedName}.`);
                const targetPath = directoryPath({ kind: "session", workspace: workspaceName, session: forkedName });
                if (targetPath) actions.navigate?.(targetPath);
                return true;
            }
            if (name === "parent" || name === "enter" || name === "older" || name === "newer") {
                const { workspaceName, sessionName } = readIdentity();
                const res = await call("workspace.sessions", {});
                signal.throwIfAborted();
                const rawSessions = isRecord(res) && Array.isArray(res.sessions) ? res.sessions : [];
                const sessions = rawSessions.filter((s) => isRecord(s) && s.origin !== "maintenance" && s.origin !== "scratch");
                const current = sessions.find((s) => isRecord(s) && s.name === sessionName);
                const parentIdOf = (/** @type {unknown} */ s) => isRecord(s) && typeof s.parentSessionId === "number" ? s.parentSessionId : null;
                /** @type {string | null} */
                let targetName = null;
                if (name === "parent") {
                    const pid = parentIdOf(current);
                    const parent = pid !== null ? sessions.find((s) => isRecord(s) && s.id === pid) : undefined;
                    if (!isRecord(parent) || typeof parent.name !== "string") {
                        showStatus("(at the root: no parent)");
                        return true;
                    }
                    targetName = parent.name;
                } else if (name === "enter") {
                    const curId = isRecord(current) && typeof current.id === "number" ? current.id : null;
                    const children = curId !== null ? sessions.filter((s) => parentIdOf(s) === curId) : [];
                    const newest = children.at(-1);
                    if (!isRecord(newest) || typeof newest.name !== "string") {
                        showStatus("(no children)");
                        return true;
                    }
                    targetName = newest.name;
                } else {
                    const pid = parentIdOf(current);
                    const siblings = sessions.filter((s) => parentIdOf(s) === pid);
                    if (siblings.length <= 1) {
                        showStatus("(no siblings)");
                        return true;
                    }
                    const idx = siblings.findIndex((s) => isRecord(s) && s.name === sessionName);
                    const nextIdx = name === "older"
                        ? (idx - 1 + siblings.length) % siblings.length
                        : (idx + 1) % siblings.length;
                    const chosen = siblings[nextIdx];
                    if (isRecord(chosen) && typeof chosen.name === "string") targetName = chosen.name;
                }
                if (targetName) {
                    showStatus(`Session: ${targetName}.`);
                    const targetPath = directoryPath({ kind: "session", workspace: workspaceName, session: targetName });
                    if (targetPath) actions.navigate?.(targetPath);
                }
                return true;
            }
            if (name === "loops" || name === "loop") {
                const reqSeq = name === "loop" && args[0] ? Number.parseInt(args[0], 10) : undefined;
                const res = await call("session.loops", reqSeq !== undefined ? { loopSeq: reqSeq } : {});
                signal.throwIfAborted();
                const items = (isRecord(res) && Array.isArray(res.items) ? res.items : [])
                    .filter(isRecord)
                    .toSorted((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0));
                if (items.length === 0) {
                    showStatus("(no loops yet)");
                    return true;
                }
                if (name === "loops") {
                    const lines = items.map((l) => {
                        const seq = String(l.sequence ?? "");
                        const rawOpening = typeof l.opening === "string" ? l.opening : "";
                        const firstLine = rawOpening.split(/\r?\n/u).map((s) => s.trim()).find(Boolean) ?? "";
                        const withEllipsis = l.continued === true && firstLine && !firstLine.endsWith("…")
                            ? `${firstLine}…`
                            : firstLine;
                        const clipped = withEllipsis.length > 160 ? `${withEllipsis.slice(0, 160)}…` : withEllipsis;
                        return `${seq}: ${clipped}`;
                    });
                    showOutputModal("/loops", lines.join("\n"));
                    return true;
                }
                const targetSeq = reqSeq ?? Number(items.at(-1)?.sequence ?? 1);
                const targetLoop = items.find((i) => Number(i.sequence) === targetSeq);
                if (!targetLoop) {
                    showStatus(`(no loop ${targetSeq}; /loops lists them)`);
                    return true;
                }
                const detail = reqSeq !== undefined ? res : await call("session.loops", { loopSeq: targetSeq });
                const updates = isRecord(detail) && Array.isArray(detail.updates) ? detail.updates : [];
                const lines = [`── loop ${targetSeq} ──`];
                if (typeof targetLoop.opening === "string" && targetLoop.opening) {
                    const suffix = targetLoop.continued === true && !targetLoop.opening.endsWith("…") ? "…" : "";
                    lines.push(`> ${targetLoop.opening}${suffix}`);
                }
                for (const u of updates) {
                    if (!isRecord(u)) continue;
                    if (u.sessionUpdate === "tool_call_update" && typeof u.title === "string") {
                        lines.push(u.title);
                    } else if (u.sessionUpdate === "agent_message" && Array.isArray(u.content)) {
                        const msgText = u.content
                            .map((c) => isRecord(c) && typeof c.text === "string" ? c.text : "")
                            .join("");
                        if (msgText) lines.push(msgText);
                    }
                }
                showOutputModal(`/loop ${targetSeq}`, lines.join("\n"));
                return true;
            }
            if (name === "review") {
                const gates = actions.getPendingGates?.() ?? [];
                if (gates.length === 0) {
                    showStatus("review: none");
                } else {
                    const lines = gates.map((g) => {
                        if (g.method === "session/request_permission") {
                            const facts = g._meta?.plurnk?.proposal;
                            const label = facts ? `${facts.session} ${facts.op}` : "permission";
                            return `@${g.id}  permission  ${label}`;
                        }
                        return `@${g.id}  elicitation  ${g.message ?? "input required"}`;
                    });
                    showOutputModal("/review", lines.join("\n"));
                }
                return true;
            }
            if (name === "accept" || name === "approve" || name === "reject" || name === "cancel" || name === "edit" || name === "answer") {
                if (!actions.resolveGate) throw new Error("Gate resolution is unavailable outside an active session.");
                const gates = actions.getPendingGates?.() ?? [];
                const hasExplicitId = args[0]?.startsWith("@") === true;
                const gate = selectGate(gates, hasExplicitId ? args[0] : undefined, name);
                if (name === "edit") {
                    if (gate.method !== "session/request_permission") {
                        throw new Error(`Gate @${gate.id} is not a permission proposal.`);
                    }
                    const bodyMatch = hasExplicitId
                        ? /^\/\S+\s+\S+(?:\r?\n|[ \t])([\s\S]*)$/u.exec(text.trim())
                        : /^\/\S+(?:\r?\n|[ \t])([\s\S]*)$/u.exec(text.trim());
                    const editedBody = bodyMatch?.[1] ?? "";
                    if (!editedBody) throw new Error("Usage: /edit [@id] <body...>.");
                    await actions.resolveGate({
                        id: gate.id,
                        method: "session/request_permission",
                        response: {
                            outcome: { outcome: "selected", optionId: allowOptionId(gate) },
                            _meta: { plurnk: { body: editedBody } },
                        },
                    });
                    showStatus(`Submitted edited proposal @${gate.id}.`);
                } else if (name === "answer") {
                    if (gate.method !== "elicitation/create") {
                        throw new Error(`Gate @${gate.id} is not an elicitation request.`);
                    }
                    const payloadMatch = hasExplicitId
                        ? /^\/\S+\s+\S+(?:\r?\n|[ \t])([\s\S]*)$/u.exec(text.trim())
                        : /^\/\S+(?:\r?\n|[ \t])([\s\S]*)$/u.exec(text.trim());
                    const rawPayload = (payloadMatch?.[1] ?? "").trim();
                    /** @type {Record<string, unknown>} */
                    let content = {};
                    if (rawPayload) {
                        try {
                            const parsedJson = /** @type {unknown} */ (JSON.parse(rawPayload));
                            content = isRecord(parsedJson) ? parsedJson : { answer: parsedJson };
                        } catch {
                            content = { answer: rawPayload };
                        }
                    }
                    await actions.resolveGate({
                        id: gate.id,
                        method: "elicitation/create",
                        response: { action: "accept", content },
                    });
                    showStatus(`Submitted answer for @${gate.id}.`);
                } else if (name === "cancel") {
                    await actions.resolveGate(gate.method === "session/request_permission"
                        ? { id: gate.id, method: "session/request_permission", response: { outcome: { outcome: "cancelled" } } }
                        : { id: gate.id, method: "elicitation/create", response: { action: "cancel" } });
                    showStatus(`Cancelled @${gate.id}.`);
                } else if (name === "reject") {
                    await actions.resolveGate(gate.method === "session/request_permission"
                        ? { id: gate.id, method: "session/request_permission", response: { outcome: { outcome: "selected", optionId: rejectOptionId(gate) } } }
                        : { id: gate.id, method: "elicitation/create", response: { action: "decline" } });
                    showStatus(`Rejected @${gate.id}.`);
                } else {
                    await actions.resolveGate(gate.method === "session/request_permission"
                        ? { id: gate.id, method: "session/request_permission", response: { outcome: { outcome: "selected", optionId: allowOptionId(gate) } } }
                        : { id: gate.id, method: "elicitation/create", response: { action: "accept" } });
                    showStatus(`Accepted @${gate.id}.`);
                }
                return true;
            }
            return true;
        } catch (error) {
            const { message, recovery } = await describeFailure(error);
            showError(signal.aborted ? "Response not confirmed." : [message, recovery].filter(Boolean).join(" "));
            return false;
        }
    };

    const dismissAll = () => {
        if (outputDialog?.open) {
            outputDialog.close();
            return true;
        }
        const feedback = $(main, '[aria-label="Message feedback"]');
        if (feedback instanceof HTMLElement) {
            const curStatus = the(feedback, "message-status") ?? "";
            const curError = the(feedback, "command-error") ?? "";
            if ((curStatus && curStatus !== "Sending…") || curError) {
                the(feedback, { "message-status": "", "command-error": "" });
                return true;
            }
        }
        return false;
    };

    const showHelp = () => {
        navigateToSettings("help");
        return true;
    };

    return Object.assign(execute, { dismissAll, showHelp });
}
