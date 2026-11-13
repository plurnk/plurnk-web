import assert from "node:assert/strict";
import test from "node:test";
import stickyTail from "../web/sticky-tail.js";

function fakeScroller({ scrollHeight = 1200, clientHeight = 400, scrollTop = 0, children = [] } = {}) {
    const state = { scrollHeight, clientHeight, scrollTop };
    /** @type {((event?: Event) => void) | null} */
    let onscroll = null;
    const scroller = {
        children,
        querySelector: () => null,
        get scrollHeight() { return state.scrollHeight; },
        set scrollHeight(value) { state.scrollHeight = value; },
        get clientHeight() { return state.clientHeight; },
        set clientHeight(value) { state.clientHeight = value; },
        get scrollTop() { return state.scrollTop; },
        set scrollTop(value) {
            state.scrollTop = Math.max(0, Math.min(value, Math.max(0, state.scrollHeight - state.clientHeight)));
        },
        get onscroll() { return onscroll; },
        set onscroll(handler) { onscroll = handler; },
        scrollToUser(value) {
            state.scrollTop = Math.max(0, Math.min(value, Math.max(0, state.scrollHeight - state.clientHeight)));
            onscroll?.();
        },
    };
    return /** @type {any} */ (scroller);
}

test("{§web-session-history} stickyTail pins initial arrival, releases on upward scroll, survives shrink clamping and re-pins", () => {
    const prevLocation = globalThis.location;
    const prevCss = globalThis.CSS;
    globalThis.location = /** @type {any} */ ({ hash: "" });
    globalThis.CSS = /** @type {any} */ ({ escape: (value) => String(value) });
    try {
        const main = fakeScroller({ scrollHeight: 1400, clientHeight: 400, scrollTop: 0 });
        const tail = stickyTail(main);
        assert.equal(tail.isPinned(), true);

        tail.follow();
        assert.equal(main.scrollTop, 1000, "initial snapshot lands at main's bottom edge");

        main.scrollHeight = 1800;
        tail.follow();
        assert.equal(main.scrollTop, 1400, "tail growth keeps main at the bottom while pinned");

        // Content shrink at bottom (e.g. clearing reasoning preview) clamps scrollTop without unpinning,
        // including when new content (e.g. an arriving review gate) grows scrollHeight before follow() runs.
        main.scrollHeight = 1500;
        main.scrollToUser(1100);
        assert.equal(tail.isPinned(), true, "bottom clamp after shrink remains pinned");
        main.scrollHeight = 1300;
        main.scrollTop = 900;
        main.scrollHeight = 1950;
        tail.follow();
        assert.equal(tail.isPinned(), true, "shrink-then-grow within one update keeps bottom pin");
        assert.equal(main.scrollTop, 1550);

        // Deliberate upward scroll releases the pin immediately.
        main.scrollToUser(600);
        assert.equal(tail.isPinned(), false, "upward scroll releases the bottom pin");
        main.scrollHeight = 2200;
        tail.follow();
        assert.equal(main.scrollTop, 600, "streaming while unpinned leaves reader scrollTop untouched");

        // Scrolling slightly downward but still away from bottom stays unpinned.
        main.scrollToUser(700);
        assert.equal(tail.isPinned(), false);

        // Scrolling back within one line of bottom re-pins.
        main.scrollToUser(1790);
        assert.equal(tail.isPinned(), true);
        main.scrollHeight = 2400;
        tail.follow();
        assert.equal(main.scrollTop, 2000);

        // Explicit release (e.g. Load previous loop or disclosure toggle) and explicit pin (prompt submit).
        tail.release();
        assert.equal(tail.isPinned(), false);
        main.scrollHeight = 2600;
        tail.follow();
        assert.equal(main.scrollTop, 2000);

        tail.pin();
        assert.equal(tail.isPinned(), true);
        assert.equal(main.scrollTop, 2200);

        // Pause / resume across pagehide / pageshow.
        tail.pause();
        main.scrollHeight = 3000;
        tail.follow();
        assert.equal(main.scrollTop, 2200);
        tail.resume();
        tail.follow();
        assert.equal(main.scrollTop, 2600);
    } finally {
        globalThis.location = prevLocation;
        globalThis.CSS = prevCss;
    }
});

test("{§web-session-history} stickyTail suppresses initial bottom jump when URL hash targets an in-main anchor", () => {
    const prevLocation = globalThis.location;
    const prevCss = globalThis.CSS;
    globalThis.location = /** @type {any} */ ({ hash: "#fn-note-1" });
    globalThis.CSS = /** @type {any} */ ({ escape: (value) => String(value) });
    try {
        let anchorPresent = false;
        const main = fakeScroller({ scrollHeight: 1400, clientHeight: 400, scrollTop: 120 });
        main.querySelector = (selector) => selector === "#fn-note-1" && anchorPresent ? ({}) : null;
        const tail = stickyTail(main);
        anchorPresent = true;
        tail.follow();
        assert.equal(tail.isPinned(), false, "initial fragment target inside main suppresses bottom jump");
        assert.equal(main.scrollTop, 120);

        // Explicit prompt submission later in the visit re-pins even if location.hash remains set.
        tail.pin();
        assert.equal(tail.isPinned(), true);
        assert.equal(main.scrollTop, 1000);
        main.scrollHeight = 1600;
        tail.follow();
        assert.equal(main.scrollTop, 1200);
    } finally {
        globalThis.location = prevLocation;
        globalThis.CSS = prevCss;
    }
});

test("{§web-session-history} stickyTail defers ResizeObserver adjustments to requestAnimationFrame", () => {
    const prevLocation = globalThis.location;
    const prevCss = globalThis.CSS;
    const prevRo = globalThis.ResizeObserver;
    const prevRaf = globalThis.requestAnimationFrame;
    const prevCaf = globalThis.cancelAnimationFrame;
    /** @type {(() => void) | undefined} */
    let resizeCallback;
    /** @type {Map<number, () => void>} */
    const frames = new Map();
    let frameId = 0;
    globalThis.location = /** @type {any} */ ({ hash: "" });
    globalThis.CSS = /** @type {any} */ ({ escape: (value) => String(value) });
    globalThis.ResizeObserver = /** @type {any} */ (class {
        constructor(cb) { resizeCallback = cb; }
        observe() {}
        disconnect() {}
    });
    globalThis.requestAnimationFrame = (cb) => {
        const id = ++frameId;
        frames.set(id, () => cb(0));
        return id;
    };
    globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
    try {
        const main = fakeScroller({ scrollHeight: 1400, clientHeight: 400, scrollTop: 1000 });
        const tail = stickyTail(main);
        main.scrollHeight = 1900;
        resizeCallback?.();
        resizeCallback?.();
        assert.equal(frames.size, 1, "multiple ResizeObserver callbacks coalesce into one animation frame");
        assert.equal(main.scrollTop, 1000, "ResizeObserver callback never mutates scrollTop synchronously during layout delivery");
        for (const run of [...frames.values()]) run();
        frames.clear();
        assert.equal(main.scrollTop, 1500, "queued animation frame settles scrollTop at bottom");

        main.scrollHeight = 2200;
        resizeCallback?.();
        assert.equal(frames.size, 1);
        tail.pause();
        assert.equal(frames.size, 0, "pause cancels pending animation frame");
    } finally {
        globalThis.location = prevLocation;
        globalThis.CSS = prevCss;
        globalThis.ResizeObserver = prevRo;
        globalThis.requestAnimationFrame = prevRaf;
        globalThis.cancelAnimationFrame = prevCaf;
    }
});
