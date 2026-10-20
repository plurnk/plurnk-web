import accessHeaders from "./access-headers.js";

/** {§web-result-bodies} Credentials never follow an authored URL to another authority.
 * @param {string} address @param {"session" | "none"} auth @param {AbortSignal} signal
 */
export default async function readBody(address, auth, signal) {
    if (!address.trim()) throw new Error("Body address is empty.");
    const url = new URL(address, location.href);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== location.origin || url.username || url.password) {
        throw new Error("Body address must be on this daemon's origin.");
    }
    const headers = await accessHeaders(auth, signal);
    signal.throwIfAborted();
    const response = await fetch(url, { headers, signal, redirect: "error", cache: "no-store" });
    if (!response.ok) throw new Error(`Body request failed (${response.status}).`);
    return response.text();
}
