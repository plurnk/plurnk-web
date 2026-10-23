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
 * @param {unknown} cause @param {string} failed @param {string} retry
 */
export function refusal(cause, failed, retry) {
    const problem = Problems.fromError(cause);
    if (problem === null || problem.status < 400 || problem.status >= 500) return new RequestError(502, failed, { cause, retry });
    const recovery = typeof problem.recovery === "string" ? problem.recovery : undefined;
    return new RequestError(problem.status, problem.detail ?? problem.title, { cause, recovery, retry });
}

/** @param {import("node:http").IncomingMessage} req @param {string} name */
export function cookie(req, name) {
    const values = (req.headers.cookie ?? "").split(";").map((part) => part.trim())
        .filter((part) => part.startsWith(`${name}=`));
    return values.length === 1 ? values[0].slice(name.length + 1) : null;
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
 * @param {import("node:http").IncomingMessage} req
 */
export function sameOriginFetch(req) {
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin") throw new RequestError(403, "Same-origin form required.");
}

/** {§web-worker-approval} The person reached this page from this origin or through the browser itself (address bar, bookmark),
 * by its Fetch Metadata; another site, a sibling site or no metadata is not their own navigation.
 * @param {import("node:http").IncomingMessage} req
 */
export const ownNavigation = (req) => req.headers["sec-fetch-site"] === "same-origin" || req.headers["sec-fetch-site"] === "none";

/** @param {import("node:http").ServerResponse} res @param {string} location */
export function redirect(res, location) {
    res.writeHead(303, { ...privateHeaders, location });
    res.end();
}
