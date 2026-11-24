import { $, $$, on, the } from "on_the_money";
import { createComposerAttachments, createPromptHistory } from "./session-attachments.js";
import {
    acceptCommandSuggestion,
    computeCommandSuggestions,
    isCommand,
    isLocalExec,
    prepareComposerPrompt,
    primaryModifierLabel,
} from "./session-commands.js";
import { flattenSelectOptions } from "./session-models.js";
import { isRecord } from "./session-translator.js";

const COMPOSER_MODEL_DEBOUNCE_MS = 100;

/** @typedef {import("./session-translator.js").Message} Message */
/** @typedef {import("./session-agent-updates.js").PromptImageAttachment} PromptImageAttachment */
/** @typedef {import("./session-gates.js").SessionGate} SessionGate */
/** @typedef {import("./session-models.js").ModelChoice} ModelChoice */
/** @typedef {ReturnType<typeof import("./session-models.js").createModelSearchCache>} ModelSearchCache */
/** @typedef {import("@plurnk/plurnk-acp/client").AcpSessionStatus} AcpSessionStatus */

/**
 * {§web-session-input} {§web-session-commands} {§web-inline-images}
 * Session composer controller: draft storage, prompt history, raster image attachments, and live slash/model/skill suggestions.
 * @param {{
 *   readonly controls: Element,
 *   readonly footer: HTMLElement,
 *   readonly feedback: Element,
 *   readonly sessionId: string,
 *   readonly slate: ReturnType<typeof import("./reading-slate.js").default>,
 *   readonly modelSearchCache: ModelSearchCache,
 *   readonly getAgentState: () => Record<string, unknown>,
 *   readonly getStatus: () => AcpSessionStatus | undefined,
 *   readonly getConnection: () => string | null,
 *   readonly getPendingGates: () => readonly SessionGate[],
 *   readonly getPromptImageSupported: () => boolean,
 *   readonly getWorkspaceProjectRoot: () => string | null | undefined,
 *   readonly getLatestWorkspaceName: () => string,
 *   readonly getWorkbenchSnapshot?: () => { readonly workspaces: readonly string[], readonly sessions: readonly string[], readonly projectRoot: string | null },
 *   readonly hasPendingDelivery: () => boolean,
 *   readonly isDisposed: () => boolean,
 *   readonly onAvailabilityChange: () => void,
 *   readonly onRunCommand: (text: string) => Promise<boolean>,
 *   readonly onSubmitPrompt: (payload: {
 *     readonly source: string,
 *     readonly sourceKey: string,
 *     readonly prompt: string,
 *     readonly forceReview: boolean,
 *     readonly openPaths: readonly string[],
 *     readonly attachments: readonly PromptImageAttachment[],
 *     readonly attachmentIds: ReadonlySet<string>,
 *   }) => void,
 * }} options
 */
