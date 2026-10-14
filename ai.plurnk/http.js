/** @param {string} value */
export const escapeHtml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export class RequestError extends Error {
    /** @param {number} status @param {string} message @param {ErrorOptions} [options] */
    constructor(status, message, options) {
        super(message, options);
        this.status = status;
    }
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
    "content-security-policy": "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "x-frame-options": "DENY",
};

/** @param {import("node:http").ServerResponse} res @param {string} location */
export function redirect(res, location) {
    res.writeHead(303, { ...privateHeaders, location });
    res.end();
}
