import accessHeaders from "./access-headers.js";
import { acpOrigin } from "./endpoints.js";
import { recoverFromUnauthorized } from "./oidc.js";
import refusal from "./problem-response.js";

/** {§web-result-bodies} {§web-session-history} Read opaque daemon URLs on `acpOrigin()` within their credential perimeter.
 * @param {string} address @param {AbortSignal} signal
 */
export default async function daemonRead(address, signal) {
    if (!address.trim()) throw new Error("Read address is empty.");
    const daemonOrigin = acpOrigin();
    const url = new URL(address, daemonOrigin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== daemonOrigin || url.username || url.password) {
        throw new Error("Read address must be on this daemon's origin.");
    }
    let headers = await accessHeaders(signal);
    signal.throwIfAborted();
    let response = await fetch(url, { headers, credentials: "same-origin", signal, redirect: "error", cache: "no-store" });
    if (response.status === 401) {
        const recovery = await recoverFromUnauthorized({ signal, redirectOnDiscovery: false });
        if (recovery.status === "refreshed") {
            headers = await accessHeaders(signal);
            signal.throwIfAborted();
            response = await fetch(url, { headers, credentials: "same-origin", signal, redirect: "error", cache: "no-store" });
        }
    }
    const refused = await refusal(response);
    if (refused) throw refused;
    if (!response.ok) throw new Error(`Read request failed (${response.status}).`);
    return response;
}
