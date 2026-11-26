import { open, readFile } from "node:fs/promises";
import Negotiator from "negotiator";
import { RequestError } from "./http.js";

/** @typedef {[string, string, string, Record<string, string>]} AssetEntry */
/** @typedef {{ readonly byteLength: number, readonly file: URL } | { readonly byteLength: number, readonly body: Buffer }} AssetRepresentation */
/** @typedef {{ readonly mediaType: string, readonly representations: ReadonlyMap<string, AssetRepresentation>, readonly preferred: readonly string[] }} LoadedAsset */

/**
 * Verify a packaged `dist/` representation is readable and regular at startup without
 * pinning its bytes in per-daemon private heap memory.
 * @param {URL} url
 * @returns {Promise<{ readonly byteLength: number, readonly file: URL }>}
 */
async function verifyFileRepresentation(url) {
    const handle = await open(url, "r");
    try {
        const info = await handle.stat();
        if (!info.isFile()) {
            throw new Error(`Declared web asset '${url.pathname}' is not a regular file.`);
        }
        return { byteLength: info.size, file: url };
    } finally {
        await handle.close();
    }
}

/** {§web-asset-encoding} Verify all declared representations before admitting requests.
 * @param {string} file @param {string} mediaType @param {Record<string, string>} encoded
 * @returns {Promise<LoadedAsset>}
 */
export async function readAsset(file, mediaType, encoded) {
    const identity = await verifyFileRepresentation(new URL(`../dist/${file}`, import.meta.url));
    const variants = await Promise.all(Object.entries(encoded).map(async ([encoding, path]) =>
        /** @type {const} */ ([encoding, await verifyFileRepresentation(new URL(`../dist/${path}`, import.meta.url))])));
    /** @type {Map<string, AssetRepresentation>} */
    const representations = new Map([["identity", identity], ...variants]);
    const preferred = [...representations].toSorted(([, a], [, b]) => a.byteLength - b.byteLength).map(([encoding]) => encoding);
    return { mediaType, representations, preferred };
}

/**
 * Read a representation's bytes on demand (OS page-cache backed for packaged `dist/` files).
 * @param {LoadedAsset} asset
 * @param {string} [encoding]
 * @returns {Promise<Buffer>}
 */
export async function readAssetBytes(asset, encoding = "identity") {
    const representation = asset.representations.get(encoding);
    if (representation === undefined) {
        throw new Error(`Undeclared asset representation '${encoding}'.`);
    }
    return "body" in representation ? representation.body : await readFile(representation.file);
}

/** {§web-asset-encoding} No response wrapper: only admitted static resources reach this path.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {LoadedAsset} asset
 */
export async function sendAsset(req, res, asset) {
    res.appendHeader("vary", "Accept-Encoding");
    const negotiator = new Negotiator(req);
    // Published typings omit the documented same-quality preference option.
    const choose = /** @type {(available: readonly string[], options: { preferred: readonly string[] }) => string | undefined} */ (negotiator.encoding);
    const encoding = choose.call(negotiator, asset.preferred, { preferred: asset.preferred });
    if (encoding === undefined) throw new RequestError(406, "No acceptable content encoding.");
    const representation = asset.representations.get(encoding);
    if (representation === undefined) throw new Error("Negotiated an undeclared asset representation.");
    const body = req.method === "HEAD"
        ? undefined
        : "body" in representation
            ? representation.body
            : await readFile(representation.file);
    res.writeHead(200, {
        "content-type": asset.mediaType.startsWith("text/") ? `${asset.mediaType}; charset=utf-8` : asset.mediaType,
        "content-length": body?.byteLength ?? representation.byteLength,
        "x-content-type-options": "nosniff",
        ...(encoding === "identity" ? {} : { "content-encoding": encoding }),
    });
    res.end(body);
}
