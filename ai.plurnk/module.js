import { readFile } from "node:fs/promises";
import { Knob } from "@plurnk/plurnk-meta";
import { Problems } from "@plurnk/plurnk-contracts";
import indexDocument from "./index-document.js";
import { parseDirectory } from "./directory-addresses.js";
import Documents from "./documents.js";
import Session, { CALLBACK, CLIENT } from "./session.js";
import { privateHeaders, redirect, RequestError } from "./http.js";

/** @typedef {Pick<import("@plurnk/plurnk-contracts").ApplicationPort, "credentials" | "registerHttpRoute" | "listWorkspaces" | "listWorkers">} Port */
/** @returns {import("@plurnk/plurnk-modules").DaemonModule<Pick<Port, "credentials">, Port>} */
export default function createModule() {
    if (!Knob.flag("PLURNK_WEB_ENABLED")) return {};
    const authenticate = Knob.flag("PLURNK_AUTH");
    const limits = { ttl: Knob.integer("PLURNK_WEB_LOGIN_TTL_SEC", 1), pending: Knob.integer("PLURNK_WEB_LOGIN_PENDING", 1) };
    /** @type {{ clientId: string, clientSecret: string } | null} */
    let registration = null;
    /** @type {Session | null} */
    let session = null;

    return {
        mounts: ["/"],
        async setup({ credentials }) {
            if (!authenticate) return;
            // {§web-authorization-style} The same built stylesheet serves both document owners.
            /** @type {[string, string, string][]} */
            const inventory = JSON.parse(await readFile(new URL("assets.json", import.meta.url), "utf8"));
            const stylesheets = inventory.filter(([, , mediaType]) => mediaType === "text/css");
            if (stylesheets.length !== 1) throw new Error("The web asset inventory must contain exactly one application stylesheet.");
            registration = credentials.registerClient({ id: CLIENT, redirectPaths: [CALLBACK], scopes: ["agui"], stylesheetPath: stylesheets[0][0] });
        },
        async start(seam) {
            if (authenticate) {
                const face = seam.credentials.face();
                if (registration === null || face === null) throw new Error("Web sign-in requires the daemon's credential authority and completed module setup.");
                session = new Session(seam.credentials, registration, face.issuer(), limits);
            }
            // {§web-assets} Requests select entries, never filesystem paths.
            /** @type {[string, string, string][]} */
            const inventory = JSON.parse(await readFile(new URL("assets.json", import.meta.url), "utf8"));
            const resources = new Map(await Promise.all(inventory.map(async ([pathname, file, mediaType]) => /** @type {const} */ ([
                pathname,
                { body: await readFile(new URL(`dist/${file}`, import.meta.url)), mediaType },
            ]))));

            const root = resources.get("/index.html");
            if (root === undefined) throw new Error("The web asset inventory must include index.html.");
            const documents = new Documents(root.body.toString("utf8"));

            seam.registerHttpRoute("/", async (req, res) => {
                const pathname = (req.url ?? "").split("?")[0];
                const directory = parseDirectory(pathname);
                const home = indexDocument(pathname) === "/index.html";
                const account = indexDocument(pathname) === "/account/index.html";
                const sessions = indexDocument(pathname) === "/account/sessions/index.html";
                const revoke = /^\/account\/sessions\/([^/]+)\/revoke$/u.exec(pathname);
                const others = pathname === "/account/sessions/revoke-others";
                const token = pathname === "/auth/token";
                const auth = token || ["/auth/login", CALLBACK, "/auth/logout"].includes(pathname);
                let admitted = false;
                try {
                    if (session !== null && (directory !== null || auth || home || account || sessions || revoke !== null || others)) {
                        const issuer = new URL(session.issuer);
                        // {§web-session} Use the configured public origin, never forwarded headers.
                        const incoming = URL.parse(`${issuer.protocol}//${req.headers.host ?? ""}`);
                        if (incoming === null || incoming.username || incoming.password || incoming.pathname !== "/" || incoming.search || incoming.hash) {
                            throw new RequestError(421, "Use the daemon's configured origin.");
                        }
                        if (incoming.origin !== issuer.origin) {
                            const loopback = incoming !== null && (incoming.hostname === "localhost" || incoming.hostname === "[::1]"
                                || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(incoming.hostname));
                            if (loopback && (req.method === "GET" || req.method === "HEAD")) { redirect(res, `${issuer.origin}${req.url}`); return; }
                            throw new RequestError(421, "Use the daemon's configured origin.");
                        }
                    }
                    const inventory = sessions ? session?.account(req) : null;
                    admitted = sessions ? inventory != null : session?.admitted(req) ?? false;
                    if (token && session === null) throw new RequestError(404, "Access credentials are unavailable while authentication is disabled.");
                    if (auth && session !== null) {
                        const expected = token || pathname === "/auth/logout" ? "POST" : "GET";
                        if (req.method !== expected) {
                            res.setHeader("allow", expected);
                            throw new RequestError(405, "Method not allowed.");
                        }
                        if (pathname === "/auth/login") await session.login(req, res);
                        else if (pathname === CALLBACK) await session.callback(req, res);
                        else if (token) await session.token(req, res);
                        else session.logout(req, res);
                        return;
                    }
                    if (account || sessions || revoke !== null || others) {
                        if (session === null) throw new RequestError(404, "Account is unavailable while authentication is disabled.");
                        if (revoke !== null || others) {
                            if (req.method !== "POST") {
                                res.setHeader("allow", "POST");
                                throw new RequestError(405, "Method not allowed.");
                            }
                            if (others) session.revokeOthers(req, res);
                            else if (revoke !== null) {
                                let family;
                                try { family = decodeURIComponent(revoke[1]); }
                                catch (cause) { throw new RequestError(400, "Invalid session address.", { cause }); }
                                session.revoke(req, res, family);
                            }
                            return;
                        }
                    }
                    if (directory !== null || home || account || sessions) {
                        if (req.method !== "GET" && req.method !== "HEAD") {
                            res.setHeader("allow", "GET, HEAD");
                            throw new RequestError(405, "Method not allowed.");
                        }
                        if (!home && session !== null && !admitted) {
                            redirect(res, `/auth/login?${new URLSearchParams({ return: req.url ?? "/~/" })}`);
                            return;
                        }
                        const body = home ? documents.home(admitted) : account ? documents.account() : inventory ? documents.sessions(inventory)
                            : directory === null ? null : await documents.read(directory, seam, admitted);
                        if (body === null) throw new RequestError(404, "Workspace or worker not found.");
                        res.writeHead(200, { ...privateHeaders, "content-type": "text/html; charset=utf-8", "content-length": body.byteLength });
                        res.end(req.method === "HEAD" ? undefined : body);
                        return;
                    }
                    if (req.method !== "GET" && req.method !== "HEAD") {
                        res.setHeader("allow", "GET, HEAD");
                        throw new RequestError(405, "Use GET or HEAD for this resource.");
                    }
                    const resource = resources.get(indexDocument(pathname));
                    if (resource === undefined) throw new RequestError(404, "The requested page or resource does not exist.");
                    const { body, mediaType } = resource;
                    res.writeHead(200, {
                        "content-type": mediaType.startsWith("image/") ? mediaType : `${mediaType}; charset=utf-8`,
                        "content-length": body.byteLength,
                        "x-content-type-options": "nosniff",
                    });
                    res.end(req.method === "HEAD" ? undefined : body);
                } catch (error) {
                    if (!(error instanceof RequestError)) throw error;
                    const body = token ? Buffer.from(JSON.stringify(Problems.create("web", "token-request-rejected", error.status, error.message)))
                        : documents.error(error.status, error.message, admitted);
                    res.writeHead(error.status, { ...privateHeaders, "content-type": token ? "application/problem+json" : "text/html; charset=utf-8", "content-length": body.byteLength });
                    res.end(req.method === "HEAD" ? undefined : body);
                }
            });
        },
        close() { session?.close(); },
    };
}
