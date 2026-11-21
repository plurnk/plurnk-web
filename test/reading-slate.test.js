import assert from "node:assert/strict";
import test from "node:test";
import readingSlate from "../web/reading-slate.js";

class FakeElement {
    hidden = false;
    isConnected = true;
    /** @type {Map<string, string>} */
    #attrs = new Map();
    /** @type {FakeElement[]} */
    children = [];
    /** @type {FakeElement | null} */
    parentElement = null;
    top = 0;
    height = 0;

    /** @param {string} name @param {string} value */
    setAttribute(name, value) { this.#attrs.set(name, String(value)); }
    /** @param {string} name */
    getAttribute(name) { return this.#attrs.get(name) ?? null; }
    /** @param {string} name */
    removeAttribute(name) { this.#attrs.delete(name); }
    /** @param {string} name */
    hasAttribute(name) { return this.#attrs.has(name); }
    /** @param {string} _selector */
    querySelectorAll(_selector) { return []; }
    /** @param {string} _selector */
    querySelector(_selector) { return null; }
    addEventListener() {}
    removeEventListener() {}
    /** @param {FakeElement} child */
    append(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
        child.parentElement = this;
        this.children.push(child);
    }
    /** @param {FakeElement} child @param {FakeElement | null} ref */
    insertBefore(child, ref) {
        const curIdx = this.children.indexOf(child);
        if (curIdx >= 0) this.children.splice(curIdx, 1);
        const refIdx = ref ? this.children.indexOf(ref) : -1;
        child.parentElement = this;
        if (refIdx >= 0) this.children.splice(refIdx, 0, child);
        else this.children.push(child);
        return child;
    }

    get nextElementSibling() {
        if (!this.parentElement) return null;
        const idx = this.parentElement.children.indexOf(this);
        return idx >= 0 && idx + 1 < this.parentElement.children.length ? this.parentElement.children[idx + 1] : null;
    }

    get offsetTop() { return this.top; }
    get offsetHeight() { return this.height; }

    getBoundingClientRect() {
        const scrollTop = /** @type {any} */ (this.parentElement)?.scrollTop ?? 0;
        const y = this.top - scrollTop;
        return /** @type {DOMRect} */ ({
            top: y,
            bottom: y + this.height,
            left: 0,
            right: 600,
            width: 600,
            height: this.height,
            x: 0,
            y,
            toJSON: () => ({}),
        });
    }
}

class FakeButton extends FakeElement {
    title = "";
    /** @type {(() => void) | null} */
    onclick = null;
}

class FakeSvg extends FakeElement {}

function createSlateScroller({ scrollHeight = 1400, clientHeight = 400, scrollTop = 0 } = {}) {
    const state = { realHeight: scrollHeight, clientHeight, scrollTop };
    /** @type {((event?: Event) => void) | null} */
    let onscroll = null;

    const jumpBtn = new FakeButton();
    jumpBtn.hidden = true;
    const jumpSlot = new FakeElement();
    jumpSlot.children.push(jumpBtn);
    jumpSlot.querySelector = (sel) => sel === "button[data-jump-bottom]" ? /** @type {any} */ (jumpBtn) : null;

    const spacer = new FakeSvg();
    spacer.setAttribute("height", "0");

    /** @type {Map<string, FakeElement>} */
    const prompts = new Map();
    const review = new FakeElement();
    review.setAttribute("data-request-count", "0");

    const scroller = new FakeElement();
    jumpSlot.parentElement = scroller;
    spacer.parentElement = scroller;
    review.parentElement = scroller;
    scroller.children.push(jumpSlot, spacer);

    Object.defineProperties(scroller, {
        clientHeight: {
            get: () => state.clientHeight,
            set: (v) => { state.clientHeight = v; },
        },
        scrollHeight: {
            get: () => state.realHeight + Number(spacer.getAttribute("height") ?? "0"),
            set: (v) => { state.realHeight = v; },
        },
        scrollTop: {
            get: () => state.scrollTop,
            set: (v) => {
                const total = state.realHeight + Number(spacer.getAttribute("height") ?? "0");
                state.scrollTop = Math.max(0, Math.min(v, Math.max(0, total - state.clientHeight)));
            },
        },
        onscroll: {
            get: () => onscroll,
            set: (fn) => { onscroll = fn; },
        },
    });
    scroller.getBoundingClientRect = () => /** @type {DOMRect} */ ({
        top: 0, bottom: state.clientHeight, left: 0, right: 600, width: 600, height: state.clientHeight, x: 0, y: 0, toJSON: () => ({}),
    });
    scroller.querySelector = (selector) => {
        if (selector === ":scope > [data-jump-slot]") return /** @type {any} */ (jumpSlot);
        if (selector === ":scope > svg[data-slate-spacer]") return /** @type {any} */ (spacer);
        if (selector === '[aria-label="Review requests"]:not([data-request-count="0"])') {
            return review.getAttribute("data-request-count") !== "0" ? /** @type {any} */ (review) : null;
        }
        const m = /^\[data-messages\] > \[data-message-id="([^"]+)"\]$/u.exec(selector);
        if (m) return /** @type {any} */ (prompts.get(m[1]) ?? null);
        return null;
    };

    return {
        scroller: /** @type {any} */ (scroller),
        jumpSlot,
        jumpBtn,
        spacer,
        review,
        addPrompt(id, top, height) {
            const p = new FakeElement();
            p.top = top;
            p.height = height;
            p.parentElement = scroller;
            prompts.set(id, p);
            state.realHeight = Math.max(state.realHeight, top + height);
            return p;
        },
        setRealHeight(h) { state.realHeight = h; },
        scrollToUser(v) {
            /** @type {any} */ (scroller).scrollTop = v;
            onscroll?.();
        },
    };
}

test("{§web-session-history} readingSlate lands at bottom initially, frames short and tall prompts without tail-chasing, and surfaces ↓ / gate pill", () => {
    const prevLocation = globalThis.location;
    const prevCss = globalThis.CSS;
    const prevElement = globalThis.Element;
    const prevHtml = globalThis.HTMLElement;
    const prevBtn = globalThis.HTMLButtonElement;
    const prevSvg = globalThis.SVGElement;
    const prevDoc = globalThis.document;
    globalThis.location = /** @type {any} */ ({ hash: "" });
    globalThis.CSS = /** @type {any} */ ({ escape: (value) => String(value) });
    globalThis.Element = /** @type {any} */ (FakeElement);
    globalThis.HTMLElement = /** @type {any} */ (FakeElement);
    globalThis.HTMLButtonElement = /** @type {any} */ (FakeButton);
    globalThis.SVGElement = /** @type {any} */ (FakeSvg);
    globalThis.document = /** @type {any} */ ({ querySelector: () => null });
    try {
        const env = createSlateScroller({ scrollHeight: 1400, clientHeight: 400, scrollTop: 0 });

        const slate = readingSlate(env.scroller);

        // 1. Initial arrival lands at bottom and hides ↓ button.
        slate.landInitial();
        assert.equal(env.scroller.scrollTop, 1000, "initial arrival lands at main's bottom edge");
        assert.equal(env.jumpBtn.hidden, true);

        // 2. Short prompt (height 80 <= 35% of 400) frames near top (1400 - 12 = 1388) with dynamic trailing spacer.
        const shortPrompt = env.addPrompt("m-short", 1400, 80);
        slate.frameTurn("m-short");
        assert.equal(env.scroller.scrollTop, 1388, "short prompt frames at top of Reading Slate");
        assert.equal(Number(env.spacer.getAttribute("height")), 308, "spacer reserves remaining viewport height");
        assert.equal(env.jumpBtn.hidden, true, "blank spacer never triggers ↓ button");

        // 3. Streaming response (and expanded work/reply height inside prompt row) grows below the fold WITHOUT forcing scrollTop = scrollHeight or flipping tall-prompt anchor.
        shortPrompt.height = 420;
        env.setRealHeight(2300);
        slate.sync();
        assert.equal(env.scroller.scrollTop, 1388, "streaming never yanks reader away from top of response");
        assert.equal(Number(env.spacer.getAttribute("height")), 0, "spacer collapses to 0 once turn fills viewport");
        assert.equal(env.jumpBtn.hidden, false, "floating ↓ button surfaces when real content passes bottom");
        assert.equal(env.jumpBtn.getAttribute("data-jump-gate"), null);

        // 3b. Reader scrolls down to the bottom of generated output: sync() never jerks scrollTop back up to anchoredScrollTop (#147).
        env.scrollToUser(1900);
        assert.equal(env.jumpBtn.hidden, true, "scrolling to bottom hides ↓ button");
        slate.sync();
        assert.equal(env.scroller.scrollTop, 1900, "downward scroll to bottom releases anchor and never snaps back up");
        env.setRealHeight(2450);
        slate.sync();
        assert.equal(env.scroller.scrollTop, 1900, "subsequent stream growth preserves reader's downward scroll position");

        // Scroll back up so step 4 exercises off-screen review gate below the fold.
        env.scrollToUser(1388);
        slate.sync();
        assert.equal(env.jumpBtn.hidden, false);

        // 4. Off-screen review gate sets data-jump-gate="true".
        env.review.setAttribute("data-request-count", "1");
        env.review.top = 2300;
        env.review.height = 150;
        slate.sync();
        assert.equal(env.jumpBtn.getAttribute("data-jump-gate"), "true");

        slate.jumpToBottom();
        assert.equal(env.scroller.scrollTop, 2050);
        assert.equal(env.jumpBtn.hidden, true);
        env.review.setAttribute("data-request-count", "0");

        // 5. Tall pasted prompt (height 300 > 35% of 400) aligns bottom 30% of prompt + incoming response slate, and release() unlocks anchor.
        env.addPrompt("m-tall", 2450, 300);
        slate.frameTurn("m-tall");
        assert.equal(env.scroller.scrollTop, 2630, "tall prompt aligns bottom tail of prompt so incoming response starts in view");
        assert.equal(Number(env.spacer.getAttribute("height")), 280);
        slate.release();
        env.scroller.scrollTop = 2500;
        slate.sync();
        assert.equal(env.scroller.scrollTop, 2500, "release() unlocks frame anchor for disclosures and fragment links");

        slate.pause();
    } finally {
        globalThis.location = prevLocation;
        globalThis.CSS = prevCss;
        globalThis.Element = prevElement;
        globalThis.HTMLElement = prevHtml;
        globalThis.HTMLButtonElement = prevBtn;
        globalThis.SVGElement = prevSvg;
        globalThis.document = prevDoc;
    }
});

test("{§web-session-history} readingSlate suppresses initial bottom jump when URL hash targets an in-main anchor", () => {
    const prevLocation = globalThis.location;
    const prevCss = globalThis.CSS;
    const prevElement = globalThis.Element;
    const prevHtml = globalThis.HTMLElement;
    const prevBtn = globalThis.HTMLButtonElement;
    const prevSvg = globalThis.SVGElement;
    const prevDoc = globalThis.document;
    globalThis.location = /** @type {any} */ ({ hash: "#footnote-1" });
    globalThis.CSS = /** @type {any} */ ({ escape: (value) => String(value) });
    globalThis.Element = /** @type {any} */ (FakeElement);
    globalThis.HTMLElement = /** @type {any} */ (FakeElement);
    globalThis.HTMLButtonElement = /** @type {any} */ (FakeButton);
    globalThis.SVGElement = /** @type {any} */ (FakeSvg);
    globalThis.document = /** @type {any} */ ({ querySelector: () => null });
    try {
        const env = createSlateScroller({ scrollHeight: 1400, clientHeight: 400, scrollTop: 120 });
        const prevQuery = env.scroller.querySelector.bind(env.scroller);
        env.scroller.querySelector = (sel) => sel === "#footnote-1" ? ({}) : prevQuery(sel);

        const slate = readingSlate(env.scroller);
        slate.landInitial();
        assert.equal(env.scroller.scrollTop, 120, "in-main footnote fragment suppresses initial bottom jump");
        slate.pause();
    } finally {
        globalThis.location = prevLocation;
        globalThis.CSS = prevCss;
        globalThis.Element = prevElement;
        globalThis.HTMLElement = prevHtml;
        globalThis.HTMLButtonElement = prevBtn;
        globalThis.SVGElement = prevSvg;
        globalThis.document = prevDoc;
    }
});
