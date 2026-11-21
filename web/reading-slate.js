import { $, on, the } from "on_the_money";

// {§web-session-history} One line-height slack absorbs subpixel rounding across zoom levels and DPIs.
const FOLD_SLACK_PX = 24;
const TOP_BREATHING_PX = 12;
const TALL_PROMPT_RATIO = 0.35;
const TALL_PROMPT_TAIL_RATIO = 0.3;

/** @param {HTMLElement} scroller */
function hasHashTarget(scroller) {
    const raw = location.hash.slice(1);
    if (!raw) return false;
    let id = raw;
    try { id = decodeURIComponent(raw); }
    catch { /* keep literal fragment */ }
    return id !== "" && $(scroller, `#${CSS.escape(id)}`) !== null;
}

/**
 * {§web-session-history} Modern Reading Slate scroll framing:
 * - Initial transcript arrival lands at the bottom of real content (unless `#footnote-*` hash is targeted).
 * - Prompt submission frames the new turn at the top of `<main>` using a CSP-clean `<svg data-slate-spacer>`
 *   trailing buffer that shrinks proportionally as response content grows, without chasing `scrollHeight`.
 * - A sticky floating `↓` control (`[data-jump-bottom]`) surfaces whenever real content or a review gate extends below the fold.
 * @param {HTMLElement} scroller
 */
