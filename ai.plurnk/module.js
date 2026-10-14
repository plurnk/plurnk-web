import { readFile } from "node:fs/promises";
import { Knob } from "@plurnk/plurnk-meta";
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
        setup({ credentials }) {
            if (authenticate) registration = credentials.registerClient({ id: CLIENT, redirectPaths: [CALLBACK], scopes: ["agui"] });
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
                const auth = ["/auth/login", CALLBACK, "/auth/logout"].includes(pathname);
                try {
                    if (session !== null && (directory !== null || auth)) {
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
                    if (auth && session !== null) {
                        const expected = pathname === "/auth/logout" ? "POST" : "GET";
                        if (req.method !== expected) {
                            res.setHeader("allow", expected);
                            throw new RequestError(405, "Method not allowed.");
                        }
                        if (pathname === "/auth/login") await session.login(req, res);
                        else if (pathname === CALLBACK) await session.callback(req, res);
                        else session.logout(req, res);
                        return;
                    }
                    if (directory !== null) {
                        if (req.method !== "GET" && req.method !== "HEAD") {
                            res.setHeader("allow", "GET, HEAD");
                            throw new RequestError(405, "Method not allowed.");
                        }
                        if (session !== null && !session.admitted(req)) {
                            redirect(res, `/auth/login?${new URLSearchParams({ return: req.url ?? "/~/" })}`);
                            return;
                        }
                        const body = await documents.read(directory, seam, session !== null);
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
                    const body = documents.error(error.status, error.message);
                    res.writeHead(error.status, { ...privateHeaders, "content-type": "text/html; charset=utf-8", "content-length": body.byteLength });
                    res.end(req.method === "HEAD" ? undefined : body);
                }
            });
        },
        close() { session?.close(); },
    };
}
