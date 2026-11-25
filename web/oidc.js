import { $, on } from "on_the_money";
import { acpOrigin, authLoginUrl, authLogoutMethod, authLogoutUrl } from "./endpoints.js";

export const OIDC_GRANT_KEY = "plurnk_oidc_grant";
export const OIDC_PKCE_KEY = "plurnk_oidc_pkce";

const EXPIRY_MARGIN_MS = 1_000;
const PKCE_RANDOM_BYTES = 32;
const DEFAULT_CLIENT_ID = "plurnk-web";
const DEFAULT_SCOPES = ["openid", "profile", "email"];

/**
 * @typedef {{
 *   readonly acpOrigin: string,
 *   readonly issuer: string,
 *   readonly clientId: string,
 *   readonly tokenEndpoint: string,
 *   readonly accessToken: string,
 *   readonly refreshToken?: string,
 *   readonly expiresAt?: number,
 * }} OidcGrant
 */

/**
 * @typedef {{
 *   readonly state: string,
 *   readonly verifier: string,
 *   readonly returnTo: string,
 *   readonly acpOrigin: string,
 *   readonly issuer: string,
 *   readonly clientId: string,
 *   readonly tokenEndpoint: string,
 *   readonly redirectUri: string,
 *   readonly createdAt: number,
 * }} OidcPkceTransaction
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @type {Set<() => void>} */
const grantListeners = new Set();
/** @type {Map<string, Promise<OidcGrant | null>>} */
const refreshInFlight = new Map();
/** @type {Promise<{ readonly status: "redirecting", readonly authorizationUrl: string } | { readonly status: "unavailable" } | { readonly status: "signed-out" }> | null} */
let redirectInFlight = null;

function notifyGrantChanged() {
    for (const listener of grantListeners) listener();
}

if (typeof window !== "undefined") {
    on.target(window, "storage", (event) => {
        if (event instanceof StorageEvent && (event.key === null || event.key === OIDC_GRANT_KEY)) {
            notifyGrantChanged();
        }
    });
}

/**
 * @param {() => void} listener
 * @returns {() => void}
 */
export function onOidcGrantChange(listener) {
    grantListeners.add(listener);
    return () => { grantListeners.delete(listener); };
}

/**
 * @param {"localStorage" | "sessionStorage"} target
 * @returns {Storage | null}
 */
function resolveStorage(target) {
    try {
        if (typeof window === "undefined") {
            const desc = Object.getOwnPropertyDescriptor(globalThis, target);
            if (!desc || !("value" in desc)) return null;
            return /** @type {Storage | null} */ (desc.value ?? null);
        }
        return globalThis[target] ?? null;
    } catch {
        return null;
    }
}

/**
 * @param {"localStorage" | "sessionStorage"} target
 * @param {string} key
 * @returns {string | null}
 */
function safeStorageGet(target, key) {
    try {
        const storage = resolveStorage(target);
        return storage ? storage.getItem(key) : null;
    } catch {
        return null;
    }
}

/**
 * @param {"localStorage" | "sessionStorage"} target
 * @param {string} key
 * @param {string} value
 */
function safeStorageSet(target, key, value) {
    try { resolveStorage(target)?.setItem(key, value); }
    catch { /* storage disabled */ }
}

/**
 * @param {"localStorage" | "sessionStorage"} target
 * @param {string} key
 */
function safeStorageRemove(target, key) {
    try { resolveStorage(target)?.removeItem(key); }
    catch { /* storage disabled */ }
}

/**
 * @param {Uint8Array} bytes
 */
function base64UrlEncode(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * @param {number} byteLength
 */
function randomBase64Url(byteLength = PKCE_RANDOM_BYTES) {
    const bytes = new Uint8Array(byteLength);
    globalThis.crypto.getRandomValues(bytes);
    return base64UrlEncode(bytes);
}

/**
 * Compute RFC 7636 `S256` `code_challenge` from `code_verifier`.
 * @param {string} verifier
 */
export async function computePkceChallenge(verifier) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return base64UrlEncode(new Uint8Array(digest));
}

