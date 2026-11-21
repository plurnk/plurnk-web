import { Problems } from "@plurnk/plurnk-contracts";

/** @param {string} value */
export const escapeHtml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export class RequestError extends Error {
    /** @param {number} status @param {string} message @param {ErrorOptions & { recovery?: string, retry?: string }} [options] */
    constructor(status, message, { recovery, retry, ...options } = {}) {
        super(message, options);
        this.status = status;
        /** What the person can do next, as the daemon words it. */
        this.recovery = recovery;
        /** The form to submit again, holding the person's draft. */
        this.retry = retry;
    }
}

/**
 * {§web-workspace-creation} A daemon refusal answers with the daemon's own status, detail and recovery; a daemon that
 * failed is a 502. Either way the person's draft comes back in `retry`.
 * @param {unknown} cause @param {string} failed @param {string} [retry]
 */
export function refusal(cause, failed, retry = undefined) {
    const problem = Problems.fromError(cause);
    if (problem === null || problem.status < 400 || problem.status >= 500) return new RequestError(502, failed, { cause, retry });
    const recovery = typeof problem.recovery === "string" ? problem.recovery : undefined;
    return new RequestError(problem.status, problem.detail ?? problem.title, { cause, recovery, retry });
}

const PLACE_COOKIE = "plurnk_web_place";
const HOST_ONLY_PREFIX = "__Host-";
const PLACE_TTL_SEC = 31536000;

/** @param {import("@plurnk/plurnk-contracts").RequestHeaders} req @param {string} name */
export function cookie(req, name) {
    const raw = req.headers.cookie;
    const header = typeof raw === "string" ? raw : "";
    const values = header.split(";").map((part) => part.trim())
        .filter((part) => part.startsWith(`${name}=`));
    return values.length === 1 ? values[0].slice(name.length + 1) : null;
}

/**
 * {§web-arrival} Read this browser's remembered `<workspaceId>:<sessionId>` navigation place, if present and well-formed.
 * @param {import("@plurnk/plurnk-contracts").RequestHeaders} req
 * @param {boolean} secure
 * @returns {{ readonly workspaceId: number, readonly sessionId: number } | null}
 */
export function readPlaceCookie(req, secure) {
    const raw = cookie(req, `${secure ? HOST_ONLY_PREFIX : ""}${PLACE_COOKIE}`);
    if (raw === null) return null;
    const match = /^([1-9]\d*):([1-9]\d*)$/u.exec(raw);
    if (!match) return null;
    const workspaceId = Number(match[1]);
    const sessionId = Number(match[2]);
    return Number.isSafeInteger(workspaceId) && Number.isSafeInteger(sessionId) ? { workspaceId, sessionId } : null;
}

/**
 * {§web-arrival} Format the HttpOnly navigation cookie remembering the active `<workspaceId>:<sessionId>`.
 * @param {number} workspaceId
 * @param {number} sessionId
 * @param {boolean} secure
 */
export function formatPlaceCookie(workspaceId, sessionId, secure) {
    const name = `${secure ? HOST_ONLY_PREFIX : ""}${PLACE_COOKIE}`;
    return `${name}=${workspaceId}:${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PLACE_TTL_SEC}${secure ? "; Secure" : ""}`;
}

/**
 * {§web-arrival} Clear the remembered navigation place cookie on logout.
 * @param {boolean} secure
 */
export function clearPlaceCookie(secure) {
    const name = `${secure ? HOST_ONLY_PREFIX : ""}${PLACE_COOKIE}`;
    return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

// {§web-directory-documents} Dynamic replies contain no cacheable workspace or sign-in evidence.
export const privateHeaders = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "x-frame-options": "DENY",
};

/** {§web-workspace-creation} A browser that reports where a request came from must report this origin, in either posture.
 * @param {import("@plurnk/plurnk-contracts").RequestHeaders} req
 */
export function sameOriginFetch(req) {
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin") throw new RequestError(403, "Same-origin form required.");
}

/** {§web-session-approval} The person reached this page from this origin or through the browser itself (address bar, bookmark),
 * by its Fetch Metadata; another site, a sibling site or no metadata is not their own navigation.
 * @param {import("@plurnk/plurnk-contracts").RequestHeaders} req
 */
export const ownNavigation = (req) => req.headers["sec-fetch-site"] === "same-origin" || req.headers["sec-fetch-site"] === "none";

/** @typedef {{ setHeader(name: string, value: string | readonly string[]): unknown, writeHead(statusCode: number, headers?: import("node:http").OutgoingHttpHeaders): unknown, end(chunk?: unknown): unknown }} HttpResponse */

/** @param {Pick<HttpResponse, "writeHead" | "end">} res @param {string} location @param {string | string[]} [cookies] */
export function redirect(res, location, cookies) {
    res.writeHead(303, {
        ...privateHeaders,
        "content-length": "0",
        ...(cookies === undefined ? {} : { "set-cookie": cookies }),
        location,
    });
    res.end();
}
