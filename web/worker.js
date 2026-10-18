import { $, on, the } from "on_the_money";
import WorkerAgent from "./worker-agent.js";
import { elapsed, gauges } from "./worker-status.js";
import conversation from "./conversation.js";

/** {§web-worker-observer} {§web-worker-input} Delivery changes never own the worker's lifetime.
 * @param {HTMLElement} element
 */
export default function observeWorker(element) {
    const { threadId, auth } = element.dataset;
    if (!threadId || (auth !== "session" && auth !== "none")) throw new Error("Worker document metadata is incomplete.");
    const history = $("#worker-conversation");
    if (!(history instanceof HTMLElement)) throw new Error("Worker document has no conversation outlet.");
    const controls = $.clone("#main", "#worker-controls");
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
        if (!response.ok) throw Object.assign(new Error("Access credential unavailable."), { status: response.status });
        const token = await response.json();
        if (token.token_type !== "Bearer" || typeof token.access_token !== "string" || !token.access_token) {
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

    /** @param {AbortController} controller @param {{id: string, role: "user", content: string}} [message] */
    async function follow(controller, message) {
        const { signal } = controller;
        const timer = setInterval(() => {
            if (the(element, "connection") === "connected" && status) the(element, "elapsed", elapsed(status, Date.now()));
        }, 1000);
        try {
            while (!signal.aborted) {
                connection("connecting", "Connecting…");
                if (!message) agent = new WorkerAgent({ url: "/agui/connect", threadId });
                agent.headers = await credentials(signal);
                signal.throwIfAborted();
                agent.url = message ? "/agui" : "/agui/connect";
                agent.abortController = controller;
                if (message) agent.addMessage(message);
                let terminal = false;
                let interrupted = false;
                /** @type {number | undefined} */
                let problem;
                /** @type {import("@ag-ui/client").AgentSubscriber} */
                const subscriber = {
                    onMessagesChanged: ({ messages }) => { if (!signal.aborted) present(messages); },
                    onTextMessageStartEvent: ({ event }) => {
                        if (!signal.aborted && event.role === "user") acknowledged(event.messageId);
                    },
                    onMessagesSnapshotEvent: ({ event }) => {
                        if (signal.aborted || !pending) return;
                        if (event.messages.some(({ id, role }) => id === pending?.message.id && role === "user")) acknowledged(pending.message.id);
                        else if (!message) {
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
                        connection("connected", "Connected");
                    },
                    onRunFinishedEvent: ({ outcome }) => {
                        terminal = outcome !== "interrupt";
                        interrupted = outcome === "interrupt";
                    },
                    onRunErrorEvent: ({ event }) => {
                        if (signal.aborted) return;
                        const details = /** @type {{plurnk?: {terminal?: unknown, problem?: {status: number}}} | undefined} */ (event.metadata)?.plurnk;
                        terminal = details?.terminal !== undefined;
                        problem = details?.problem?.status;
                        if (terminal) the(controls, "command-error", event.message);
                    },
                };
                if (message) await agent.runAgent({ abortController: controller, forwardedProps: { plurnk: { interactive: true } } }, subscriber);
                else await agent.connectAgent({}, subscriber);
                signal.throwIfAborted();
                if (interrupted) {
                    connection("interrupted", "Input required");
                    the(element, "connection-detail", "This page cannot answer approvals or interactions yet. Work remains pending.");
                    return;
                }
                if (!terminal) throw Object.assign(new Error("Delivery ended without a worker outcome."), { status: problem });
                message = undefined;
            }
        } catch (error) {
            if (signal.aborted) return;
            const signedOut = Reflect.get(Object(error), "status") === 401;
            connection(signedOut ? "signed-out" : "disconnected", signedOut ? "Sign-in ended" : "Disconnected");
            the(element, "connection-detail", signedOut ? "Sign in to connect to this worker again." : "Displayed values are no longer live. Reconnect to check the worker.");
            if (pending) the(controls, { messageStatus: "", commandError: "Message delivery is unconfirmed. Your draft is retained; reconnect before trying again." });
        } finally {
            clearInterval(timer);
            agent.headers = {};
        }
    }

    /** @param {{id: string, role: "user", content: string}} [message] */
    function connect(message) {
        const previous = delivery;
        previous?.controller.abort();
        const controller = new AbortController();
        connection("connecting", "Connecting…");
        delivery = { controller, done: (async () => {
            await previous?.done;
            if (!controller.signal.aborted) await follow(controller, message);
        })() };
    }

    on(element, "submit", "#worker-reconnect", (event) => {
        event.preventDefault();
        if (["disconnected", "interrupted"].includes(the(element, "connection") ?? "")) connect();
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
            : { id: crypto.randomUUID(), role: /** @type {const} */ ("user"), content: draft.value };
        pending = { message, retryable: false };
        the(controls, { messageStatus: "Sending…", commandError: "" });
        connect(message);
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
