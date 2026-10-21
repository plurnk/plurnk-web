import daemonRead from "./daemon-read.js";

/** {§web-result-bodies} Credentials never follow an authored URL to another authority.
 * @param {string} address @param {"session" | "none"} auth @param {AbortSignal} signal
 */
export default async function readBody(address, auth, signal) {
    const response = await daemonRead(address, auth, signal);
    return response.text();
}
