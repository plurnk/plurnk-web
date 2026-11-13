import { $ } from "on_the_money";

// {§web-session-history} One line-height slack absorbs subpixel rounding across zoom levels and DPIs without capturing deliberate upward scrolls.
const TAIL_SLACK_PX = 24;

/** @param {HTMLElement} scroller */
function hasHashTarget(scroller) {
    const raw = location.hash.slice(1);
    if (!raw) return false;
    let id = raw;
    try { id = decodeURIComponent(raw); }
    catch { /* keep literal fragment */ }
    return id !== "" && $(scroller, `#${CSS.escape(id)}`) !== null;
}

/** {§web-session-history} Keep `<main>` at its trailing edge until the reader scrolls away or inspects earlier history.
 * @param {HTMLElement} scroller
 */
export default function stickyTail(scroller) {
    let checkInitialHash = location.hash.length > 1;
    let pinned = true;
    if (checkInitialHash && hasHashTarget(scroller)) {
        pinned = false;
        checkInitialHash = false;
    }
    let paused = false;
    let lastScrollTop = scroller.scrollTop;

    const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= TAIL_SLACK_PX;

    function syncScrollState() {
        if (atBottom()) {
            pinned = true;
            checkInitialHash = false;
        } else if (scroller.scrollTop < lastScrollTop) {
            pinned = false;
        }
        lastScrollTop = scroller.scrollTop;
    }

    function follow() {
        if (paused || !pinned) return;
        if (checkInitialHash && hasHashTarget(scroller)) {
            pinned = false;
            checkInitialHash = false;
            lastScrollTop = scroller.scrollTop;
            return;
        }
        const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (scroller.scrollTop !== maxScrollTop) {
            scroller.scrollTop = scroller.scrollHeight;
        }
        lastScrollTop = scroller.scrollTop;
    }

    function pin() {
        if (paused) return;
        pinned = true;
        checkInitialHash = false;
        const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (scroller.scrollTop !== maxScrollTop) {
            scroller.scrollTop = scroller.scrollHeight;
        }
        lastScrollTop = scroller.scrollTop;
    }

    function release() {
        pinned = false;
        lastScrollTop = scroller.scrollTop;
    }

    /** @type {ResizeObserver | undefined} */
    let resizeObserver;
    let resizeFrame = 0;
    function scheduleFollow() {
        if (paused || !pinned || resizeFrame !== 0) return;
        if (typeof requestAnimationFrame === "function") {
            resizeFrame = requestAnimationFrame(() => {
                resizeFrame = 0;
                follow();
            });
        } else {
            follow();
        }
    }
    function connect() {
        scroller.onscroll = syncScrollState;
        if (typeof ResizeObserver === "function" && !resizeObserver) {
            resizeObserver = new ResizeObserver(scheduleFollow);
            resizeObserver.observe(scroller);
            for (const child of scroller.children) resizeObserver.observe(child);
        }
    }

    connect();

    return {
        follow,
        pin,
        release,
        isPinned: () => pinned,
        pause() {
            paused = true;
            scroller.onscroll = null;
            if (resizeFrame !== 0 && typeof cancelAnimationFrame === "function") {
                cancelAnimationFrame(resizeFrame);
            }
            resizeFrame = 0;
            resizeObserver?.disconnect();
            resizeObserver = undefined;
        },
        resume() {
            paused = false;
            lastScrollTop = scroller.scrollTop;
            connect();
        },
    };
}
