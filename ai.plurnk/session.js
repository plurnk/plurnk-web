import * as oauth from "oauth4webapi";
import { cookie, redirect, RequestError, privateHeaders } from "./http.js";
import { directoryPath, parseDirectory } from "./directory-addresses.js";
import indexDocument from "./index-document.js";

const SESSION = "plurnk_web_session";
const TRANSACTION = "plurnk_web_login";
export const CALLBACK = "/auth/callback";
export const CLIENT = "plurnk-web";

/** @typedef {{ access: string, refresh: string, claims: import("@plurnk/plurnk-contracts").CredentialClaims, refreshing: Promise<void> | null }} Grant */

/** {§web-session} A consumer of the daemon's authority, never an independent issuer or session inventory. */
export default class Session {
    #credentials;
    #client;
    #authenticate;
    #face;
    /** @type {{ server: oauth.AuthorizationServer, options: { [oauth.allowInsecureRequests]: boolean } } | null} */
    #authority = null;
    #limits;
    /** @type {Map<string, { verifier: string, binding: string, target: string, redirectUri: string, expires: number }>} */
    #pending = new Map();
    /** @type {Map<string, Grant>} */
    #grants = new Map();
    #unsubscribe;

    /**
     * @param {import("@plurnk/plurnk-contracts").CredentialAuthority} credentials
     * @param {{ clientId: string, clientSecret: string }} registration
     * @param {import("@plurnk/plurnk-contracts").CredentialFace} face
     * @param {{ ttl: number, pending: number }} limits
     */
    constructor(credentials, registration, face, limits) {
        this.#credentials = credentials;
        this.#client = { client_id: registration.clientId };
        this.#authenticate = oauth.ClientSecretBasic(registration.clientSecret);
        this.#face = face;
        this.#limits = limits;
        this.#unsubscribe = credentials.onRevoked((family) => this.#grants.delete(family));
    }

    /** {§web-session} The daemon's issuer for this request: its configured origin, else the address the browser reached.
     * @param {import("node:http").IncomingMessage} req
     */
    #issuer(req) { return this.#face.issuer(req); }

    // {§web-session} This module's own calls go to the daemon's answer for no request, never to an address a
    // browser named. Discovery is after admission, not module startup: the listener is not serving yet at start.
    async #metadata() {
        if (this.#authority !== null) return this.#authority;
        const issuer = new URL(this.#face.issuer());
        const options = { [oauth.allowInsecureRequests]: issuer.protocol === "http:" };
        const response = await oauth.discoveryRequest(issuer, { ...options, algorithm: "oauth2" });
        this.#authority = { server: await oauth.processDiscoveryResponse(issuer, response), options };
        return this.#authority;
    }

    /** @param {import("node:http").IncomingMessage} req */
    #claims(req) {
        const token = cookie(req, SESSION);
        const claims = token === null ? null : this.#credentials.verify(token);
        return claims?.kind === "session" && claims.clientId === this.#client.client_id && claims.scopes.includes("agui") ? claims : null;
    }

    /** @param {import("node:http").IncomingMessage} req */
    admitted(req) { return this.#claims(req) !== null; }

    /** {§web-account} The authority owns the inventory; the cookie identifies its current family.
     * @param {import("node:http").IncomingMessage} req
     */
    account(req) {
        const claims = this.#claims(req);
        return claims === null ? null : {
            family: claims.family, sessions: this.#credentials.sessions(claims.subject),
        };
    }

    /** @param {import("node:http").IncomingMessage} req */
    #mutation(req) {
        const account = this.account(req);
        if (account === null) throw new RequestError(401, "Sign in again before managing sessions.");
        this.sameOriginForm(req);
        return account;
    }