function currentWebOrigin() {
    const raw = globalThis.location?.origin;
    return typeof raw === "string" && raw !== "" && raw !== "null" ? raw : "http://127.0.0.1";
}

function currentReturnTo() {
    const loc = globalThis.location;
    if (!loc) return "/";
    return normalizeReturnTo(`${loc.pathname ?? "/"}${loc.search ?? ""}${loc.hash ?? ""}`);
}

/**
 * Restrict `returnTo` to an origin-relative path on this web host (never `/auth/callback` or an external URL).
 * @param {unknown} raw
 */
export function normalizeReturnTo(raw) {
    if (typeof raw !== "string" || raw.trim() === "") return "/";
    const trimmed = raw.trim();
    if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return "/";
    try {
        const parsed = new URL(trimmed, "http://plurnk.local");
        if (parsed.origin !== "http://plurnk.local" || parsed.pathname === "/auth/callback") return "/";
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
        return "/";
    }
}

/**
 * Pick the bearer JWT from an OIDC token response (`access_token` if 3-part JWT or `id_token` absent, else `id_token`).
 * @param {Record<string, unknown>} payload
 * @returns {string | null}
 */
export function selectOidcBearerToken(payload) {
    const access = typeof payload.access_token === "string" && payload.access_token.trim() !== ""
        ? payload.access_token.trim()
        : null;
    const idToken = typeof payload.id_token === "string" && payload.id_token.trim() !== ""
        ? payload.id_token.trim()
        : null;
    if (access !== null && (access.split(".").length === 3 || idToken === null)) {
        return access;
    }
    return idToken;
}

/**
 * @param {Record<string, unknown>} payload
 * @param {number} [now]
 * @returns {number | undefined}
 */
function computeExpiresAt(payload, now = Date.now()) {
    const raw = typeof payload.expires_in === "number"
        ? payload.expires_in
        : typeof payload.expires_in === "string" && payload.expires_in.trim() !== ""
            ? Number(payload.expires_in)
            : Number.NaN;
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    return now + Math.floor(raw * 1000);
}

/**
 * {§web-oidc} Read the stored OIDC grant matching `origin` from `localStorage`, or `null` when absent/mismatched.
 * @param {string} [origin]
 * @returns {OidcGrant | null}
 */
export function readOidcGrant(origin = acpOrigin()) {
    const raw = safeStorageGet("localStorage", OIDC_GRANT_KEY);
    if (raw === null || raw === "") return null;
    try {
        const parsed = JSON.parse(raw);
        if (
            !isRecord(parsed)
            || parsed.acpOrigin !== origin
            || typeof parsed.issuer !== "string" || parsed.issuer === ""
            || typeof parsed.clientId !== "string" || parsed.clientId === ""
            || typeof parsed.tokenEndpoint !== "string" || parsed.tokenEndpoint === ""
            || typeof parsed.accessToken !== "string" || parsed.accessToken === ""
        ) {
            return null;
        }
        return {
            acpOrigin: parsed.acpOrigin,
            issuer: parsed.issuer,
            clientId: parsed.clientId,
            tokenEndpoint: parsed.tokenEndpoint,
            accessToken: parsed.accessToken,
            ...(typeof parsed.refreshToken === "string" && parsed.refreshToken !== "" ? { refreshToken: parsed.refreshToken } : {}),
            ...(typeof parsed.expiresAt === "number" && Number.isFinite(parsed.expiresAt) ? { expiresAt: parsed.expiresAt } : {}),
        };
    } catch {
        return null;
    }
}

/**
 * {§web-oidc} True when `localStorage` holds an active OIDC grant for `origin`.
 * @param {string} [origin]
 */
export function hasActiveOidcGrant(origin = acpOrigin()) {
    return readOidcGrant(origin) !== null;
}

/**
 * {§web-oidc} {§web-bff-auth} True when either a browser OIDC grant or a configured BFF logout URL supports Sign out.
 * @param {string} [origin]
 */
export function canSignOut(origin = acpOrigin()) {
    return hasActiveOidcGrant(origin) || authLogoutUrl() !== null;
}

