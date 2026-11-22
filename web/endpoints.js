const DEFAULT_ACP_PATH = "/acp";
const DEFAULT_OVERVIEW_SESSIONS = 200;
const DEFAULT_OVERVIEW_EXCERPT_CHARS = 160;
const DEFAULT_WEB_VERSION = "4.0.0";

/** @type {string | null} */
let cachedServiceVersion = null;
/** @type {Set<(version: string) => void>} */
const serviceVersionListeners = new Set();

function currentOrigin() {
    const raw = globalThis.location?.origin;
    return typeof raw === "string" && raw !== "" && raw !== "null" ? raw : "http://127.0.0.1";
}

function rootDataset() {
    return globalThis.document?.documentElement?.dataset ?? null;
}

/**
 * {§web-configuration} {§web-arrival} True when the HTML shell was stamped by the Node module (rather than standalone Vite dev).
 */
export function isModuleDocument() {
    const el = globalThis.document?.documentElement;
    return Boolean(el && (el.hasAttribute("data-web-version") || el.hasAttribute("data-acp-url")));
}

/**
 * {§web-configuration} Full `http(s):` URL to `/acp` resolved from `data-acp-url` (default same-origin `/acp`).
 */
export function acpUrl() {
    const raw = (rootDataset()?.acpUrl ?? "").trim();
    const target = raw === "" || raw === "invalid" ? DEFAULT_ACP_PATH : raw;
    return new URL(target, currentOrigin()).href;
}

/**
 * {§web-configuration} Origin of the configured `/acp` endpoint.
 */
export function acpOrigin() {
    return new URL(acpUrl()).origin;
}

/**
 * {§web-configuration} Full `http(s):` URL to `/notifications` (plus optional suffix such as `/${workspaceId}`) on `acpOrigin()`.
 * @param {string} [suffix]
 */
export function notificationsUrl(suffix = "") {
    return `${acpOrigin()}/notifications${suffix}`;
}

/**
 * {§web-diagram-service} Same-origin `/render/mermaid` endpoint on the web document host.
 */
export function mermaidUrl() {
    return new URL("/render/mermaid", currentOrigin()).href;
}

/**
 * {§web-workspace-creation} True when project-folder binding is enabled (`data-allow-project-folder` is not `"0"` or `"invalid"`).
 */
export function allowProjectFolder() {
    const raw = rootDataset()?.allowProjectFolder;
    return raw !== "0" && raw !== "invalid";
}

/**
 * {§web-workspace-creation} True when workspace creation is not withheld by an invalid `PLURNK_WEB_ALLOW_PROJECT_FOLDER`.
 */
export function allowWorkspaceCreation() {
    return rootDataset()?.allowProjectFolder !== "invalid";
}

/**
 * {§web-search} Configured `PLURNK_WEB_OVERVIEW_SESSIONS` limit stamped on the HTML shell.
 */
export function overviewSessionsLimit() {
    const parsed = Number.parseInt(rootDataset()?.overviewSessions ?? "", 10);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_OVERVIEW_SESSIONS;
}

/**
 * {§web-search} Configured `PLURNK_WEB_OVERVIEW_EXCERPT_CHARS` limit stamped on the HTML shell.
 */
export function overviewExcerptCharsLimit() {
    const parsed = Number.parseInt(rootDataset()?.overviewExcerptChars ?? "", 10);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_OVERVIEW_EXCERPT_CHARS;
}

/**
 * {§web-workspace-settings} `@plurnk/plurnk-web` package version stamped on the HTML shell.
 */
export function webVersion() {
    const raw = (rootDataset()?.webVersion ?? "").trim();
    return raw !== "" ? raw : DEFAULT_WEB_VERSION;
}

/**
 * {§web-workspace-settings} Record `@plurnk/plurnk-service` version observed from `/acp` `initialize` `response.info.version`.
 * @param {unknown} version
 */
export function recordServiceVersion(version) {
    if (typeof version !== "string" || version.trim() === "" || cachedServiceVersion === version.trim()) return;
    cachedServiceVersion = version.trim();
    for (const listener of serviceVersionListeners) listener(cachedServiceVersion);
}

/**
 * {§web-workspace-settings} Read the most recently observed `@plurnk/plurnk-service` version, if any.
 */
export function serviceVersion() {
    return cachedServiceVersion;
}

/**
 * @param {(version: string) => void} listener
 * @returns {() => void}
 */
export function onServiceVersion(listener) {
    serviceVersionListeners.add(listener);
    if (cachedServiceVersion !== null) listener(cachedServiceVersion);
    return () => { serviceVersionListeners.delete(listener); };
}
