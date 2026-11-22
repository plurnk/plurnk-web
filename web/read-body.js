import daemonRead from "./daemon-read.js";
import { SAFE_RASTER_IMAGE_MIMES, bytesToBase64, detectRasterMime } from "./inline-images.js";

/** {§web-result-bodies} {§web-inline-images} Credentials never follow an authored URL to another authority.
 * @param {string} address @param {AbortSignal} signal
 */
export default async function readBody(address, signal) {
    const response = await daemonRead(address, signal);
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (SAFE_RASTER_IMAGE_MIMES.has(contentType)) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (detectRasterMime(bytes) !== null) return bytesToBase64(bytes);
        return new TextDecoder().decode(bytes);
    }
    return response.text();
}