/**
 * {§web-bff-auth} Build an origin-relative BFF login URL carrying a normalized `returnTo` path.
 * Substitutes `{returnTo}` when present in `loginTemplate`, otherwise appends `returnTo` as a query parameter.
 * @param {string} loginTemplate
 * @param {unknown} [returnTo]
 * @returns {string}
 */
export function buildBffLoginUrl(loginTemplate, returnTo = currentReturnTo()) {
    const safeReturnTo = normalizeReturnTo(returnTo);
    if (loginTemplate.includes("{returnTo}")) {
        return loginTemplate.replaceAll("{returnTo}", encodeURIComponent(safeReturnTo));
    }
    const parsed = new URL(loginTemplate, "http://plurnk.local");
    parsed.searchParams.set("returnTo", safeReturnTo);
    return `${parsed.pathname}${parsed.search}`;
}

/**
 * @param {OidcGrant} grant
 */
export function writeOidcGrant(grant) {
    safeStorageSet("localStorage", OIDC_GRANT_KEY, JSON.stringify(grant));
    notifyGrantChanged();
}

/**
 * {§web-oidc} Clear `plurnk_oidc_grant` from `localStorage` and `plurnk_oidc_pkce` from `sessionStorage`.
 */
export function clearOidcState() {
    const hadGrant = safeStorageGet("localStorage", OIDC_GRANT_KEY) !== null;
    safeStorageRemove("localStorage", OIDC_GRANT_KEY);
    safeStorageRemove("sessionStorage", OIDC_PKCE_KEY);
    if (hadGrant) notifyGrantChanged();
}

/**
 * {§web-oidc} Append `?access_token=<encodeURIComponent(accessToken)>` to WebSocket `/acp` and `<img src="/acp/.../entry">` URLs when non-empty.
 * @param {string} urlString
 * @param {string | null | undefined} [accessToken]
 */
export function withAccessTokenQuery(urlString, accessToken = readOidcGrant()?.accessToken ?? null) {
    if (typeof accessToken !== "string" || accessToken.length === 0) return urlString;
    const url = new URL(urlString, acpOrigin());
    url.searchParams.set("access_token", accessToken);
    return url.href;
}

/**
 * {§web-oidc} Exchange a `refresh_token` at `grant.tokenEndpoint` (single-flight per origin + refresh token).
 * @param {OidcGrant | null} [grant]
 * @param {AbortSignal} [signal]
 * @param {typeof globalThis.fetch} [fetchImpl]
 * @returns {Promise<OidcGrant | null>}
 */
export function refreshOidcGrant(grant = readOidcGrant(), signal, fetchImpl = globalThis.fetch) {
    if (!grant) return Promise.resolve(null);
    const refreshToken = grant.refreshToken;
    if (typeof refreshToken !== "string" || refreshToken === "") return Promise.resolve(null);
    const flightKey = `${grant.acpOrigin}:${refreshToken}`;
    const existing = refreshInFlight.get(flightKey);
    if (existing) return existing;

    const flight = (async () => {
        try {
            const body = new URLSearchParams({
                grant_type: "refresh_token",
                client_id: grant.clientId,
                refresh_token: refreshToken,
            });
            const res = await fetchImpl(grant.tokenEndpoint, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: body.toString(),
                cache: "no-store",
                signal,
            });
            if (!res.ok) {
                if (res.status === 400 || res.status === 401) clearOidcState();
                return null;
            }
            const payload = await res.json();
            if (!isRecord(payload)) return null;
            const accessToken = selectOidcBearerToken(payload);
            if (accessToken === null) return null;
            const expiresAt = computeExpiresAt(payload);
            const nextRefreshToken = typeof payload.refresh_token === "string" && payload.refresh_token.trim() !== ""
                ? payload.refresh_token.trim()
                : grant.refreshToken;
            /** @type {OidcGrant} */
            const updated = {
                acpOrigin: grant.acpOrigin,
                issuer: grant.issuer,
                clientId: grant.clientId,
                tokenEndpoint: grant.tokenEndpoint,
                accessToken,
                ...(nextRefreshToken ? { refreshToken: nextRefreshToken } : {}),
                ...(expiresAt !== undefined ? { expiresAt } : {}),
            };
            writeOidcGrant(updated);
            return updated;
        } catch {
            return null;
        } finally {
            refreshInFlight.delete(flightKey);
        }
    })();

    refreshInFlight.set(flightKey, flight);
    return flight;
}

