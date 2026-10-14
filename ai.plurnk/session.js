import * as oauth from "oauth4webapi";
import { cookie, redirect, RequestError } from "./http.js";
import { directoryPath, parseDirectory } from "./directory-addresses.js";
import indexDocument from "./index-document.js";

const SESSION = "plurnk_web_session";
const TRANSACTION = "plurnk_web_login";
export const CALLBACK = "/auth/callback";
export const CLIENT = "plurnk-web";

/** {§web-session} A consumer of the daemon's authority; only OAuth transactions live here. */
export default class Session {
    #credentials;
    #client;
    #authenticate;
    #issuer;
    /** @type {oauth.AuthorizationServer | null} */
    #server = null;
    #options;
    #limits;
    /** @type {Map<string, { verifier: string, binding: string, target: string, expires: number }>} */
    #pending = new Map();

    /**
     * @param {import("@plurnk/plurnk-contracts").CredentialAuthority} credentials
     * @param {{ clientId: string, clientSecret: string }} registration
     * @param {string} issuer
     * @param {{ ttl: number, pending: number }} limits
     */
    constructor(credentials, registration, issuer, limits) {
        this.#credentials = credentials;
        this.#client = { client_id: registration.clientId };
        this.#authenticate = oauth.ClientSecretBasic(registration.clientSecret);
        this.#issuer = issuer;
        // The daemon's declared issuer, including its normal HTTP loopback listener, owns transport.
        this.#options = { [oauth.allowInsecureRequests]: new URL(issuer).protocol === "http:" };
        this.#limits = limits;
    }

    get issuer() { return this.#issuer; }

    async #metadata() {
        if (this.#server !== null) return this.#server;
        // Discovery is after admission, not module startup: the listener is not serving yet at start.
        const issuer = new URL(this.issuer);
        const response = await oauth.discoveryRequest(issuer, { ...this.#options, algorithm: "oauth2" });
        this.#server = await oauth.processDiscoveryResponse(issuer, response);
        return this.#server;
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
        if (req.headers.origin !== this.issuer) throw new RequestError(403, "Same-origin form required.");
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

    /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
    revokeOthers(req, res) {
        const account = this.#mutation(req);
        for (const entry of account.sessions) if (entry.family !== account.family) this.#credentials.revokeFamily(entry.family);
        redirect(res, "/account/sessions/");
    }

    /** @param {string} name @param {string} value @param {string} path @param {number} ttl */
    #cookie(name, value, path, ttl) {
        return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.ceil(ttl))}`
            + (this.issuer.startsWith("https:") ? "; Secure" : "");
    }

    /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
    async login(req, res) {
        const requested = new URL(req.url ?? "/", this.issuer).searchParams.get("return") ?? "/~/";
        const directory = parseDirectory(requested);
        const document = indexDocument(requested.split(/[?#]/u)[0]);
        const target = ["/account/index.html", "/account/sessions/index.html"].includes(document) ? document.slice(0, -"index.html".length)
            : directory === null ? null : directoryPath(directory);
        if (target === null) throw new RequestError(400, "Invalid return page.");
        if (this.admitted(req)) { redirect(res, target); return; }
        const server = await this.#metadata();
        if (!server.authorization_endpoint) throw new Error("The daemon's authorization metadata omits its authorization endpoint.");

        const state = oauth.generateRandomState();
        const verifier = oauth.generateRandomCodeVerifier();
        const challenge = await oauth.calculatePKCECodeChallenge(verifier);
        const now = Date.now();
        for (const [key, transaction] of this.#pending) if (transaction.expires <= now) this.#pending.delete(key);
        if (this.#pending.size >= this.#limits.pending) throw new RequestError(429, "Too many pending sign-ins. Try again later.");
        const binding = cookie(req, TRANSACTION) ?? oauth.generateRandomState();
        this.#pending.set(state, { verifier, binding, target, expires: now + this.#limits.ttl * 1000 });
        res.setHeader("set-cookie", this.#cookie(TRANSACTION, binding, "/auth", this.#limits.ttl));
        const url = new URL(server.authorization_endpoint);
        url.search = new URLSearchParams({
            client_id: this.#client.client_id, redirect_uri: `${this.issuer}${CALLBACK}`,
            response_type: "code", scope: "agui", code_challenge_method: "S256", code_challenge: challenge, state,
        }).toString();
        redirect(res, url.href);
    }

    /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
    async callback(req, res) {
        const url = new URL(req.url ?? "/", this.issuer);
        const state = url.searchParams.get("state") ?? "";
        const transaction = this.#pending.get(state);
        if (transaction === undefined || transaction.expires <= Date.now() || cookie(req, TRANSACTION) !== transaction.binding) {
            throw new RequestError(400, "Sign-in expired or does not belong to this browser. Start sign-in again.");
        }
        this.#pending.delete(state);
        const server = await this.#metadata();
        let params;
        try {
            params = oauth.validateAuthResponse(server, this.#client, url, state);
        } catch (cause) {
            throw new RequestError(400, "Sign-in was not completed. Start sign-in again.", { cause });
        }
        const response = await oauth.authorizationCodeGrantRequest(server, this.#client, this.#authenticate,
            params, `${this.issuer}${CALLBACK}`, transaction.verifier, this.#options);
        let result;
        try {
            result = await oauth.processAuthorizationCodeResponse(server, this.#client, response);
        } catch (cause) {
            throw new RequestError(502, "The daemon did not complete sign-in. Start sign-in again.", { cause });
        }
        const access = this.#credentials.verify(result.access_token);
        const refresh = result.refresh_token === undefined ? null : this.#credentials.verify(result.refresh_token);
        if (access?.kind !== "access" || refresh?.kind !== "refresh" || access.family !== refresh.family
            || access.clientId !== this.#client.client_id || refresh.clientId !== access.clientId
            || access.subject !== refresh.subject || !access.scopes.includes("agui")) {
            throw new Error("The authorization server returned credentials outside the registered web grant.");
        }
        const ttlMs = refresh.expiresAt - Date.now();
        const issued = this.#credentials.issue({ kind: "session", subject: access.subject, clientId: access.clientId,
            scopes: access.scopes, family: access.family, ttlMs });
        const old = this.#claims(req);
        if (old !== null && old.family !== access.family) this.#credentials.revokeFamily(old.family);
        res.setHeader("set-cookie", this.#cookie(SESSION, issued.token, "/", ttlMs / 1000));
        redirect(res, transaction.target);
    }

    /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
    logout(req, res) {
        if (req.headers.origin !== this.issuer) throw new RequestError(403, "Same-origin form required.");
        const claims = this.#claims(req);
        if (claims !== null) this.#credentials.revokeFamily(claims.family);
        res.setHeader("set-cookie", this.#cookie(SESSION, "", "/", 0));
        redirect(res, "/");
    }

    close() { this.#pending.clear(); }
}
