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
export const BUILTIN_SETTINGS_SECTIONS = Object.freeze([
    "workspace",
    "session",
    "models",
    "mcp",
    "skills",
    "schedule",
    "personas",
    "members",
    "env",
    "help",
    "about",
]);
const BUILTIN_SETTINGS_SECTION_SET = new Set(BUILTIN_SETTINGS_SECTIONS);
const MAX_APP_NAME_CHARS = 100;
const MAX_APP_DESCRIPTION_CHARS = 300;
const MAX_ABOUT_LINKS = 20;
const MAX_ABOUT_LABEL_CHARS = 80;
const MAX_SETTINGS_TABS = 20;
const MAX_SETTINGS_TAB_LABEL_CHARS = 80;
const SETTINGS_TAB_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;

/**
 * @typedef {{ readonly label: string, readonly url: string }} AboutLink
 * @typedef {{
 *   readonly id: string,
 *   readonly label: string,
 *   readonly htmlFile: string,
 *   readonly scriptFile: string | null,
 *   readonly scriptHref: string | null,
 * }} SettingsTabSpec
 * @typedef {{
 *   readonly id: string,
 *   readonly label: string,
 *   readonly html: string,
 *   readonly scriptHref: string | null,
 * }} LoadedSettingsTab
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
 *   readonly settingsTabs: readonly SettingsTabSpec[],
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
    settingsTabs: Object.freeze([]),
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
 * {§web-settings-extensions} Validate `PLURNK_WEB_SETTINGS_TABS` strictly at module creation.
 * @param {string} raw
 * @returns {readonly SettingsTabSpec[]}
 */
function parseSettingsTabs(raw) {
    /** @type {unknown} */
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new ConfigurationError(
            "PLURNK_WEB_SETTINGS_TABS",
            "must be a valid JSON array of { id, label, htmlFile, scriptFile? } objects",
        );
    }
    if (!Array.isArray(parsed)) {
        throw new ConfigurationError(
            "PLURNK_WEB_SETTINGS_TABS",
            "must be a JSON array of { id, label, htmlFile, scriptFile? } objects",
        );
    }
    if (parsed.length > MAX_SETTINGS_TABS) {
        throw new ConfigurationError("PLURNK_WEB_SETTINGS_TABS", `must contain at most ${MAX_SETTINGS_TABS} tabs`);
    }
    /** @type {SettingsTabSpec[]} */
    const out = [];
    /** @type {Set<string>} */
    const seenIds = new Set();
    for (let i = 0; i < parsed.length; i += 1) {
        const entry = parsed[i];
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            throw new ConfigurationError("PLURNK_WEB_SETTINGS_TABS", `entry ${i} must be an object`);
        }
        const rec = /** @type {Record<string, unknown>} */ (entry);
        const extraKeys = Object.keys(rec).filter((k) => k !== "id" && k !== "label" && k !== "htmlFile" && k !== "scriptFile");
        if (extraKeys.length > 0) {
            throw new ConfigurationError("PLURNK_WEB_SETTINGS_TABS", `entry ${i} has unsupported key: ${extraKeys[0]}`);
        }
        if (typeof rec.id !== "string" || typeof rec.label !== "string" || typeof rec.htmlFile !== "string") {
            throw new ConfigurationError("PLURNK_WEB_SETTINGS_TABS", `entry ${i} must provide string id, label, and htmlFile fields`);
        }
        const id = rec.id.trim();
        if (!SETTINGS_TAB_ID_PATTERN.test(id)) {
            throw new ConfigurationError("PLURNK_WEB_SETTINGS_TABS", `entry ${i} id must be a lowercase slug of 1–32 ASCII letters, digits, or hyphens`);
        }
        if (BUILTIN_SETTINGS_SECTION_SET.has(id)) {
            throw new ConfigurationError("PLURNK_WEB_SETTINGS_TABS", `entry ${i} id '${id}' collides with a built-in Settings section`);
        }
        if (seenIds.has(id)) {
            throw new ConfigurationError("PLURNK_WEB_SETTINGS_TABS", `duplicate tab id '${id}'`);
        }
        seenIds.add(id);

        const label = parseLabelText(rec.label, "PLURNK_WEB_SETTINGS_TABS", MAX_SETTINGS_TAB_LABEL_CHARS);
        const htmlFile = rec.htmlFile.trim();
        if (htmlFile === "" || !isAbsolute(htmlFile)) {
            throw new ConfigurationError("PLURNK_WEB_SETTINGS_TABS", `entry ${i} htmlFile must be an absolute file path`);
        }
        if (extname(htmlFile).toLowerCase() !== ".html") {
            throw new ConfigurationError("PLURNK_WEB_SETTINGS_TABS", `entry ${i} htmlFile must reference an .html file`);
        }

        /** @type {string | null} */
        let scriptFile = null;
        if (rec.scriptFile !== undefined && rec.scriptFile !== null) {
            if (typeof rec.scriptFile !== "string") {
                throw new ConfigurationError("PLURNK_WEB_SETTINGS_TABS", `entry ${i} scriptFile must be a string path when provided`);
            }
            const trimmedScript = rec.scriptFile.trim();
            if (trimmedScript === "" || !isAbsolute(trimmedScript)) {
                throw new ConfigurationError("PLURNK_WEB_SETTINGS_TABS", `entry ${i} scriptFile must be a non-empty absolute file path`);
            }
            if (extname(trimmedScript).toLowerCase() !== ".js") {
                throw new ConfigurationError("PLURNK_WEB_SETTINGS_TABS", `entry ${i} scriptFile must reference a .js file`);
            }
            scriptFile = trimmedScript;
        }

        out.push(Object.freeze({
            id,
            label,
            htmlFile,
            scriptFile,
            scriptHref: scriptFile === null ? null : `/brand/tabs/${id}.js`,
        }));
    }
    return Object.freeze(out);
}