/**
 * {§web-oidc} Return the active bearer token for `acpOrigin()`, refreshing proactively when expired.
 * Loopback / unauthenticated fast path: returns `null` synchronously-settled with zero network preflight when no grant is stored.
 * @param {AbortSignal} [signal]
 * @param {typeof globalThis.fetch} [fetchImpl]
 * @returns {Promise<string | null>}
 */
export async function ensureValidAccessToken(signal, fetchImpl = globalThis.fetch) {
    const grant = readOidcGrant();
    if (grant === null) return null;
    if (typeof grant.expiresAt === "number" && Date.now() + EXPIRY_MARGIN_MS >= grant.expiresAt) {
        if (typeof grant.refreshToken === "string" && grant.refreshToken !== "") {
            const refreshed = await refreshOidcGrant(grant, signal, fetchImpl);
            return refreshed?.accessToken ?? null;
        }
        clearOidcState();
        return null;
    }
    return grant.accessToken;
}

/**
 * {§web-oidc} Recover from a `401` on `/acp`:
 * 1. Try `refreshToken` at `tokenEndpoint` first if present;
 * 2. Otherwise clear stale grant, discover `/.well-known/oauth-protected-resource` + OIDC metadata, save ephemeral PKCE S256 transaction in `sessionStorage`, and redirect to `authorization_endpoint`.
 *
 * @param {{
 *   signal?: AbortSignal,
 *   returnTo?: string,
 *   redirectOnDiscovery?: boolean,
 *   fetchImpl?: typeof globalThis.fetch,
 *   navigate?: (url: string) => void,
 * }} [options]
 * @returns {Promise<
 *   | { readonly status: "refreshed", readonly accessToken: string }
 *   | { readonly status: "redirecting", readonly authorizationUrl: string }
 *   | { readonly status: "signed-out" }
 *   | { readonly status: "unavailable" }
 * >}
 */
