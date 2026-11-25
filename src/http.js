import { isLoopbackHost } from "@plurnk/plurnk-contracts";
import { ConfigurationError } from "@plurnk/plurnk-meta";

/**
 * @param {string | readonly string[] | undefined} raw
 * @returns {string | undefined}
 */
function firstHeader(raw) {
    return typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
}

/**
 * {§web-diagram-service} {§web-browser-security} Resolve the effective target `Host` for a request,
 * honoring the first hop of `X-Forwarded-Host` when delivered over a loopback reverse proxy
 * (matching `@plurnk/plurnk-contracts` `HttpOrigin`), and falling back to `Host` otherwise.
 * @param {import("@plurnk/plurnk-contracts").RequestHeaders | undefined} req
 * @returns {string}
 */
function resolveEffectiveRequestHost(req) {
    const rawHost = firstHeader(req?.headers?.host)?.trim() ?? "";
    const remoteAddress = req?.socket?.remoteAddress;
    const onLoopbackSocket = remoteAddress !== undefined
        ? isLoopbackHost(remoteAddress)
        : (() => {
            if (rawHost === "") return false;
            try { return isLoopbackHost(new URL(`http://${rawHost}`).hostname); }
            catch { return false; }
        })();
    if (onLoopbackSocket) {
        const forwardedHost = firstHeader(req?.headers?.["x-forwarded-host"])?.split(",", 1)[0]?.trim();
        if (forwardedHost) return forwardedHost;
    }
    return rawHost;
}

/**
 * Normalize a `Host` or `X-Forwarded-Host` authority under `protocol`, rejecting credentials, paths,
 * queries, or fragments.
 * @param {string} protocol
 * @param {string} rawAuthority
 * @returns {string | null}
 */
function normalizeAuthorityHost(protocol, rawAuthority) {
    if (rawAuthority === "") return null;
    try {
        const parsed = new URL(`${protocol}//${rawAuthority}`);
        if (
            parsed.username !== ""
            || parsed.password !== ""
            || parsed.pathname !== "/"
            || parsed.search !== ""
            || parsed.hash !== ""
        ) {
            return null;
        }
        return parsed.host.toLowerCase();
    } catch {
        return null;
    }
}

/** @param {string} value */
export const escapeHtml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export class RequestError extends Error {
    /** @param {number} status @param {string} message @param {ErrorOptions} [options] */
    constructor(status, message, options = {}) {
        super(message, options);
        this.status = status;
    }
}

export const DEFAULT_ACP_URL = "/acp";

/**
 * @typedef {{
 *   readonly loginUrl: string | null,
 *   readonly logoutUrl: string | null,
 *   readonly logoutMethod: "POST" | "GET",
 * }} AuthConfig
 */

/** @type {AuthConfig} */
export const DEFAULT_AUTH_CONFIG = Object.freeze({
    loginUrl: null,
    logoutUrl: null,
    logoutMethod: "POST",
});

/**
 * @param {string | undefined} raw
 * @param {string} key
 * @param {{ readonly allowReturnToPlaceholder?: boolean }} [options]
 * @returns {string | null}
 */
function parseOptionalOriginRelativeAuthPath(raw, key, { allowReturnToPlaceholder = false } = {}) {
    const trimmed = (raw ?? "").trim();
    if (trimmed === "") return null;
    if (/\p{Cc}|\s/u.test(trimmed)) {
        throw new ConfigurationError(key, "must not contain whitespace or control characters");
    }
    if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.startsWith("/\\") || trimmed.includes("#")) {
        throw new ConfigurationError(key, "must be an origin-relative path starting with '/' without fragments");
    }
    const probe = allowReturnToPlaceholder ? trimmed.replaceAll("{returnTo}", "RETURN_TO") : trimmed;
    let parsed;
    try { parsed = new URL(probe, "http://plurnk.local"); }
    catch {
        throw new ConfigurationError(key, "must be a valid origin-relative path");
    }
    if (parsed.origin !== "http://plurnk.local" || parsed.hash !== "" || parsed.username !== "" || parsed.password !== "") {
        throw new ConfigurationError(key, "must be an origin-relative path without embedded credentials or fragments");
    }
    if (allowReturnToPlaceholder && parsed.pathname === "/auth/callback") {
        throw new ConfigurationError(key, "must not target /auth/callback");
    }
    return trimmed;
}

