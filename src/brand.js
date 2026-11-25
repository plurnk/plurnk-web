import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip } from "node:zlib";
import { ConfigurationError } from "@plurnk/plurnk-meta";

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const CODECS = /** @type {const} */ ([["br", compressBrotli], ["gzip", compressGzip]]);
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const DEFAULT_APP_NAME = "Plurnk";
export const DEFAULT_APP_DESCRIPTION = "Plurnk agent workspace.";
export const DEFAULT_THEME_COLOR = "#148800";
export const DEFAULT_ICON_HREF = "/icons/plurnk.svg";
export const DEFAULT_MASKABLE_ICON_HREF = "/icons/plurnk-maskable.svg";
export const BUG_REPORT_URL = "https://github.com/plurnk/plurnk-service/issues";
export const BRAND_THEME_CSS_PATH = "/brand/theme.css";
export const MAX_BRAND_FILE_BYTES = 1024 * 1024;
const MAX_APP_NAME_CHARS = 100;
const MAX_APP_DESCRIPTION_CHARS = 300;
const MAX_ABOUT_LINKS = 20;
const MAX_ABOUT_LABEL_CHARS = 80;

/**
 * @typedef {{ readonly label: string, readonly url: string }} AboutLink
 * @typedef {{
 *   readonly filePath: string,
 *   readonly href: string,
 *   readonly mediaType: "image/svg+xml" | "image/png",
 *   readonly sizes: "any" | null,
 * }} BrandIconAsset
 * @typedef {{
 *   readonly appName: string,
 *   readonly appDescription: string,
 *   readonly themeColor: string,
 *   readonly aboutLinks: readonly AboutLink[],
 *   readonly themeCssFile: string | null,
 *   readonly themeCssHref: string | null,
 *   readonly icon: BrandIconAsset | null,
 *   readonly maskableIcon: BrandIconAsset | null,
 * }} BrandConfig
 */

/** @type {readonly AboutLink[]} */
export const DEFAULT_ABOUT_LINKS = Object.freeze([
    Object.freeze({ label: "Report an issue", url: BUG_REPORT_URL }),
]);

/** @type {BrandConfig} */
export const DEFAULT_BRAND = Object.freeze({
    appName: DEFAULT_APP_NAME,
    appDescription: DEFAULT_APP_DESCRIPTION,
    themeColor: DEFAULT_THEME_COLOR,
    aboutLinks: DEFAULT_ABOUT_LINKS,
    themeCssFile: null,
    themeCssHref: null,
    icon: null,
    maskableIcon: null,
});

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} key
 * @returns {string}
 */
function requireFloor(env, key) {
    const raw = env[key];
    if (raw === undefined) {
        throw new Error(`${key} is missing from the assembled environment floor.`);
    }
    return raw;
}

/**
 * @param {string} raw
 * @param {string} key
 * @param {number} maxChars
 * @returns {string}
 */
function parseLabelText(raw, key, maxChars) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
        throw new ConfigurationError(key, "must be a non-empty string");
    }
    if (trimmed.length > maxChars) {
        throw new ConfigurationError(key, `must be at most ${maxChars} characters`);
    }
    if (/\p{Cc}/u.test(trimmed)) {
        throw new ConfigurationError(key, "must not contain control characters");
    }
    return trimmed;
}

/**
 * @param {string} raw
 * @returns {string}
 */
function parseThemeColor(raw) {
    const trimmed = raw.trim();
    if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu.test(trimmed)) {
        throw new ConfigurationError("PLURNK_WEB_THEME_COLOR", "must be a #RGB or #RRGGBB hex color");
    }
    return trimmed.toLowerCase();
}

/**
 * @param {string} raw
 * @returns {readonly AboutLink[]}
 */
function parseAboutLinks(raw) {
    /** @type {unknown} */
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new ConfigurationError("PLURNK_WEB_ABOUT_LINKS", "must be a valid JSON array of { label, url } objects");
    }
    if (!Array.isArray(parsed)) {
        throw new ConfigurationError("PLURNK_WEB_ABOUT_LINKS", "must be a JSON array of { label, url } objects");
    }
    if (parsed.length > MAX_ABOUT_LINKS) {
        throw new ConfigurationError("PLURNK_WEB_ABOUT_LINKS", `must contain at most ${MAX_ABOUT_LINKS} links`);
    }
    /** @type {AboutLink[]} */
    const out = [];
    for (let i = 0; i < parsed.length; i += 1) {
        const entry = parsed[i];
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            throw new ConfigurationError("PLURNK_WEB_ABOUT_LINKS", `entry ${i} must be an object with label and url`);
        }
        const rec = /** @type {Record<string, unknown>} */ (entry);
        const extraKeys = Object.keys(rec).filter((k) => k !== "label" && k !== "url");
        if (extraKeys.length > 0) {
            throw new ConfigurationError("PLURNK_WEB_ABOUT_LINKS", `entry ${i} has unsupported key: ${extraKeys[0]}`);
        }
        if (typeof rec.label !== "string" || typeof rec.url !== "string") {
            throw new ConfigurationError("PLURNK_WEB_ABOUT_LINKS", `entry ${i} must provide string label and url fields`);
        }
        const label = parseLabelText(rec.label, "PLURNK_WEB_ABOUT_LINKS", MAX_ABOUT_LABEL_CHARS);
        let url;
        try {
            url = new URL(rec.url.trim());
        } catch {
            throw new ConfigurationError("PLURNK_WEB_ABOUT_LINKS", `entry ${i} url must be a valid http(s) URL`);
        }
        if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
            throw new ConfigurationError("PLURNK_WEB_ABOUT_LINKS", `entry ${i} url must use http: or https: without embedded credentials`);
        }
        out.push(Object.freeze({ label, url: url.href }));
    }
    return Object.freeze(out);
}

