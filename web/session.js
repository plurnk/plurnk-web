import { $, $$, on, the } from "on_the_money";
import { parseDirectory } from "../src/directory-addresses.js";
import SessionAgent, { randomUUID } from "./session-agent.js";
import { clocks } from "./session-status.js";
import sessionState from "./session-state.js";
import sessionHistory from "./session-history.js";
import reviewRequests from "./session-review.js";
import diagnostics from "./session-diagnostics.js";
import accessHeaders from "./access-headers.js";
import { acpUrl } from "./endpoints.js";
import { hasActiveOidcGrant, onOidcGrantChange, recoverFromUnauthorized } from "./oidc.js";
import readBody from "./read-body.js";
import readHistory from "./read-history.js";
import managementAction from "./management-action.js";
import { sessionConfigOption } from "./session-models.js";
import sessionCommands, {
    acceptCommandSuggestion,
    computeCommandSuggestions,
    isCommand,
    isLocalExec,
    prepareComposerPrompt,
    primaryModifierLabel,
} from "./session-commands.js";
import { isRecord } from "./session-translator.js";
import describeFailure from "./failure.js";
import { createPassiveReconnect, isRetryableObservationFailure } from "./passive-reconnect.js";
import readingSlate from "./reading-slate.js";
import math from "./math.js";
import mermaid from "./mermaid.js";
import { readRasterFileAttachment } from "./inline-images.js";

/** @param {EventTarget | null} target */
function isTextEntry(target) {
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
    if (target instanceof HTMLInputElement) {
        return !["radio", "checkbox", "button", "submit", "reset", "file"].includes(target.type);
    }
    return target instanceof HTMLElement && target.isContentEditable;
}

/** @typedef {{message?: {id: string, role: "user", content: string, attachments?: readonly import("./session-agent.js").PromptImageAttachment[], openPaths?: readonly string[]}, resolutions?: readonly import("./session-agent.js").GateResolution[], forceReview?: boolean}} Submission */

// {§web-session-status} Repaint elapsed and wait at whole-second precision; no network polling.
const CLOCK_TICK_MS = 1000;
const SENDING_DWELL_MS = 250;

/** {§web-session-observer} The SDK reports a subscriber's exception to the console and continues delivery. Each callback
 * here hands its first failure to `fail` and skips the rest, so the run ends with that cause.
 * @param {import("./session-agent.js").SessionSubscriber} subscriber @param {(error: unknown) => void} fail
 * @returns {import("./session-agent.js").SessionSubscriber}
 */
function failing(subscriber, fail) {
    let failed = false;
    return Object.fromEntries(Object.entries(subscriber).map(([name, callback]) => [name, async (/** @type {never} */ params) => {
        if (failed) return undefined;
        try { return await callback(params); }
        catch (error) {
            failed = true;
            fail(error);
            return undefined;
        }
    }]));
}

/** {§web-session-observer} {§web-session-input} Delivery changes never own the session's lifetime.
 * @param {HTMLElement} element
 * @param {{
 *   main?: Element | null,
 *   transport?: "http" | "ws",
 *   onNavigate?: (targetPath: string) => void,
 *   getWorkbenchSnapshot?: () => { readonly workspaces: readonly string[], readonly sessions: readonly string[], readonly projectRoot: string | null },
 * }} [options]
 */