/**
 * {§web-configuration} {§web-bff-auth} Validate optional Backend-for-Frontend (BFF) login/logout handoff knobs fail-hard.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {AuthConfig}
 */
export function parseAuthConfig(env = process.env) {
    const loginUrl = parseOptionalOriginRelativeAuthPath(
        env.PLURNK_WEB_AUTH_LOGIN_URL,
        "PLURNK_WEB_AUTH_LOGIN_URL",
        { allowReturnToPlaceholder: true },
    );
    const logoutUrl = parseOptionalOriginRelativeAuthPath(
        env.PLURNK_WEB_AUTH_LOGOUT_URL,
        "PLURNK_WEB_AUTH_LOGOUT_URL",
    );
    const rawMethod = env.PLURNK_WEB_AUTH_LOGOUT_METHOD;
    if (rawMethod === undefined) {
        throw new Error("PLURNK_WEB_AUTH_LOGOUT_METHOD is missing from the assembled environment floor.");
    }
    const logoutMethod = rawMethod.trim().toUpperCase();
    if (logoutMethod !== "POST" && logoutMethod !== "GET") {
        throw new ConfigurationError("PLURNK_WEB_AUTH_LOGOUT_METHOD", "must be POST or GET");
    }
    return Object.freeze({
        loginUrl,
        logoutUrl,
        logoutMethod: /** @type {"POST" | "GET"} */ (logoutMethod),
    });
}

/**
 * {§web-configuration} {§web-browser-security} Validate `PLURNK_ACP_URL` as either a same-origin path (empty -> `/acp`)
 * or an `http(s):` endpoint URL without credentials or fragments, deriving its HTTP and WebSocket origins for CSP.
 * @param {string | undefined} raw
 * @returns {{ readonly acpUrl: string, readonly httpOrigin: string | null, readonly wsOrigin: string | null }}
 */
export function parseAcpEndpoint(raw = process.env.PLURNK_ACP_URL) {
    const trimmed = (raw ?? "").trim();
    if (trimmed === "") {
        return { acpUrl: DEFAULT_ACP_URL, httpOrigin: null, wsOrigin: null };
    }
    if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
        let parsed;
        try { parsed = new URL(trimmed, "http://plurnk.local"); }
        catch { throw new ConfigurationError("PLURNK_ACP_URL", "must be a valid http(s) URL or origin-relative path"); }
        if (parsed.origin !== "http://plurnk.local" || parsed.hash !== "") {
            throw new ConfigurationError("PLURNK_ACP_URL", "must not include fragments or protocol-relative authorities");
        }
        return { acpUrl: `${parsed.pathname}${parsed.search}`, httpOrigin: null, wsOrigin: null };
    }
    let parsed;
    try { parsed = new URL(trimmed); }
    catch { throw new ConfigurationError("PLURNK_ACP_URL", "must be a valid http(s) URL or origin-relative path"); }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
        throw new ConfigurationError("PLURNK_ACP_URL", "must use http: or https: without embedded credentials or fragments");
    }
    const wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    return {
        acpUrl: parsed.href,
        httpOrigin: parsed.origin,
        wsOrigin: `${wsProtocol}//${parsed.host}`,
    };
}

/**
 * {§web-browser-security} Extract an external `http(s):` OIDC issuer origin from `PLURNK_AUTH_ISSUER` or the credential authority face.
 * @param {unknown} face
 * @param {import("@plurnk/plurnk-contracts").RequestHeaders} [req]
 * @returns {string | null}
 */
export function resolveIssuerOrigin(face, req) {
    /** @type {unknown} */
    let candidate = null;
    if (face !== null && typeof face === "object" && "authorizationServer" in face) {
        const authServer = /** @type {{ authorizationServer?: unknown }} */ (face).authorizationServer;
        if (typeof authServer === "string" && authServer.trim() !== "") candidate = authServer;
    }
    if (candidate === null) {
        candidate = process.env.PLURNK_AUTH_ISSUER ?? "";
    }
    if (typeof candidate !== "string" || candidate.trim() === "") {
        if (face !== null && typeof face === "object" && "issuer" in face) {
            const rawIssuer = /** @type {{ issuer?: unknown }} */ (face).issuer;
            if (typeof rawIssuer === "function") {
                try { candidate = rawIssuer(req); }
                catch { candidate = null; }
            } else if (typeof rawIssuer === "string") {
                candidate = rawIssuer;
            }
        }
    }
    const trimmed = typeof candidate === "string" ? candidate.trim() : "";
    if (trimmed === "") return null;
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
        const reqHost = normalizeAuthorityHost(parsed.protocol, resolveEffectiveRequestHost(req));
        if (reqHost !== null && parsed.host.toLowerCase() === reqHost) return null;
        return parsed.origin;
    } catch {
        return null;
    }
}

