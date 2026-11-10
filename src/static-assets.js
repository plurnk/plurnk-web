import { readFile } from "node:fs/promises";
import Negotiator from "negotiator";
import { RequestError } from "./http.js";

/** @typedef {[string, string, string, Record<string, string>]} AssetEntry */

/** {§web-asset-encoding} Load all declared representations before admitting requests.
 * @param {string} file @param {string} mediaType @param {Record<string, string>} encoded
 */
export async function readAsset(file, mediaType, encoded) {
    const body = await readFile(new URL(`../dist/${file}`, import.meta.url));
    const variants = await Promise.all(Object.entries(encoded).map(async ([encoding, path]) =>
        /** @type {const} */ ([encoding, await readFile(new URL(`../dist/${path}`, import.meta.url))])));
    const representations = new Map([["identity", body], ...variants]);
    const preferred = [...representations].toSorted(([, a], [, b]) => a.byteLength - b.byteLength).map(([encoding]) => encoding);
    return { body, mediaType, representations, preferred };
}

/** {§web-asset-encoding} No response wrapper: only admitted static resources reach this path.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {Awaited<ReturnType<typeof readAsset>>} asset
 */
export function sendAsset(req, res, asset) {
    res.appendHeader("vary", "Accept-Encoding");
    const negotiator = new Negotiator(req);
    // Published typings omit the documented same-quality preference option.
    const choose = /** @type {(available: string[], options: { preferred: string[] }) => string | undefined} */ (negotiator.encoding);
    const encoding = choose.call(negotiator, asset.preferred, { preferred: asset.preferred });
    if (encoding === undefined) throw new RequestError(406, "No acceptable content encoding.");
    const body = asset.representations.get(encoding);
    if (body === undefined) throw new Error("Negotiated an undeclared asset representation.");
    res.writeHead(200, {
        "content-type": asset.mediaType.startsWith("text/") ? `${asset.mediaType}; charset=utf-8` : asset.mediaType,
        "content-length": body.byteLength,
        "x-content-type-options": "nosniff",
        ...(encoding === "identity" ? {} : { "content-encoding": encoding }),
    });
    res.end(req.method === "HEAD" ? undefined : body);
}
