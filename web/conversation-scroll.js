import { on, the } from "on_the_money";

// scrollTop can be fractional; scrollHeight and clientHeight are integer CSS pixels.
const SCROLL_ROUNDING_PX = 1;

/** {§web-session-history} Native scrolling, with a reading anchor across document updates.
 * @param {HTMLElement} main @param {HTMLElement} conversation @param {() => void} followed
 */
export default function conversationScroll(main, conversation, followed) {
    let following = true;
    let paused = false;
    let last = main.scrollTop;
    const bottom = () => main.scrollHeight - main.clientHeight - main.scrollTop <= SCROLL_ROUNDING_PX;
    const tail = () => { if (following && !paused) main.scrollTop = main.scrollHeight; };
    // A scroll event arrives after the scroll that caused it, so content may have grown in between: only the reader moving
    // up leaves the end, and reaching it again follows. While following, the browser's own scroll anchoring stays off.
    const follow = (/** @type {boolean} */ value) => { following = value; the(main, "following", value ? "" : null); };
    follow(true);
    on(main, "scroll", "main", () => {
        if (paused) return;
        const wasFollowing = following;
        const top = main.scrollTop;
        if (bottom()) follow(true);
        else if (top < last) follow(false);
        last = top;
        if (following && !wasFollowing) followed();
    });
    // Following holds the end of main: the conversation and what follows it, such as a review or a failure, as each grows.
    const added = new MutationObserver(tail);
    const watch = () => {
        added.observe(main, { childList: true, subtree: true, attributes: true, characterData: true });
    };
    watch();
    return {
        get following() { return following; },
        /** @param {() => void} update @param {boolean} [prepend] */
        update(update, prepend = false) {
            if (prepend) follow(false);
            const edge = main.getBoundingClientRect().top;
            const anchor = !following ? [...conversation.querySelectorAll("[data-messages] > [data-message-id]")]
                .find((row) => row.getBoundingClientRect().bottom > edge) : undefined;
            const top = anchor?.getBoundingClientRect().top;
            update();
            if (anchor?.isConnected && top !== undefined) main.scrollTop += anchor.getBoundingClientRect().top - top;
            if (bottom()) follow(true);
            tail();
        },
        pause() { paused = true; added.disconnect(); },
        resume() { paused = false; watch(); },
    };
}