    /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res @param {string} family */
    revoke(req, res, family) {
        const account = this.#mutation(req);
        if (!account.sessions.some((entry) => entry.family === family)) throw new RequestError(404, "Session not found.");
        if (family === account.family) { this.logout(req, res); return; }
        this.#credentials.revokeFamily(family);
        redirect(res, "/account/sessions/");
    }
    /** {§web-workspace-creation} Module-owned form mutations use the daemon's own origin.
     * @param {import("node:http").IncomingMessage} req
     */
    sameOriginForm(req) {
        if (req.headers.origin !== this.#issuer(req)) throw new RequestError(403, "Same-origin form required.");
    }

    /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
    revokeOthers(req, res) {
        const account = this.#mutation(req);
        for (const entry of account.sessions) if (entry.family !== account.family) this.#credentials.revokeFamily(entry.family);
        redirect(res, "/account/sessions/");
    }

    /** @param {import("node:http").IncomingMessage} req @param {string} name @param {string} value @param {string} path @param {number} ttl */
    #cookie(req, name, value, path, ttl) {
        return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.ceil(ttl))}`
            + (this.#issuer(req).startsWith("https:") ? "; Secure" : "");
    }

    /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
    async login(req, res) {
        const issuer = this.#issuer(req);
        const requested = new URL(req.url ?? "/", issuer).searchParams.get("return") ?? "/~/";
        const directory = parseDirectory(requested);
        const document = indexDocument(requested.split(/[?#]/u)[0]);
        const target = ["/account/index.html", "/account/sessions/index.html"].includes(document) ? document.slice(0, -"index.html".length)
            : directory === null ? null : directoryPath(directory);
        if (target === null) throw new RequestError(400, "Invalid return page.");
        if (this.admitted(req)) { redirect(res, target); return; }
        const { server } = await this.#metadata();
        if (!server.authorization_endpoint) throw new Error("The daemon's authorization metadata omits its authorization endpoint.");

        const state = oauth.generateRandomState();
        const verifier = oauth.generateRandomCodeVerifier();
        const challenge = await oauth.calculatePKCECodeChallenge(verifier);
        const now = Date.now();
        for (const [key, transaction] of this.#pending) if (transaction.expires <= now) this.#pending.delete(key);
        if (this.#pending.size >= this.#limits.pending) throw new RequestError(429, "Too many pending sign-ins. Try again later.");
        const binding = cookie(req, TRANSACTION) ?? oauth.generateRandomState();
        const redirectUri = `${issuer}${CALLBACK}`;
        this.#pending.set(state, { verifier, binding, target, redirectUri, expires: now + this.#limits.ttl * 1000 });
        res.setHeader("set-cookie", this.#cookie(req, TRANSACTION, binding, "/auth", this.#limits.ttl));
        // The browser signs in at the daemon's authorization endpoint on the address it reached.
        const url = new URL(new URL(server.authorization_endpoint).pathname, issuer);
        url.search = new URLSearchParams({
            client_id: this.#client.client_id, redirect_uri: redirectUri,
            response_type: "code", scope: "agui", code_challenge_method: "S256", code_challenge: challenge, state,
        }).toString();
        redirect(res, url.href);
    }

    /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
    async callback(req, res) {
        const url = new URL(req.url ?? "/", this.#issuer(req));
        const state = url.searchParams.get("state") ?? "";
        const transaction = this.#pending.get(state);
        if (transaction === undefined || transaction.expires <= Date.now() || cookie(req, TRANSACTION) !== transaction.binding) {
            throw new RequestError(400, "Sign-in expired or does not belong to this browser. Start sign-in again.");
        }
        this.#pending.delete(state);
        const { server, options } = await this.#metadata();
        let params;
        try {
            params = oauth.validateAuthResponse(server, this.#client, url, state);
        } catch (cause) {
            throw new RequestError(400, "Sign-in was not completed. Start sign-in again.", { cause });
        }
        const response = await oauth.authorizationCodeGrantRequest(server, this.#client, this.#authenticate,
            params, transaction.redirectUri, transaction.verifier, options);
        let result;
        try {
            result = await oauth.processAuthorizationCodeResponse(server, this.#client, response);
        } catch (cause) {
            throw new RequestError(502, "The daemon did not complete sign-in. Start sign-in again.", { cause });
        }
        const grant = this.#grant(result);
        const { claims } = grant;
        const ttlMs = claims.expiresAt - Date.now();
        const issued = this.#credentials.issue({ kind: "session", subject: claims.subject, clientId: claims.clientId,
            scopes: claims.scopes, family: claims.family, ttlMs });
        const old = this.#claims(req);
        if (old !== null && old.family !== claims.family) this.#credentials.revokeFamily(old.family);
        this.#prune();
        this.#grants.set(claims.family, grant);
        res.setHeader("set-cookie", this.#cookie(req, SESSION, issued.token, "/", ttlMs / 1000));
        redirect(res, transaction.target);
    }

    /** @param {oauth.TokenEndpointResponse} result @returns {Grant} */
    #grant(result) {
        const access = this.#credentials.verify(result.access_token);
        const refresh = result.refresh_token === undefined ? null : this.#credentials.verify(result.refresh_token);
        if (access?.kind !== "access" || refresh?.kind !== "refresh" || access.family !== refresh.family
            || access.clientId !== this.#client.client_id || refresh.clientId !== access.clientId
            || access.subject !== refresh.subject || !access.scopes.includes("agui") || !refresh.scopes.includes("agui")) {
            throw new Error("The authorization server returned credentials outside the registered web grant.");
        }
        return { access: result.access_token, refresh: /** @type {string} */ (result.refresh_token), claims: refresh, refreshing: null };
    }

    #prune() {
        for (const [family, grant] of this.#grants) {
            if (grant.refreshing === null && this.#credentials.verify(grant.refresh) === null) this.#grants.delete(family);
        }
    }

    /** @param {Grant} grant */
    async #refresh(grant) {
        const { server, options } = await this.#metadata();
        let result;
        try {
            const response = await oauth.refreshTokenGrantRequest(server, this.#client, this.#authenticate, grant.refresh, options);
            result = await oauth.processRefreshTokenResponse(server, this.#client, response);
        } catch (cause) {
            if (cause instanceof oauth.ResponseBodyError && cause.error === "invalid_grant") {
                this.#credentials.revokeFamily(grant.claims.family);
                throw new RequestError(401, "Sign in again to connect.", { cause });
            }
            throw new RequestError(502, "The daemon could not refresh the connection credential.", { cause });
        }
        // Logout or a later callback must not be undone by an in-flight refresh.
        if (this.#grants.get(grant.claims.family) !== grant) throw new RequestError(401, "Sign in again to connect.");
        const next = this.#grant(result);
        if (next.claims.family !== grant.claims.family || next.claims.subject !== grant.claims.subject) {
            throw new Error("The authorization server changed the web grant during refresh.");
        }
        grant.access = next.access;
        grant.refresh = next.refresh;
        grant.claims = next.claims;
    }

    /** {§web-access-token} Share one standard refresh across concurrent tabs; authority owns validity.
     * @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res
     */
    async token(req, res) {
        const claims = this.#claims(req);
        if (claims === null) throw new RequestError(401, "Sign in again to connect.");
        if (req.headers.origin !== this.#issuer(req)) throw new RequestError(403, "Same-origin request required.");
        this.#prune();
        const grant = this.#grants.get(claims.family);
        if (grant === undefined) throw new RequestError(401, "Sign in again to connect.");
        if (this.#credentials.verify(grant.access) === null) {
            grant.refreshing ??= this.#refresh(grant).finally(() => { grant.refreshing = null; });
            await grant.refreshing;
        }
        const access = this.#credentials.verify(grant.access);
        if (this.#claims(req) === null || this.#grants.get(claims.family) !== grant || access === null) {
            throw new RequestError(401, "Sign in again to connect.");
        }
        const body = Buffer.from(JSON.stringify({ access_token: grant.access, token_type: "Bearer",
            expires_in: Math.max(0, Math.floor((access.expiresAt - Date.now()) / 1000)) }));
        res.writeHead(200, { ...privateHeaders, "content-type": "application/json", "content-length": body.byteLength });
        res.end(body);
    }

    /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
    logout(req, res) {
        this.sameOriginForm(req);
        const claims = this.#claims(req);
        if (claims !== null) this.#credentials.revokeFamily(claims.family);
        res.setHeader("set-cookie", this.#cookie(req, SESSION, "", "/", 0));
        redirect(res, "/");
    }

    close() { this.#pending.clear(); this.#grants.clear(); this.#unsubscribe(); }
}
