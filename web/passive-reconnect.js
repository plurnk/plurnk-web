// {§web-session-observer} {§web-session-directory} Bounded retry pacing for idempotent passive streams.
// Per ARCHITECTURE.md configuration authority, backoff timing is transport mechanism, not an operator panel knob:
// 1.5s base lets whole-second status clocks freeze visibly on disconnect and avoids hammering a restarting daemon,
// doubling to a 30s ceiling with 0..500ms positive jitter so concurrent views desynchronize.
const RECONNECT_INITIAL_MS = 1500;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_FACTOR = 2;
const RECONNECT_JITTER_MS = 500;

/**
 * Classify whether an observation error represents a transient transport or server availability loss
 * eligible for automatic passive reconnection, as opposed to a deterministic client/authority/protocol refusal.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryableObservationFailure(error) {
    const record = Object(error);
    if (Reflect.get(record, "protocolFailure") === true) return false;
    const status = Reflect.get(record, "status");
    if (typeof status === "number") {
        return status === 408 || status === 429 || status >= 500;
    }
    return true;
}

/**
 * Schedule bounded jittered exponential-backoff retries and immediate `online` / `visibilitychange` recovery
 * for a passive observation stream.
 * @param {() => void} retry
 */
export function createPassiveReconnect(retry) {
    let attempts = 0;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    let active = false;

    const clearTimer = () => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };

    const triggerImmediate = () => {
        if (!active) return;
        clearTimer();
        retry();
    };

    window.ononline = () => {
        triggerImmediate();
    };
    document.onvisibilitychange = () => {
        if (document.visibilityState === "visible") {
            triggerImmediate();
        }
    };

    return {
        schedule() {
            clearTimer();
            active = true;
            const exponentialMs = Math.min(RECONNECT_MAX_MS, RECONNECT_INITIAL_MS * RECONNECT_FACTOR ** attempts);
            const delayMs = exponentialMs + Math.floor(Math.random() * RECONNECT_JITTER_MS);
            attempts += 1;
            timer = setTimeout(() => {
                timer = undefined;
                if (active) retry();
            }, delayMs);
        },
        reset() {
            active = false;
            attempts = 0;
            clearTimer();
        },
        stop() {
            active = false;
            clearTimer();
        },
    };
}
