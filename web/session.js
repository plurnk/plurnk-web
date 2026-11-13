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

/** @param {EventTarget | null} target */
function isTextEntry(target) {
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
    if (target instanceof HTMLInputElement) {
        return !["radio", "checkbox", "button", "submit", "reset"].includes(target.type);
    }
    return target instanceof HTMLElement && target.isContentEditable;
}

/** @typedef {{message?: {id: string, role: "user", content: string}, resolutions?: readonly import("./session-agent.js").GateResolution[]}} Submission */

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
 */
export default function observeSession(element) {
    const { sessionId, auth } = element.dataset;
    if (!sessionId || (auth !== "session" && auth !== "none")) throw new Error("Session document metadata is incomplete.");
    const approval = $(element, "#session-yolo");
    if (!(approval instanceof HTMLButtonElement) || !["true", "false"].includes(approval.getAttribute("aria-pressed") ?? "")) {
        throw new Error("Session document has no approval mode.");
    }
    const history = $("#session-conversation");
    if (!(history instanceof HTMLElement)) throw new Error("Session document has no conversation outlet.");
    const main = $("#main");
    if (!(main instanceof HTMLElement)) throw new Error("Session document has no main region.");
    const controls = $.clone(element, "#session-controls");
    // {§web-session-history} What needs the person follows the conversation, where its pinned end is.
    const feedback = $.clone(main, "#session-feedback");
    const notice = $("#session-connection");
    if (!notice) throw new Error("Session document has no connection notice.");
    const connectionNotice = notice;
    const review = reviewRequests(main, approval.getAttribute("aria-pressed") === "true");
    const compose = $(controls, "#session-compose");
    const stop = $(controls, "#session-stop");
    const field = $(controls, "#session-message");
    const sendButton = $(controls, 'button[form="session-compose"]');
    if (!(compose instanceof HTMLFormElement) || !(stop instanceof HTMLFormElement)
        || !(field instanceof HTMLTextAreaElement) || !(sendButton instanceof HTMLButtonElement)) {
        throw new Error("Session controls are incomplete.");
    }
    const draft = field;
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
    coarseMedia.onchange = syncSendShortcuts;
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
    const diagnosticList = $("#session-diagnostics");
    if (!(diagnosticList instanceof HTMLElement)) throw new Error("Session document has no diagnostics outlet.");
    const diagnose = diagnostics(diagnosticList);
    const presentState = sessionState(element);
    const agent = new SessionAgent({ url: "/acp", sessionId });
    /** @type {import("@plurnk/plurnk-acp/client").AcpSessionStatus | undefined} */
    let status;
    /** @type {{message: {id: string, role: "user", content: string}, source: string, retryable: boolean} | undefined} */
    let pending;
    /** @type {{controller: AbortController, done: Promise<void>} | undefined} */
    let delivery;
    /** @type {AbortController | undefined} */
    let cancellation;
    // {§web-session-input} An interrupt that has arrived and is not yet presented holds Send until its review appears.
    let arriving = false;
    const availableCommands = () => {
        const plurnk = /** @type {Record<string, unknown> | undefined} */ (agent.state.plurnk);
        return Array.isArray(plurnk?.availableCommands)
            ? /** @type {readonly { name: string }[]} */ (plurnk.availableCommands)
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

    function availability() {
        const current = the(element, "connection");
        const live = status && ["queued", "running", "parked"].includes(status.lifecycle);
        const commandPending = the(controls, "command-pending") !== null;
        the(controls, {
            liveWork: live ? "" : null,
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
    on(document, "keydown", "body", (event) => {
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
    on(compose, "submit", "form", async (event) => {
        event.preventDefault();
        if (the(controls, "send-unavailable") !== null) return;
        if (isCommand(draft.value, availableCommands())) {
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
        if (!draft.value.trim()) {
            draft.setCustomValidity("Enter a message.");
            draft.reportValidity();
            return;
        }
        const source = draft.value;
        const expanded = expandPromptCommand(source);
        const message = pending?.source === source ? pending.message
            : { id: randomUUID(), role: /** @type {const} */ ("user"), content: expanded };
        pending = { message, source, retryable: false };
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

    window.onpagehide = () => {
        reconnect.reset();
        tail.pause();
        transcript.pause();
        preview.clear();
        resources.abort();
        delivery?.controller.abort();
        cancellation?.abort();
        agent.close();
        connection("closed", "Not connected.");
    };
    window.onpageshow = (event) => {
        if (event.persisted) {
            resources = new AbortController();
            if (!pending) {
                const savedDraft = readStoredDraft() ?? "";
                if (draft.value !== savedDraft) draft.value = savedDraft;
            }
            transcript.resume();
            tail.resume();
            connect();
        }
    };
    connect();
}