export async function recoverFromUnauthorized(options = {}) {
    const {
        signal,
        returnTo = currentReturnTo(),
        redirectOnDiscovery = true,
        fetchImpl = globalThis.fetch,
        navigate = (url) => { globalThis.location.assign(url); },
    } = options;

    const bffLogin = authLoginUrl();
    if (bffLogin !== null) {
        clearOidcState();
        if (!redirectOnDiscovery) {
            return { status: "signed-out" };
        }
        const target = buildBffLoginUrl(bffLogin, returnTo);
        navigate(target);
        return { status: "redirecting", authorizationUrl: target };
    }

    const current = readOidcGrant();
    if (current !== null && typeof current.refreshToken === "string" && current.refreshToken !== "") {
        const refreshed = await refreshOidcGrant(current, signal, fetchImpl);
        if (refreshed !== null) {
            return { status: "refreshed", accessToken: refreshed.accessToken };
        }
    }

    clearOidcState();
    if (!redirectOnDiscovery) {
        return { status: "signed-out" };
    }
    if (redirectInFlight !== null) {
        return await redirectInFlight;
    }

    const origin = acpOrigin();
    redirectInFlight = (async () => {
        try {
            const prmRes = await fetchImpl(`${origin}/.well-known/oauth-protected-resource`, {
                cache: "no-store",
                signal,
            });
            if (!prmRes.ok) return { status: /** @type {const} */ ("unavailable") };
            const prm = await prmRes.json();
            if (!isRecord(prm) || !Array.isArray(prm.authorization_servers) || typeof prm.authorization_servers[0] !== "string") {
                return { status: /** @type {const} */ ("unavailable") };
            }
            const issuer = prm.authorization_servers[0].trim();
            if (issuer === "") return { status: /** @type {const} */ ("unavailable") };
            const issuerBase = issuer.replace(/\/+$/u, "");

            let metaRes = await fetchImpl(`${issuerBase}/.well-known/openid-configuration`, {
                cache: "no-store",
                signal,
            });
            if (!metaRes.ok) {
                metaRes = await fetchImpl(`${issuerBase}/.well-known/oauth-authorization-server`, {
                    cache: "no-store",
                    signal,
                });
            }
            if (!metaRes.ok) return { status: /** @type {const} */ ("unavailable") };
            const meta = await metaRes.json();
            if (
                !isRecord(meta)
                || typeof meta.authorization_endpoint !== "string" || meta.authorization_endpoint.trim() === ""
                || typeof meta.token_endpoint !== "string" || meta.token_endpoint.trim() === ""
            ) {
                return { status: /** @type {const} */ ("unavailable") };
            }

            const clientId = typeof prm.client_id === "string" && prm.client_id.trim() !== ""
                ? prm.client_id.trim()
                : DEFAULT_CLIENT_ID;
            const redirectUri = typeof prm.redirect_uri === "string" && prm.redirect_uri.trim() !== ""
                ? prm.redirect_uri.trim()
                : new URL("/auth/callback", currentWebOrigin()).href;
            const scopes = Array.isArray(prm.scopes_supported)
                && prm.scopes_supported.length > 0
                && prm.scopes_supported.every((s) => typeof s === "string" && s.trim() !== "")
                ? prm.scopes_supported.map((s) => s.trim())
                : DEFAULT_SCOPES;

            const state = randomBase64Url();
            const verifier = randomBase64Url();
            const challenge = await computePkceChallenge(verifier);

            /** @type {OidcPkceTransaction} */
            const tx = {
                state,
                verifier,
                returnTo: normalizeReturnTo(returnTo),
                acpOrigin: origin,
                issuer,
                clientId,
                tokenEndpoint: meta.token_endpoint.trim(),
                redirectUri,
                createdAt: Date.now(),
            };
            safeStorageSet("sessionStorage", OIDC_PKCE_KEY, JSON.stringify(tx));

            const authUrl = new URL(meta.authorization_endpoint.trim());
            authUrl.searchParams.set("response_type", "code");
            authUrl.searchParams.set("client_id", clientId);
            authUrl.searchParams.set("redirect_uri", redirectUri);
            authUrl.searchParams.set("code_challenge", challenge);
            authUrl.searchParams.set("code_challenge_method", "S256");
            authUrl.searchParams.set("state", state);
            authUrl.searchParams.set("scope", scopes.join(" "));

            navigate(authUrl.href);
            return { status: /** @type {const} */ ("redirecting"), authorizationUrl: authUrl.href };
        } catch {
            return { status: /** @type {const} */ ("unavailable") };
        } finally {
            redirectInFlight = null;
        }
    })();

    return await redirectInFlight;
}

/**
 * {§web-oidc} Complete the `/auth/callback` authorization-code + PKCE exchange.
 * Immediately removes `plurnk_oidc_pkce` from `sessionStorage`, verifies `state`, exchanges `code`, stores `plurnk_oidc_grant`, and replaces location with `returnTo`.
 *
 * @param {{
 *   search?: string,
 *   fetchImpl?: typeof globalThis.fetch,
 *   replace?: (url: string) => void,
 * }} [options]
 * @returns {Promise<{ readonly ok: true, readonly returnTo: string } | { readonly ok: false, readonly message: string }>}
 */