export default function readingSlate(scroller) {
    const checkInitialHash = location.hash.length > 1;
    let suppressInitial = checkInitialHash && hasHashTarget(scroller);
    let initialSettled = false;
    let paused = false;
    /** @type {string | null} */
    let pendingTurnMessageId = null;
    /** @type {string | null} */
    let priorLastUserId = null;
    /** @type {string | null} */
    let anchoredMessageId = null;
    let anchoredUserIndex = -1;
    let anchoredTurn = false;
    let userScrolledAway = false;
    /** @type {number | null} */
    let anchoredScrollTop = null;

    let jumpSlot = $(scroller, ":scope > [data-jump-slot]");
    if (!(jumpSlot instanceof HTMLElement) && $("#reading-slate-jump")) {
        const cloned = $.clone(scroller, "#reading-slate-jump");
        if (cloned instanceof HTMLElement) jumpSlot = cloned;
    }
    const jumpButton = jumpSlot ? $(jumpSlot, "button[data-jump-bottom]") : null;

    let spacer = $(scroller, ":scope > svg[data-slate-spacer]");
    if (!(spacer instanceof SVGElement) && $("#reading-slate-spacer")) {
        const cloned = $.clone(scroller, "#reading-slate-spacer");
        if (cloned instanceof SVGElement) spacer = cloned;
    }

    function ensureTailOrder() {
        if (jumpSlot && spacer) {
            if (spacer.nextElementSibling !== null) scroller.append(spacer);
            if (jumpSlot.nextElementSibling !== spacer) scroller.insertBefore(jumpSlot, spacer);
        } else if (spacer && spacer.nextElementSibling !== null) {
            scroller.append(spacer);
        }
    }

    function currentSpacerHeight() {
        if (!spacer) return 0;
        const raw = Number(spacer.getAttribute("height") ?? "0");
        return Number.isFinite(raw) && raw > 0 ? raw : 0;
    }

    /** @param {number} px */
    function setSpacerHeight(px) {
        if (!spacer) return;
        const clamped = Math.max(0, Math.round(px));
        const next = String(clamped);
        if (spacer.getAttribute("height") !== next) {
            spacer.setAttribute("height", next);
            if (clamped > 0) spacer.setAttribute("viewBox", `0 0 1 ${clamped}`);
            else spacer.removeAttribute("viewBox");
        }
    }

    function realContentBottom() {
        ensureTailOrder();
        let maxBottom = 0;
        const canMeasureStyle = typeof getComputedStyle === "function";
        for (const child of scroller.children) {
            if (child === jumpSlot || child === spacer || !(child instanceof HTMLElement) || child.hidden) continue;
            if (child.getAttribute("aria-label") === "Message feedback") continue;
            const { top, height } = offsetWithinScroller(child);
            if (height > 0) {
                const marginBottom = canMeasureStyle ? (Number.parseFloat(getComputedStyle(child).marginBottom) || 0) : 0;
                if (top + height + marginBottom > maxBottom) {
                    maxBottom = top + height + marginBottom;
                }
            }
        }
        if (maxBottom > 0) {
            const padBottom = canMeasureStyle
                ? (Number.parseFloat(getComputedStyle(scroller).paddingBottom) || 0)
                : 0;
            return maxBottom + padBottom;
        }
        return Math.max(0, scroller.scrollHeight - currentSpacerHeight());
    }

    /** @param {HTMLElement} target */
    function offsetWithinScroller(target) {
        const scrollerRect = scroller.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        if (scrollerRect.height > 0 || targetRect.height > 0) {
            return {
                top: scroller.scrollTop + (targetRect.top - scrollerRect.top),
                height: targetRect.height,
            };
        }
        return {
            top: target.offsetTop,
            height: target.offsetHeight,
        };
    }

    function updateJumpIndicator() {
        if (!jumpSlot || !(jumpButton instanceof HTMLButtonElement)) return;
        if (scroller.isConnected === false || scroller.hidden) return;
        const realBottom = realContentBottom();
        const visibleBottom = scroller.scrollTop + scroller.clientHeight;
        const belowFold = realBottom - visibleBottom > FOLD_SLACK_PX;
        if (!belowFold) {
            jumpButton.hidden = true;
            the(jumpButton, { "jump-gate": null });
            jumpButton.setAttribute("aria-label", "Jump to latest");
            jumpButton.title = "Jump to latest";
            return;
        }
        const reviewForm = $(scroller, '[aria-label="Review requests"]:not([data-request-count="0"])');
        let gateBelowFold = false;
        if (reviewForm instanceof HTMLElement && !reviewForm.hidden) {
            const { top } = offsetWithinScroller(reviewForm);
            gateBelowFold = top > visibleBottom - FOLD_SLACK_PX;
        }
        jumpButton.hidden = false;
        if (gateBelowFold) {
            the(jumpButton, { "jump-gate": "true" });
            jumpButton.setAttribute("aria-label", "Jump to pending review");
            jumpButton.title = "Jump to pending review";
        } else {
            the(jumpButton, { "jump-gate": null });
            jumpButton.setAttribute("aria-label", "Jump to latest");
            jumpButton.title = "Jump to latest";
        }
    }

    /** @param {HTMLElement} promptEl @param {number} viewportH */
    function computeTargetTop(promptEl, viewportH) {
        const { top, height } = offsetWithinScroller(promptEl);
        return viewportH > 0 && height > viewportH * TALL_PROMPT_RATIO
            ? Math.max(0, Math.round(top + height - viewportH * TALL_PROMPT_TAIL_RATIO))
            : Math.max(0, Math.round(top - TOP_BREATHING_PX));
    }

    function findAnchoredPrompt() {
        if (anchoredMessageId) {
            const byId = $(scroller, `[data-messages] > [data-message-id="${CSS.escape(anchoredMessageId)}"]`);
            if (byId instanceof HTMLElement) return byId;
        }
        if (anchoredUserIndex >= 0) {
            const users = Array.from(scroller.querySelectorAll('[data-messages] > [data-message-role="user"]'));
            const byIdx = users[anchoredUserIndex];
            if (byIdx instanceof HTMLElement) return byIdx;
        }
        return null;
    }

    /** @param {HTMLElement} promptEl @param {string} [knownId] */
    function applyTurnFrame(promptEl, knownId) {
        if (scroller.isConnected === false || scroller.hidden) return;
        ensureTailOrder();
        anchoredTurn = true;
        userScrolledAway = false;
        anchoredMessageId = promptEl.getAttribute("data-message-id") ?? knownId ?? "";
        const users = Array.from(scroller.querySelectorAll('[data-messages] > [data-message-role="user"]'));
        anchoredUserIndex = users.indexOf(promptEl);
        const viewportH = scroller.clientHeight;
        const targetTop = computeTargetTop(promptEl, viewportH);
        anchoredScrollTop = targetTop;
        const realBottom = realContentBottom();
        const naturalTurnHeight = Math.max(0, realBottom - targetTop);
        const neededSpacer = viewportH > 0 ? Math.max(0, viewportH - naturalTurnHeight) : 0;
        setSpacerHeight(neededSpacer);
        scroller.scrollTop = targetTop;
        updateJumpIndicator();
    }

    function sync() {
        if (paused || scroller.isConnected === false || scroller.hidden) return;
        if (!suppressInitial && checkInitialHash && !initialSettled && hasHashTarget(scroller)) {
            suppressInitial = true;
        }
        if (pendingTurnMessageId !== null) {
            const requestedId = pendingTurnMessageId;
            const direct = requestedId
                ? $(scroller, `[data-messages] > [data-message-id="${CSS.escape(requestedId)}"]`)
                : null;
            const lastUser = Array.from(scroller.querySelectorAll('[data-messages] > [data-message-role="user"]')).at(-1);
            const fallback = lastUser instanceof HTMLElement
                && (requestedId === "" || (lastUser.dataset.messageId ?? null) !== priorLastUserId)
                ? lastUser
                : null;
            const matched = direct ?? fallback;
            if (matched instanceof HTMLElement) {
                pendingTurnMessageId = null;
                priorLastUserId = null;
                applyTurnFrame(matched, requestedId);
                return;
            }
        }
        if (anchoredTurn && anchoredScrollTop !== null) {
            const viewportH = scroller.clientHeight;
            const currentPrompt = findAnchoredPrompt();
            if (currentPrompt !== null) {
                anchoredScrollTop = computeTargetTop(currentPrompt, viewportH);
            }
            const realBottom = realContentBottom();
            const naturalTurnHeight = Math.max(0, realBottom - anchoredScrollTop);
            const neededSpacer = viewportH > 0 ? Math.max(0, viewportH - naturalTurnHeight) : 0;
            setSpacerHeight(neededSpacer);
            if (!userScrolledAway && currentPrompt !== null && Math.abs(scroller.scrollTop - anchoredScrollTop) > 1) {
                scroller.scrollTop = anchoredScrollTop;
            }
        }
        updateJumpIndicator();
    }

    function jumpToBottom() {
        if (paused || scroller.isConnected === false || scroller.hidden) return;
        pendingTurnMessageId = null;
        priorLastUserId = null;
        anchoredMessageId = null;
        anchoredUserIndex = -1;
        anchoredTurn = false;
        userScrolledAway = false;
        anchoredScrollTop = null;
        setSpacerHeight(0);
        const reviewForm = $(scroller, '[aria-label="Review requests"]:not([data-request-count="0"])');
        if (reviewForm instanceof HTMLElement && !reviewForm.hidden && the(jumpButton ?? scroller, "jump-gate") === "true") {
            const { top, height } = offsetWithinScroller(reviewForm);
            if (height > scroller.clientHeight) {
                scroller.scrollTop = Math.max(0, Math.round(top - TOP_BREATHING_PX));
                updateJumpIndicator();
                return;
            }
        }
        const realBottom = realContentBottom();
        const maxScrollTop = Math.max(0, realBottom - scroller.clientHeight);
        if (scroller.scrollTop !== maxScrollTop) {
            scroller.scrollTop = maxScrollTop;
        }
        updateJumpIndicator();
    }

    function landInitial() {
        if (initialSettled) {
            sync();
            return;
        }
        initialSettled = true;
        if (paused || scroller.isConnected === false || scroller.hidden) return;
        if (suppressInitial || (checkInitialHash && hasHashTarget(scroller))) {
            suppressInitial = true;
            updateJumpIndicator();
            return;
        }
        jumpToBottom();
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => {
                if (!paused && pendingTurnMessageId === null && !anchoredTurn && !suppressInitial) {
                    jumpToBottom();
                }
            });
        }
    }

    /** @param {string} [messageId] */
    function frameTurn(messageId) {
        suppressInitial = false;
        initialSettled = true;
        pendingTurnMessageId = messageId ?? "";
        const immediate = messageId
            ? $(scroller, `[data-messages] > [data-message-id="${CSS.escape(messageId)}"]`)
            : null;
        if (immediate instanceof HTMLElement) {
            pendingTurnMessageId = null;
            priorLastUserId = null;
            applyTurnFrame(immediate, messageId);
            return;
        }
        const lastUser = Array.from(scroller.querySelectorAll('[data-messages] > [data-message-role="user"]')).at(-1);
        priorLastUserId = lastUser instanceof HTMLElement ? (lastUser.dataset.messageId ?? null) : null;
    }

    function release() {
        suppressInitial = true;
        pendingTurnMessageId = null;
        priorLastUserId = null;
        updateJumpIndicator();
    }

    if (jumpSlot) {
        on(jumpSlot, "click", "[data-jump-bottom]", () => {
            jumpToBottom();
        });
    }

    /** @type {MutationObserver | undefined} */
    let mutationObserver;
    /** @type {ResizeObserver | undefined} */
    let resizeObserver;
    /** @type {(() => void)[]} */
    let offViewport = [];
    let syncFrame = 0;

    function handleScroll() {
        if (anchoredTurn && anchoredScrollTop !== null
            && scroller.scrollTop < anchoredScrollTop - 2
            && scroller.scrollTop < scroller.scrollHeight - scroller.clientHeight - 2) {
            userScrolledAway = true;
        }
        updateJumpIndicator();
    }

    function scheduleSync() {
        if (paused || syncFrame !== 0) return;
        if (typeof requestAnimationFrame === "function") {
            syncFrame = requestAnimationFrame(() => {
                syncFrame = 0;
                sync();
            });
        } else {
            sync();
        }
    }

    function connect() {
        scroller.onscroll = handleScroll;
        if (typeof MutationObserver === "function" && !mutationObserver) {
            mutationObserver = new MutationObserver(scheduleSync);
            mutationObserver.observe(scroller, {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: true,
                attributeFilter: ["hidden", "open", "data-request-count"],
            });
        }
        if (typeof ResizeObserver === "function" && !resizeObserver) {
            resizeObserver = new ResizeObserver(scheduleSync);
            resizeObserver.observe(scroller);
        }
        if (offViewport.length === 0 && typeof window === "object" && typeof window?.addEventListener === "function") {
            offViewport.push(on.target(window, "resize", scheduleSync));
            if (window.visualViewport) {
                offViewport.push(on.target(window.visualViewport, "resize", scheduleSync));
            }
        }
    }

    connect();

    return {
        sync,
        landInitial,
        frameTurn,
        jumpToBottom,
        release,
        pause() {
            paused = true;
            scroller.onscroll = null;
            if (syncFrame !== 0 && typeof cancelAnimationFrame === "function") {
                cancelAnimationFrame(syncFrame);
            }
            syncFrame = 0;
            mutationObserver?.disconnect();
            mutationObserver = undefined;
            resizeObserver?.disconnect();
            resizeObserver = undefined;
            for (const off of offViewport) off();
            offViewport = [];
        },
        resume() {
            paused = false;
            connect();
            sync();
        },
    };
}
