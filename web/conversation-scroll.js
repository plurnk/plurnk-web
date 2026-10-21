import { on } from "on_the_money";

// scrollTop can be fractional; scrollHeight and clientHeight are integer CSS pixels.
const SCROLL_ROUNDING_PX = 1;

/** {§web-worker-history} Native scrolling, with a reading anchor across document updates.
 * @param {HTMLElement} main @param {HTMLElement} conversation @param {() => void} followed
 */
export default function conversationScroll(main, conversation, followed) {
    let following = true;
    let paused = false;
    const bottom = () => main.scrollHeight - main.clientHeight - main.scrollTop <= SCROLL_ROUNDING_PX;
    const tail = () => { if (following && !paused) main.scrollTop = main.scrollHeight; };
    on(main, "scroll", "main", () => {
        if (paused) return;
        const wasFollowing = following;
        following = bottom();
        if (following && !wasFollowing) followed();
    });
    const observer = new ResizeObserver(tail);
    observer.observe(main);
    observer.observe(conversation);
    return {
        get following() { return following; },
        /** @param {() => void} update @param {boolean} [prepend] */
        update(update, prepend = false) {
            if (prepend) following = false;
            const edge = main.getBoundingClientRect().top;
            const anchor = !following ? [...conversation.querySelectorAll("[data-messages] > [data-message-id]")]
                .find((row) => row.getBoundingClientRect().bottom > edge) : undefined;
            const top = anchor?.getBoundingClientRect().top;
            update();
            if (anchor?.isConnected && top !== undefined) main.scrollTop += anchor.getBoundingClientRect().top - top;
            if (bottom()) following = true;
            tail();
        },
        pause() { paused = true; observer.disconnect(); },
        resume() { paused = false; observer.observe(main); observer.observe(conversation); },
    };
}