export async function completeOidcCallback(options = {}) {
    const {
        search = globalThis.location?.search ?? "",
        fetchImpl = globalThis.fetch,
        replace = (url) => { globalThis.location.replace(url); },
    } = options;

    const rawTx = safeStorageGet("sessionStorage", OIDC_PKCE_KEY);
    safeStorageRemove("sessionStorage", OIDC_PKCE_KEY);

    const params = new URLSearchParams(search);
    const oauthError = params.get("error");
    if (oauthError) {
        const desc = params.get("error_description")?.trim();
        return { ok: false, message: desc || `Sign-in was refused (${oauthError}).` };
    }

    /** @type {OidcPkceTransaction | null} */
    let tx = null;
    if (rawTx !== null && rawTx !== "") {
        try {
            const parsed = JSON.parse(rawTx);
            if (
                isRecord(parsed)
                && typeof parsed.state === "string" && parsed.state !== ""
                && typeof parsed.verifier === "string" && parsed.verifier !== ""
                && typeof parsed.acpOrigin === "string" && parsed.acpOrigin !== ""
                && typeof parsed.issuer === "string" && parsed.issuer !== ""
                && typeof parsed.clientId === "string" && parsed.clientId !== ""
                && typeof parsed.tokenEndpoint === "string" && parsed.tokenEndpoint !== ""
                && typeof parsed.redirectUri === "string" && parsed.redirectUri !== ""
            ) {
                tx = {
                    state: parsed.state,
                    verifier: parsed.verifier,
                    returnTo: normalizeReturnTo(parsed.returnTo),
                    acpOrigin: parsed.acpOrigin,
                    issuer: parsed.issuer,
                    clientId: parsed.clientId,
                    tokenEndpoint: parsed.tokenEndpoint,
                    redirectUri: parsed.redirectUri,
                    createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
                };
            }
        } catch {
            tx = null;
        }
    }

    const stateParam = params.get("state") ?? "";
    const codeParam = params.get("code") ?? "";
    if (tx === null || stateParam === "" || stateParam !== tx.state || codeParam === "") {
        return { ok: false, message: "Sign-in state did not match this browser tab. Start sign-in again from Home." };
    }

    try {
        const body = new URLSearchParams({
            grant_type: "authorization_code",
            client_id: tx.clientId,
            code: codeParam,
            redirect_uri: tx.redirectUri,
            code_verifier: tx.verifier,
        });
        const res = await fetchImpl(tx.tokenEndpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: body.toString(),
            cache: "no-store",
        });
        if (!res.ok) {
            return { ok: false, message: `Token exchange failed (${res.status}).` };
        }
        const payload = await res.json();
        if (!isRecord(payload)) {
            return { ok: false, message: "The identity provider returned an invalid token response." };
        }
        const accessToken = selectOidcBearerToken(payload);
        if (accessToken === null) {
            return { ok: false, message: "The identity provider returned no bearer token." };
        }
        const expiresAt = computeExpiresAt(payload);
        const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token.trim() !== ""
            ? payload.refresh_token.trim()
            : undefined;
        writeOidcGrant({
            acpOrigin: tx.acpOrigin,
            issuer: tx.issuer,
            clientId: tx.clientId,
            tokenEndpoint: tx.tokenEndpoint,
            accessToken,
            ...(refreshToken ? { refreshToken } : {}),
            ...(expiresAt !== undefined ? { expiresAt } : {}),
        });
        const destination = normalizeReturnTo(tx.returnTo);
        replace(destination);
        return { ok: true, returnTo: destination };
    } catch {
        return { ok: false, message: "Could not reach the identity provider token endpoint." };
    }
}

/**
 * {§web-bff-auth} Submit a CSRF-safe top-level `POST` logout form to a same-origin BFF logout endpoint.
 * @param {string} action
 */
function submitBffLogoutForm(action) {
    if (typeof document === "undefined" || !document.body) return;
    const form = $.clone(document.body, "#auth-logout-form");
    if (form instanceof HTMLFormElement) {
        form.action = action;
        form.submit();
    }
}

/**
 * {§web-oidc} {§web-bff-auth} Clear browser OIDC storage and trigger BFF logout (when configured) or return to `/`.
 * @param {{
 *   reload?: (() => void) | boolean,
 *   navigate?: (url: string) => void,
 *   submitPost?: (action: string) => void,
 * }} [options]
 */
export function signOut(options = {}) {
    const {
        reload = true,
        navigate = (url) => { globalThis.location.assign(url); },
        submitPost = submitBffLogoutForm,
    } = options;
    clearOidcState();
    const logoutUrl = authLogoutUrl();
    if (logoutUrl !== null) {
        if (typeof reload === "function") {
            reload();
        } else if (reload !== false) {
            if (authLogoutMethod() === "GET") navigate(logoutUrl);
            else submitPost(logoutUrl);
        }
        return;
    }
    if (typeof reload === "function") reload();
    else if (reload !== false) navigate("/");
}
