import { $ } from "on_the_money";

// {§web-inline-images} Only verified raster formats decode into data-URI images; SVG and non-image payloads are rejected.
export const SAFE_RASTER_IMAGE_MIMES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
]);

/** @type {ReadonlyMap<string, string>} */
const RASTER_EXT_MIMES = new Map([
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".gif", "image/gif"],
    [".webp", "image/webp"],
]);

/** @type {ReadonlyMap<string, string>} */
const DEFAULT_RASTER_EXT = new Map([
    ["image/png", ".png"],
    ["image/jpeg", ".jpg"],
    ["image/gif", ".gif"],
    ["image/webp", ".webp"],
]);

/**
 * Detect raster image MIME type strictly from binary magic bytes.
 * @param {Uint8Array} bytes
 * @returns {"image/png" | "image/jpeg" | "image/gif" | "image/webp" | null}
 */
export function detectRasterMime(bytes) {
    if (
        bytes.length >= 8
        && bytes[0] === 0x89
        && bytes[1] === 0x50
        && bytes[2] === 0x4e
        && bytes[3] === 0x47
        && bytes[4] === 0x0d
        && bytes[5] === 0x0a
        && bytes[6] === 0x1a
        && bytes[7] === 0x0a
    ) {
        return "image/png";
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return "image/jpeg";
    }
    if (
        bytes.length >= 6
        && bytes[0] === 0x47
        && bytes[1] === 0x49
        && bytes[2] === 0x46
        && bytes[3] === 0x38
        && (bytes[4] === 0x37 || bytes[4] === 0x39)
        && bytes[5] === 0x61
    ) {
        return "image/gif";
    }
    if (
        bytes.length >= 12
        && bytes[0] === 0x52
        && bytes[1] === 0x49
        && bytes[2] === 0x46
        && bytes[3] === 0x46
        && bytes[8] === 0x57
        && bytes[9] === 0x45
        && bytes[10] === 0x42
        && bytes[11] === 0x50
    ) {
        return "image/webp";
    }
    return null;
}

/**
 * @param {string} filename
 * @returns {string | null}
 */
export function rasterMimeForFilename(filename) {
    const dot = filename.lastIndexOf(".");
    if (dot < 0) return null;
    return RASTER_EXT_MIMES.get(filename.slice(dot).toLowerCase()) ?? null;
}

/**
 * Normalize an attachment filename so its extension matches its verified raster MIME type.
 * @param {string} rawName
 * @param {string} mimeType
 * @returns {string}
 */
export function normalizeAttachmentFilename(rawName, mimeType) {
    const leaf = (rawName.split(/[\\/]/u).pop() ?? "")
        .replace(/[\p{Cc}<>]/gu, "")
        .trim();
    const expectedExt = DEFAULT_RASTER_EXT.get(mimeType) ?? ".bin";
    if (!leaf) return `image${expectedExt}`;
    const existingMime = rasterMimeForFilename(leaf);
    if (existingMime === mimeType) return leaf;
    const dot = leaf.lastIndexOf(".");
    const stem = dot > 0 ? leaf.slice(0, dot) : leaf;
    return `${stem || "image"}${expectedExt}`;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const slice = bytes.subarray(offset, offset + chunkSize);
        binary += String.fromCharCode(...slice);
    }
    return btoa(binary);
}

/**
 * @param {string} encoded
 * @returns {Uint8Array}
 */
