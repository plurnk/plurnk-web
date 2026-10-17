import { the } from "on_the_money";
import WorkerAgent from "./worker-agent.js";
import { elapsed, gauges } from "./worker-status.js";

/** {§web-worker-observer} One page owns a passive subscription, not the worker's lifetime.
 * @param {HTMLElement} element
 */
export default function observeWorker(element) {
    const { threadId, auth } = element.dataset;
    if (!threadId || (auth !== "session" && auth !== "none")) throw new Error("Worker document metadata is incomplete.");
    /** @type {AbortController | undefined} */
    let page;

    /** @param {AbortController} controller */
    async function observe(controller) {
        const { signal } = controller;
        /** @type {import("@plurnk/plurnk-agui/client").AguiStatusState | undefined} */
        let status;
        let connected = false;
        const timer = setInterval(() => {
            if (connected && status) the(element, "elapsed", elapsed(status, Date.now()));
        }, 1000);
        try {
            while (!signal.aborted) {
                connected = false;
                the(element, { connection: "connecting", connectionLabel: "Connecting…" });
                /** @type {Record<string, string>} */
                const headers = {};
                if (auth === "session") {
                    const response = await fetch("/auth/token", { method: "POST", signal });
                    if (!response.ok) throw Object.assign(new Error("Access credential unavailable."), { status: response.status });
                    const token = await response.json();
                    if (token.token_type !== "Bearer" || typeof token.access_token !== "string" || !token.access_token) {
                        throw new Error("Invalid access credential response.");
                    }
                    headers.Authorization = `Bearer ${token.access_token}`;
                }
                signal.throwIfAborted();
                const agent = new WorkerAgent({ url: "/agui/connect", threadId, headers });
                agent.abortController = controller;
                let terminated = false;
                /** @type {number | undefined} */
                let problem;
                await agent.connectAgent({}, {
                    onStateChanged: ({ state }) => {
                        const next = /** @type {{plurnk?: import("@plurnk/plurnk-agui/client").AguiPlusState}} */ (state).plurnk?.status;
                        if (!next || signal.aborted) return;
                        status = next;
                        connected = true;
                        the(element, { ...gauges(next), elapsed: elapsed(next, Date.now()), connection: "connected", connectionLabel: "Connected" });
                    },
                    onRunFinishedEvent: ({ outcome }) => { terminated = outcome !== "interrupt"; },
                    onRunErrorEvent: ({ event }) => {
                        const details = /** @type {{plurnk?: {terminal?: unknown, problem?: {status: number}}} | undefined} */ (event.metadata)?.plurnk;
                        terminated = details?.terminal !== undefined;
                        problem = details?.problem?.status;
                    },
                });
                signal.throwIfAborted();
                if (!terminated) throw Object.assign(new Error("Observation ended."), { status: problem });
            }
        } catch (error) {
            if (signal.aborted) return;
            const signedOut = Reflect.get(Object(error), "status") === 401;
            the(element, {
                connection: signedOut ? "signed-out" : "disconnected",
                connectionLabel: signedOut ? "Sign-in ended" : "Disconnected",
                connectionDetail: signedOut ? "Sign in to observe this worker again." : "Displayed values are no longer live. Reconnect to check the worker.",
            });
        } finally {
            clearInterval(timer);
        }
    }

    function start() {
        page = new AbortController();
        void observe(page);
    }
    window.onpagehide = () => {
        page?.abort();
        the(element, { connection: "closed", connectionLabel: "Not connected." });
    };
    window.onpageshow = (event) => { if (event.persisted) start(); };
    start();
}