export function createSessionComposer({
    controls,
    footer,
    feedback,
    sessionId,
    slate,
    modelSearchCache,
    getAgentState,
    getStatus,
    getConnection,
    getPendingGates,
    getPromptImageSupported,
    getWorkspaceProjectRoot,
    getLatestWorkspaceName,
    getWorkbenchSnapshot,
    hasPendingDelivery,
    isDisposed,
    onAvailabilityChange,
    onRunCommand,
    onSubmitPrompt,
}) {
    const compose = $(controls, "#session-compose");
    const stop = $(controls, "#session-stop");
    const attachInput = $(controls, "[data-attach-input]");
    const suggestionList = $(controls, "[data-compose-suggestions]");
    const attachmentList = $(controls, "[data-compose-attachments]");
    const field = $(controls, "#session-message");
    const sendButton = $(controls, 'button[form="session-compose"]');
    if (!(compose instanceof HTMLFormElement) || !(stop instanceof HTMLFormElement)
        || !($(controls, "[data-attach-image]") instanceof HTMLButtonElement)
        || !(attachInput instanceof HTMLInputElement)
        || !(suggestionList instanceof HTMLUListElement)
        || !(attachmentList instanceof HTMLUListElement)
        || !(field instanceof HTMLTextAreaElement) || !(sendButton instanceof HTMLButtonElement)) {
        throw new Error("Session controls are incomplete.");
    }
    const draft = field;
    const suggestionOutlet = suggestionList;
    const defaultPlaceholder = draft.getAttribute("placeholder") || "Message…";

    const coarseMedia = window.matchMedia("(pointer: coarse)");
    const syncSendShortcuts = () => {
        const mod = primaryModifierLabel();
        if (coarseMedia.matches) {
            sendButton.setAttribute("aria-keyshortcuts", "Control+Enter Meta+Enter");
            sendButton.title = `Send (${mod}+Enter)`;
        } else {
            sendButton.setAttribute("aria-keyshortcuts", "Enter Control+Enter Meta+Enter");
            sendButton.title = `Send (Enter · ${mod}+Enter)`;
        }
    };
    syncSendShortcuts();
    const offCoarseMedia = on.target(coarseMedia, "change", syncSendShortcuts);

    const draftKey = `plurnk:draft:${sessionId}`;
    /** @returns {string | null} */
    function readStoredDraft() {
        try { return sessionStorage.getItem(draftKey); }
        catch { return null; }
    }
    /** @param {string} value */
    function writeStoredDraft(value) {
        try {
            if (value === "") sessionStorage.removeItem(draftKey);
            else sessionStorage.setItem(draftKey, value);
        } catch {
            // Disabled or quota-exhausted Web Storage degrades cleanly to in-memory editing.
        }
    }
    if (draft.value === "") {
        const savedDraft = readStoredDraft();
        if (savedDraft !== null && savedDraft !== "") draft.value = savedDraft;
    }

    const history = createPromptHistory();
    const attachmentStaging = createComposerAttachments({
        compose,
        controls,
        draft,
        fileInput: attachInput,
        attachmentOutlet: attachmentList,
        feedback,
        slate,
        getPromptImageSupported,
        hasPendingDelivery,
        isDisposed,
        onAvailabilityChange,
    });

    /** @type {ModelChoice[]} */
    let liveModelChoices = [];
    /** @type {ModelChoice[]} */
    let liveChildChoices = [];
    /** @type {Record<string, readonly string[]>} */
    const liveEffortsByModel = Object.create(null);
    let lastModelLookupKey = "";
    /** @type {ReturnType<typeof setTimeout> | null} */
    let composerModelTimer = null;
    /** @type {AbortController | null} */
    let composerModelLookup = null;
    let activeSuggestionIndex = 0;
    let suggestionsDismissed = false;
    let lastSuggestionsSignature = "";
    let lastRenderedSuggestionsSignature = "";

    const availableCommands = () => {
        const plurnk = /** @type {Record<string, unknown> | undefined} */ (getAgentState().plurnk);
        return Array.isArray(plurnk?.availableCommands)
            ? /** @type {readonly { readonly name: string, readonly type?: string }[]} */ (plurnk.availableCommands)
            : [];
    };

    const promptSuggestions = () => {
        const plurnk = /** @type {Record<string, unknown> | undefined} */ (getAgentState().plurnk);
        return Array.isArray(plurnk?.promptSuggestions)
            ? /** @type {readonly string[]} */ (plurnk.promptSuggestions.filter((item) => typeof item === "string" && item.length > 0))
            : [];
    };

    /** @param {string} value */
    const isClientDispatch = (value) => isCommand(value, availableCommands()) || isLocalExec(value);

    const clearComposerModelTimer = () => {
        if (composerModelTimer !== null) {
            clearTimeout(composerModelTimer);
            composerModelTimer = null;
        }
    };

    const abortComposerModelLookup = () => {
        clearComposerModelTimer();
        composerModelLookup?.abort();
        composerModelLookup = null;
    };

    /** @returns {import("./session-commands.js").SuggestionSources} */
    function buildSuggestionSources() {
        const plurnk = /** @type {Record<string, unknown> | undefined} */ (getAgentState().plurnk);
        const configOptions = Array.isArray(plurnk?.configOptions) ? plurnk.configOptions : [];
        const providers = Array.isArray(plurnk?.providers) ? plurnk.providers : [];
        const readOptionValues = (/** @type {string} */ id) => {
            const opt = configOptions.find((entry) => isRecord(entry) && entry.configId === id);
            return isRecord(opt)
                ? flattenSelectOptions(opt.options).flatMap((o) => typeof o.value === "string" && o.value ? [o.value] : [])
                : [];
        };
        const providerAliases = providers.flatMap((p) => isRecord(p) && typeof p.alias === "string" && p.alias ? [p.alias] : []);
        const models = [...providerAliases, ...readOptionValues("model").filter((v) => v !== "none")];
        const efforts = readOptionValues("thought_level");
        const personaOptions = readOptionValues("persona");
        /** @type {Partial<Record<"mcp" | "skills" | "schedule" | "personas" | "members" | "env", readonly string[]>>} */
        const familyAliases = {};
        for (const family of /** @type {const} */ (["mcp", "skills", "schedule", "personas"])) {
            const prefix = `${family}:`;
            const aliases = configOptions.flatMap((entry) =>
                isRecord(entry) && typeof entry.configId === "string" && entry.configId.startsWith(prefix)
                    ? [entry.configId.slice(prefix.length)]
                    : []);
            if (aliases.length > 0) familyAliases[family] = aliases;
        }
        const personas = personaOptions.length > 0
            ? personaOptions
            : ["none", ...(familyAliases.personas ?? [])];
        const childModels = [...readOptionValues("child"), ...models];
        const modes = readOptionValues("mode");
        const wb = getWorkbenchSnapshot?.();
        const latestWorkspaceName = getLatestWorkspaceName();
        const workspaces = wb
            ? wb.workspaces
            : (latestWorkspaceName ? [latestWorkspaceName] : []);
        const currentSessionName = footer.dataset.sessionName || "";
        const status = getStatus();
        const descendantNames = Array.isArray(status?.descendants)
            ? status.descendants.flatMap((d) => typeof d?.name === "string" && d.name ? [d.name] : [])
            : [];
        const sessions = wb
            ? wb.sessions
            : [...new Set([currentSessionName, ...descendantNames].filter(Boolean))];
        const workspaceProjectRoot = getWorkspaceProjectRoot();
        const effectiveProjectRoot = workspaceProjectRoot !== undefined ? workspaceProjectRoot : wb?.projectRoot;
        const latestLoopId = status?.loopId;
        const loops = typeof latestLoopId === "number" && latestLoopId > 0
            ? Array.from({ length: latestLoopId }, (_, idx) => String(latestLoopId - idx))
            : [];
        return {
            availableCommands: availableCommands(),
            promptSuggestions: promptSuggestions(),
            models,
            ...(liveModelChoices.length > 0 ? { modelChoices: liveModelChoices } : {}),
            efforts,
            ...(Object.keys(liveEffortsByModel).length > 0 ? { effortsByModel: liveEffortsByModel } : {}),
            personas,
            childModels,
            ...(liveChildChoices.length > 0 ? { childModelChoices: liveChildChoices } : {}),
            ...(modes.length > 0 ? { modes } : {}),
            workspaces,
            sessions,
            loops,
            gateIds: getPendingGates().map((g) => `@${g.id}`),
            familyAliases,
            ...(effectiveProjectRoot !== undefined ? { projectRoot: effectiveProjectRoot } : {}),
        };
    }

    /** @param {string} rawInput */
    function scheduleComposerModelLookup(rawInput) {
        if (isDisposed()) return;
        const trimmedStart = rawInput.trimStart();
        if (trimmedStart.startsWith(": ") || rawInput.includes("\n")) {
            lastModelLookupKey = "";
            abortComposerModelLookup();
            return;
        }
        const argMatch = /^\/(model|child)\s+([\s\S]*)$/iu.exec(trimmedStart);
        if (!argMatch) {
            lastModelLookupKey = "";
            abortComposerModelLookup();
            return;
        }
        const cmd = (argMatch[1] ?? "").toLowerCase();
        const restRaw = argMatch[2] ?? "";
        const endsWithSpace = restRaw === "" || /\s$/u.test(restRaw);
        const parts = restRaw.trim() ? restRaw.trim().split(/\s+/u) : [];
        const completedArgs = endsWithSpace ? parts : parts.slice(0, -1);
        const partial = endsWithSpace ? "" : (parts.at(-1) ?? "");

        if (cmd === "model" && completedArgs.length === 1) {
            const selector = completedArgs[0] ?? "";
            if (!selector || (liveEffortsByModel[selector]?.length ?? 0) > 0) {
                abortComposerModelLookup();
                return;
            }
            const key = `efforts:${selector}`;
            if (key === lastModelLookupKey) return;
            lastModelLookupKey = key;
            abortComposerModelLookup();
            const controller = composerModelLookup = new AbortController();
            void modelSearchCache.resolveEfforts(selector, controller.signal).then((resolved) => {
                if (isDisposed() || controller.signal.aborted) return;
                if (resolved.efforts.length > 0) {
                    liveEffortsByModel[selector] = resolved.efforts;
                    syncSuggestions();
                    slate.sync();
                }
            }).catch(() => {});
            return;
        }

        if (completedArgs.length !== 0) return;
        const includeInherit = cmd === "child";
        const key = `${cmd}:${partial.toLowerCase()}`;
        if (key === lastModelLookupKey) return;
        lastModelLookupKey = key;

        const cached = modelSearchCache.searchCached(partial, { includeInherit });
        if (cached.length > 0) {
            if (includeInherit) liveChildChoices = cached;
            else liveModelChoices = cached;
            for (const choice of cached) {
                if (choice.efforts.length > 0) liveEffortsByModel[choice.value] = choice.efforts;
            }
        }

        const runLookup = async () => {
            abortComposerModelLookup();
            const controller = composerModelLookup = new AbortController();
            try {
                const res = await modelSearchCache.search(partial, {
                    includeInherit,
                    limit: 40,
                    signal: controller.signal,
                });
                if (isDisposed() || controller.signal.aborted) return;
                if (includeInherit) liveChildChoices = res.items;
                else liveModelChoices = res.items;
                for (const choice of res.items) {
                    if (choice.efforts.length > 0) liveEffortsByModel[choice.value] = choice.efforts;
                }
                syncSuggestions();
                slate.sync();
            } catch {
                // Ignore aborted or unavailable transient catalog lookups while typing.
            } finally {
                if (composerModelLookup === controller) composerModelLookup = null;
            }
        };

        clearComposerModelTimer();
        if (partial === "") {
            void runLookup();
        } else {
            composerModelTimer = setTimeout(() => {
                composerModelTimer = null;
                void runLookup();
            }, COMPOSER_MODEL_DEBOUNCE_MS);
        }
    }

    function computeComposeSuggestions() {
        const status = getStatus();
        const live = Boolean(status && ["queued", "running", "parked"].includes(status.lifecycle));
        const allowPromptSuggestions = !live && getConnection() !== "interrupted";
        return computeCommandSuggestions(draft.value, buildSuggestionSources(), { allowPromptSuggestions });
    }

    /** @param {string} suggestion */
    function acceptComposeSuggestion(suggestion) {
        const nextValue = acceptCommandSuggestion(draft.value, suggestion, buildSuggestionSources());
        if (nextValue === draft.value) return;
        suggestionsDismissed = false;
        activeSuggestionIndex = 0;
        draft.value = nextValue;
        draft.focus();
        draft.setSelectionRange(draft.value.length, draft.value.length);
        draft.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function paintSuggestionHighlight() {
        const rows = $$(suggestionOutlet, "[data-suggestion-item]");
        for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i];
            if (!(row instanceof HTMLElement)) continue;
            const active = i === activeSuggestionIndex;
            row.dataset.suggestionActive = active ? "true" : "false";
            const btn = $(row, "[data-accept-suggestion]");
            if (btn instanceof HTMLElement) {
                btn.setAttribute("aria-selected", active ? "true" : "false");
            }
            if (active) row.scrollIntoView({ block: "nearest" });
        }
    }

    function syncSuggestions() {
        scheduleComposerModelLookup(draft.value);
        if (suggestionsDismissed) {
            if (lastRenderedSuggestionsSignature !== "") {
                lastRenderedSuggestionsSignature = "";
                suggestionOutlet.replaceChildren();
                delete suggestionOutlet.dataset.suggestionsMode;
            }
            draft.placeholder = defaultPlaceholder;
            return;
        }
        const { kind, items, details, menu } = computeComposeSuggestions();
        const sig = `${kind}\0${items.join("\0")}`;
        if (sig !== lastSuggestionsSignature) {
            lastSuggestionsSignature = sig;
            activeSuggestionIndex = 0;
        } else if (activeSuggestionIndex >= items.length) {
            activeSuggestionIndex = Math.max(0, items.length - 1);
        }
        if (items.length > 0) {
            const detailSig = details ? items.map((item) => details[item] ?? "").join("\0") : "";
            const renderSig = `${menu ? "menu" : "pills"}\0${sig}\0${detailSig}`;
            if (renderSig !== lastRenderedSuggestionsSignature || suggestionOutlet.childElementCount !== items.length) {
                lastRenderedSuggestionsSignature = renderSig;
                suggestionOutlet.dataset.suggestionsMode = menu ? "menu" : "pills";
                $.cloneEach(suggestionOutlet, "#compose-suggestion", items, (item, text, index) => {
                    const active = kind !== "prompt" && index === activeSuggestionIndex;
                    if (item instanceof HTMLElement) {
                        item.dataset.suggestionActive = active ? "true" : "false";
                    }
                    const btn = $(item, "[data-accept-suggestion]");
                    if (btn instanceof HTMLElement) {
                        btn.dataset.suggestionValue = text;
                        btn.setAttribute("aria-selected", active ? "true" : "false");
                    }
                    the(item, {
                        "suggestion-text": text,
                        "suggestion-detail": details?.[text] ?? "",
                    });
                });
            }
            if (kind === "prompt") {
                const lead = items[0]?.replaceAll(/\s+/gu, " ").trim() ?? "";
                draft.placeholder = lead ? `→ ${lead} (Tab)` : defaultPlaceholder;
            } else {
                draft.placeholder = defaultPlaceholder;
            }
        } else {
            if (lastRenderedSuggestionsSignature !== "" || suggestionOutlet.childElementCount > 0) {
                lastRenderedSuggestionsSignature = "";
                suggestionOutlet.replaceChildren();
                delete suggestionOutlet.dataset.suggestionsMode;
            }
            draft.placeholder = defaultPlaceholder;
        }
    }

    /**
     * @param {string} id
     * @param {{ readonly source: string, readonly attachmentIds: ReadonlySet<string> }} acknowledgedPending
     */
    function acknowledgePrompt(id, acknowledgedPending) {
        history.recordSubmitted(id, acknowledgedPending.source);
        if (draft.value === acknowledgedPending.source) {
            draft.value = "";
            writeStoredDraft("");
        }
        attachmentStaging.removeAcknowledged(acknowledgedPending.attachmentIds);
    }

    function restoreSavedDraft() {
        const savedDraft = readStoredDraft() ?? "";
        if (draft.value !== savedDraft) draft.value = savedDraft;
    }

    on(compose, "input", "textarea", () => {
        history.resetCursor();
        suggestionsDismissed = false;
        draft.setCustomValidity("");
        const value = draft.value;
        writeStoredDraft(value.trim() !== "" && !isClientDispatch(value) ? value : "");
        onAvailabilityChange();
        slate.sync();
    });
    on(compose, "click", "[data-insert-command]", () => {
        if (the(controls, "send-unavailable") !== null) return;
        suggestionsDismissed = false;
        draft.value = draft.value === "/" ? "" : "/";
        draft.focus();
        draft.setSelectionRange(draft.value.length, draft.value.length);
        draft.dispatchEvent(new Event("input", { bubbles: true }));
    });
    on(compose, "click", "[data-accept-suggestion]", (_event, button) => {
        const value = button instanceof HTMLElement
            ? (button.dataset.suggestionValue || $(button, '[data-text="suggestion-text"]')?.textContent || button.textContent || "")
            : (button.textContent ?? "");
        acceptComposeSuggestion(value);
    });
    on(compose, "keydown", "textarea", (event) => {
        if (!(event instanceof KeyboardEvent) || event.isComposing) return;
        if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
            && (event.key === "ArrowUp" || event.key === "ArrowDown")
            && draft.selectionStart === draft.selectionEnd) {
            if (!suggestionsDismissed && !history.isBrowsing() && draft.value !== "") {
                const { kind, items } = computeComposeSuggestions();
                if (kind !== "prompt" && items.length > 0) {
                    event.preventDefault();
                    activeSuggestionIndex = event.key === "ArrowDown"
                        ? (activeSuggestionIndex + 1) % items.length
                        : (activeSuggestionIndex - 1 + items.length) % items.length;
                    paintSuggestionHighlight();
                    return;
                }
            }
            if (history.navigate(event.key, draft)) {
                event.preventDefault();
                onAvailabilityChange();
                slate.sync();
                return;
            }
        }
        if (event.repeat) return;
        if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
            if (!suggestionsDismissed) {
                const { kind, items } = computeComposeSuggestions();
                const chosen = kind === "prompt" ? items[0] : (items[activeSuggestionIndex] ?? items[0]);
                if (chosen && (kind !== "prompt" || draft.value === "")) {
                    event.preventDefault();
                    acceptComposeSuggestion(chosen);
                }
            }
            return;
        }
        if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
            event.preventDefault();
            if (!suggestionsDismissed) {
                const { kind, items } = computeComposeSuggestions();
                if (kind !== "prompt" && items.length > 0) {
                    suggestionsDismissed = true;
                    syncSuggestions();
                    slate.sync();
                    return;
                }
            }
            draft.blur();
            return;
        }
        if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
            && (event.code === "KeyJ" || event.key === "j" || event.key === "J")) {
            event.preventDefault();
            if (!draft.disabled && !draft.readOnly) {
                draft.setRangeText("\n", draft.selectionStart, draft.selectionEnd, "end");
                draft.dispatchEvent(new Event("input", { bubbles: true }));
            }
            return;
        }
        if (event.key !== "Enter" || event.altKey || event.shiftKey || (event.ctrlKey && event.metaKey)) return;
        if (!event.ctrlKey && !event.metaKey && coarseMedia.matches) return;
        event.preventDefault();
        compose.requestSubmit();
    });
    on(compose, "submit", "form", async (event) => {
        event.preventDefault();
        if (the(controls, "send-unavailable") !== null) return;
        if (isClientDispatch(draft.value)) {
            if (attachmentStaging.hasItems()) {
                the(feedback, {
                    "message-status": "",
                    "command-error": "Remove queued image attachments before running a client slash command.",
                });
                slate.sync();
                return;
            }
            const text = draft.value;
            the(controls, "command-pending", "");
            onAvailabilityChange();
            try {
                if (await onRunCommand(text) && draft.value === text) {
                    history.push(text);
                    history.resetCursor();
                    draft.value = "";
                    writeStoredDraft("");
                }
                slate.jumpToBottom();
            } finally {
                the(controls, "command-pending", null);
                onAvailabilityChange();
            }
            return;
        }
        if (!draft.value.trim() && !attachmentStaging.hasItems()) {
            draft.setCustomValidity("Enter a message.");
            draft.reportValidity();
            return;
        }
        const source = draft.value;
        const workspaceProjectRoot = getWorkspaceProjectRoot();
        const prepared = source.trim()
            ? prepareComposerPrompt(source, workspaceProjectRoot === undefined ? undefined : { projectRoot: workspaceProjectRoot })
            : { ok: /** @type {const} */ (true), prompt: "", forceReview: false, openPaths: /** @type {readonly string[]} */ ([]) };
        if ("error" in prepared) {
            the(feedback, { "message-status": "", "command-error": prepared.error });
            return;
        }
        const { idsKey, items: queuedAttachments, idSet } = attachmentStaging.snapshotPayload();
        onSubmitPrompt({
            source,
            sourceKey: `${source}\0${idsKey}`,
            prompt: prepared.prompt,
            forceReview: prepared.forceReview,
            openPaths: prepared.openPaths,
            attachments: queuedAttachments,
            attachmentIds: idSet,
        });
    });

    return {
        draft,
        stop,
        isClientDispatch,
        syncSuggestions,
        recordMessagesPromptHistory: history.recordMessages,
        acknowledgePrompt,
        restoreSavedDraft,
        dispose() {
            abortComposerModelLookup();
            offCoarseMedia();
        },
    };
}