/**
 * {§web-configuration} {§web-brand} {§web-settings-extensions} Validate brand identity, theme stylesheet, icon files, About links, and Settings extension tabs strictly.
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
    const settingsTabs = parseSettingsTabs(requireFloor(env, "PLURNK_WEB_SETTINGS_TABS"));

    return Object.freeze({
        appName,
        appDescription,
        themeColor,
        aboutLinks,
        themeCssFile,
        themeCssHref: themeCssFile === null ? null : BRAND_THEME_CSS_PATH,
        icon,
        maskableIcon,
        settingsTabs,
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
 * @param {Buffer} body
 * @param {string} mediaType
 * @returns {Promise<import("./static-assets.js").LoadedAsset>}
 */
export async function encodeBrandAsset(body, mediaType) {
    /** @type {Array<readonly [string, import("./static-assets.js").AssetRepresentation]>} */
    const variants = (await Promise.all(CODECS.map(async ([encoding, compress]) => {
        const bytes = /** @type {Buffer} */ (await compress(body));
        return bytes.byteLength < body.byteLength ? /** @type {const} */ ([encoding, { byteLength: bytes.byteLength, body: bytes }]) : null;
    }))).filter((entry) => entry !== null);
    /** @type {Map<string, import("./static-assets.js").AssetRepresentation>} */
    const representations = new Map([["identity", { byteLength: body.byteLength, body }], ...variants]);
    const preferred = [...representations].toSorted(([, a], [, b]) => a.byteLength - b.byteLength).map(([encoding]) => encoding);
    return { mediaType, representations, preferred };
}

/**
 * @param {string} key
 * @param {string} filePath
 */
async function readRegularFileBytes(key, filePath) {
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
    return await readFile(filePath);
}

/**
 * @param {string} key
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readUtf8TextFile(key, filePath) {
    const bytes = await readRegularFileBytes(key, filePath);
    try {
        return UTF8_STRICT.decode(bytes);
    } catch (cause) {
        throw new Error(`${key}: '${filePath}' is not valid UTF-8.`, { cause });
    }
}

/**
 * {§web-settings-extensions} Reject CSP-incompatible or unsafe markup in startup-loaded Settings extension fragments.
 * @param {string} id
 * @param {string} html
 */
function validateSettingsTabHtml(id, html) {
    if (/<script\b/iu.test(html)) {
        throw new Error(`PLURNK_WEB_SETTINGS_TABS[${id}]: htmlFile must not contain <script> tags; configure scriptFile instead.`);
    }
    if (/<style\b/iu.test(html) || /<[a-z][^>]*\sstyle\s*=/iu.test(html)) {
        throw new Error(`PLURNK_WEB_SETTINGS_TABS[${id}]: htmlFile must not contain inline styles; configure PLURNK_WEB_THEME_CSS_FILE instead.`);
    }
    const forbiddenTag = /<(iframe|object|embed|base|meta|link|html|head|body)\b/iu.exec(html);
    if (forbiddenTag !== null) {
        throw new Error(`PLURNK_WEB_SETTINGS_TABS[${id}]: htmlFile must be an HTML fragment without <${forbiddenTag[1].toLowerCase()}> elements.`);
    }
    if (/<[a-z][^>]*\son[a-z]+\s*=/iu.test(html)) {
        throw new Error(`PLURNK_WEB_SETTINGS_TABS[${id}]: htmlFile must not contain inline event handlers; attach listeners in scriptFile instead.`);
    }
    if (/<[a-z][^>]*\bjavascript\s*:/iu.test(html)) {
        throw new Error(`PLURNK_WEB_SETTINGS_TABS[${id}]: htmlFile must not contain javascript: URLs.`);
    }
}

/**
 * @param {string} key
 * @param {string} filePath
 * @param {"text/css" | "text/javascript" | "image/svg+xml" | "image/png"} mediaType
 */
async function readBrandFile(key, filePath, mediaType) {
    const bytes = await readRegularFileBytes(key, filePath);
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
 * {§web-brand} {§web-settings-extensions} {§web-assets} Load configured brand CSS/icon files and Settings extension tabs once at startup, and synthesize `/manifest.webmanifest` when customized.
 * @param {BrandConfig} brand
 * @param {Map<string, import("./module.js").LoadedAsset>} resources
 * @returns {Promise<readonly LoadedSettingsTab[]>}
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
    /** @type {LoadedSettingsTab[]} */
    const loadedTabs = [];
    for (const tab of brand.settingsTabs) {
        const html = await readUtf8TextFile(`PLURNK_WEB_SETTINGS_TABS[${tab.id}].htmlFile`, tab.htmlFile);
        validateSettingsTabHtml(tab.id, html);
        if (tab.scriptFile !== null && tab.scriptHref !== null) {
            resources.set(
                tab.scriptHref,
                await readBrandFile(`PLURNK_WEB_SETTINGS_TABS[${tab.id}].scriptFile`, tab.scriptFile, "text/javascript"),
            );
        }
        loadedTabs.push(Object.freeze({
            id: tab.id,
            label: tab.label,
            html,
            scriptHref: tab.scriptHref,
        }));
    }
    return Object.freeze(loadedTabs);
}
