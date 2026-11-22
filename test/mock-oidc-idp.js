import { once } from "node:events";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";

/**
 * Minimal real ES256 OIDC Identity Provider for end-to-end browser PKCE + JWKS daemon verification.
 * @param {{
 *   clientId?: string,
 *   accessTtlSec?: number,
 *   autoApprove?: boolean,
 * }} [options]
 */
export default async function startMockOidcIdp({
    clientId = "web-client",
    accessTtlSec = 300,
    autoApprove = false,
} = {}) {
    const kid = "mock-oidc-p256-1";
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const publicJwk = {
        ...publicKey.export({ format: "jwk" }),
        kid,
        alg: "ES256",
        use: "sig",
    };

    /** @type {Map<string, { codeChallenge: string, redirectUri: string, clientId: string, scope: string, expiresAt: number }>} */
    const authorizationCodes = new Map();
    /** @type {Map<string, { sub: string, scope: string, revoked: boolean }>} */
    const refreshTokens = new Map();
    /** @type {string[]} */
    const requests = [];
    let issuer = "";

    const corsHeaders = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization",
        "cache-control": "no-store",
    };

    /**
     * @param {{ sub?: string, scope?: string, ttlSec?: number }} [claims]
     */
    function mintToken({ sub = "operator", scope = "openid profile email", ttlSec = accessTtlSec } = {}) {
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", kid })).toString("base64url");
        const payload = Buffer.from(JSON.stringify({
            iss: issuer,
            sub,
            aud: clientId,
            client_id: clientId,
            scope,
            iat: now,
            exp: now + ttlSec,
            jti: randomUUID(),
        })).toString("base64url");
        const signingInput = `${header}.${payload}`;
        const signature = sign("sha256", Buffer.from(signingInput), {
            key: privateKey,
            dsaEncoding: "ieee-p1363",
        }).toString("base64url");
        return `${signingInput}.${signature}`;
    }

    /**
     * @param {string} redirectUri
     * @param {string} state
     * @param {string} codeChallenge
     * @param {string} reqClientId
     * @param {string} scope
     */
    function issueAuthorizationRedirect(redirectUri, state, codeChallenge, reqClientId, scope) {
        const code = randomBytes(24).toString("base64url");
        authorizationCodes.set(code, {
            codeChallenge,
            redirectUri,
            clientId: reqClientId,
            scope,
            expiresAt: Date.now() + 60_000,
        });
        const dest = new URL(redirectUri);
        dest.searchParams.set("code", code);
        if (state) dest.searchParams.set("state", state);
        return dest.href;
    }

    const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", issuer || "http://127.0.0.1");
        requests.push(`${req.method} ${url.pathname}`);

        if (req.method === "OPTIONS") {
            res.writeHead(204, corsHeaders);
            res.end();
            return;
        }

        if (req.method === "GET" && (url.pathname === "/.well-known/openid-configuration" || url.pathname === "/.well-known/oauth-authorization-server")) {
            res.writeHead(200, { ...corsHeaders, "content-type": "application/json" });
            res.end(JSON.stringify({
                issuer,
                authorization_endpoint: `${issuer}/authorize`,
                token_endpoint: `${issuer}/token`,
                jwks_uri: `${issuer}/jwks`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                code_challenge_methods_supported: ["S256"],
                scopes_supported: ["openid", "profile", "email"],
            }));
            return;
        }

        if (req.method === "GET" && url.pathname === "/jwks") {
            res.writeHead(200, { ...corsHeaders, "content-type": "application/json" });
            res.end(JSON.stringify({ keys: [publicJwk] }));
            return;
        }

        if (url.pathname === "/authorize" && req.method === "GET") {
            const responseType = url.searchParams.get("response_type");
            const reqClientId = url.searchParams.get("client_id") ?? "";
            const redirectUri = url.searchParams.get("redirect_uri") ?? "";
            const codeChallenge = url.searchParams.get("code_challenge") ?? "";
            const challengeMethod = url.searchParams.get("code_challenge_method") ?? "";
            const state = url.searchParams.get("state") ?? "";
            const scope = url.searchParams.get("scope") ?? "openid profile email";

            if (responseType !== "code" || reqClientId !== clientId || !redirectUri || !codeChallenge || challengeMethod !== "S256") {
                res.writeHead(400, { ...corsHeaders, "content-type": "text/plain; charset=utf-8" });
                res.end("Invalid OIDC authorization request.");
                return;
            }

            if (autoApprove) {
                const location = issueAuthorizationRedirect(redirectUri, state, codeChallenge, reqClientId, scope);
                res.writeHead(303, { ...corsHeaders, location });
                res.end();
                return;
            }

            const escape = (/** @type {string} */ s) =>
                s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
            const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Mock OIDC Sign in</title></head>"
                + "<body><main><h1>Sign in</h1>"
                + "<form method=\"post\" action=\"/authorize\">"
                + `<input type="hidden" name="client_id" value="${escape(reqClientId)}">`
                + `<input type="hidden" name="redirect_uri" value="${escape(redirectUri)}">`
                + `<input type="hidden" name="code_challenge" value="${escape(codeChallenge)}">`
                + `<input type="hidden" name="state" value="${escape(state)}">`
                + `<input type="hidden" name="scope" value="${escape(scope)}">`
                + "<button type=\"submit\">Continue</button>"
                + "</form></main></body></html>";
            res.writeHead(200, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
            res.end(html);
            return;
        }

        if (url.pathname === "/authorize" && req.method === "POST") {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
            const reqClientId = params.get("client_id") ?? "";
            const redirectUri = params.get("redirect_uri") ?? "";
            const codeChallenge = params.get("code_challenge") ?? "";
            const state = params.get("state") ?? "";
            const scope = params.get("scope") ?? "openid profile email";
            if (reqClientId !== clientId || !redirectUri || !codeChallenge) {
                res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
                res.end("Invalid authorization form submission.");
                return;
            }
            const location = issueAuthorizationRedirect(redirectUri, state, codeChallenge, reqClientId, scope);
            res.writeHead(303, { "cache-control": "no-store", location });
            res.end();
            return;
        }

        if (url.pathname === "/token" && req.method === "POST") {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
            const grantType = params.get("grant_type");

            if (grantType === "authorization_code") {
                const code = params.get("code") ?? "";
                const verifier = params.get("code_verifier") ?? "";
                const redirectUri = params.get("redirect_uri") ?? "";
                const reqClientId = params.get("client_id") ?? "";
                const stored = authorizationCodes.get(code);
                authorizationCodes.delete(code);

                if (!stored || stored.expiresAt < Date.now() || stored.clientId !== reqClientId || stored.redirectUri !== redirectUri || !verifier) {
                    res.writeHead(400, { ...corsHeaders, "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "invalid_grant" }));
                    return;
                }
                const computedChallenge = createHash("sha256").update(verifier).digest("base64url");
                if (computedChallenge !== stored.codeChallenge) {
                    res.writeHead(400, { ...corsHeaders, "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "invalid_grant", error_description: "PKCE verification failed" }));
                    return;
                }
                const accessToken = mintToken({ scope: stored.scope });
                const refreshToken = randomBytes(24).toString("base64url");
                refreshTokens.set(refreshToken, { sub: "operator", scope: stored.scope, revoked: false });
                res.writeHead(200, { ...corsHeaders, "content-type": "application/json" });
                res.end(JSON.stringify({
                    token_type: "Bearer",
                    access_token: accessToken,
                    id_token: accessToken,
                    refresh_token: refreshToken,
                    expires_in: accessTtlSec,
                }));
                return;
            }

            if (grantType === "refresh_token") {
                const incomingRefresh = params.get("refresh_token") ?? "";
                const record = refreshTokens.get(incomingRefresh);
                if (!record || record.revoked) {
                    res.writeHead(400, { ...corsHeaders, "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "invalid_grant" }));
                    return;
                }
                refreshTokens.delete(incomingRefresh);
                const nextRefresh = randomBytes(24).toString("base64url");
                refreshTokens.set(nextRefresh, { ...record });
                const accessToken = mintToken({ sub: record.sub, scope: record.scope });
                res.writeHead(200, { ...corsHeaders, "content-type": "application/json" });
                res.end(JSON.stringify({
                    token_type: "Bearer",
                    access_token: accessToken,
                    id_token: accessToken,
                    refresh_token: nextRefresh,
                    expires_in: accessTtlSec,
                }));
                return;
            }

            res.writeHead(400, { ...corsHeaders, "content-type": "application/json" });
            res.end(JSON.stringify({ error: "unsupported_grant_type" }));
            return;
        }

        res.writeHead(404, { ...corsHeaders, "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = /** @type {import("node:net").AddressInfo} */ (server.address());
    issuer = `http://127.0.0.1:${address.port}`;

    return {
        issuer,
        clientId,
        requests,
        env: {
            PLURNK_AUTH_ISSUER: issuer,
            PLURNK_AUTH_CLIENT_ID: clientId,
        },
        mintToken,
        revokeAllRefreshTokens() {
            for (const entry of refreshTokens.values()) entry.revoked = true;
        },
        async close() {
            const closed = once(server, "close");
            server.close();
            server.closeAllConnections();
            await closed;
        },
    };
}