/**
 * {§web-browser-security} Compose the strict `Content-Security-Policy` header (`script-src 'self'`), expanding
 * `connect-src` and `img-src` only for an explicitly configured external `PLURNK_ACP_URL` or OIDC issuer origin.
 * @param {{ readonly acpHttpOrigin?: string | null, readonly acpWsOrigin?: string | null, readonly issuerOrigin?: string | null }} [options]
 */
export function contentSecurityPolicy({ acpHttpOrigin = null, acpWsOrigin = null, issuerOrigin = null } = {}) {
    /** @type {string[]} */
    const connectSources = ["'self'"];
    for (const source of [acpHttpOrigin, acpWsOrigin, issuerOrigin]) {
        if (typeof source === "string" && source !== "" && !connectSources.includes(source)) {
            connectSources.push(source);
        }
    }
    const imgSources = [
        "'self'",
        ...(typeof acpHttpOrigin === "string" && acpHttpOrigin !== "" ? [acpHttpOrigin] : []),
        "data:",
        "blob:",
    ];
    return [
        "default-src 'self'",
        "script-src 'self'",
        `connect-src ${connectSources.join(" ")}`,
        `img-src ${imgSources.join(" ")}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ].join("; ");
}

/**
 * {§web-directory-documents} {§web-browser-security} Dynamic shell and service replies carry `Cache-Control: no-store` and strict security headers.
 * @param {{ readonly acpHttpOrigin?: string | null, readonly acpWsOrigin?: string | null, readonly issuerOrigin?: string | null }} [options]
 */
export function privateHeadersFor(options = {}) {
    return {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy": contentSecurityPolicy(options),
        "x-frame-options": "DENY",
    };
}

export const privateHeaders = privateHeadersFor();

/**
 * {§web-diagram-service} Enforce same-origin browser requests (`Origin` host matches effective target host,
 * honoring loopback `X-Forwarded-Host` before `Host`, and `Sec-Fetch-Site` is `same-origin` or `none`).
 * @param {import("@plurnk/plurnk-contracts").RequestHeaders} req
 */
export function sameOriginRequest(req) {
    const origin = firstHeader(req.headers.origin)?.trim();
    const targetHost = resolveEffectiveRequestHost(req);
    if (origin === undefined || origin === "" || origin === "null" || targetHost === "") {
        throw new RequestError(403, "Same-origin request required.");
    }
    let originUrl;
    try { originUrl = new URL(origin); }
    catch (cause) { throw new RequestError(403, "Same-origin request required.", { cause }); }
    if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
        throw new RequestError(403, "Same-origin request required.");
    }
    const expectedHost = normalizeAuthorityHost(originUrl.protocol, targetHost);
    if (expectedHost === null || originUrl.host.toLowerCase() !== expectedHost) {
        throw new RequestError(403, "Same-origin request required.");
    }
    const site = firstHeader(req.headers["sec-fetch-site"])?.trim().toLowerCase();
    if (site !== undefined && site !== "same-origin" && site !== "none") {
        throw new RequestError(403, "Same-origin request required.");
    }
}

/** @typedef {{ setHeader(name: string, value: string | readonly string[]): unknown, writeHead(statusCode: number, headers?: import("node:http").OutgoingHttpHeaders): unknown, end(chunk?: unknown): unknown }} HttpResponse */

/**
 * @param {Pick<HttpResponse, "writeHead" | "end">} res
 * @param {string} location
 * @param {import("node:http").OutgoingHttpHeaders} [headers]
 */
export function redirect(res, location, headers = privateHeaders) {
    res.writeHead(303, {
        ...headers,
        "content-length": "0",
        location,
    });
    res.end();
}
