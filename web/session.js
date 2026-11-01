import { $, on, the } from "on_the_money";
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
import sessionStreams from "./session-streams.js";
import readEntry from "./read-entry.js";
import activity from "./session-activity.js";
import managementAction from "./management-action.js";
import sessionCommands, { isCommand } from "./session-commands.js";
import sessionSettings from "./session-settings.js";
import describeFailure from "./failure.js";

/** @typedef {{message?: {id: string, role: "user", content: string}, resume?: readonly import("./session-agent.js").ResumeResolution[]}} Submission */

// {§web-session-status} Repaint elapsed and WAIT at whole-second precision; no network polling.
const CLOCK_TICK_MS = 1000;

// {§web-session-approval} These refusals require fresh observation, never replay of the answer.
const SETTLED_INTERRUPTS = new Set([
    "https://problems.plurnk.xyz/acp/interrupt/interrupt-not-pending",
    "https://problems.plurnk.xyz/proposal/resolution/proposal-not-pending",
    "https://problems.plurnk.xyz/interaction/resolution/interaction-not-pending",
    "interrupt-not-pending",
    "proposal-not-pending",
    "interaction-not-pending",
]);

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
    if (!(compose instanceof HTMLFormElement) || !(stop instanceof HTMLFormElement) || !(field instanceof HTMLTextAreaElement)) {
        throw new Error("Session controls are incomplete.");
    }
    const draft = field;
    the(feedback, "message-status", "");
    let resources = new AbortController();
    const transcript = sessionHistory(history, main, (address) => readBody(address, auth, resources.signal),
        (address, signal) => readHistory(address, auth, AbortSignal.any([signal, resources.signal])));
    const preview = reasoningPreview(history, Number(element.dataset.reasoningPreviewChars));
    const diagnosticList = $("#session-diagnostics");
    if (!(diagnosticList instanceof HTMLElement)) throw new Error("Session document has no diagnostics outlet.");
    const diagnose = diagnostics(diagnosticList);
    const activityList = $("#session-activity");
    if (!(activityList instanceof HTMLElement)) throw new Error("Session document has no activity outlet.");
    const observeActivity = activity(activityList, (address) => readBody(address, auth, resources.signal));
    const streamList = $("#session-streams");
    if (!(streamList instanceof HTMLElement)) throw new Error("Session document has no stream outlet.");
    const streams = sessionStreams(streamList, (target) => readEntry(target, sessionId, auth, resources.signal));
    const presentState = sessionState(element);
    let agent = new SessionAgent({ url: "/acp", sessionId });
    /** @type {import("@plurnk/plurnk-acp/client").AcpSessionStatus | undefined} */
    let status;
    /** @type {{message: {id: string, role: "user", content: string}, retryable: boolean} | undefined} */
    let pending;
    /** @type {{controller: AbortController, done: Promise<void>} | undefined} */
    let delivery;
    /** @type {AbortController | undefined} */
    let cancellation;
    // {§web-session-input} An interrupt that has arrived and is not yet presented holds Send until its review appears.
    let arriving = false;
    /** @param {string} kind @param {Record<string, unknown>} [params] @param {AbortSignal} [signal] */
    const action = (kind, params = {}, signal = resources.signal) => managementAction(kind, params, sessionId, auth, signal);
    const toggleYolo = async () => {
        const enabled = approval.getAttribute("aria-pressed") !== "true";
        approval.setAttribute("aria-pressed", String(enabled));
        approval.title = `${enabled ? "Auto" : "Manual"} Approval (/yolo)`;
        const mode = review.automatic(enabled);
        const current = agent;
        if (mode === "automatic" && the(element, "connection") === "interrupted" && !cancellation) {
            const resume = await review.decisions(current.pendingInterrupts);
            if (resume && current === agent && the(element, "connection") === "interrupted" && !cancellation) connect({ resume });
        }
        availability();
        return enabled;
    };
    const runCommand = sessionCommands(main, { call: action, stop: cancelWork, toggleYolo });
    sessionSettings(main, element, action, () => resources.signal);

    function availability() {
        const current = the(element, "connection");
        const live = status && ["queued", "running", "parked"].includes(status.lifecycle);
        const commandPending = the(controls, "command-pending") !== null;
        the(controls, {
            liveWork: live ? "" : null,
            sendUnavailable: (isCommand(draft.value) ? !commandPending
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
    }

    /** @param {AbortSignal} signal @returns {Promise<Record<string, string>>} */
    const credentials = (signal) => accessHeaders(auth, signal);

    /** @param {string} id */
    function acknowledged(id) {
        if (pending?.message.id !== id) return;
        if (draft.value === pending.message.content) draft.value = "";
        pending = undefined;
        the(feedback, { messageStatus: "", commandError: "" });
        availability();
    }

    /** @param {AbortController} controller @param {Submission} [submission] */
    async function follow(controller, submission) {
        const { signal } = controller;
        let holding = false;
        const timer = setInterval(() => {
            if (["connected", "interrupted"].includes(the(element, "connection") ?? "") && status) the(element, clocks(status, Date.now()));
        }, CLOCK_TICK_MS);
        try {
            while (!signal.aborted) {
                if (!holding) connection("connecting", "Connecting…");
                if (!submission && !holding) {
                    agent.close();
                    agent = new SessionAgent({ url: "/acp", sessionId });
                }
                if (!submission?.resume && !holding) review.present([]);
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
                        await streams.consume(update);
                        observeActivity(update);
                    },
                    onMessagesChanged: ({ messages }) => { if (!signal.aborted) transcript.present(messages); },
                    onUserMessage: ({ messageId }) => {
                        if (!signal.aborted) acknowledged(messageId);
                    },
                    onMessagesSnapshot: ({ snapshot }) => {
                        if (signal.aborted) return;
                        transcript.snapshot(snapshot);
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
                    onError: ({ message, status: errStatus, problem: errProblem, terminal: errTerminal }) => {
                        if (signal.aborted) return;
                        terminal = errTerminal !== undefined;
                        problem = errStatus ?? (typeof errProblem?.status === "number" ? errProblem.status : undefined);
                        const problemType = typeof errProblem?.type === "string" ? errProblem.type : "";
                        settled = problem === 409 && SETTLED_INTERRUPTS.has(problemType);
                        // An observer sent nothing: the session's own failure shows in its status, not as this page's request.
                        if (terminal && submission) the(feedback, "command-error", message);
                        else refusal = message;
                    },
                };
                const delivered = failing(subscriber, (error) => { intake = { error }; run.abort(error); });
                try {
                    if (submission) await agent.runAgent({ abortController: run, message: submission.message, resume: submission.resume }, delivered);
                    else await agent.connectAgent(holding ? { interrupts: agent.pendingInterrupts.map(({ id }) => id) } : {}, delivered);
                } catch (error) {
                    if (intake === undefined) throw error;
                }
                if (intake !== undefined) {
                    agent.close();
                    throw intake.error;
                }
                signal.throwIfAborted();
                if (interrupted) {
                    holding = false;
                    const mode = review.present(agent.pendingInterrupts, agent.messages);
                    arriving = false;
                    if (mode === "automatic") {
                        const resume = await review.decisions(agent.pendingInterrupts);
                        if (!resume) throw new Error("Automatic approval did not resolve its presented set.");
                        submission = { resume };
                        continue;
                    }
                    connection("interrupted", "Input required");
                    the(connectionNotice, "connection-detail", mode === "manual" ? "Review the pending requests."
                        : mode === "expired" ? "The decision deadline has passed; the daemon cancels these requests."
                            : "This page cannot answer this interaction. Work remains pending.");
                    holding = true;
                    submission = undefined;
                    continue;
                }
                if (settled && submission?.resume) the(feedback, "command-error", `Response not accepted: ${refusal}`);
                else if (!terminal) throw Object.assign(new Error(refusal ?? "Delivery ended without a session outcome."), { status: problem });
                holding = false;
                submission = undefined;
            }
        } catch (error) {
            if (signal.aborted) return;
            agent.close();
            const signedOut = Reflect.get(Object(error), "status") === 401;
            connection(signedOut ? "signed-out" : "disconnected", signedOut ? "Sign-in ended" : "Disconnected");
            const guidance = signedOut ? "Sign in to connect to this session again." : "Displayed values are no longer live. Reconnect to check the session.";
            the(connectionNotice, "connection-detail", `${error instanceof Error ? error.message : String(error)} ${guidance}`);
            if (pending) the(feedback, { messageStatus: "", commandError: "Message delivery is unconfirmed. Your draft is retained; reconnect before trying again." });
            if (submission?.resume) the(feedback, { messageStatus: "", commandError: `Response could not be confirmed: ${error instanceof Error ? error.message : String(error)}` });
        } finally {
            arriving = false;
            availability();
            preview.clear();
            clearInterval(timer);
            agent.headers = {};
        }
    }

    /** @param {Submission} [submission] */
    function connect(submission) {
        const previous = delivery;
        previous?.controller.abort();
        preview.clear();
        const controller = new AbortController();
        connection("connecting", "Connecting…");
        delivery = { controller, done: (async () => {
            await previous?.done;
            if (!controller.signal.aborted) await follow(controller, submission);
        })() };
    }

    on(element, "click", "#session-yolo", async () => {
        try { await toggleYolo(); }
        catch (error) {
            if (!resources.signal.aborted) the(feedback, "command-error", error instanceof Error ? error.message : String(error));
        }
    });
    on(main, "submit", "#session-reconnect", (event) => {
        event.preventDefault();
        if (["disconnected", "interrupted"].includes(the(element, "connection") ?? "")) {
            the(feedback, "command-error", "");
            connect();
        }
    });
    on(compose, "input", "textarea", () => { draft.setCustomValidity(""); availability(); });
    on(compose, "keydown", "textarea", (event) => {
        if (!(event instanceof KeyboardEvent) || event.key !== "Enter" || !event.ctrlKey
            || event.altKey || event.metaKey || event.shiftKey || event.isComposing || event.repeat) return;
        event.preventDefault();
        compose.requestSubmit();
    });
    on(compose, "submit", "form", async (event) => {
        event.preventDefault();
        if (the(controls, "send-unavailable") !== null) return;
        if (isCommand(draft.value)) {
            const text = draft.value;
            the(controls, "command-pending", "");
            availability();
            try {
                if (await runCommand(text, resources.signal) && draft.value === text) draft.value = "";
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
        const message = pending?.message.content === draft.value ? pending.message
            : { id: randomUUID(), role: /** @type {const} */ ("user"), content: draft.value };
        pending = { message, retryable: false };
        the(feedback, { messageStatus: "Sending…", commandError: "" });
        connect({ message });
    });

    on(review.form, "submit", "form", async (event) => {
        event.preventDefault();
        if (the(review.form, "review-unavailable") !== null || the(review.form, "request-count") === "0") return;
        const current = agent;
        const reading = review.decisions(current.pendingInterrupts);
        the(review.form, "review-unavailable", "");
        try {
            const resume = await reading;
            if (!resume || current !== agent || cancellation || the(element, "connection") !== "interrupted") return;
            the(feedback, { messageStatus: "", commandError: "" });
            connect({ resume });
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
            if (the(element, "connection") === "interrupted") connect();
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
            transcript.resume();
            connect();
        }
    };
    connect();
}