export function base64ToBytes(encoded) {
    const cleaned = encoded.replace(/\s+/gu, "");
    if (!cleaned) throw new Error("Image data is empty.");
    let binary;
    try {
        binary = atob(cleaned);
    } catch (cause) {
        throw new Error("Unsupported or invalid raster image data.", { cause });
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

/**
 * Verify raster magic bytes from base64 data and build a canonical `data:` URI.
 * @param {string} encoded
 * @returns {{ mimeType: string, base64: string, dataUrl: string }}
 */
export function rasterDataUrlFromBase64(encoded) {
    const bytes = base64ToBytes(encoded);
    const mimeType = detectRasterMime(bytes);
    if (!mimeType) {
        throw new Error("Unsupported or invalid raster image data.");
    }
    const base64 = bytesToBase64(bytes);
    return {
        mimeType,
        base64,
        dataUrl: `data:${mimeType};base64,${base64}`,
    };
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatByteSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Read and verify a user-selected/pasted/dropped raster image file before queueing it in the composer.
 * @param {File} file
 * @param {() => string} makeId
 * @returns {Promise<{ id: string, name: string, mimeType: string, data: string, sizeLabel: string }>}
 */
export async function readRasterFileAttachment(file, makeId) {
    const label = file.name || "attachment";
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mimeType = detectRasterMime(bytes);
    if (!mimeType) {
        throw new Error(`Unsupported image file "${label}". Attach PNG, JPEG, GIF, or WebP.`);
    }
    const data = bytesToBase64(bytes);
    const probe = new Image();
    probe.src = `data:${mimeType};base64,${data}`;
    try {
        await probe.decode();
    } catch (cause) {
        throw new Error(`Image file "${label}" could not be decoded.`, { cause });
    }
    return {
        id: makeId(),
        name: normalizeAttachmentFilename(file.name, mimeType),
        mimeType,
        data,
        sizeLabel: formatByteSize(bytes.byteLength),
    };
}

/**
 * Mount a verified raster image inside a template-cloned `<figure data-inline-image>` outlet.
 * @param {Element} outlet
 * @param {string} encodedBase64
 * @param {string} [label]
 */
export async function mountRasterImage(outlet, encodedBase64, label) {
    const { dataUrl } = rasterDataUrlFromBase64(encodedBase64);
    if (!outlet.isConnected) return;
    const figure = $.clone(outlet, "#conversation-inline-image");
    const image = $(figure, "img");
    if (!(figure instanceof HTMLElement) || !(image instanceof HTMLImageElement)) {
        throw new Error("Inline image template is incomplete.");
    }
    image.alt = label?.trim() ? label.trim() : "Attached image";
    image.setAttribute("src", dataUrl);
    try {
        await image.decode();
    } catch (cause) {
        figure.remove();
        throw new Error("Image failed to decode.", { cause });
    }
    if (!outlet.isConnected) {
        figure.remove();
        return;
    }
    figure.hidden = false;
}

/**
 * Derive a same-origin `/acp/<workspaceId>/<sessionId>/entry?target=...` URL from a message/call `_meta.plurnk.body.url`.
 * @param {unknown} baseEntryUrl
 * @param {string} targetUri
 * @returns {string | null}
 */
export function entryUrlForTarget(baseEntryUrl, targetUri) {
    if (typeof baseEntryUrl !== "string" || !baseEntryUrl.trim() || !targetUri.trim()) return null;
    let url;
    try {
        url = new URL(baseEntryUrl, location.href);
    } catch {
        return null;
    }
    if (
        !["http:", "https:"].includes(url.protocol)
        || url.origin !== location.origin
        || url.username
        || url.password
        || !/\/acp\/\d+\/\d+\/entry$/u.test(url.pathname)
    ) {
        return null;
    }
    url.search = "";
    url.searchParams.set("target", targetUri);
    return url.href;
}

/**
 * Readable label from a `session://`, `file://`, or `mcp://` URI without exposing credentials.
 * @param {string} uri
 * @returns {string}
 */
export function labelFromUri(uri) {
    const cleaned = uri.split(/[?#]/u)[0] ?? uri;
    const slash = cleaned.lastIndexOf("/");
    const raw = slash >= 0 && slash < cleaned.length - 1 ? cleaned.slice(slash + 1) : cleaned;
    let decoded;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        decoded = raw;
    }
    const innerSlash = decoded.lastIndexOf("/");
    const leaf = innerSlash >= 0 && innerSlash < decoded.length - 1 ? decoded.slice(innerSlash + 1) : decoded;
    return leaf || "Attached image";
}
