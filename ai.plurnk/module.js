import { readFile } from "node:fs/promises";
import { MIMEType } from "node:util";
import { Knob } from "@plurnk/plurnk-meta";
import { Problems } from "@plurnk/plurnk-contracts";
import indexDocument from "./index-document.js";
import { directoryPath, parseDirectory } from "./directory-addresses.js";
import Documents from "./documents.js";
import Session, { CALLBACK, CLIENT } from "./session.js";
import { ownNavigation, privateHeaders, redirect, refusal, RequestError, sameOriginFetch } from "./http.js";
import { readAsset, sendAsset } from "./static-assets.js";
import Creations from "./creations.js";
import Diagrams from "./diagrams.js";

/** @typedef {Pick<import("@plurnk/plurnk-contracts/port").ApplicationPort, "credentials" | "registerHttpRoute" | "listWorkspaces" | "listWorkers" | "createWorkspace" | "renameWorkspace" | "createWorker" | "setWorkspaceHidden" | "setWorkerHidden">} Port */
/** @returns {import("@plurnk/plurnk-modules").DaemonModule<Pick<Port, "credentials">, Port>} */
export default function createModule() {
    if (!Knob.flag("PLURNK_WEB_ENABLED")) return {};
    const yolo = Knob.flag("PLURNK_WEB_YOLO");
    const reasoningPreviewChars = Knob.integer("PLURNK_WEB_REASONING_PREVIEW_CHARS", 1);
    const authenticate = Knob.flag("PLURNK_AUTH");
    const limits = { ttl: Knob.integer("PLURNK_WEB_LOGIN_TTL_SEC", 1) };
    const formBytes = Knob.integer("PLURNK_WEB_FORM_BYTES", 1);
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
            registration = credentials.registerClient({ id: CLIENT, redirectPaths: [CALLBACK], scopes: ["acp"], stylesheetPath });
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
                const workspaceHide = pathname === "/workspaces/hide";
                const workerHide = pathname === "/workers/hide";
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
                    if (creation || rename || workerCreation || workspaceHide || workerHide) {
                        const actionName = creation ? "create a workspace" : rename ? "rename a workspace" : workerCreation ? "create a worker" : workspaceHide ? "hide a workspace" : "hide a worker";
                        if (req.method !== "POST") {
                            res.setHeader("allow", "POST");
                            throw new RequestError(405, `Use POST to ${actionName}.`);
                        }
                        if (session !== null && !admitted) throw new RequestError(401, `Sign in again before ${actionName}.`);
                        if (session !== null) session.sameOriginForm(req);
                        else {
                            const origin = req.headers.origin;
                            if (typeof origin !== "string") throw new RequestError(403, "Same-origin form required.");
                            let host;
                            try { host = new URL(origin).host; }
                            catch (cause) { throw new RequestError(403, "Same-origin form required.", { cause }); }
                            if (host !== req.headers.host) throw new RequestError(403, "Same-origin form required.");
                            sameOriginFetch(req);
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
                            if (size > formBytes) { req.resume(); throw new RequestError(413, "Form exceeds its bound."); }
                            chunks.push(chunk);
                        }
                        let fields;
                        try { fields = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
                        catch (cause) { throw new RequestError(400, "Invalid form data.", { cause }); }
                        if (creation) {
                            const formToken = fields.getAll("token").length === 1 ? fields.get("token") : null;
                            if (!formToken) throw new RequestError(400, "Expected the form's workspace creation token.");
                            // An empty name is no name: the daemon names the workspace.
                            const name = fields.get("name") ?? "";
                            redirect(res, await creations.submit(formToken, async () => {
                                try { return await seam.createWorkspace({ ...(name === "" ? {} : { name }), projectRoot: null }); }
                                catch (cause) { throw refusal(cause, "The daemon could not create the workspace.", documents.retryCreation(name)); }
                            }));
                            return;
                        }
                        if (rename) {
                            const targetName = fields.get("workspace");
                            const newName = fields.get("name");
                            if (!targetName || !newName) throw new RequestError(400, "Expected current workspace and new name.");
                            const workspaces = await seam.listWorkspaces();
                            const ws = workspaces.find(({ name }) => name === targetName);
                            if (!ws) throw new RequestError(404, "Workspace not found.");
                            let renamed;
                            try { renamed = await seam.renameWorkspace(ws.id, newName); }
                            catch (cause) { throw refusal(cause, "The daemon could not rename the workspace.", documents.retryRename(ws.name, newName)); }
                            const path = directoryPath({ kind: "workspace", workspace: renamed.name });
                            if (path === null) throw new Error("The daemon returned a workspace name without a directory address.");
                            redirect(res, path);
                            return;
                        }
                        if (workerCreation) {
                            const formToken = fields.getAll("token").length === 1 ? fields.get("token") : null;
                            const targetName = fields.get("workspace");
                            if (!formToken || !targetName) throw new RequestError(400, "Expected worker creation token and workspace name.");
                            // An empty name is no name: the daemon names the worker.
                            const workerName = fields.get("name") ?? "";
                            const workspaces = await seam.listWorkspaces();
                            const ws = workspaces.find(({ name }) => name === targetName);
                            if (!ws) throw new RequestError(404, "Workspace not found.");
                            redirect(res, await creations.submit(formToken, async () => {
                                let createdWorker;
                                try { createdWorker = await seam.createWorker({ workspaceId: ws.id, ...(workerName === "" ? {} : { name: workerName }) }); }
                                catch (cause) { throw refusal(cause, "The daemon could not create the worker.", documents.retryWorker(ws.name, workerName)); }
                                // An internal fault, not a refusal: the worker exists.
                                const path = directoryPath({ kind: "worker", workspace: ws.name, worker: createdWorker.workerName });
                                if (path === null) throw new Error("The daemon returned a worker name without a directory address.");
                                return path;
                            }));
                            return;
                        }
                        if (workspaceHide) {
                            const targetName = fields.get("workspace");
                            if (!targetName) throw new RequestError(400, "Expected workspace name.");
                            const workspaces = await seam.listWorkspaces();
                            const ws = workspaces.find(({ name }) => name === targetName);
                            if (!ws) throw new RequestError(404, "Workspace not found.");
                            try { await seam.setWorkspaceHidden({ workspaceId: ws.id, hidden: true }); }
                            catch (cause) { throw refusal(cause, "The daemon could not hide the workspace."); }
                            redirect(res, "/~/");
                            return;
                        }
                        if (workerHide) {
                            const targetName = fields.get("workspace");
                            const targetWorker = fields.get("worker");
                            if (!targetName || !targetWorker) throw new RequestError(400, "Expected workspace and worker name.");
                            const workspaces = await seam.listWorkspaces();
                            const ws = workspaces.find(({ name }) => name === targetName);
                            if (!ws) throw new RequestError(404, "Workspace not found.");
                            const workers = await seam.listWorkers(ws.id);
                            const worker = workers.find(({ name }) => name === targetWorker);
                            if (!worker) throw new RequestError(404, "Worker not found.");
                            try { await seam.setWorkerHidden({ workspaceId: ws.id, workerId: worker.id, hidden: true }); }
                            catch (cause) { throw refusal(cause, "The daemon could not hide the worker."); }
                            const path = directoryPath({ kind: "workspace", workspace: ws.name });
                            if (path === null) throw new Error("The daemon returned a workspace name without a directory address.");
                            redirect(res, path);
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
                            redirect(res, session.signIn(req, req.url ?? "/~/"));
                            return;
                        }
                        const body = home ? documents.home(admitted) : account ? documents.account() : inventory ? documents.sessions(inventory)
                            : directory === null ? null : await documents.read(directory, seam, admitted, ownNavigation(req));
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
                        : documents.error(error.status, error.message, admitted, { recovery: error.recovery, retry: error.retry });
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
