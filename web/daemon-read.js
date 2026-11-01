import accessHeaders from "./access-headers.js";
import refusal from "./problem-response.js";

/** {§web-result-bodies} {§web-session-history} Read opaque daemon URLs within their credential perimeter.
 * @param {string} address @param {"session" | "none"} auth @param {AbortSignal} signal
 */
export default async function daemonRead(address, auth, signal) {
    if (!address.trim()) throw new Error("Read address is empty.");
    const url = new URL(address, location.href);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== location.origin || url.username || url.password) {
        throw new Error("Read address must be on this daemon's origin.");
    }
    const headers = await accessHeaders(auth, signal);
    signal.throwIfAborted();
    const response = await fetch(url, { headers, signal, redirect: "error", cache: "no-store" });
    const refused = await refusal(response);
    if (refused) throw refused;
    if (!response.ok) throw new Error(`Read request failed (${response.status}).`);
    return response;
}