/**
 * @param {string | undefined} raw
 * @param {string} key
 * @returns {string | null}
 */
function parseOptionalAbsoluteCssFile(raw, key) {
    const trimmed = (raw ?? "").trim();
    if (trimmed === "") return null;
    if (!isAbsolute(trimmed)) {
        throw new ConfigurationError(key, "must be an absolute file path");
    }
    if (extname(trimmed).toLowerCase() !== ".css") {
        throw new ConfigurationError(key, "must reference a .css file");
    }
    return trimmed;
}

/**
 * @param {string | undefined} raw
 * @param {string} key
 * @param {"icon" | "maskable"} slot
 * @returns {BrandIconAsset | null}
 */
function parseOptionalIconFile(raw, key, slot) {
    const trimmed = (raw ?? "").trim();
    if (trimmed === "") return null;
    if (!isAbsolute(trimmed)) {
        throw new ConfigurationError(key, "must be an absolute file path");
    }
    const ext = extname(trimmed).toLowerCase();
    if (ext !== ".svg" && ext !== ".png") {
        throw new ConfigurationError(key, "must reference a .svg or .png file");
    }
    const isSvg = ext === ".svg";
    return Object.freeze({
        filePath: trimmed,
        href: `/brand/${slot}${ext}`,
        mediaType: isSvg ? "image/svg+xml" : "image/png",
        sizes: isSvg ? "any" : null,
    });
}

/**
 * {§web-configuration} {§web-brand} Validate brand identity, theme stylesheet, icon files, and About links strictly.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {BrandConfig}
 */
export function parseBrandConfig(env = process.env) {
    const appName = parseLabelText(requireFloor(env, "PLURNK_WEB_APP_NAME"), "PLURNK_WEB_APP_NAME", MAX_APP_NAME_CHARS);
    const appDescription = parseLabelText(
        requireFloor(env, "PLURNK_WEB_APP_DESCRIPTION"),
        "PLURNK_WEB_APP_DESCRIPTION",
        MAX_APP_DESCRIPTION_CHARS,
    );
    const themeColor = parseThemeColor(requireFloor(env, "PLURNK_WEB_THEME_COLOR"));
    const aboutLinks = parseAboutLinks(requireFloor(env, "PLURNK_WEB_ABOUT_LINKS"));
    const themeCssFile = parseOptionalAbsoluteCssFile(env.PLURNK_WEB_THEME_CSS_FILE, "PLURNK_WEB_THEME_CSS_FILE");
    const icon = parseOptionalIconFile(env.PLURNK_WEB_ICON_FILE, "PLURNK_WEB_ICON_FILE", "icon");
    const maskableIcon = parseOptionalIconFile(env.PLURNK_WEB_MASKABLE_ICON_FILE, "PLURNK_WEB_MASKABLE_ICON_FILE", "maskable");

    return Object.freeze({
        appName,
        appDescription,
        themeColor,
        aboutLinks,
        themeCssFile,
        themeCssHref: themeCssFile === null ? null : BRAND_THEME_CSS_PATH,
        icon,
        maskableIcon,
    });
}

/** @param {BrandConfig} brand */
export function isDefaultManifestBrand(brand) {
    return brand.appName === DEFAULT_APP_NAME
        && brand.appDescription === DEFAULT_APP_DESCRIPTION
        && brand.themeColor === DEFAULT_THEME_COLOR
        && brand.icon === null
        && brand.maskableIcon === null;
}

/**
 * {§web-brand} {§web-installation} Synthesize `/manifest.webmanifest` for customized brand/theme configurations.
 * @param {BrandConfig} brand
 * @returns {string}
 */
