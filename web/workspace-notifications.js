import { $, on } from "on_the_money";
import { sse } from "on_the_money/live";
import accessHeaders from "./access-headers.js";
import { acpOrigin, notificationsUrl } from "./endpoints.js";
import { hasActiveOidcGrant, onOidcGrantChange, recoverFromUnauthorized } from "./oidc.js";
import { isRetryableObservationFailure } from "./passive-reconnect.js";

export const NOTIFICATION_EVENT_LIST = [
    "notifications/snapshot",
    "notifications/resync",
    "config/changed",
    "workspace/created",
    "workspace/renamed",
    "workspace/archived",
    "functionality/changed",
    "session/created",
    "session/archived",
    "session/deleted",
    "session/titled",
    "session/policy",
    "session/replied",
    "loop/started",
    "loop/parked",
    "loop/proposal",
    "loop/interaction",
    "loop/gate-settled",
    "loop/terminated",
    "stream/concluded",
    "notice/event",
];

/** @typedef {"connecting" | "connected" | "disconnected" | "signed-out" | "closed"} NotificationState */

/**
 * @typedef {{
 *   onNotification?: (payload: Record<string, unknown>) => void,
 *   onStateChange?: (state: NotificationState) => void,
 * }} NotificationListener
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @typedef {{
 *   state: NotificationState,
 *   latestSnapshot: Record<string, unknown> | null,
 *   listeners: Set<NotificationListener>,
 *   initialAuthSettled: Promise<void>,
 *   close: () => void,
 * }} SharedStreamEntry
 */

/** @type {Map<string, SharedStreamEntry>} */
const activeStreams = new Map();

/**
 * {§web-session-directory} {§web-workspace-tabs} Shared reference-counted `/notifications` Watch SSE subscription per scope on `acpOrigin()`.
 * @param {{
 *   workspaceId?: number,
 *   onNotification?: (payload: Record<string, unknown>) => void,
 *   onStateChange?: (state: NotificationState) => void,
 * }} options
 */
export function subscribeWorkspaceNotifications({ workspaceId, onNotification, onStateChange }) {
    const scopeKey = `${acpOrigin()}:${workspaceId ?? "daemon"}`;
    let entry = activeStreams.get(scopeKey);
    if (!entry) {
        const listeners = /** @type {Set<NotificationListener>} */ (new Set());
        /** @type {NotificationState} */
        let currentState = "connecting";
        const { promise: initialAuthSettled, resolve: resolveInitialAuth } = Promise.withResolvers();
        /** @param {NotificationState} next */
        const setState = (next) => {
            if (currentState === next) return;
            currentState = next;
            if (entry) entry.state = next;
            for (const listener of listeners) listener.onStateChange?.(next);
        };
        const endpoint = workspaceId === undefined
            ? notificationsUrl()
            : notificationsUrl(`/${encodeURIComponent(String(workspaceId))}`);
        /** @type {{ close: () => void } | null} */
        let stream = null;
        let disposed = false;

        const startStream = () => {
            stream?.close();
            if (disposed) return;
            setState("connecting");
            const instance = sse(endpoint, {
                types: NOTIFICATION_EVENT_LIST,
                headers: async (signal) => {
                    try {
                        if ($('#session-status[data-connection="signed-out"], #main[data-connection="signed-out"]')) {
                            throw Object.assign(new Error("Sign-in ended"), { status: 401 });
                        }
                        return await accessHeaders(signal);
                    } finally {
                        resolveInitialAuth(undefined);
                    }
                },
                onUp: () => {
                    if (!disposed) setState("connected");
                },
                onMessage: (_type, payload) => {
                    if (disposed) return;
                    if (!isRecord(payload) || typeof payload.event !== "string" || !isRecord(payload.data)) {
                        instance.close();
                        setState("disconnected");
                        return;
                    }
                    if (payload.event === "notifications/snapshot" && entry) {
                        entry.latestSnapshot = payload;
                    }
                    for (const listener of listeners) listener.onNotification?.(payload);
                },
                onError: (error) => {
                    if (disposed) return;
                    const signedOut = Reflect.get(Object(error), "status") === 401;
                    if (signedOut) {
                        instance.close();
                        void recoverFromUnauthorized({ redirectOnDiscovery: false }).then((recovery) => {
                            if (disposed) return;
                            if (recovery.status === "refreshed") {
                                startStream();
                            } else {
                                setState("signed-out");
                            }
                        });
                        return;
                    }
                    if (!isRetryableObservationFailure(error)) {
                        instance.close();
                        setState("disconnected");
                        return;
                    }
                    setState("disconnected");
                },
                onDown: (error) => {
                    if (disposed) return;
                    const signedOut = currentState === "signed-out" || Reflect.get(Object(error), "status") === 401;
                    setState(signedOut ? "signed-out" : "disconnected");
                },
            });
            stream = instance;
        };

        const offGrantChange = onOidcGrantChange(() => {
            if (disposed) return;
            if (!hasActiveOidcGrant()) {
                stream?.close();
                stream = null;
                if (entry) entry.latestSnapshot = null;
                setState("signed-out");
            }
        });

        const offPageHide = on.target(window, "pagehide", () => {
            if (disposed) return;
            stream?.close();
            stream = null;
            if (entry) entry.latestSnapshot = null;
            setState("closed");
        });
        const offPageShow = on.target(window, "pageshow", (event) => {
            if (disposed) return;
            if (event instanceof PageTransitionEvent && event.persisted) {
                startStream();
            }
        });

        entry = {
            state: currentState,
            latestSnapshot: null,
            listeners,
            initialAuthSettled,
            close() {
                if (disposed) return;
                disposed = true;
                offGrantChange();
                offPageHide();
                offPageShow();
                stream?.close();
                stream = null;
                activeStreams.delete(scopeKey);
            },
        };
        activeStreams.set(scopeKey, entry);
        startStream();
    }

    const hadPriorSnapshot = entry.latestSnapshot;
    /** @type {NotificationListener} */
    const listener = { onNotification, onStateChange };
    entry.listeners.add(listener);
    onStateChange?.(entry.state);
    if (hadPriorSnapshot !== null) {
        onNotification?.(hadPriorSnapshot);
    }

    const shared = entry;
    return {
        get state() {
            return shared.state;
        },
        initialAuthSettled: shared.initialAuthSettled,
        unsubscribe() {
            shared.listeners.delete(listener);
            if (shared.listeners.size === 0) {
                shared.close();
            }
        },
    };
}
