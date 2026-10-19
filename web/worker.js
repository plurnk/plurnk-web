import { $, on, the } from "on_the_money";
import WorkerAgent, { interactionTools, randomUUID } from "./worker-agent.js";
import { elapsed, gauges } from "./worker-status.js";
import conversation from "./conversation.js";
import reviewRequests from "./worker-review.js";

/** @typedef {{message?: {id: string, role: "user", content: string}, resume?: import("@ag-ui/client").RunAgentParameters["resume"]}} Submission */

// {§web-worker-observer} Repaint at the elapsed label's whole-second precision; no network polling.
const ELAPSED_TICK_MS = 1000;

// {§web-worker-approval} These refusals require fresh observation, never replay of the answer.
const SETTLED_INTERRUPTS = new Set([
    "https://problems.plurnk.xyz/agui/interrupt/interrupt-not-pending",
    "https://problems.plurnk.xyz/proposal/resolution/proposal-not-pending",
    "https://problems.plurnk.xyz/interaction/resolution/interaction-not-pending",
]);

/** {§web-worker-observer} {§web-worker-input} Delivery changes never own the worker's lifetime.
 * @param {HTMLElement} element
 */
export default function observeWorker(element) {
    const { threadId, auth, yolo } = element.dataset;
    if (!threadId || (auth !== "session" && auth !== "none") || (yolo !== "1" && yolo !== "0")) throw new Error("Worker document metadata is incomplete.");
    const history = $("#worker-conversation");
    if (!(history instanceof HTMLElement)) throw new Error("Worker document has no conversation outlet.");
    const controls = $.clone("#main", "#worker-controls");
    const review = reviewRequests(controls, yolo === "1");
    const compose = $(controls, "#worker-compose");
    const stop = $(controls, "#worker-stop");
    const field = $(controls, "#worker-message");
    if (!(compose instanceof HTMLFormElement) || !(stop instanceof HTMLFormElement) || !(field instanceof HTMLTextAreaElement)) {
        throw new Error("Worker controls are incomplete.");
    }
    const draft = field;
    the(controls, "message-status", "");
    const present = conversation(history);
    let agent = new WorkerAgent({ url: "/agui/connect", threadId });
    /** @type {import("@plurnk/plurnk-agui/client").AguiStatusState | undefined} */
    let status;
    /** @type {{message: {id: string, role: "user", content: string}, retryable: boolean} | undefined} */
    let pending;
    /** @type {{controller: AbortController, done: Promise<void>} | undefined} */
    let delivery;
    /** @type {AbortController | undefined} */
    let cancellation;

    function availability() {
        const current = the(element, "connection");
        const live = status && ["queued", "running", "parked"].includes(status.lifecycle);
        the(controls, {
            sendUnavailable: current === "connected" && (!pending || pending.retryable) && !cancellation ? null : "",
            stopUnavailable: live && ["connected", "interrupted"].includes(current ?? "") && !cancellation ? null : "",
        });
        the(review.form, "review-unavailable", current === "interrupted" && !cancellation ? null : "");
    }

    /** @param {string} current @param {string} label */
    function connection(current, label) {
        the(element, { connection: current, connectionLabel: label });
        availability();
    }

    /** @param {AbortSignal} signal @returns {Promise<Record<string, string>>} */
    async function credentials(signal) {
        if (auth === "none") return {};
        const response = await fetch("/auth/token", { method: "POST", signal });
        if (!response.ok) throw Object.assign(new Error(`Access credential request failed (${response.status}).`), { status: response.status });
        let token;
        try {
            token = await response.json();
        } catch (cause) {
            // A JSON parser's message may contain credential bytes; preserve it only as the cause.
            throw new Error("Access credential response is not valid JSON.", { cause });
        }
        if (!token || token.token_type !== "Bearer" || typeof token.access_token !== "string" || !token.access_token) {
            throw new Error("Invalid access credential response.");
        }
        return { Authorization: `Bearer ${token.access_token}` };
    }

    /** @param {string} id */
    function acknowledged(id) {
        if (pending?.message.id !== id) return;
        if (draft.value === pending.message.content) draft.value = "";
        pending = undefined;
        the(controls, { messageStatus: "", commandError: "" });
        availability();
    }

    /** @param {AbortController} controller @param {Submission} [submission] */
    async function follow(controller, submission) {
        const { signal } = controller;
        let holding = false;
        const timer = setInterval(() => {
            if (["connected", "interrupted"].includes(the(element, "connection") ?? "") && status) the(element, "elapsed", elapsed(status, Date.now()));
        }, ELAPSED_TICK_MS);
        try {
            while (!signal.aborted) {
                if (!holding) connection("connecting", "Connecting…");
                if (!submission && !holding) agent = new WorkerAgent({ url: "/agui/connect", threadId });
                if (!submission?.resume && !holding) review.present([]);
                agent.headers = await credentials(signal);
                signal.throwIfAborted();
                agent.url = submission ? "/agui" : "/agui/connect";
                agent.abortController = controller;
                if (submission?.message) agent.addMessage(submission.message);
                let terminal = false;
                let interrupted = false;
                let settled = false;
                /** @type {number | undefined} */
                let problem;
                /** @type {string | undefined} */
                let refusal;
                /** @type {import("@ag-ui/client").AgentSubscriber} */
                const subscriber = {
                    onMessagesChanged: ({ messages }) => { if (!signal.aborted) present(messages); },
                    onTextMessageStartEvent: ({ event }) => {
                        if (!signal.aborted && event.role === "user") acknowledged(event.messageId);
                    },
                    onMessagesSnapshotEvent: ({ event }) => {
                        if (signal.aborted || !pending) return;
                        if (event.messages.some(({ id, role }) => id === pending?.message.id && role === "user")) acknowledged(pending.message.id);
                        else if (!submission) {
                            pending.retryable = true;
                            the(controls, { messageStatus: "Delivery remains unconfirmed. You may retry this draft.", commandError: "" });
                            availability();
                        }
                    },
                    onStateChanged: ({ state }) => {
                        const next = /** @type {{plurnk?: import("@plurnk/plurnk-agui/client").AguiPlusState}} */ (state).plurnk?.status;
                        if (!next || signal.aborted) return;
                        status = next;
                        if (pending && next.inbox.some(({ id }) => id === pending?.message.id)) acknowledged(pending.message.id);
                        the(element, { ...gauges(next), elapsed: elapsed(next, Date.now()) });
                        if (!holding) connection("connected", "Connected");
                    },
                    onRunFinishedEvent: ({ outcome }) => {
                        terminal = outcome !== "interrupt";
                        interrupted = outcome === "interrupt";
                    },
                    onRunErrorEvent: ({ event }) => {
                        if (signal.aborted) return;
                        const details = /** @type {{plurnk?: {terminal?: unknown, problem?: {status: number, type: string}}} | undefined} */ (event.metadata)?.plurnk;
                        terminal = details?.terminal !== undefined;
                        problem = details?.problem?.status;
                        settled = problem === 409 && SETTLED_INTERRUPTS.has(details?.problem?.type ?? "");
                        if (terminal) the(controls, "command-error", event.message);
                        else refusal = event.message;
                    },
                };
                if (submission) await agent.runAgent({ abortController: controller, resume: submission.resume, tools: interactionTools, forwardedProps: { plurnk: { interactive: true } } }, subscriber);
                else await agent.connectAgent(holding ? { forwardedProps: { plurnk: { interrupts: agent.pendingInterrupts.map(({ id }) => id) } } } : {}, subscriber);
                signal.throwIfAborted();
                if (interrupted) {
                    holding = false;
                    const mode = review.present(agent.pendingInterrupts, agent.messages);
                    if (mode === "automatic") {
                        const resume = await review.decisions(agent.pendingInterrupts);
                        if (!resume) throw new Error("Automatic approval did not resolve its presented set.");
                        submission = { resume };
                        continue;
                    }
                    connection("interrupted", "Input required");
                    the(element, "connection-detail", mode === "manual" ? "Review the pending requests below." : "This page cannot answer this interaction. Work remains pending.");
                    holding = true;
                    submission = undefined;
                    continue;
                }
                if (settled && submission?.resume) the(controls, "command-error", `Response not accepted: ${refusal}`);
                else if (!terminal) throw Object.assign(new Error(refusal ?? "Delivery ended without a worker outcome."), { status: problem });
                holding = false;
                submission = undefined;
            }
        } catch (error) {
            if (signal.aborted) return;
            const signedOut = Reflect.get(Object(error), "status") === 401;
            connection(signedOut ? "signed-out" : "disconnected", signedOut ? "Sign-in ended" : "Disconnected");
            const guidance = signedOut ? "Sign in to connect to this worker again." : "Displayed values are no longer live. Reconnect to check the worker.";
            the(element, "connection-detail", `${error instanceof Error ? error.message : String(error)} ${guidance}`);
            if (pending) the(controls, { messageStatus: "", commandError: "Message delivery is unconfirmed. Your draft is retained; reconnect before trying again." });
            if (submission?.resume) the(controls, { messageStatus: "", commandError: `Response could not be confirmed: ${error instanceof Error ? error.message : String(error)}` });
        } finally {
            clearInterval(timer);
            agent.headers = {};
        }
    }

    /** @param {Submission} [submission] */
    function connect(submission) {
        const previous = delivery;
        previous?.controller.abort();
        const controller = new AbortController();
        connection("connecting", "Connecting…");
        delivery = { controller, done: (async () => {
            await previous?.done;
            if (!controller.signal.aborted) await follow(controller, submission);
        })() };
    }

    on(element, "submit", "#worker-reconnect", (event) => {
        event.preventDefault();
        if (["disconnected", "interrupted"].includes(the(element, "connection") ?? "")) {
            the(controls, "command-error", "");
            connect();
        }
    });
    on(compose, "input", "textarea", () => draft.setCustomValidity(""));
    on(compose, "submit", "form", (event) => {
        event.preventDefault();
        if (the(controls, "send-unavailable") !== null) return;
        if (!draft.value.trim()) {
            draft.setCustomValidity("Enter a message.");
            draft.reportValidity();
            return;
        }
        const message = pending?.message.content === draft.value ? pending.message
            : { id: randomUUID(), role: /** @type {const} */ ("user"), content: draft.value };
        pending = { message, retryable: false };
        the(controls, { messageStatus: "Sending…", commandError: "" });
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
            the(controls, { messageStatus: "", commandError: "" });
            connect({ resume });
        } finally { availability(); }
    });

    on(stop, "submit", "form", async (event) => {
        event.preventDefault();
        if (the(controls, "stop-unavailable") !== null) return;
        const controller = new AbortController();
        cancellation = controller;
        availability();
        the(controls, { messageStatus: "Requesting Stop…", commandError: "" });
        const command = new WorkerAgent({ url: "/agui", threadId });
        try {
            command.headers = await credentials(controller.signal);
            controller.signal.throwIfAborted();
            const { result } = await command.runAgent({ abortController: controller, forwardedProps: { plurnk: { action: { kind: "loop.cancel" } } } });
            controller.signal.throwIfAborted();
            const outcome = /** @type {{ok?: boolean, result?: {cancelled?: boolean}} | undefined} */ (result);
            if (outcome?.ok !== true || typeof outcome.result?.cancelled !== "boolean") throw new Error("Stop was not acknowledged.");
            the(controls, "message-status", outcome.result.cancelled ? "Stop requested." : "No active work to stop.");
            if (the(element, "connection") === "interrupted") connect();
        } catch (error) {
            if (!controller.signal.aborted) the(controls, { messageStatus: "", commandError: `Stop could not be confirmed: ${error instanceof Error ? error.message : String(error)}` });
        } finally {
            command.headers = {};
            cancellation = undefined;
            availability();
        }
    });

    window.onpagehide = () => {
        delivery?.controller.abort();
        cancellation?.abort();
        connection("closed", "Not connected.");
    };
    window.onpageshow = (event) => { if (event.persisted) connect(); };
    connect();
}
