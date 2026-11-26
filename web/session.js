import { $, on, the } from "on_the_money";
import { parseDirectory } from "../src/directory-addresses.js";
import accessHeaders from "./access-headers.js";
import { acpUrl } from "./endpoints.js";
import describeFailure from "./failure.js";
import managementAction from "./management-action.js";
import math from "./math.js";
import mermaid from "./mermaid.js";
import { hasActiveOidcGrant, onOidcGrantChange, recoverFromUnauthorized } from "./oidc.js";
import { createPassiveReconnect, isRetryableObservationFailure } from "./passive-reconnect.js";
import readBody from "./read-body.js";
import readHistory from "./read-history.js";
import readingSlate from "./reading-slate.js";
import SessionAgent, { randomUUID } from "./session-agent.js";
import sessionCommands from "./session-commands.js";
import { createSessionComposer } from "./session-composer.js";
import diagnostics from "./session-diagnostics.js";
import sessionHistory from "./session-history.js";
import { createModelSearchCache, sessionConfigOption } from "./session-models.js";
import reviewRequests from "./session-review.js";
import { wireSessionShortcuts } from "./session-shortcuts.js";
import sessionState from "./session-state.js";
import { clocks } from "./session-status.js";

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
    /** @type {{controller: AbortController, done: Promise<void>} | undefined} */
    let delivery;
    /** @type {AbortController | undefined} */
    let cancellation;
    // {§web-session-input} An interrupt that has arrived and is not yet presented holds Send until its review appears.
    let arriving = false;
    let disposed = false;
    let connectedWithGrant = false;
    let inFlightAuthRecovery = false;

    /** @param {string} kind @param {Record<string, unknown>} [params] @param {AbortSignal} [signal] */
    const action = (kind, params = {}, signal = resources.signal) =>
        managementAction(kind, params, sessionId, signal, { redirectOn401: false });
    const modelSearchCache = createModelSearchCache((kind, params = {}, signal) => {
        const combined = signal ? AbortSignal.any([resources.signal, signal]) : resources.signal;
        return action(kind, params, combined);
    });

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

    const composer = createSessionComposer({
        controls,
        footer: element,
        feedback,
        sessionId,
        slate,
        modelSearchCache,
        getAgentState: () => agent.state,
        getStatus: () => status,
        getConnection: () => the(element, "connection"),
        getPendingGates: () => agent.pendingGates,
        getPromptImageSupported: () => agent.promptImageSupported,
        getWorkspaceProjectRoot: () => workspaceProjectRoot,
        getLatestWorkspaceName: () => latestWorkspaceName,
        getWorkbenchSnapshot,
        hasPendingDelivery: () => pending !== undefined,
        isDisposed: () => disposed,
        onAvailabilityChange: () => availability(),
        onRunCommand: (text) => runCommand(text, resources.signal),
        onSubmitPrompt: ({ source, sourceKey, prompt, forceReview, openPaths, attachments: queuedAttachments, attachmentIds }) => {
            const message = pending?.sourceKey === sourceKey
                ? pending.message
                : {
                    id: randomUUID(),
                    role: /** @type {const} */ ("user"),
                    content: prompt,
                    ...(queuedAttachments.length > 0 ? { attachments: queuedAttachments } : {}),
                    ...(openPaths.length > 0 ? { openPaths } : {}),
                };
            pending = {
                message,
                source,
                sourceKey,
                attachmentIds,
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
            connect({ message, ...(forceReview ? { forceReview: true } : {}) });
        },
    });

    const shortcuts = wireSessionShortcuts({
        element,
        main,
        controls,
        stop: composer.stop,
        draft: composer.draft,
        feedback,
        reviewForm: review.form,
        getPendingGates: () => agent.pendingGates,
        isCancelling: () => cancellation !== undefined,
        getResourcesSignal: () => resources.signal,
        toggleYolo,
        runCommand,
    });

    function availability() {
        const current = the(element, "connection");
        const live = status && ["queued", "running", "parked"].includes(status.lifecycle);
        const commandPending = the(controls, "command-pending") !== null;
        the(controls, {
            "live-work": live ? "" : null,
            "prompt-image": agent.promptImageSupported ? "true" : null,
            "send-unavailable": (composer.isClientDispatch(composer.draft.value) ? !commandPending
                : current === "connected" && !arriving && (!pending || pending.retryable) && !cancellation && !commandPending) ? null : "",
            "stop-unavailable": live && ["connected", "interrupted"].includes(current ?? "") && !cancellation ? null : "",
        });
        the(review.form, "review-unavailable", current === "interrupted" && !cancellation && the(review.form, "deadline-passed") === null ? null : "");
        composer.syncSuggestions();
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
        composer.acknowledgePrompt(id, pending);
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
                            composer.recordMessagesPromptHistory(messages);
                            transcript.present(messages);
                            slate.sync();
                        }
                    },
                    onUserMessage: ({ messageId }) => {
                        if (!signal.aborted) acknowledged(messageId);
                    },
                    onMessagesSnapshot: ({ snapshot }) => {
                        if (signal.aborted) return;
                        composer.recordMessagesPromptHistory(snapshot.messages);
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
                        composer.syncSuggestions();
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

    on(composer.stop, "submit", "form", async (event) => {
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
                composer.restoreSavedDraft();
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
            composer.dispose();
            shortcuts.dispose();
            offGrantChange();
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