export default function observeSession(element, { main: suppliedMain = $("#main"), transport, onNavigate, getWorkbenchSnapshot } = {}) {
    const { sessionId } = element.dataset;
    if (!sessionId) throw new Error("Session document metadata is incomplete.");
    if (!(suppliedMain instanceof HTMLElement)) throw new Error("Session document has no main region.");
    const main = suppliedMain;
    const history = $(main, "#session-conversation");
    if (!(history instanceof HTMLElement)) throw new Error("Session document has no conversation outlet.");
    const controls = $.clone(element, "#session-controls");
    // {§web-session-history} What needs the person follows the conversation, where its pinned end is.
    const feedback = $.clone(main, "#session-feedback");
    const notice = $(main, "#session-connection");
    if (!notice) throw new Error("Session document has no connection notice.");
    const connectionNotice = notice;
    const review = reviewRequests(main);
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
    const defaultPlaceholder = draft.getAttribute("placeholder") || "Message…";
    const fileInput = attachInput;
    const suggestionOutlet = suggestionList;
    const attachmentOutlet = attachmentList;
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
    /** @type {Set<string>} */
    const seenHistoryMessageIds = new Set();
    /** @type {string[]} */
    const promptHistory = [];
    let historyIndex = -1;
    /** @type {string | null} */
    let historyDraft = null;
    let connectedWithGrant = false;
    let inFlightAuthRecovery = false;

    /** @param {string} raw */
    function pushPromptHistory(raw) {
        const trimmed = raw.trim();
        if (!trimmed || promptHistory.at(-1) === trimmed) return;
        promptHistory.push(trimmed);
    }

    /** @param {readonly import("./session-agent.js").Message[]} messages */
    function recordMessagesPromptHistory(messages) {
        for (const msg of messages) {
            if (msg.role !== "user" || seenHistoryMessageIds.has(msg.id)) continue;
            seenHistoryMessageIds.add(msg.id);
            const plurnk = /** @type {Record<string, unknown> | undefined} */ (msg._meta?.plurnk);
            if (typeof plurnk?.answering === "string") continue;
            if (
                typeof plurnk?.actor === "string" &&
                plurnk.actor !== "" &&
                plurnk.actor !== "operator" &&
                plurnk.actor !== "anonymous" &&
                plurnk.actor !== "client" &&
                plurnk.actor !== "owner"
            ) {
                continue;
            }
            if (typeof plurnk?.source === "string"
                && (plurnk.source.startsWith("session://") || plurnk.source.startsWith("schedule://"))) {
                continue;
            }
            const rawText = typeof msg.content === "string"
                ? msg.content
                : Array.isArray(msg.content)
                    ? msg.content.map((part) => {
                        if (part.type === "text" && typeof part.text === "string") return part.text;
                        if (part.type === "skill" && typeof part.name === "string") return `$${part.name}`;
                        return "";
                    }).join("")
                    : "";
            const cleaned = rawText
                .split("\n")
                .filter((line) => !/^<session:\/\/[^\s>]+\/attachments\/[0-9a-f]+\/[^\s>]+>$/u.test(line.trim()))
                .join("\n")
                .trim();
            if (cleaned) pushPromptHistory(cleaned);
        }
    }

    the(feedback, "message-status", "");
    let resources = new AbortController();
    const transcript = sessionHistory(history, (address) => readBody(address, resources.signal),
        (address, signal) => readHistory(address, AbortSignal.any([signal, resources.signal])));
    const diagnosticList = $(main, "#session-diagnostics");
    if (!(diagnosticList instanceof HTMLElement)) throw new Error("Session document has no diagnostics outlet.");
    const diagnose = diagnostics(diagnosticList);
    const presentState = sessionState(element, main);
    const effectiveTransport = transport ?? ($('#workspace-tabs[data-live="true"]') ? "ws" : "http");
    const agent = new SessionAgent({ url: acpUrl(), sessionId, transport: effectiveTransport });
    void import("@plurnk/plurnk-contracts").catch(() => {});
    /** @type {string | null | undefined} */
    let workspaceProjectRoot = $(main.ownerDocument.body, '#session-workspace [aria-label="Folderless workspace"]') ? null : undefined;
    let latestWorkspaceName = $('#session-workspace [data-text="workspace-name"]')?.textContent?.trim()
        || $("#session-workspace")?.textContent?.trim()
        || "";
    /** @type {import("@plurnk/plurnk-acp/client").AcpSessionStatus | undefined} */
    let status;
    /** @type {{message: {id: string, role: "user", content: string, attachments?: readonly import("./session-agent.js").PromptImageAttachment[], openPaths?: readonly string[]}, source: string, sourceKey: string, attachmentIds: ReadonlySet<string>, retryable: boolean} | undefined} */
    let pending;
    /** @type {{ id: string, name: string, mimeType: string, data: string, sizeLabel: string }[]} */
    let attachments = [];
    /** @type {{controller: AbortController, done: Promise<void>} | undefined} */
    let delivery;
    /** @type {AbortController | undefined} */
    let cancellation;
    // {§web-session-input} An interrupt that has arrived and is not yet presented holds Send until its review appears.
    let arriving = false;
    let disposed = false;
    const availableCommands = () => {
        const plurnk = /** @type {Record<string, unknown> | undefined} */ (agent.state.plurnk);
        return Array.isArray(plurnk?.availableCommands)
            ? /** @type {readonly { readonly name: string, readonly type?: string }[]} */ (plurnk.availableCommands)
            : [];
    };
    const promptSuggestions = () => {
        const plurnk = /** @type {Record<string, unknown> | undefined} */ (agent.state.plurnk);
        return Array.isArray(plurnk?.promptSuggestions)
            ? /** @type {readonly string[]} */ (plurnk.promptSuggestions.filter((item) => typeof item === "string" && item.length > 0))
            : [];
    };
    const isClientDispatch = (/** @type {string} */ value) => isCommand(value, availableCommands()) || isLocalExec(value);
    /** @param {string} kind @param {Record<string, unknown>} [params] @param {AbortSignal} [signal] */
    const action = (kind, params = {}, signal = resources.signal) => managementAction(kind, params, sessionId, signal, { redirectOn401: false });
    const toggleYolo = async () => {
        const currentMode = the(element, "approval-mode") ?? "review";
        const nextMode = currentMode === "accept" ? "review" : "accept";
        const { currentValue } = await sessionConfigOption(
            (kind, params = {}) => action(kind, params, resources.signal),
            "mode",
            nextMode,
        );
        const resolvedMode = currentValue || nextMode;
        the(element, "approval-mode", resolvedMode);
        availability();
        return resolvedMode === "accept";
    };
    const runCommand = sessionCommands(main, {
        call: action,
        stop: cancelWork,
        toggleYolo,
        getContext: () => ({
            workspaceName: latestWorkspaceName
                || $('#session-workspace [data-text="workspace-name"]')?.textContent?.trim()
                || "default",
            sessionName: element.dataset.sessionName || "session1",
        }),
        getPendingGates: () => agent.pendingGates,
        resolveGate: async (resolution) => {
            if (the(element, "connection") !== "interrupted" || cancellation) {
                throw new Error("No interrupt is awaiting resolution.");
            }
            the(feedback, { "message-status": "", "command-error": "" });
            connect({ resolutions: [resolution] });
        },
        navigate: (targetPath) => {
            if (onNavigate) {
                onNavigate(targetPath);
                return;
            }
            const dir = parseDirectory(targetPath);
            if (dir && dir.kind === "session" && dir.workspace === latestWorkspaceName && location.pathname.startsWith("/~/")) {
                location.hash = `#${encodeURIComponent(dir.session)}`;
            } else {
                location.assign(targetPath);
            }
        },
        ...(getWorkbenchSnapshot ? { hasSession: (target) => getWorkbenchSnapshot().sessions.includes(target) } : {}),
    });
    const slate = readingSlate(main);
    /** @type {ReturnType<typeof setTimeout> | null} */
    let sendingTimer = null;
    const clearSendingTimer = () => {
        if (sendingTimer !== null) {
            clearTimeout(sendingTimer);
            sendingTimer = null;
        }
    };

    function syncAttachments() {
        draft.required = attachments.length === 0;
        attachmentOutlet.replaceChildren();
        for (const item of attachments) {
            const row = $.clone(attachmentOutlet, "#compose-attachment");
            if (row instanceof HTMLElement) row.dataset.removeId = item.id;
            the(row, {
                "attachment-name": item.name,
                "attachment-size": item.sizeLabel,
                "attachment-remove": `Remove ${item.name}`,
            });
        }
    }

    /** {§web-inline-images} Attachments queue in the order the person added them, however long each takes to verify. */
    let intake = Promise.resolve();

    /** @param {readonly File[]} files */
    function queueAttachmentFiles(files) {
        const queued = intake.then(() => verifyAttachmentFiles(files));
        intake = queued.then(() => undefined, () => undefined);
        return queued;
    }

    /** @param {readonly File[]} files */
    async function verifyAttachmentFiles(files) {
        if (!agent.promptImageSupported) {
            the(feedback, { "message-status": "", "command-error": "Image attachments are not supported on this session." });
            slate.sync();
            return;
        }
        /** @type {string[]} */
        const errors = [];
        for (const file of files) {
            try {
                const item = await readRasterFileAttachment(file, randomUUID);
                if (disposed) return;
                attachments.push(item);
            } catch (error) {
                errors.push(error instanceof Error ? error.message : String(error));
            }
        }
        if (attachments.length > 0) draft.setCustomValidity("");
        syncAttachments();
        the(feedback, {
            "message-status": pending ? (the(feedback, "message-status") ?? "") : "",
            "command-error": errors.join(" "),
        });
        availability();
        slate.sync();
    }

    /** @returns {import("./session-commands.js").SuggestionSources} */
    function buildSuggestionSources() {
        const plurnk = /** @type {Record<string, unknown> | undefined} */ (agent.state.plurnk);
        const configOptions = Array.isArray(plurnk?.configOptions) ? plurnk.configOptions : [];
        const providers = Array.isArray(plurnk?.providers) ? plurnk.providers : [];
        const readOptionValues = (/** @type {string} */ id) => {
            const opt = configOptions.find((entry) => isRecord(entry) && entry.configId === id);
            return isRecord(opt) && Array.isArray(opt.options)
                ? opt.options.flatMap((o) => isRecord(o) && typeof o.value === "string" && o.value ? [o.value] : [])
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
        const childModels = [...readOptionValues("spawn_model"), ...models];
        const modes = readOptionValues("mode");
        const wb = getWorkbenchSnapshot?.();
        const workspaces = wb
            ? wb.workspaces
            : (latestWorkspaceName ? [latestWorkspaceName] : []);
        const currentSessionName = element.dataset.sessionName || "";
        const descendantNames = Array.isArray(status?.descendants)
            ? status.descendants.flatMap((d) => typeof d?.name === "string" && d.name ? [d.name] : [])
            : [];
        const sessions = wb
            ? wb.sessions
            : [...new Set([currentSessionName, ...descendantNames].filter(Boolean))];
        const effectiveProjectRoot = workspaceProjectRoot !== undefined ? workspaceProjectRoot : wb?.projectRoot;
        const latestLoopId = status?.loopId;
        const loops = typeof latestLoopId === "number" && latestLoopId > 0
            ? Array.from({ length: latestLoopId }, (_, idx) => String(latestLoopId - idx))
            : [];
        return {
            availableCommands: availableCommands(),
            promptSuggestions: promptSuggestions(),
            models,
            efforts,
            personas,
            childModels,
            ...(modes.length > 0 ? { modes } : {}),
            workspaces,
            sessions,
            loops,
            gateIds: agent.pendingGates.map((g) => `@${g.id}`),
            familyAliases,
            ...(effectiveProjectRoot !== undefined ? { projectRoot: effectiveProjectRoot } : {}),
        };
    }

    function computeComposeSuggestions() {
        const live = Boolean(status && ["queued", "running", "parked"].includes(status.lifecycle));
        const allowPromptSuggestions = !live && the(element, "connection") !== "interrupted";
        return computeCommandSuggestions(draft.value, buildSuggestionSources(), { allowPromptSuggestions });
    }

    /** @param {string} suggestion */
    function acceptComposeSuggestion(suggestion) {
        const nextValue = acceptCommandSuggestion(draft.value, suggestion, buildSuggestionSources());
        if (nextValue === draft.value) return;
        draft.value = nextValue;
        draft.focus();
        draft.setSelectionRange(draft.value.length, draft.value.length);
        draft.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function syncSuggestions() {
        const { kind, items } = computeComposeSuggestions();
        if (items.length > 0) {
            $.cloneEach(suggestionOutlet, "#compose-suggestion", items, (item, text) => {
                the(item, { "suggestion-text": text });
            });
            if (kind === "prompt") {
                const lead = items[0]?.replaceAll(/\s+/gu, " ").trim() ?? "";
                draft.placeholder = lead ? `→ ${lead} (Tab)` : defaultPlaceholder;
            } else {
                draft.placeholder = defaultPlaceholder;
            }
        } else {
            suggestionOutlet.replaceChildren();
            draft.placeholder = defaultPlaceholder;
        }
    }

    function availability() {
        const current = the(element, "connection");
        const live = status && ["queued", "running", "parked"].includes(status.lifecycle);
        const commandPending = the(controls, "command-pending") !== null;
        the(controls, {
            "live-work": live ? "" : null,
            "prompt-image": agent.promptImageSupported ? "true" : null,
            "send-unavailable": (isClientDispatch(draft.value) ? !commandPending
                : current === "connected" && !arriving && (!pending || pending.retryable) && !cancellation && !commandPending) ? null : "",
            "stop-unavailable": live && ["connected", "interrupted"].includes(current ?? "") && !cancellation ? null : "",
        });
        the(review.form, "review-unavailable", current === "interrupted" && !cancellation && the(review.form, "deadline-passed") === null ? null : "");
        syncSuggestions();
    }

    /** @param {string} current @param {string} label */
    function connection(current, label) {
        the(element, { connection: current, "connection-label": label });
        the(connectionNotice, "connection-label", label);
        availability();
        slate.sync();
    }

    /** @param {AbortSignal} signal @returns {Promise<Record<string, string>>} */
    const credentials = (signal) => accessHeaders(signal);

    /** @param {string} id */
    function acknowledged(id) {
        if (pending?.message.id !== id) return;
        clearSendingTimer();
        seenHistoryMessageIds.add(id);
        pushPromptHistory(pending.source);
        historyIndex = -1;
        historyDraft = null;
        if (draft.value === pending.source) {
            draft.value = "";
            writeStoredDraft("");
        }
        if (pending.attachmentIds.size > 0) {
            attachments = attachments.filter((item) => !pending?.attachmentIds.has(item.id));
            syncAttachments();
        }
        pending = undefined;
        the(feedback, { "message-status": "", "command-error": "" });
        availability();
    }

    const reconnect = createPassiveReconnect(() => {
        if (!resources.signal.aborted && the(element, "connection") === "disconnected" && !pending && !cancellation) {
            agent.close();
            connect(undefined, true);
        }
    });

    /** @param {AbortController} controller @param {Submission} [submission] @param {boolean} [initialPassiveRetry] */
    async function follow(controller, submission, initialPassiveRetry = false) {
        const { signal } = controller;
        let holding = false;
        /** @type {string[]} */
        let presentedGateIds = [];
        let passiveRetry = initialPassiveRetry;
        const timer = setInterval(() => {
            if (["connected", "interrupted"].includes(the(element, "connection") ?? "") && status) the(element, clocks(status, Date.now()));
        }, CLOCK_TICK_MS);
        try {
            while (!signal.aborted) {
                if (!holding && !passiveRetry) {
                    connection("connecting", "Connecting…");
                }
                if (!submission?.resolutions && !holding && !passiveRetry) review.present([]);
                try {
                    inFlightAuthRecovery = true;
                    agent.headers = await credentials(signal);
                } finally {
                    inFlightAuthRecovery = false;
                }
                if (Object.keys(agent.headers).length > 0) connectedWithGrant = true;
                signal.throwIfAborted();
                agent.url = acpUrl();
                // This run ends with the page's observation or with its first intake failure.
                const run = new AbortController();
                signal.onabort = () => run.abort(signal.reason);
                agent.abortController = run;
                /** @type {{ error: unknown } | undefined} */
                let intakeFailure;
                let terminal = false;
                let interrupted = false;
                let settled = false;
                /** @type {number | undefined} */
                let problem;
                /** @type {string | undefined} */
                let refusal;
                /** @type {import("./session-agent.js").SessionSubscriber} */
                const subscriber = {
                    onSessionUpdate: async ({ update }) => {
                        if (signal.aborted) return;
                        await diagnose(update);
                        slate.sync();
                    },
                    onMessagesChanged: ({ messages }) => {
                        if (!signal.aborted) {
                            recordMessagesPromptHistory(messages);
                            transcript.present(messages);
                            slate.sync();
                        }
                    },
                    onUserMessage: ({ messageId }) => {
                        if (!signal.aborted) acknowledged(messageId);
                    },
                    onMessagesSnapshot: ({ snapshot }) => {
                        if (signal.aborted) return;
                        recordMessagesPromptHistory(snapshot.messages);
                        transcript.snapshot(snapshot);
                        slate.landInitial();
                        if (!pending) return;
                        if (snapshot.messages.some(({ id, role }) => id === pending?.message.id && role === "user")) acknowledged(pending.message.id);
                        else if (!submission) {
                            pending.retryable = true;
                            the(feedback, { "message-status": "Delivery remains unconfirmed. You may retry this draft.", "command-error": "" });
                            availability();
                        }
                    },
                    onStateChanged: ({ state }) => {
                        if (signal.aborted) return;
                        const snapshot = /** @type {Parameters<typeof presentState>[0]} */ (state);
                        if (snapshot.plurnk?.workspace) {
                            if ("projectRoot" in snapshot.plurnk.workspace) {
                                workspaceProjectRoot = snapshot.plurnk.workspace.projectRoot;
                            }
                            if (typeof snapshot.plurnk.workspace.name === "string" && snapshot.plurnk.workspace.name) {
                                latestWorkspaceName = snapshot.plurnk.workspace.name;
                            }
                        }
                        presentState(snapshot, Date.now());
                        syncSuggestions();
                        slate.sync();
                        const next = snapshot.plurnk?.status;
                        if (!next) return;
                        status = next;
                        if (pending && next.inbox.some(({ id }) => id === pending?.message.id)) acknowledged(pending.message.id);
                        reconnect.reset();
                        if (passiveRetry) {
                            passiveRetry = false;
                            if (agent.pendingGates.length === 0) review.present([]);
                        }
                        if (!holding) connection("connected", "Connected");
                    },
                    onSettled: ({ stopReason }) => {
                        terminal = stopReason !== "interrupt";
                        interrupted = stopReason === "interrupt";
                        if (interrupted) {
                            arriving = true;
                            availability();
                        }
                    },
                    onError: ({ message, status: errStatus, problem: errProblem, terminal: errTerminal, settled: errSettled }) => {
                        if (signal.aborted) return;
                        clearSendingTimer();
                        terminal = errTerminal !== undefined;
                        problem = errStatus ?? (typeof errProblem?.status === "number" ? errProblem.status : undefined);
                        settled = Boolean(errSettled);
                        // An observer sent nothing: the session's own failure shows in its status, not as this page's request.
                        if (terminal && submission) the(feedback, { "message-status": "", "command-error": message });
                        else refusal = message;
                    },
                };
                const delivered = failing(subscriber, (error) => { intakeFailure = { error }; run.abort(error); });
                try {
                    if (submission) {
                        await agent.send({
                            abortController: run,
                            message: submission.message,
                            resolutions: submission.resolutions,
                            ...(submission.forceReview ? { proposalPolicy: "review" } : {}),
                        }, delivered);
                    } else {
                        await agent.resume(holding ? { abortController: run, gates: presentedGateIds } : { abortController: run }, delivered);
                    }
                } catch (error) {
                    if (intakeFailure === undefined) throw error;
                }
                if (intakeFailure !== undefined) {
                    agent.close();
                    throw Object.assign(
                        intakeFailure.error instanceof Error ? intakeFailure.error : new Error(String(intakeFailure.error)),
                        { protocolFailure: true },
                    );
                }
                signal.throwIfAborted();
                if (interrupted) {
                    holding = false;
                    passiveRetry = false;
                    reconnect.reset();
                    const presentedGates = [...agent.pendingGates];
                    presentedGateIds = presentedGates.map(({ id }) => id);
                    const mode = review.present(presentedGates);
                    arriving = false;
                    connection("interrupted", "Input required");
                    the(connectionNotice, "connection-detail", mode === "manual" ? "Review the pending requests."
                        : mode === "expired" ? "The decision deadline has passed; the daemon cancels these requests."
                            : "This page cannot answer this interaction. Work remains pending.");
                    slate.sync();
                    holding = true;
                    submission = undefined;
                    continue;
                }
                if (settled && submission?.resolutions) the(feedback, "command-error", `Response not accepted: ${refusal}`);
                else if (!terminal) throw Object.assign(new Error(refusal ?? "Delivery ended without a session outcome."), { status: problem });
                holding = false;
                passiveRetry = false;
                submission = undefined;
            }
        } catch (error) {
            if (signal.aborted) return;
            clearSendingTimer();
            agent.close();
            const signedOut = Reflect.get(Object(error), "status") === 401;
            if (signedOut) {
                let recovery;
                try {
                    inFlightAuthRecovery = true;
                    recovery = await recoverFromUnauthorized({
                        signal,
                        redirectOnDiscovery: status === undefined && !submission && !pending,
                    });
                } finally {
                    inFlightAuthRecovery = false;
                }
                if (signal.aborted) return;
                if (recovery.status === "refreshed") {
                    connect(submission, passiveRetry);
                    return;
                }
                if (recovery.status === "redirecting") {
                    return;
                }
            }
            if (signedOut || !passiveRetry) {
                connection(signedOut ? "signed-out" : "disconnected", signedOut ? "Sign-in ended" : "Disconnected");
                const guidance = signedOut ? "Sign in to connect to this session again." : "Displayed values are no longer live. Reconnect to check the session.";
                the(connectionNotice, "connection-detail", `${error instanceof Error ? error.message : String(error)} ${guidance}`);
            }
            if (pending) the(feedback, { "message-status": "", "command-error": "Message delivery is unconfirmed. Your draft is retained; reconnect before trying again." });
            if (submission?.resolutions) the(feedback, { "message-status": "", "command-error": `Response could not be confirmed: ${error instanceof Error ? error.message : String(error)}` });
            if (!signedOut && !submission && !pending && isRetryableObservationFailure(error)) reconnect.schedule();
            else reconnect.stop();
        } finally {
            arriving = false;
            availability();
            clearInterval(timer);
            agent.headers = {};
        }
    }

    /** @param {Submission} [submission] @param {boolean} [passiveRetry] */
    function connect(submission, passiveRetry = false) {
        const previous = delivery;
        previous?.controller.abort();
        if (!passiveRetry) {
            reconnect.reset();
            if (submission && the(element, "connection") === "interrupted") {
                connection("connected", "Connected");
            } else {
                connection("connecting", "Connecting…");
            }
        }
        const controller = new AbortController();
        delivery = { controller, done: (async () => {
            await previous?.done;
            if (!controller.signal.aborted) await follow(controller, submission, passiveRetry);
        })() };
    }

    const offKeydown = on(document, "keydown", "body", (event) => {
        if (!main.isConnected || element.hidden) return;
        if (!(event instanceof KeyboardEvent) || event.defaultPrevented || event.isComposing || event.repeat) return;
        if ($("dialog[open]")) return;
        if (event.key === "Tab" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
            const inDraft = event.target === draft;
            const pendingProposal = the(element, "connection") === "interrupted"
                && agent.pendingGates.some(({ method }) => method === "session/request_permission");
            if (cancellation || (!inDraft && !pendingProposal)) return;
            event.preventDefault();
            void toggleYolo().then(
                (enabled) => {
                    if (!resources.signal.aborted) {
                        the(feedback, { "message-status": `Approvals: ${enabled ? "Automatic" : "Manual"}.`, "command-error": "" });
                    }
                },
                async (error) => {
                    if (!resources.signal.aborted) {
                        const { message, recovery } = await describeFailure(error);
                        the(feedback, { "message-status": "", "command-error": [message, recovery].filter(Boolean).join(" ") });
                    }
                },
            );
            return;
        }
        if (isTextEntry(event.target) || event.ctrlKey || event.altKey || event.metaKey) return;
        if (event.key === "Escape" && !event.shiftKey) {
            if (runCommand.dismissAll()) {
                event.preventDefault();
                return;
            }
            if (the(controls, "stop-unavailable") === null) {
                event.preventDefault();
                stop.requestSubmit();
            }
            return;
        }
        if (event.key === "/" && !event.shiftKey) {
            event.preventDefault();
            draft.focus();
            return;
        }
        if (event.key === "?") {
            event.preventDefault();
            runCommand.showHelp();
            return;
        }
        const lower = event.key.toLowerCase();
        if ((lower === "y" || lower === "a" || lower === "n" || lower === "r" || lower === "e")
            && the(element, "connection") === "interrupted"
            && the(review.form, "review-unavailable") === null) {
            const proposals = $$(review.form, 'fieldset:has(input[type="radio"][value="accept"])');
            if (proposals.length === 0) return;
            const focusedProposal = event.target instanceof Element
                ? event.target.closest('fieldset:has(input[type="radio"][value="accept"])')
                : null;
            const targetProposal = focusedProposal
                ?? proposals.find((fieldset) => !$(fieldset, 'input[type="radio"]:checked'))
                ?? proposals[0];
            const choice = lower === "y" || lower === "a" ? "accept" : lower === "e" ? "edit" : "reject";
            if (choice === "edit" && targetProposal?.getAttribute("data-proposal-editable") === "false") return;
            const radio = targetProposal ? $(targetProposal, `input[type="radio"][value="${choice}"]`) : null;
            if (radio instanceof HTMLInputElement && !radio.disabled) {
                event.preventDefault();
                radio.checked = true;
                radio.dispatchEvent(new Event("change", { bubbles: true }));
                if (choice === "edit") {
                    const editBody = targetProposal ? $(targetProposal, "[data-proposal-edit-body]") : null;
                    if (editBody instanceof HTMLTextAreaElement) editBody.focus();
                    else radio.focus();
                } else {
                    radio.focus();
                }
            }
        }
    });
    on(review.form, "keydown", "[data-proposal-edit-body]", (event) => {
        if (!(event instanceof KeyboardEvent) || event.isComposing || event.repeat) return;
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
            event.preventDefault();
            review.form.requestSubmit();
        }
    });
    on(main, "click", ':is(#session-conversation, #session-diagnostics) summary, a[href^="#"]', () => {
        slate.release();
    });
    on(main, "submit", "[data-history-boundary] form", () => {
        slate.release();
    });
    on(main, "submit", "#session-reconnect", (event) => {
        event.preventDefault();
        if (["disconnected", "interrupted"].includes(the(element, "connection") ?? "")) {
            the(feedback, "command-error", "");
            agent.close();
            connect();
        }
    });
    on(compose, "input", "textarea", () => {
        historyIndex = -1;
        historyDraft = null;
        draft.setCustomValidity("");
        const value = draft.value;
        writeStoredDraft(value.trim() !== "" && !isClientDispatch(value) ? value : "");
        availability();
        slate.sync();
    });
    on(compose, "click", "[data-insert-command]", () => {
        if (the(controls, "send-unavailable") !== null) return;
        draft.value = draft.value === "/" ? "" : "/";
        draft.focus();
        draft.setSelectionRange(draft.value.length, draft.value.length);
        draft.dispatchEvent(new Event("input", { bubbles: true }));
    });
    on(compose, "click", "[data-accept-suggestion]", (_event, button) => {
        acceptComposeSuggestion(button.textContent ?? "");
    });
    on(compose, "keydown", "textarea", (event) => {
        if (!(event instanceof KeyboardEvent) || event.isComposing) return;
        if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
            && (event.key === "ArrowUp" || event.key === "ArrowDown")
            && draft.selectionStart === draft.selectionEnd) {
            if (event.key === "ArrowUp") {
                const isFirstLine = !draft.value.slice(0, draft.selectionStart).includes("\n");
                if (isFirstLine && (draft.value === "" || historyIndex > -1 || draft.selectionStart === 0)) {
                    const newestFirst = promptHistory.toReversed();
                    if (historyIndex + 1 < newestFirst.length) {
                        event.preventDefault();
                        if (historyIndex === -1) historyDraft = draft.value;
                        historyIndex += 1;
                        draft.value = newestFirst[historyIndex] ?? "";
                        draft.setSelectionRange(0, 0);
                        draft.setCustomValidity("");
                        availability();
                        slate.sync();
                    }
                    return;
                }
            } else if (historyIndex > -1) {
                const isLastLine = !draft.value.slice(draft.selectionEnd).includes("\n");
                if (isLastLine) {
                    event.preventDefault();
                    historyIndex -= 1;
                    if (historyIndex === -1) {
                        draft.value = historyDraft ?? "";
                        historyDraft = null;
                    } else {
                        const newestFirst = promptHistory.toReversed();
                        draft.value = newestFirst[historyIndex] ?? "";
                    }
                    draft.setSelectionRange(draft.value.length, draft.value.length);
                    draft.setCustomValidity("");
                    availability();
                    slate.sync();
                    return;
                }
            }
        }
        if (event.repeat) return;
        if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
            const { kind, items } = computeComposeSuggestions();
            const lead = items[0];
            if (lead && (kind !== "prompt" || draft.value === "")) {
                event.preventDefault();
                acceptComposeSuggestion(lead);
            }
            return;
        }
        if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
            event.preventDefault();
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
    on(compose, "click", "[data-attach-image]", () => {
        if (the(controls, "send-unavailable") === null && agent.promptImageSupported) {
            fileInput.click();
        }
    });
    on(compose, "change", "[data-attach-input]", () => {
        const files = Array.from(fileInput.files ?? []);
        fileInput.value = "";
        if (files.length > 0) void queueAttachmentFiles(files);
    });
    on(compose, "click", "[data-remove-attachment]", (_event, button) => {
        const item = button.closest("[data-attachment-item]");
        const id = item instanceof HTMLElement ? item.dataset.removeId : null;
        if (!id) return;
        attachments = attachments.filter((entry) => entry.id !== id);
        syncAttachments();
        availability();
    });
    on(compose, "paste", "textarea", (event) => {
        const clipboardData = "clipboardData" in event ? /** @type {DataTransfer | null} */ (event.clipboardData) : null;
        if (!clipboardData) return;
        /** @type {File[]} */
        const files = [];
        for (const item of clipboardData.items ?? []) {
            if (item.kind === "file" && item.type.startsWith("image/")) {
                const file = item.getAsFile();
                if (file) files.push(file);
            }
        }
        if (files.length === 0) {
            for (const file of clipboardData.files ?? []) {
                if (file.type.startsWith("image/")) files.push(file);
            }
        }
        if (files.length === 0) return;
        event.preventDefault();
        void queueAttachmentFiles(files);
    });
    on(compose, "dragover", "form", (event) => {
        const dataTransfer = "dataTransfer" in event ? /** @type {DataTransfer | null} */ (event.dataTransfer) : null;
        if (!dataTransfer?.types?.includes("Files")) return;
        event.preventDefault();
        dataTransfer.dropEffect = "copy";
    });
    on(compose, "drop", "form", (event) => {
        const dataTransfer = "dataTransfer" in event ? /** @type {DataTransfer | null} */ (event.dataTransfer) : null;
        if (!dataTransfer || dataTransfer.files.length === 0) return;
        event.preventDefault();
        void queueAttachmentFiles(Array.from(dataTransfer.files));
    });
    on(compose, "submit", "form", async (event) => {
        event.preventDefault();
        if (the(controls, "send-unavailable") !== null) return;
        if (isClientDispatch(draft.value)) {
            if (attachments.length > 0) {
                the(feedback, {
                    "message-status": "",
                    "command-error": "Remove queued image attachments before running a client slash command.",
                });
                slate.sync();
                return;
            }
            const text = draft.value;
            the(controls, "command-pending", "");
            availability();
            try {
                if (await runCommand(text, resources.signal) && draft.value === text) {
                    pushPromptHistory(text);
                    historyIndex = -1;
                    historyDraft = null;
                    draft.value = "";
                    writeStoredDraft("");
                }
                slate.jumpToBottom();
            } finally {
                the(controls, "command-pending", null);
                availability();
            }
            return;
        }
        if (!draft.value.trim() && attachments.length === 0) {
            draft.setCustomValidity("Enter a message.");
            draft.reportValidity();
            return;
        }
        const source = draft.value;
        const prepared = source.trim()
            ? prepareComposerPrompt(source, workspaceProjectRoot === undefined ? undefined : { projectRoot: workspaceProjectRoot })
            : { ok: /** @type {const} */ (true), prompt: "", forceReview: false, openPaths: /** @type {readonly string[]} */ ([]) };
        if ("error" in prepared) {
            the(feedback, { "message-status": "", "command-error": prepared.error });
            return;
        }
        const sourceKey = `${source}\0${attachments.map(({ id }) => id).join(",")}`;
        const queuedAttachments = attachments.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
        const message = pending?.sourceKey === sourceKey
            ? pending.message
            : {
                id: randomUUID(),
                role: /** @type {const} */ ("user"),
                content: prepared.prompt,
                ...(queuedAttachments.length > 0 ? { attachments: queuedAttachments } : {}),
                ...(prepared.openPaths.length > 0 ? { openPaths: prepared.openPaths } : {}),
            };
        pending = {
            message,
            source,
            sourceKey,
            attachmentIds: new Set(attachments.map(({ id }) => id)),
            retryable: false,
        };
        clearSendingTimer();
        the(feedback, { "message-status": "", "command-error": "" });
        sendingTimer = setTimeout(() => {
            sendingTimer = null;
            if (pending && !disposed) {
                the(feedback, { "message-status": "Sending…", "command-error": "" });
                slate.sync();
            }
        }, SENDING_DWELL_MS);
        slate.frameTurn(message.id);
        connect({ message, ...(prepared.forceReview ? { forceReview: true } : {}) });
    });

    on(review.form, "submit", "form", async (event) => {
        event.preventDefault();
        if (the(review.form, "review-unavailable") !== null || the(review.form, "request-count") === "0") return;
        const reading = review.decisions(agent.pendingGates);
        the(review.form, "review-unavailable", "");
        try {
            const resolutions = await reading;
            if (!resolutions || cancellation || the(element, "connection") !== "interrupted") return;
            the(feedback, { "message-status": "", "command-error": "" });
            connect({ resolutions });
        } catch (error) {
            const { message, recovery } = await describeFailure(error);
            the(feedback, { "message-status": "", "command-error": `Responses could not be submitted: ${[message, recovery].filter(Boolean).join(" ")}` });
        } finally { availability(); }
    });

    // {§web-session-commands} The button and slash command have one explicit cancellation path.
    async function cancelWork() {
        if (cancellation) throw new Error("Stop is already pending.");
        const controller = new AbortController();
        cancellation = controller;
        availability();
        try {
            const wasLive = Boolean(status && ["queued", "running", "parked"].includes(status.lifecycle));
            await action("session/cancel", {}, controller.signal);
            controller.signal.throwIfAborted();
            return wasLive ? "Stop requested." : "No active work to stop.";
        } finally {
            cancellation = undefined;
            availability();
        }
    }

    on(stop, "submit", "form", async (event) => {
        event.preventDefault();
        if (the(controls, "stop-unavailable") !== null) return;
        the(feedback, { "message-status": "Requesting Stop…", "command-error": "" });
        // The visit that asked: leaving the page ends it, whatever a later return starts.
        const visit = resources.signal;
        try { the(feedback, "message-status", await cancelWork()); }
        catch (error) {
            if (visit.aborted) {
                the(feedback, { "message-status": "", "command-error": "Stop could not be confirmed before the page was left." });
                return;
            }
            const { message, recovery } = await describeFailure(error);
            the(feedback, { "message-status": "", "command-error": `Stop could not be confirmed: ${[message, recovery].filter(Boolean).join(" ")}` });
        }
    });

    let savedScrollTop = main.scrollTop;

    const offGrantChange = onOidcGrantChange(() => {
        if (disposed || inFlightAuthRecovery) return;
        if (connectedWithGrant && !hasActiveOidcGrant()) {
            connectedWithGrant = false;
            clearSendingTimer();
            reconnect.stop();
            delivery?.controller.abort();
            agent.close();
            connection("signed-out", "Sign-in ended");
            the(connectionNotice, "connection-detail", "Sign-in was cleared. Sign in to connect to this session again.");
            availability();
        }
    });
    const offPageHide = on.target(window, "pagehide", () => {
        if (disposed) return;
        reconnect.reset();
        slate.pause();
        transcript.pause();
        resources.abort();
        delivery?.controller.abort();
        cancellation?.abort();
        agent.close();
        connection("closed", "Not connected.");
    });
    const offPageShow = on.target(window, "pageshow", (event) => {
        if (disposed) return;
        if (event instanceof PageTransitionEvent && event.persisted) {
            resources = new AbortController();
            if (!pending) {
                const savedDraft = readStoredDraft() ?? "";
                if (draft.value !== savedDraft) draft.value = savedDraft;
            }
            transcript.resume();
            if (main.isConnected) slate.resume();
            connect();
        }
    });
    connect();

    return {
        main,
        footer: element,
        deactivate() {
            if (disposed) return;
            savedScrollTop = main.scrollTop;
            slate.pause();
            element.hidden = true;
        },
        activate() {
            if (disposed) return;
            element.hidden = false;
            presentState.syncHeader();
            slate.resume();
            main.scrollTop = savedScrollTop;
            slate.sync();
            void math(main).catch(reportError);
            void mermaid(main).catch(reportError);
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            clearSendingTimer();
            offGrantChange();
            offKeydown();
            offCoarseMedia();
            offPageHide();
            offPageShow();
            reconnect.dispose();
            slate.pause();
            transcript.pause();
            resources.abort();
            delivery?.controller.abort();
            cancellation?.abort();
            agent.close();
        },
    };
}
