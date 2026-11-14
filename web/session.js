import { $, $$, on, the } from "on_the_money";
import SessionAgent, { randomUUID } from "./session-agent.js";
import { clocks } from "./session-status.js";
import sessionState from "./session-state.js";
import sessionHistory from "./session-history.js";
import reviewRequests from "./session-review.js";
import diagnostics from "./session-diagnostics.js";
import accessHeaders from "./access-headers.js";
import readBody from "./read-body.js";
import readHistory from "./read-history.js";
import reasoningPreview from "./reasoning-preview.js";
import managementAction from "./management-action.js";
import sessionCommands, { expandPromptCommand, isCommand, primaryModifierLabel } from "./session-commands.js";
import sessionSettings from "./session-settings.js";
import describeFailure from "./failure.js";
import { createPassiveReconnect, isRetryableObservationFailure } from "./passive-reconnect.js";
import stickyTail from "./sticky-tail.js";
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

/** @typedef {{message?: {id: string, role: "user", content: string, attachments?: readonly import("./session-agent.js").PromptImageAttachment[]}, resolutions?: readonly import("./session-agent.js").GateResolution[]}} Submission */

// {§web-session-status} Repaint elapsed and wait at whole-second precision; no network polling.
const CLOCK_TICK_MS = 1000;

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
 * @param {{ main?: Element | null }} [options]
 */
