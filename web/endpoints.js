const DEFAULT_ACP_PATH = "/acp";
const DEFAULT_APP_NAME = "Plurnk";
const DEFAULT_OVERVIEW_SESSIONS = 200;
const DEFAULT_OVERVIEW_EXCERPT_CHARS = 160;
const DEFAULT_WEB_VERSION = "4.1.0";

/**
 * @typedef {"unrestricted" | "confined" | "none"} ProjectRootPolicyMode
 * @typedef {"service" | "workspace" | "session"} FunctionalityScope
 * @typedef {{
 *   readonly workspaceTransports: readonly ("stdio" | "streamable-http")[],
 *   readonly publicOnly: boolean,
 * }} McpDaemonPolicy
 * @typedef {{
 *   readonly workspaceSources: readonly ("mcp" | "git" | "local")[],
 *   readonly publicOnly: boolean,
 * }} SkillsDaemonPolicy
 * @typedef {{
 *   readonly projectRoot?: ProjectRootPolicyMode,
 *   readonly families?: readonly string[],
 *   readonly familyScopes?: Readonly<Record<string, readonly FunctionalityScope[]>>,
 *   readonly mcp?: McpDaemonPolicy,
 *   readonly skills?: SkillsDaemonPolicy,
 * }} DaemonPolicy
 */

/** @type {string | null} */
let cachedServiceVersion = null;
/** @type {Set<(version: string) => void>} */
const serviceVersionListeners = new Set();

/** @type {DaemonPolicy | null} */
let cachedDaemonPolicy = null;
let cachedDaemonPolicyKey = "";
/** @type {Set<(policy: DaemonPolicy) => void>} */
const daemonPolicyListeners = new Set();

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * {§web-workspace-settings} {§web-workspace-creation} Normalize `_meta.plurnk.policy` advertised by `/acp` `initialize`.
 * @param {unknown} raw
 * @returns {DaemonPolicy | null}
 */
export function parseDaemonPolicy(raw) {
    if (!isRecord(raw)) return null;
    /** @type {{
     *   projectRoot?: ProjectRootPolicyMode,
     *   families?: readonly string[],
     *   familyScopes?: Readonly<Record<string, readonly FunctionalityScope[]>>,
     *   mcp?: McpDaemonPolicy,
     *   skills?: SkillsDaemonPolicy,
     * }} */
    const next = {};
    if (raw.projectRoot === "unrestricted" || raw.projectRoot === "confined" || raw.projectRoot === "none") {
        next.projectRoot = raw.projectRoot;
    }
    if (Array.isArray(raw.families)) {
        const families = raw.families.filter((item) => typeof item === "string" && item.length > 0);
        next.families = Object.freeze([...new Set(families)]);
    }
    if (isRecord(raw.familyScopes)) {
        /** @type {Record<string, readonly FunctionalityScope[]>} */
        const parsedScopes = {};
        for (const [family, scopes] of Object.entries(raw.familyScopes)) {
            if (!family || !Array.isArray(scopes)) continue;
            const valid = scopes.filter(
                /** @returns {value is FunctionalityScope} */
                (value) => value === "service" || value === "workspace" || value === "session",
            );
            if (valid.length > 0) parsedScopes[family] = Object.freeze([...new Set(valid)]);
        }
        if (Object.keys(parsedScopes).length > 0) next.familyScopes = Object.freeze(parsedScopes);
    }
    if (isRecord(raw.mcp) && Array.isArray(raw.mcp.workspaceTransports)) {
        const workspaceTransports = raw.mcp.workspaceTransports.filter(
            /** @returns {value is "stdio" | "streamable-http"} */
            (value) => value === "stdio" || value === "streamable-http",
        );
        next.mcp = Object.freeze({
            workspaceTransports: Object.freeze([...new Set(workspaceTransports)]),
            publicOnly: raw.mcp.publicOnly === true,
        });
    }
    if (isRecord(raw.skills) && Array.isArray(raw.skills.workspaceSources)) {
        const workspaceSources = raw.skills.workspaceSources.filter(
            /** @returns {value is "mcp" | "git" | "local"} */
            (value) => value === "mcp" || value === "git" || value === "local",
        );
        next.skills = Object.freeze({
            workspaceSources: Object.freeze([...new Set(workspaceSources)]),
            publicOnly: raw.skills.publicOnly === true,
        });
    }
    return Object.keys(next).length > 0 ? Object.freeze(next) : null;
}

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
 * {§web-brand} Configured brand application name stamped on `<html>` (`data-app-name`, default `"Plurnk"`).
 */
export function appName() {
    const raw = (rootDataset()?.appName ?? "").trim();
    return raw !== "" ? raw : DEFAULT_APP_NAME;
}

/**
 * {§web-brand} Format a browser `<title>` using the configured brand suffix.
 * @param {string} title
 */
export function formatPageTitle(title) {
    return `${title} — ${appName()}`;
}

/**
 * {§web-bff-auth} Configured origin-relative BFF login URL (`data-auth-login-url`), or `null` when using browser OIDC PKCE.
 * @returns {string | null}
 */
export function authLoginUrl() {
    const raw = (rootDataset()?.authLoginUrl ?? "").trim();
    return raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\") ? raw : null;
}

/**
 * {§web-bff-auth} Configured origin-relative BFF logout URL (`data-auth-logout-url`), or `null`.
 * @returns {string | null}
 */
export function authLogoutUrl() {
    const raw = (rootDataset()?.authLogoutUrl ?? "").trim();
    return raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\") ? raw : null;
}

/**
 * {§web-bff-auth} Configured HTTP method for BFF logout (`"POST"` default, or `"GET"`).
 * @returns {"POST" | "GET"}
 */
export function authLogoutMethod() {
    return (rootDataset()?.authLogoutMethod ?? "").trim().toUpperCase() === "GET" ? "GET" : "POST";
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

/**
 * {§web-workspace-settings} {§web-workspace-creation} Record daemon confinement policy observed from `/acp` `initialize` `response._meta.plurnk.policy`.
 * @param {unknown} raw
 */
export function recordDaemonPolicy(raw) {
    const parsed = parseDaemonPolicy(raw);
    if (parsed === null) return;
    const key = JSON.stringify(parsed);
    if (key === cachedDaemonPolicyKey) return;
    cachedDaemonPolicy = parsed;
    cachedDaemonPolicyKey = key;
    for (const listener of daemonPolicyListeners) listener(parsed);
}

/**
 * {§web-workspace-settings} {§web-workspace-creation} Read the most recently observed daemon confinement policy, if any.
 * @returns {DaemonPolicy | null}
 */
export function daemonPolicy() {
    return cachedDaemonPolicy;
}

/**
 * @param {(policy: DaemonPolicy) => void} listener
 * @returns {() => void}
 */
export function onDaemonPolicy(listener) {
    daemonPolicyListeners.add(listener);
    if (cachedDaemonPolicy !== null) listener(cachedDaemonPolicy);
    return () => { daemonPolicyListeners.delete(listener); };
}
