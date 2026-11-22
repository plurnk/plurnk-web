import { ensureValidAccessToken } from "./oidc.js";

/**
 * {§web-oidc} Resolve `Authorization: Bearer <accessToken>` headers from the browser OIDC grant.
 * When `localStorage` holds no grant for `acpOrigin()`, returns `{}` immediately with zero network preflight.
 * @param {AbortSignal} [signal]
 * @returns {Promise<Record<string, string>>}
 */
export default async function accessHeaders(signal) {
    signal?.throwIfAborted();
    const token = await ensureValidAccessToken(signal);
    signal?.throwIfAborted();
    return token === null ? {} : { Authorization: `Bearer ${token}` };
}
