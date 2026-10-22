import { readFile } from "node:fs/promises";
import { MIMEType } from "node:util";
import { Knob } from "@plurnk/plurnk-meta";
import { Problems } from "@plurnk/plurnk-contracts";
import indexDocument from "./index-document.js";
import { directoryPath, parseDirectory } from "./directory-addresses.js";
import Documents from "./documents.js";
import Session, { CALLBACK, CLIENT } from "./session.js";
import { privateHeaders, redirect, RequestError } from "./http.js";
import { readAsset, sendAsset } from "./static-assets.js";
import Creations from "./creations.js";
import Diagrams from "./diagrams.js";

// One hidden token field: a UUID is 36 characters; 4 KiB bounds any encoding of it
// with wide margin. Larger bodies are not this native form.
const CREATE_INPUT_BYTES = 4096;
/** @typedef {Pick<import("@plurnk/plurnk-contracts/port").ApplicationPort, "credentials" | "registerHttpRoute" | "listWorkspaces" | "listWorkers" | "createWorkspace" | "renameWorkspace" | "createWorker">} Port */
/** @returns {import("@plurnk/plurnk-modules").DaemonModule<Pick<Port, "credentials">, Port>} */
export default function createModule() {
    if (!Knob.flag("PLURNK_WEB_ENABLED")) return {};
    const yolo = Knob.flag("PLURNK_WEB_YOLO");
    const reasoningPreviewChars = Knob.integer("PLURNK_WEB_REASONING_PREVIEW_CHARS", 1);
    const authenticate = Knob.flag("PLURNK_AUTH");
    const limits = { ttl: Knob.integer("PLURNK_WEB_LOGIN_TTL_SEC", 1), pending: Knob.integer("PLURNK_WEB_LOGIN_PENDING", 1) };
    const creations = new Creations({ ttl: Knob.integer("PLURNK_WEB_CREATE_TTL_SEC", 1), tokens: Knob.integer("PLURNK_WEB_CREATE_TOKENS", 1) });
    const diagrams = new Diagrams();
    /** @type {{ clientId: string, clientSecret: string } | null} */
    let registration = null;
    /** @type {Session | null} */
    let session = null;
    let stopped = false;
    /** @type {Set<Promise<void>>} */
    const requests = new Set();
    const stop = () => { stopped = true; };

    return {
        mounts: ["/"],
        async setup({ credentials }) {
            if (!authenticate) return;
            // {§web-authorization-style} The same built stylesheet serves both document owners.
            /** @type {import("./static-assets.js").AssetEntry[]} */
            const inventory = JSON.parse(await readFile(new URL("assets.json", import.meta.url), "utf8"));
            const root = inventory.find(([path]) => path === "/index.html");
            if (!root) throw new Error("The web asset inventory must include index.html.");
            const stylesheetPath = Documents.stylesheet((await readAsset(root[1], root[2], root[3])).body.toString("utf8"));
            if (!inventory.some(([path, , type]) => path === stylesheetPath && type === "text/css")) throw new Error("The application stylesheet is absent from the web asset inventory.");
            registration = credentials.registerClient({ id: CLIENT, redirectPaths: [CALLBACK], scopes: ["agui"], stylesheetPath });
        },
        async start(seam) {
            if (authenticate) {
                const face = seam.credentials.face();
                if (registration === null || face === null) throw new Error("Web sign-in requires the daemon's credential authority and completed module setup.");
                session = new Session(seam.credentials, registration, face, limits);
            }
            // {§web-assets} Requests select entries, never filesystem paths.
            /** @type {import("./static-assets.js").AssetEntry[]} */
            const inventory = JSON.parse(await readFile(new URL("assets.json", import.meta.url), "utf8"));
            const resources = new Map(await Promise.all(inventory.map(async ([pathname, file, mediaType, encoded]) => /** @type {const} */ ([
                pathname,
                await readAsset(file, mediaType, encoded),
            ]))));

            const root = resources.get("/index.html");
            if (root === undefined) throw new Error("The web asset inventory must include index.html.");
            const documents = new Documents(root.body.toString("utf8"), yolo, reasoningPreviewChars);

            /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
            const serve = async (req, res) => {
                const pathname = (req.url ?? "").split("?")[0];
                const directory = parseDirectory(pathname);
                const home = indexDocument(pathname) === "/index.html";
                const account = indexDocument(pathname) === "/account/index.html";
                const sessions = indexDocument(pathname) === "/account/sessions/index.html";
                const revoke = /^\/account\/sessions\/([^/]+)\/revoke$/u.exec(pathname);
                const others = pathname === "/account/sessions/revoke-others";
                const token = pathname === "/auth/token";
                const creation = pathname === "/workspaces/new";
                const rename = pathname === "/workspaces/rename";
                const workerCreation = pathname === "/workers/new";
                const diagram = pathname === "/render/mermaid";
                const auth = token || ["/auth/login", CALLBACK, "/auth/logout"].includes(pathname);
                let admitted = false;
                try {
                    const inventory = sessions ? session?.account(req) : null;
                    admitted = sessions ? inventory != null : session?.admitted(req) ?? false;
                    if (diagram) {
                        if (session !== null && !admitted) throw new RequestError(401, "Sign in to render diagrams.");
                        await diagrams.serve(req, res);
                        return;
                    }
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
                    if (creation || rename || workerCreation) {
                        const actionName = creation ? "create a workspace" : rename ? "rename a workspace" : "create a worker";
                        if (req.method !== "POST") {
                            res.setHeader("allow", "POST");
                            throw new RequestError(405, `Use POST to ${actionName}.`);
                        }
                        if (session !== null && !admitted) throw new RequestError(401, `Sign in again before ${creation ? "creating a workspace" : rename ? "renaming a workspace" : "creating a worker"}.`);
                        if (session !== null) session.sameOriginForm(req);
                        else {
                            const origin = req.headers.origin;
                            if (typeof origin !== "string") throw new RequestError(403, "Same-origin form required.");
                            let host;
                            try { host = new URL(origin).host; }
                            catch (cause) { throw new RequestError(403, "Same-origin form required.", { cause }); }
                            if (host !== req.headers.host) throw new RequestError(403, "Same-origin form required.");
                            if (req.headers["sec-fetch-site"] !== undefined && req.headers["sec-fetch-site"] !== "same-origin") {
                                throw new RequestError(403, "Same-origin form required.");
                            }
                        }
                        let type;
                        try { type = new MIMEType(req.headers["content-type"] ?? ""); }
                        catch (cause) { throw new RequestError(415, "Use UTF-8 application/x-www-form-urlencoded.", { cause }); }
                        if (type.essence !== "application/x-www-form-urlencoded"
                            || (type.params.has("charset") && type.params.get("charset")?.toLowerCase() !== "utf-8")) {
                            throw new RequestError(415, "Use UTF-8 application/x-www-form-urlencoded.");
                        }
                        let size = 0;
                        const chunks = [];
                        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
                            size += chunk.byteLength;
                            if (size > CREATE_INPUT_BYTES) { req.resume(); throw new RequestError(413, "Form exceeds its bound."); }
                            chunks.push(chunk);
                        }
                        let fields;
                        try { fields = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
                        catch (cause) { throw new RequestError(400, "Invalid form data.", { cause }); }
                        if (creation) {
                            const formToken = fields.get("token");
                            if (!formToken) throw new RequestError(400, "Expected the form's workspace creation token.");
                            const customName = fields.get("name")?.trim();
                            redirect(res, await creations.submit(formToken, () => seam.createWorkspace({ ...(customName ? { name: customName } : {}), projectRoot: null })));
                            return;
                        }
                        if (rename) {
                            const targetName = fields.get("workspace");
                            const newName = fields.get("name")?.trim();
                            if (!targetName || !newName) throw new RequestError(400, "Expected current workspace and new name.");
                            const workspaces = await seam.listWorkspaces();
                            const ws = workspaces.find(({ name }) => name === targetName);
                            if (!ws) throw new RequestError(404, "Workspace not found.");
                            let renamed;
                            try { renamed = await seam.renameWorkspace(ws.id, newName); }
                            catch (cause) { throw new RequestError(502, "The daemon could not rename the workspace.", { cause }); }
                            const path = directoryPath({ kind: "workspace", workspace: renamed.name });
                            if (path === null) throw new Error("The daemon returned a workspace name without a directory address.");
                            redirect(res, path);
                            return;
                        }
                        if (workerCreation) {
                            const formToken = fields.get("token");
                            const targetName = fields.get("workspace");
                            if (!formToken || !targetName) throw new RequestError(400, "Expected worker creation token and workspace name.");
                            const workerName = fields.get("name")?.trim();
                            const workspaces = await seam.listWorkspaces();
                            const ws = workspaces.find(({ name }) => name === targetName);
                            if (!ws) throw new RequestError(404, "Workspace not found.");
                            redirect(res, await creations.submit(formToken, async () => {
                                let createdWorker;
                                try { createdWorker = await seam.createWorker({ workspaceId: ws.id, ...(workerName ? { name: workerName } : {}) }); }
                                catch (cause) { throw new RequestError(502, "The daemon could not create the worker.", { cause }); }
                                const path = directoryPath({ kind: "worker", workspace: ws.name, worker: createdWorker.workerName });
                                if (path === null) throw new Error("The daemon returned a worker name without a directory address.");
                                return path;
                            }));
                            return;
                        }
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
                    sendAsset(req, res, resource);
                } catch (error) {
                    if (!(error instanceof RequestError)) throw error;
                    const body = token || diagram ? Buffer.from(JSON.stringify(Problems.create("web", diagram ? "diagram-request-rejected" : "token-request-rejected", error.status, error.message)))
                        : documents.error(error.status, error.message, admitted);
                    res.writeHead(error.status, { ...privateHeaders, "content-type": token || diagram ? "application/problem+json" : "text/html; charset=utf-8", "content-length": body.byteLength });
                    res.end(req.method === "HEAD" ? undefined : body);
                } finally {
                    if (diagram) req.resume();
                }
            };

            // {§web-route-settlement} Every admitted handler retains its host resources until settlement.
            seam.registerHttpRoute("/", async (req, res) => {
                if (stopped) {
                    const body = Buffer.from(JSON.stringify(Problems.create("web", "service-stopping", 503, "The PLURNK service is shutting down.")));
                    res.writeHead(503, { ...privateHeaders, "content-type": "application/problem+json", "content-length": body.byteLength });
                    res.end(req.method === "HEAD" ? undefined : body);
                    req.resume();
                    return;
                }
                const request = serve(req, res);
                requests.add(request);
                try { await request; }
                finally { requests.delete(request); }
            });
        },
        stop,
        async close() {
            stop();
            const cleanup = new AsyncDisposableStack();
            cleanup.defer(() => session?.close());
            cleanup.defer(async () => { await Promise.allSettled(requests); });
            cleanup.defer(() => diagrams.close());
            await cleanup.disposeAsync();
        },
    };
}