export default function observeSession(element, { main: suppliedMain = $("#main") } = {}) {
    const { sessionId, auth } = element.dataset;
    if (!sessionId || (auth !== "session" && auth !== "none")) throw new Error("Session document metadata is incomplete.");
    const approval = $(element, "#session-yolo");
    if (!(approval instanceof HTMLButtonElement) || !["true", "false"].includes(approval.getAttribute("aria-pressed") ?? "")) {
        throw new Error("Session document has no approval mode.");
    }
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
    const review = reviewRequests(main, approval.getAttribute("aria-pressed") === "true");
    const compose = $(controls, "#session-compose");
    const stop = $(controls, "#session-stop");
    const attachInput = $(controls, "[data-attach-input]");
    const attachmentList = $(controls, "[data-compose-attachments]");
    const field = $(controls, "#session-message");
    const sendButton = $(controls, 'button[form="session-compose"]');
    if (!(compose instanceof HTMLFormElement) || !(stop instanceof HTMLFormElement)
        || !($(controls, "[data-attach-image]") instanceof HTMLButtonElement)
        || !(attachInput instanceof HTMLInputElement)
        || !(attachmentList instanceof HTMLUListElement)
        || !(field instanceof HTMLTextAreaElement) || !(sendButton instanceof HTMLButtonElement)) {
        throw new Error("Session controls are incomplete.");
    }
    const draft = field;
    const fileInput = attachInput;
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
    the(feedback, "message-status", "");
    let resources = new AbortController();
    const transcript = sessionHistory(history, (address) => readBody(address, auth, resources.signal),
        (address, signal) => readHistory(address, auth, AbortSignal.any([signal, resources.signal])));
    const preview = reasoningPreview(history, Number(element.dataset.reasoningPreviewChars));
    const diagnosticList = $(main, "#session-diagnostics");
    if (!(diagnosticList instanceof HTMLElement)) throw new Error("Session document has no diagnostics outlet.");
    const diagnose = diagnostics(diagnosticList);
    const presentState = sessionState(element, main);
    const agent = new SessionAgent({ url: "/acp", sessionId });
    /** @type {import("@plurnk/plurnk-acp/client").AcpSessionStatus | undefined} */
    let status;
    /** @type {{message: {id: string, role: "user", content: string, attachments?: readonly import("./session-agent.js").PromptImageAttachment[]}, source: string, sourceKey: string, attachmentIds: ReadonlySet<string>, retryable: boolean} | undefined} */
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
    /** @param {string} kind @param {Record<string, unknown>} [params] @param {AbortSignal} [signal] */
    const action = (kind, params = {}, signal = resources.signal) => managementAction(kind, params, sessionId, auth, signal);
    const toggleYolo = async () => {
        const enabled = approval.getAttribute("aria-pressed") !== "true";
        approval.setAttribute("aria-pressed", String(enabled));
        approval.title = `${enabled ? "Auto" : "Manual"} Approval (Shift+Tab · /yolo)`;
        the(approval, "yolo-label", enabled ? "YOLO" : "Review");
        const mode = review.automatic(enabled);
        if (mode === "automatic" && the(element, "connection") === "interrupted" && !cancellation) {
            const resolutions = await review.decisions(agent.pendingGates);
            if (resolutions && the(element, "connection") === "interrupted" && !cancellation) connect({ resolutions });
        }
        availability();
        return enabled;
    };
    const runCommand = sessionCommands(main, { call: action, stop: cancelWork, toggleYolo });
    const dismissSettings = sessionSettings(main, element, action, () => resources.signal);
    const tail = stickyTail(main);

    function syncAttachments() {
        draft.required = attachments.length === 0;
        attachmentOutlet.replaceChildren();
        for (const item of attachments) {
            const row = $.clone(attachmentOutlet, "#compose-attachment");
            if (row instanceof HTMLElement) row.dataset.removeId = item.id;
            the(row, {
                attachmentName: item.name,
                attachmentSize: item.sizeLabel,
                attachmentRemove: `Remove ${item.name}`,
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
            the(feedback, { messageStatus: "", commandError: "Image attachments are not supported on this session." });
            tail.follow();
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
            messageStatus: pending ? (the(feedback, "message-status") ?? "") : "",
            commandError: errors.join(" "),
        });
        availability();
        tail.follow();
    }

    function availability() {
        const current = the(element, "connection");
        const live = status && ["queued", "running", "parked"].includes(status.lifecycle);
        const commandPending = the(controls, "command-pending") !== null;
        the(controls, {
            liveWork: live ? "" : null,
            promptImage: agent.promptImageSupported ? "true" : null,
            sendUnavailable: (isCommand(draft.value, availableCommands()) ? !commandPending
                : current === "connected" && !arriving && (!pending || pending.retryable) && !cancellation && !commandPending) ? null : "",
            stopUnavailable: live && ["connected", "interrupted"].includes(current ?? "") && !cancellation ? null : "",
        });
        the(review.form, "review-unavailable", current === "interrupted" && !cancellation && the(review.form, "deadline-passed") === null ? null : "");
    }

    /** @param {string} current @param {string} label */
    function connection(current, label) {
        the(element, { connection: current, connectionLabel: label });
        the(connectionNotice, "connection-label", label);
        availability();
        tail.follow();
    }

    /** @param {AbortSignal} signal @returns {Promise<Record<string, string>>} */
    const credentials = (signal) => accessHeaders(auth, signal);

    /** @param {string} id */
    function acknowledged(id) {
        if (pending?.message.id !== id) return;
        if (draft.value === pending.source) {
            draft.value = "";
            writeStoredDraft("");
        }
        if (pending.attachmentIds.size > 0) {
            attachments = attachments.filter((item) => !pending?.attachmentIds.has(item.id));
            syncAttachments();
        }
        pending = undefined;
        the(feedback, { messageStatus: "", commandError: "" });
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
        let passiveRetry = initialPassiveRetry;
        const timer = setInterval(() => {
            if (["connected", "interrupted"].includes(the(element, "connection") ?? "") && status) the(element, clocks(status, Date.now()));
        }, CLOCK_TICK_MS);
        try {
            while (!signal.aborted) {
                if (!holding && !passiveRetry) connection("connecting", "Connecting…");
                if (!submission?.resolutions && !holding && !passiveRetry) review.present([]);
                agent.headers = await credentials(signal);
                signal.throwIfAborted();
                agent.url = "/acp";
                // This run ends with the page's observation or with its first intake failure.
                const run = new AbortController();
                signal.onabort = () => run.abort(signal.reason);
                agent.abortController = run;
                /** @type {{ error: unknown } | undefined} */
                let intake;
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
                        preview.consume(update);
                        await diagnose(update);
                        tail.follow();
                    },
                    onMessagesChanged: ({ messages }) => {
                        if (!signal.aborted) {
                            transcript.present(messages);
                            tail.follow();
                        }
                    },
                    onUserMessage: ({ messageId }) => {
                        if (!signal.aborted) acknowledged(messageId);
                    },
                    onMessagesSnapshot: ({ snapshot }) => {
                        if (signal.aborted) return;
                        transcript.snapshot(snapshot);
                        tail.follow();
                        if (!pending) return;
                        if (snapshot.messages.some(({ id, role }) => id === pending?.message.id && role === "user")) acknowledged(pending.message.id);
                        else if (!submission) {
                            pending.retryable = true;
                            the(feedback, { messageStatus: "Delivery remains unconfirmed. You may retry this draft.", commandError: "" });
                            availability();
                        }
                    },
                    onStateChanged: ({ state }) => {
                        if (signal.aborted) return;
                        const snapshot = /** @type {Parameters<typeof presentState>[0]} */ (state);
                        presentState(snapshot, Date.now());
                        tail.follow();
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
                        terminal = errTerminal !== undefined;
                        problem = errStatus ?? (typeof errProblem?.status === "number" ? errProblem.status : undefined);
                        settled = Boolean(errSettled);
                        // An observer sent nothing: the session's own failure shows in its status, not as this page's request.
                        if (terminal && submission) the(feedback, "command-error", message);
                        else refusal = message;
                    },
                };
                const delivered = failing(subscriber, (error) => { intake = { error }; run.abort(error); });
                try {
                    if (submission) await agent.send({ abortController: run, message: submission.message, resolutions: submission.resolutions }, delivered);
                    else await agent.resume(holding ? { abortController: run, gates: agent.pendingGates.map(({ id }) => id) } : { abortController: run }, delivered);
                } catch (error) {
                    if (intake === undefined) throw error;
                }
                if (intake !== undefined) {
                    agent.close();
                    throw Object.assign(
                        intake.error instanceof Error ? intake.error : new Error(String(intake.error)),
                        { protocolFailure: true },
                    );
                }
                signal.throwIfAborted();
                if (interrupted) {
                    holding = false;
                    passiveRetry = false;
                    reconnect.reset();
                    const mode = review.present(agent.pendingGates);
                    arriving = false;
                    if (mode === "automatic") {
                        const resolutions = await review.decisions(agent.pendingGates);
                        if (!resolutions) throw new Error("Automatic approval did not resolve its presented set.");
                        submission = { resolutions };
                        continue;
                    }
                    connection("interrupted", "Input required");
                    the(connectionNotice, "connection-detail", mode === "manual" ? "Review the pending requests."
                        : mode === "expired" ? "The decision deadline has passed; the daemon cancels these requests."
                            : "This page cannot answer this interaction. Work remains pending.");
                    tail.follow();
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
            agent.close();
            const signedOut = Reflect.get(Object(error), "status") === 401;
            if (signedOut || !passiveRetry) {
                connection(signedOut ? "signed-out" : "disconnected", signedOut ? "Sign-in ended" : "Disconnected");
                const guidance = signedOut ? "Sign in to connect to this session again." : "Displayed values are no longer live. Reconnect to check the session.";
                the(connectionNotice, "connection-detail", `${error instanceof Error ? error.message : String(error)} ${guidance}`);
            }
            if (pending) the(feedback, { messageStatus: "", commandError: "Message delivery is unconfirmed. Your draft is retained; reconnect before trying again." });
            if (submission?.resolutions) the(feedback, { messageStatus: "", commandError: `Response could not be confirmed: ${error instanceof Error ? error.message : String(error)}` });
            if (!signedOut && !submission && !pending && isRetryableObservationFailure(error)) reconnect.schedule();
            else reconnect.stop();
        } finally {
            arriving = false;
            availability();
            preview.clear();
            clearInterval(timer);
            agent.headers = {};
        }
    }

    /** @param {Submission} [submission] @param {boolean} [passiveRetry] */
    function connect(submission, passiveRetry = false) {
        const previous = delivery;
        previous?.controller.abort();
        preview.clear();
        if (!passiveRetry) {
            reconnect.reset();
            connection("connecting", "Connecting…");
        }
        const controller = new AbortController();
        delivery = { controller, done: (async () => {
            await previous?.done;
            if (!controller.signal.aborted) await follow(controller, submission, passiveRetry);
        })() };
    }

    on(element, "click", "#session-yolo", async () => {
        try { await toggleYolo(); }
        catch (error) {
            if (!resources.signal.aborted) the(feedback, "command-error", error instanceof Error ? error.message : String(error));
        }
    });
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
            void toggleYolo().catch((error) => {
                if (!resources.signal.aborted) the(feedback, "command-error", error instanceof Error ? error.message : String(error));
            });
            return;
        }
        if (isTextEntry(event.target) || event.ctrlKey || event.altKey || event.metaKey) return;
        if (event.key === "Escape" && !event.shiftKey) {
            if (dismissSettings() || runCommand.dismissAll()) {
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
            if (the(controls, "command-pending") !== null) return;
            event.preventDefault();
            the(controls, "command-pending", "");
            availability();
            tail.pin();
            void runCommand.showHelp(resources.signal).then(() => {
                tail.follow();
            }).finally(() => {
                the(controls, "command-pending", null);
                availability();
            });
            return;
        }
        const lower = event.key.toLowerCase();
        if ((lower === "y" || lower === "a" || lower === "n" || lower === "r")
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
            const choice = lower === "y" || lower === "a" ? "accept" : "reject";
            const radio = targetProposal ? $(targetProposal, `input[type="radio"][value="${choice}"]`) : null;
            if (radio instanceof HTMLInputElement && !radio.disabled) {
                event.preventDefault();
                radio.checked = true;
                radio.focus();
                radio.dispatchEvent(new Event("change", { bubbles: true }));
            }
        }
    });
    on(main, "click", ':is(#session-conversation, #session-diagnostics) summary, a[href^="#"]', () => {
        tail.release();
    });
    on(main, "submit", "[data-history-boundary] form", () => {
        tail.release();
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
        draft.setCustomValidity("");
        const value = draft.value;
        writeStoredDraft(value.trim() !== "" && !isCommand(value, availableCommands()) ? value : "");
        availability();
        tail.follow();
    });
    on(compose, "keydown", "textarea", (event) => {
        if (!(event instanceof KeyboardEvent) || event.isComposing || event.repeat) return;
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
        if (isCommand(draft.value, availableCommands())) {
            if (attachments.length > 0) {
                the(feedback, {
                    messageStatus: "",
                    commandError: "Remove queued image attachments before running a client slash command.",
                });
                tail.follow();
                return;
            }
            const text = draft.value;
            the(controls, "command-pending", "");
            availability();
            tail.pin();
            try {
                if (await runCommand(text, resources.signal) && draft.value === text) {
                    draft.value = "";
                    writeStoredDraft("");
                }
                tail.follow();
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
        const expanded = source.trim() ? expandPromptCommand(source) : "";
        const sourceKey = `${source}\0${attachments.map(({ id }) => id).join(",")}`;
        const queuedAttachments = attachments.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
        const message = pending?.sourceKey === sourceKey
            ? pending.message
            : {
                id: randomUUID(),
                role: /** @type {const} */ ("user"),
                content: expanded,
                ...(queuedAttachments.length > 0 ? { attachments: queuedAttachments } : {}),
            };
        pending = {
            message,
            source,
            sourceKey,
            attachmentIds: new Set(attachments.map(({ id }) => id)),
            retryable: false,
        };
        the(feedback, { messageStatus: "Sending…", commandError: "" });
        tail.pin();
        connect({ message });
    });

    on(review.form, "submit", "form", async (event) => {
        event.preventDefault();
        if (the(review.form, "review-unavailable") !== null || the(review.form, "request-count") === "0") return;
        const reading = review.decisions(agent.pendingGates);
        the(review.form, "review-unavailable", "");
        try {
            const resolutions = await reading;
            if (!resolutions || cancellation || the(element, "connection") !== "interrupted") return;
            the(feedback, { messageStatus: "", commandError: "" });
            connect({ resolutions });
        } catch (error) {
            const { message, recovery } = await describeFailure(error);
            the(feedback, { messageStatus: "", commandError: `Responses could not be submitted: ${[message, recovery].filter(Boolean).join(" ")}` });
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
        the(feedback, { messageStatus: "Requesting Stop…", commandError: "" });
        // The visit that asked: leaving the page ends it, whatever a later return starts.
        const visit = resources.signal;
        try { the(feedback, "message-status", await cancelWork()); }
        catch (error) {
            if (visit.aborted) {
                the(feedback, { messageStatus: "", commandError: "Stop could not be confirmed before the page was left." });
                return;
            }
            const { message, recovery } = await describeFailure(error);
            the(feedback, { messageStatus: "", commandError: `Stop could not be confirmed: ${[message, recovery].filter(Boolean).join(" ")}` });
        }
    });

    let savedScrollTop = main.scrollTop;
    let wasPinned = true;

    const offPageHide = on.target(window, "pagehide", () => {
        if (disposed) return;
        reconnect.reset();
        tail.pause();
        transcript.pause();
        preview.clear();
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
            if (main.isConnected) tail.resume();
            connect();
        }
    });
    connect();

    return {
        main,
        footer: element,
        deactivate() {
            if (disposed) return;
            wasPinned = tail.isPinned();
            savedScrollTop = main.scrollTop;
            tail.pause();
        },
        activate() {
            if (disposed) return;
            presentState.syncHeader();
            tail.resume();
            if (wasPinned) tail.pin();
            else main.scrollTop = savedScrollTop;
            void math(main).catch(reportError);
            void mermaid(main).catch(reportError);
        },
        canEvict() {
            return !main.isConnected
                && !pending
                && attachments.length === 0
                && !cancellation
                && the(controls, "command-pending") === null
                && the(element, "connection") !== "interrupted"
                && agent.pendingGates.length === 0;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            offKeydown();
            offCoarseMedia();
            offPageHide();
            offPageShow();
            reconnect.dispose();
            tail.pause();
            transcript.pause();
            preview.clear();
            resources.abort();
            delivery?.controller.abort();
            cancellation?.abort();
            agent.close();
        },
    };
}