export function buildWebManifest(brand) {
    /** @type {Array<{ src: string, type: string, purpose: string, sizes?: string }>} */
    const icons = [];
    if (brand.icon === null && brand.maskableIcon === null) {
        icons.push(
            { src: DEFAULT_ICON_HREF, sizes: "any", type: "image/svg+xml", purpose: "any" },
            { src: DEFAULT_MASKABLE_ICON_HREF, sizes: "any", type: "image/svg+xml", purpose: "maskable" },
        );
    } else {
        if (brand.icon !== null) {
            icons.push({
                src: brand.icon.href,
                ...(brand.icon.sizes === null ? {} : { sizes: brand.icon.sizes }),
                type: brand.icon.mediaType,
                purpose: "any",
            });
        } else {
            icons.push({ src: DEFAULT_ICON_HREF, sizes: "any", type: "image/svg+xml", purpose: "any" });
        }
        if (brand.maskableIcon !== null) {
            icons.push({
                src: brand.maskableIcon.href,
                ...(brand.maskableIcon.sizes === null ? {} : { sizes: brand.maskableIcon.sizes }),
                type: brand.maskableIcon.mediaType,
                purpose: "maskable",
            });
        }
    }
    return JSON.stringify({
        id: "/",
        name: brand.appName,
        short_name: brand.appName,
        description: brand.appDescription,
        lang: "en",
        dir: "ltr",
        start_url: "/",
        scope: "/",
        display: "standalone",
        theme_color: brand.themeColor,
        background_color: "#ffffff",
        icons,
    }, null, 4) + "\n";
}

/**
 * {§web-asset-encoding} Pre-compress a startup-loaded brand resource or synthesized manifest.
 * @param {import("./module.js").LoadedAsset["body"]} body
 * @param {string} mediaType
 * @returns {Promise<import("./module.js").LoadedAsset>}
 */
export async function encodeBrandAsset(body, mediaType) {
    /** @type {Array<readonly [string, import("./module.js").LoadedAsset["body"]]>} */
    const variants = (await Promise.all(CODECS.map(async ([encoding, compress]) => {
        const bytes = /** @type {import("./module.js").LoadedAsset["body"]} */ (await compress(body));
        return bytes.byteLength < body.byteLength ? /** @type {const} */ ([encoding, bytes]) : null;
    }))).filter((entry) => entry !== null);
    const representations = new Map([["identity", body], ...variants]);
    const preferred = [...representations].toSorted(([, a], [, b]) => a.byteLength - b.byteLength).map(([encoding]) => encoding);
    return { body, mediaType, representations, preferred };
}

/**
 * @param {string} key
 * @param {string} filePath
 * @param {"text/css" | "image/svg+xml" | "image/png"} mediaType
 */
async function readBrandFile(key, filePath, mediaType) {
    const info = await stat(filePath);
    if (!info.isFile()) {
        throw new Error(`${key}: '${filePath}' is not a regular file.`);
    }
    if (info.size === 0) {
        throw new Error(`${key}: '${filePath}' must not be empty.`);
    }
    if (info.size > MAX_BRAND_FILE_BYTES) {
        throw new Error(`${key}: '${filePath}' exceeds the ${MAX_BRAND_FILE_BYTES}-byte brand asset limit.`);
    }
    const bytes = await readFile(filePath);
    if (mediaType === "image/png") {
        if (bytes.byteLength < PNG_SIGNATURE.byteLength || !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
            throw new Error(`${key}: '${filePath}' is not a valid PNG file.`);
        }
    } else {
        try {
            UTF8_STRICT.decode(bytes);
        } catch (cause) {
            throw new Error(`${key}: '${filePath}' is not valid UTF-8.`, { cause });
        }
    }
    return await encodeBrandAsset(bytes, mediaType);
}

/**
 * {§web-brand} {§web-assets} Load configured brand CSS/icon files once at startup and synthesize `/manifest.webmanifest` when customized.
 * @param {BrandConfig} brand
 * @param {Map<string, import("./module.js").LoadedAsset>} resources
 */
export async function loadBrandAssets(brand, resources) {
    if (brand.themeCssFile !== null && brand.themeCssHref !== null) {
        resources.set(
            brand.themeCssHref,
            await readBrandFile("PLURNK_WEB_THEME_CSS_FILE", brand.themeCssFile, "text/css"),
        );
    }
    if (brand.icon !== null) {
        resources.set(
            brand.icon.href,
            await readBrandFile("PLURNK_WEB_ICON_FILE", brand.icon.filePath, brand.icon.mediaType),
        );
    }
    if (brand.maskableIcon !== null) {
        resources.set(
            brand.maskableIcon.href,
            await readBrandFile("PLURNK_WEB_MASKABLE_ICON_FILE", brand.maskableIcon.filePath, brand.maskableIcon.mediaType),
        );
    }
    if (!isDefaultManifestBrand(brand)) {
        const manifestBytes = Buffer.from(buildWebManifest(brand), "utf8");
        resources.set("/manifest.webmanifest", await encodeBrandAsset(manifestBytes, "application/manifest+json"));
    }
}
