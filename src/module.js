import { readFile } from "node:fs/promises";
import { MIMEType } from "node:util";
import { ConfigurationError, Knob } from "@plurnk/plurnk-meta";
import { Problems } from "@plurnk/plurnk-contracts";
import indexDocument from "./index-document.js";
import { directoryPath, parseDirectory } from "./directory-addresses.js";
import Documents, { isUntouchedDraftSession, orderByReply } from "./documents.js";
import Session, { CALLBACK, CLIENT } from "./session.js";
import {
    clearPlaceCookie,
    formatPlaceCookie,
    ownNavigation,
    privateHeaders,
    readPlaceCookie,
    redirect,
    refusal,
    RequestError,
    sameOriginFetch,
} from "./http.js";
import { readAsset, sendAsset } from "./static-assets.js";
import Creations from "./creations.js";
import Diagrams from "./diagrams.js";

/** @typedef {{ credentials?: Pick<import("@plurnk/plurnk-contracts/port").ApplicationPort["credentials"], "registerClient"> | null }} SetupPort */
/**
 * @typedef {{
 *   credentials?: (import("./session.js").SessionCredentials & Pick<import("@plurnk/plurnk-contracts/port").ApplicationPort["credentials"], "face">) | null,
 *   registerHttpRoute: import("@plurnk/plurnk-contracts/port").ApplicationPort["registerHttpRoute"],
 *   listWorkspaces: () => Promise<readonly import("./documents.js").DirectoryWorkspace[]>,
 *   listSessions: (workspaceId: number) => Promise<readonly import("./documents.js").DirectorySession[]>,
 *   readSessionOverview?: import("@plurnk/plurnk-contracts/port").ApplicationPort["readSessionOverview"],
 *   listSessionLoops?: import("@plurnk/plurnk-contracts/port").ApplicationPort["listSessionLoops"],
 *   setSessionTitle?: import("@plurnk/plurnk-contracts/port").ApplicationPort["setSessionTitle"],
 *   listProviders?: import("@plurnk/plurnk-contracts/port").ApplicationPort["listProviders"],
 *   listModels?: import("@plurnk/plurnk-contracts/port").ApplicationPort["listModels"],
 *   readOperatorEnvironment?: () => Promise<unknown>,
 *   createWorkspace: (args: { name?: string, projectRoot: string | null }) => Promise<{ workspaceId: number, workspaceName: string, projectRoot: string | null }>,
 *   renameWorkspace: (workspaceId: number, name: string) => Promise<{ name: string }>,
 *   createSession: (args: { workspaceId: number, name?: string }) => Promise<{ sessionId: number, sessionName: string }>,
 *   setWorkspaceArchived: (args: { workspaceId: number, archived: boolean }) => Promise<unknown>,
 *   setSessionArchived: (args: { workspaceId: number, sessionId: number, archived: boolean }) => Promise<unknown>,
 * }} Port
 */
/** @typedef {Awaited<ReturnType<typeof readAsset>>} LoadedAsset */
/**
 * @typedef {{
 *   yolo: boolean | null,
 *   overviewSessions: number | null,
 *   overviewExcerptChars: number | null,
 * }} DocumentKnobs
 */
/**
 * @typedef {{
 *   setupStylesheet: () => Promise<string>,
 *   start: (knobs: DocumentKnobs) => Promise<void>,
 *   snapshot: () => Promise<{ documents: Documents, resources: ReadonlyMap<string, LoadedAsset> }>,
 *   close?: () => Promise<void> | void,
 * }} ModuleAssetSource
 */

/** {§web-assets} {§web-authorization-style} @returns {ModuleAssetSource} */
function productionAssets() {
    /** @type {{ documents: Documents, resources: ReadonlyMap<string, LoadedAsset> } | null} */
    let loaded = null;
    return {
        async setupStylesheet() {
            // {§web-authorization-style} The same built stylesheet serves both document owners.
            /** @type {import("./static-assets.js").AssetEntry[]} */
            const inventory = JSON.parse(await readFile(new URL("../dist/assets.json", import.meta.url), "utf8"));
            const root = inventory.find(([path]) => path === "/index.html");
            if (!root) throw new Error("The web asset inventory must include index.html.");
            const stylesheetPath = Documents.stylesheet((await readAsset(root[1], root[2], root[3])).body.toString("utf8"));
            if (!inventory.some(([path, , type]) => path === stylesheetPath && type === "text/css")) throw new Error("The application stylesheet is absent from the web asset inventory.");
            return stylesheetPath;
        },
        async start({ yolo, overviewSessions, overviewExcerptChars }) {
            // {§web-assets} Requests select entries, never filesystem paths.
            /** @type {import("./static-assets.js").AssetEntry[]} */
            const inventory = JSON.parse(await readFile(new URL("../dist/assets.json", import.meta.url), "utf8"));
            const resources = new Map(await Promise.all(inventory.map(async ([pathname, file, mediaType, encoded]) => /** @type {const} */ ([
                pathname,
                await readAsset(file, mediaType, encoded),
            ]))));
            const root = resources.get("/index.html");
            if (root === undefined) throw new Error("The web asset inventory must include index.html.");
            const documents = new Documents(root.body.toString("utf8"), yolo, overviewSessions, overviewExcerptChars);
            loaded = { documents, resources };
        },
        async snapshot() {
            if (loaded === null) throw new Error("Web assets must be loaded before serving requests.");
            return loaded;
        },
    };
}

/** {§web-host} {§web-configuration} {§web-package}
 * @param {ModuleAssetSource} [assets]
 * @returns {import("@plurnk/plurnk-modules").DaemonModule<SetupPort, Port>}
 */
export default function createModule(assets = productionAssets()) {
    /** @type {import("@plurnk/plurnk-modules").ContainedConfiguration[]} */
    const contained = [];
    /** @template T @param {() => T} read @returns {T | null} */
    const contain = (read) => {
        try { return read(); }
        catch (error) {
            if (!(error instanceof ConfigurationError)) throw error;
            contained.push({ key: error.key, message: error.message });
            return null;
        }
    };
    const yolo = contain(() => Knob.flag("PLURNK_WEB_YOLO"));
    const overviewSessions = contain(() => Knob.integer("PLURNK_WEB_OVERVIEW_SESSIONS", 1));
    const overviewExcerptChars = contain(() => Knob.integer("PLURNK_WEB_OVERVIEW_EXCERPT_CHARS", 1));
    const limits = { ttl: contain(() => Knob.integer("PLURNK_WEB_LOGIN_TTL_SEC", 1)) };
    const createTtl = contain(() => Knob.integer("PLURNK_WEB_CREATE_TTL_SEC", 1));
    const createTokens = contain(() => Knob.integer("PLURNK_WEB_CREATE_TOKENS", 1));
    const formBytes = contain(() => Knob.integer("PLURNK_WEB_FORM_BYTES", 1));
    const creations = createTtl !== null && createTokens !== null ? new Creations({ ttl: createTtl, tokens: createTokens }) : null;
    const diagrams = Diagrams.create(contain);
    /** @type {{ clientId: string, clientSecret: string } | null} */
    let registration = null;
    /** @type {Session | null} */
    let session = null;
    let stopped = false;
    /** @type {Set<Promise<void>>} */
    const requests = new Set();
    /** @type {Promise<{ readonly location: string, readonly workspaceId: number, readonly sessionId: number }> | null} */
    let starterFlight = null;
    const stop = () => { stopped = true; };

    return {
        mounts: ["/"],
        contained: Object.freeze(contained),
        async setup({ credentials }) {
            if (!credentials) return;
            const stylesheetPath = await assets.setupStylesheet();
            registration = credentials.registerClient({ id: CLIENT, redirectPaths: [CALLBACK], scopes: ["acp"], stylesheetPath });
        },
        async start(seam) {
            const credentials = seam.credentials;
            const face = credentials?.face() ?? null;
            if (face !== null && credentials) {
                if (registration === null) throw new Error("Web sign-in requires the daemon's credential authority and completed module setup.");
                session = new Session(credentials, registration, face, limits);
            }
            await assets.start({ yolo, overviewSessions, overviewExcerptChars });

            /** @param {import("node:http").IncomingMessage} req */
            const isSecureRequest = (req) => session !== null
                ? session.secure(req)
                : Boolean(req.socket && "encrypted" in req.socket && req.socket.encrypted);

            /**
             * {§web-arrival} Resolve `GET /` in three tiers:
             * 1. This browser's remembered unarchived `<workspaceId>:<sessionId>` cookie;
             * 2. Most recently active unarchived root model session on the daemon;
             * 3. Allocate a single starter `<random-ws>#user` when the daemon holds zero unarchived model sessions.
             * Returns `null` only when `seam` has no workspace creation seam and zero sessions exist (static asset fixture).
             * @param {import("node:http").IncomingMessage} req
             */
            const resolveHomeArrival = async (req) => {
                if (typeof seam.listWorkspaces !== "function" || typeof seam.listSessions !== "function") return null;
                const secure = isSecureRequest(req);
                const remembered = readPlaceCookie(req, secure);
                const workspaces = await seam.listWorkspaces();
                const unarchivedWorkspaces = workspaces.filter(({ archived_at }) => archived_at === null);
                const wsById = new Map(unarchivedWorkspaces.map((ws) => [ws.id, ws]));

                if (remembered !== null) {
                    const ws = wsById.get(remembered.workspaceId);
                    if (ws !== undefined) {
                        const sessions = await seam.listSessions(ws.id);
                        const match = sessions.find(({ id, origin, archived_at }) => id === remembered.sessionId && origin === "model" && archived_at === null);
                        if (match !== undefined) {
                            const loc = directoryPath({ kind: "session", workspace: ws.name, session: match.name });
                            if (loc !== null) return { location: loc, cookie: formatPlaceCookie(ws.id, match.id, secure) };
                        }
                    }
                }

                if (typeof seam.readSessionOverview === "function" && overviewSessions !== null && overviewExcerptChars !== null) {
                    const overview = await seam.readSessionOverview({ limit: Number.MAX_SAFE_INTEGER, excerptChars: overviewExcerptChars });
                    const unarchivedOverview = overview.sessions.filter((entry) => wsById.has(entry.workspaceId));
                    const childParents = new Set(unarchivedOverview.flatMap(({ parentSessionId }) => parentSessionId === null ? [] : [parentSessionId]));
                    const nonDraft = unarchivedOverview.filter((entry) => !isUntouchedDraftSession(entry, childParents.has(entry.id)));
                    const pool = nonDraft.length > 0 ? nonDraft : unarchivedOverview;
                    const roots = pool.filter(({ parentSessionId }) => parentSessionId === null).toSorted(orderByReply);
                    const chosen = roots[0] ?? pool.toSorted(orderByReply)[0];
                    if (chosen !== undefined) {
                        const ws = wsById.get(chosen.workspaceId);
                        if (ws !== undefined) {
                            const loc = directoryPath({ kind: "session", workspace: ws.name, session: chosen.name });
                            if (loc !== null) return { location: loc, cookie: formatPlaceCookie(ws.id, chosen.id, secure) };
                        }
                    }
                }

                /** @type {Array<{ readonly ws: (typeof unarchivedWorkspaces)[number], readonly session: Awaited<ReturnType<NonNullable<typeof seam.listSessions>>>[number], readonly hasChildren: boolean }>} */
                const allCandidates = [];
                for (const ws of unarchivedWorkspaces) {
                    const sessions = await seam.listSessions(ws.id);
                    const modelUnarchived = sessions.filter((s) => s.origin === "model" && s.archived_at === null);
                    const childParents = new Set(modelUnarchived.flatMap(({ parentSessionId }) => parentSessionId === null ? [] : [parentSessionId]));
                    for (const session of modelUnarchived) {
                        allCandidates.push({ ws, session, hasChildren: childParents.has(session.id) });
                    }
                }
                if (allCandidates.length > 0) {
                    allCandidates.sort((a, b) => orderByReply(a.session, b.session));
                    const nonDraft = allCandidates.filter(({ session, hasChildren }) => !isUntouchedDraftSession(session, hasChildren));
                    const candidatePool = nonDraft.length > 0 ? nonDraft : allCandidates;
                    const picked = candidatePool.find(({ session }) => session.parentSessionId === null) ?? candidatePool[0];
                    if (picked !== undefined) {
                        const loc = directoryPath({ kind: "session", workspace: picked.ws.name, session: picked.session.name });
                        if (loc !== null) return { location: loc, cookie: formatPlaceCookie(picked.ws.id, picked.session.id, secure) };
                    }
                }

                if (typeof seam.createWorkspace !== "function" || typeof seam.createSession !== "function") {
                    return null;
                }

                const flight = starterFlight ?? (starterFlight = (async () => {
                    const latestWorkspaces = await seam.listWorkspaces();
                    const existingWs = latestWorkspaces.find(({ archived_at, project_root }) => archived_at === null && project_root === null)
                        ?? latestWorkspaces.find(({ archived_at }) => archived_at === null);
                    /** @type {number} */
                    let wsId;
                    /** @type {string} */
                    let wsName;
                    /** @type {readonly { readonly id: number, readonly name: string, readonly origin: string, readonly archived_at: string | null }[]} */
                    let existing = [];
                    if (existingWs !== undefined) {
                        wsId = existingWs.id;
                        wsName = existingWs.name;
                        existing = await seam.listSessions(wsId);
                    } else {
                        const created = await seam.createWorkspace({ projectRoot: null });
                        wsId = created.workspaceId;
                        wsName = created.workspaceName;
                    }
                    const unarchivedModel = existing.find(({ origin, archived_at }) => origin === "model" && archived_at === null);
                    if (unarchivedModel !== undefined) {
                        const loc = directoryPath({ kind: "session", workspace: wsName, session: unarchivedModel.name });
                        if (loc === null) throw new Error("Starter session has no directory address.");
                        return { location: loc, workspaceId: wsId, sessionId: unarchivedModel.id };
                    }
                    const userNameTaken = existing.some(({ name }) => name === "user");
                    const createdSess = await seam.createSession({
                        workspaceId: wsId,
                        ...(userNameTaken ? {} : { name: "user" }),
                    });
                    const loc = directoryPath({ kind: "session", workspace: wsName, session: createdSess.sessionName });
                    if (loc === null) throw new Error("Starter session has no directory address.");
                    return { location: loc, workspaceId: wsId, sessionId: createdSess.sessionId };
                })().finally(() => { starterFlight = null; }));

                const allocated = await flight;
                return {
                    location: allocated.location,
                    cookie: formatPlaceCookie(allocated.workspaceId, allocated.sessionId, secure),
                };
            };

            /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
            const serve = async (req, res) => {
                const { documents, resources } = await assets.snapshot();
                const rawUrl = req.url ?? "/";
                const pathname = rawUrl.split("?")[0];
                const directory = parseDirectory(pathname);
                const home = indexDocument(pathname) === "/index.html";
                const search = indexDocument(pathname) === "/search/index.html";
                const account = indexDocument(pathname) === "/account/index.html";
                const sessions = indexDocument(pathname) === "/account/sessions/index.html";
                const revoke = /^\/account\/sessions\/([^/]+)\/revoke$/u.exec(pathname);
                const others = pathname === "/account/sessions/revoke-others";
                const token = pathname === "/auth/token";
                const creation = pathname === "/workspaces/new";
                const rename = pathname === "/workspaces/rename";
                const sessionCreation = pathname === "/sessions/new";
                const workspaceArchive = pathname === "/workspaces/archive";
                const workspaceUnarchive = pathname === "/workspaces/unarchive";
                const sessionArchive = pathname === "/sessions/archive";
                const sessionUnarchive = pathname === "/sessions/unarchive";
                const sessionTitle = pathname === "/sessions/title";
                const placeUpdate = pathname === "/place";
                const diagram = pathname === "/render/mermaid";
                const auth = token || ["/auth/login", CALLBACK, "/auth/logout"].includes(pathname);
                let admitted = false;
                try {
                    const inventory = sessions ? session?.account(req) : null;
                    admitted = sessions ? inventory != null : session?.admitted(req) ?? false;
                    if (diagram) {
                        if (session !== null && !admitted) throw new RequestError(401, "Sign in to render diagrams.");
                        if (diagrams === null) throw new RequestError(503, "Diagram compilation is unavailable because its configuration is invalid.");
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
                    const isFormMutation = creation || rename || sessionCreation || workspaceArchive || workspaceUnarchive || sessionArchive || sessionUnarchive || sessionTitle || placeUpdate;
                    if (isFormMutation) {
                        const actionName = creation ? "create a workspace"
                            : rename ? "rename a workspace"
                            : sessionCreation ? "create a session"
                            : workspaceArchive ? "archive a workspace"
                            : workspaceUnarchive ? "unarchive a workspace"
                            : sessionArchive ? "archive a session"
                            : sessionUnarchive ? "unarchive a session"
                            : sessionTitle ? "title a session"
                            : "record the active session";
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
                        if (formBytes === null) {
                            req.resume();
                            throw new RequestError(503, "Form submissions are unavailable because PLURNK_WEB_FORM_BYTES is invalid.");
                        }
                        if ((creation || sessionCreation) && creations === null) {
                            req.resume();
                            throw new RequestError(503, "Creation forms are unavailable because their configuration is invalid.");
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
                        const secure = isSecureRequest(req);

                        if (placeUpdate) {
                            const targetWs = fields.get("workspace");
                            const targetSess = fields.get("session");
                            if (!targetWs || !targetSess || typeof seam.listWorkspaces !== "function" || typeof seam.listSessions !== "function") {
                                throw new RequestError(400, "Expected workspace and session name.");
                            }
                            const ws = (await seam.listWorkspaces()).find(({ name, archived_at }) => name === targetWs && archived_at === null);
                            if (ws) {
                                const sess = (await seam.listSessions(ws.id)).find(({ name, origin, archived_at }) => name === targetSess && origin === "model" && archived_at === null);
                                if (sess) res.setHeader("set-cookie", formatPlaceCookie(ws.id, sess.id, secure));
                            }
                            res.writeHead(204, privateHeaders);
                            res.end();
                            return;
                        }
                        if (creation && creations !== null) {
                            const formToken = fields.getAll("token").length === 1 ? fields.get("token") : null;
                            if (!formToken) throw new RequestError(400, "Expected the form's workspace creation token.");
                            const name = fields.get("name") ?? "";
                            const rawProjectRoot = fields.get("projectRoot") ?? "";
                            const projectRoot = rawProjectRoot === "" ? null : rawProjectRoot;
                            /** @type {string | undefined} */
                            let placeCookie;
                            const targetLocation = await creations.submit(formToken, async () => {
                                let created;
                                try { created = await seam.createWorkspace({ ...(name === "" ? {} : { name }), projectRoot }); }
                                catch (cause) { throw refusal(cause, "The daemon could not create the workspace.", documents.retryCreation(name, rawProjectRoot)); }
                                const wsName = created.workspaceName;
                                const wsRoot = created.projectRoot;
                                if (projectRoot === null && wsRoot !== null) {
                                    throw new Error("The daemon created a workspace with a project folder from a folderless request.");
                                }
                                if (projectRoot !== null && wsRoot === null) {
                                    throw new Error("The daemon created a folderless workspace when a project folder was requested.");
                                }
                                if (typeof seam.createSession === "function" && typeof created.workspaceId === "number") {
                                    const sess = await seam.createSession({ workspaceId: created.workspaceId, name: "user" });
                                    placeCookie = formatPlaceCookie(created.workspaceId, sess.sessionId, secure);
                                    return { workspaceName: wsName, projectRoot: wsRoot, sessionName: sess.sessionName };
                                }
                                return { workspaceName: wsName, projectRoot: wsRoot };
                            }, { folderRequested: projectRoot !== null });
                            redirect(res, targetLocation, placeCookie);
                            return;
                        }
                        if (rename) {
                            const targetName = fields.get("workspace");
                            const newName = fields.get("name");
                            const currentSession = fields.get("session") ?? "";
                            if (!targetName || !newName) throw new RequestError(400, "Expected current workspace and new name.");
                            const workspaces = await seam.listWorkspaces();
                            const ws = workspaces.find(({ name }) => name === targetName);
                            if (!ws) throw new RequestError(404, "Workspace not found.");
                            let renamed;
                            try { renamed = await seam.renameWorkspace(ws.id, newName); }
                            catch (cause) { throw refusal(cause, "The daemon could not rename the workspace.", documents.retryRename(ws.name, newName, currentSession)); }
                            const path = currentSession
                                ? directoryPath({ kind: "session", workspace: renamed.name, session: currentSession })
                                : directoryPath({ kind: "workspace", workspace: renamed.name });
                            if (path === null) throw new Error("The daemon returned a workspace name without a directory address.");
                            redirect(res, path);
                            return;
                        }
                        if (sessionCreation && creations !== null) {
                            const formToken = fields.getAll("token").length === 1 ? fields.get("token") : null;
                            const targetName = fields.get("workspace");
                            if (!formToken || !targetName) throw new RequestError(400, "Expected session creation token and workspace name.");
                            const sessionName = fields.get("name") ?? "";
                            const workspaces = await seam.listWorkspaces();
                            const ws = workspaces.find(({ name }) => name === targetName);
                            if (!ws) throw new RequestError(404, "Workspace not found.");
                            /** @type {string | undefined} */
                            let placeCookie;
                            const targetLocation = await creations.submit(formToken, async () => {
                                let createdSession;
                                try { createdSession = await seam.createSession({ workspaceId: ws.id, ...(sessionName === "" ? {} : { name: sessionName }) }); }
                                catch (cause) { throw refusal(cause, "The daemon could not create the session.", documents.retrySession(ws.name, sessionName)); }
                                placeCookie = formatPlaceCookie(ws.id, createdSession.sessionId, secure);
                                const path = directoryPath({ kind: "session", workspace: ws.name, session: createdSession.sessionName });
                                if (path === null) throw new Error("The daemon returned a session name without a directory address.");
                                return path;
                            });
                            redirect(res, targetLocation, placeCookie);
                            return;
                        }
                        if (workspaceArchive) {
                            const targetName = fields.get("workspace");
                            if (!targetName) throw new RequestError(400, "Expected workspace name.");
                            const workspaces = await seam.listWorkspaces();
                            const ws = workspaces.find(({ name }) => name === targetName);
                            if (!ws) throw new RequestError(404, "Workspace not found.");
                            try { await seam.setWorkspaceArchived({ workspaceId: ws.id, archived: true }); }
                            catch (cause) { throw refusal(cause, "The daemon could not archive the workspace."); }
                            const remembered = readPlaceCookie(req, secure);
                            const cleared = remembered?.workspaceId === ws.id ? clearPlaceCookie(secure) : undefined;
                            redirect(res, "/", cleared);
                            return;
                        }
                        if (workspaceUnarchive) {
                            const targetName = fields.get("workspace");
                            if (!targetName) throw new RequestError(400, "Expected workspace name.");
                            const workspaces = await seam.listWorkspaces();
                            const ws = workspaces.find(({ name }) => name === targetName);
                            if (!ws) throw new RequestError(404, "Workspace not found.");
                            try { await seam.setWorkspaceArchived({ workspaceId: ws.id, archived: false }); }
                            catch (cause) { throw refusal(cause, "The daemon could not unarchive the workspace."); }
                            const path = directoryPath({ kind: "workspace", workspace: ws.name });
                            redirect(res, path ?? "/search/");
                            return;
                        }
                        if (sessionArchive) {
                            const targetName = fields.get("workspace");
                            const targetSession = fields.get("session");
                            if (!targetName || !targetSession) throw new RequestError(400, "Expected workspace and session name.");
                            const workspaces = await seam.listWorkspaces();
                            const ws = workspaces.find(({ name }) => name === targetName);
                            if (!ws) throw new RequestError(404, "Workspace not found.");
                            const workspaceSessions = await seam.listSessions(ws.id);
                            const target = workspaceSessions.find(({ name }) => name === targetSession);
                            if (!target) throw new RequestError(404, "Session not found.");
                            try { await seam.setSessionArchived({ workspaceId: ws.id, sessionId: target.id, archived: true }); }
                            catch (cause) { throw refusal(cause, "The daemon could not archive the session."); }
                            const afterSessions = await seam.listSessions(ws.id);
                            const unarchived = afterSessions
                                .filter(({ origin, archived_at }) => origin === "model" && archived_at === null)
                                .toSorted(orderByReply);
                            const childParents = new Set(unarchived.flatMap(({ parentSessionId }) => parentSessionId === null ? [] : [parentSessionId]));
                            const nonDraft = unarchived.filter((entry) => !isUntouchedDraftSession(entry, childParents.has(entry.id)));
                            const remaining = nonDraft.length > 0 ? nonDraft : unarchived;
                            if (remaining.length > 0) {
                                const next = remaining[0];
                                const path = directoryPath({ kind: "session", workspace: ws.name, session: next.name });
                                if (path !== null) {
                                    redirect(res, path, formatPlaceCookie(ws.id, next.id, secure));
                                    return;
                                }
                            }
                            if (ws.archived_at === null && typeof seam.createSession === "function") {
                                const userNameTaken = afterSessions.some(({ name }) => name === "user");
                                const fresh = await seam.createSession({
                                    workspaceId: ws.id,
                                    ...(userNameTaken ? {} : { name: "user" }),
                                });
                                const freshPath = directoryPath({ kind: "session", workspace: ws.name, session: fresh.sessionName });
                                if (freshPath !== null) {
                                    redirect(res, freshPath, formatPlaceCookie(ws.id, fresh.sessionId, secure));
                                    return;
                                }
                            }
                            redirect(res, "/", clearPlaceCookie(secure));
                            return;
                        }
                        if (sessionTitle) {
                            const targetName = fields.get("workspace");
                            const targetSession = fields.get("session");
                            const rawTitle = (fields.get("title") ?? "").trim();
                            if (!targetName || !targetSession || !rawTitle) {
                                throw new RequestError(400, "Expected workspace, session name, and non-empty title.");
                            }
                            if (typeof seam.setSessionTitle !== "function") {
                                throw new RequestError(501, "Session titling is unavailable.");
                            }
                            const workspaces = await seam.listWorkspaces();
                            const ws = workspaces.find(({ name }) => name === targetName);
                            if (!ws) throw new RequestError(404, "Workspace not found.");
                            const workspaceSessions = await seam.listSessions(ws.id);
                            const target = workspaceSessions.find(({ name }) => name === targetSession);
                            if (!target) throw new RequestError(404, "Session not found.");
                            try { await seam.setSessionTitle({ workspaceId: ws.id, sessionId: target.id, title: rawTitle }); }
                            catch (cause) { throw refusal(cause, "The daemon could not title the session."); }
                            const path = directoryPath({ kind: "session", workspace: ws.name, session: target.name });
                            redirect(res, path ?? "/search/", formatPlaceCookie(ws.id, target.id, secure));
                            return;
                        }
                        if (sessionUnarchive) {
                            const targetName = fields.get("workspace");
                            const targetSession = fields.get("session");
                            if (!targetName || !targetSession) throw new RequestError(400, "Expected workspace and session name.");
                            const workspaces = await seam.listWorkspaces();
                            const ws = workspaces.find(({ name }) => name === targetName);
                            if (!ws) throw new RequestError(404, "Workspace not found.");
                            const workspaceSessions = await seam.listSessions(ws.id);
                            const target = workspaceSessions.find(({ name }) => name === targetSession);
                            if (!target) throw new RequestError(404, "Session not found.");
                            try { await seam.setSessionArchived({ workspaceId: ws.id, sessionId: target.id, archived: false }); }
                            catch (cause) { throw refusal(cause, "The daemon could not unarchive the session."); }
                            if (ws.archived_at !== null) {
                                await seam.setWorkspaceArchived({ workspaceId: ws.id, archived: false });
                            }
                            const path = directoryPath({ kind: "session", workspace: ws.name, session: target.name });
                            redirect(res, path ?? "/search/", formatPlaceCookie(ws.id, target.id, secure));
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
                    if (directory !== null || home || search || account || sessions) {
                        if (req.method !== "GET" && req.method !== "HEAD") {
                            res.setHeader("allow", "GET, HEAD");
                            throw new RequestError(405, "Method not allowed.");
                        }
                        if (session !== null && !admitted) {
                            redirect(res, session.signIn(req, rawUrl));
                            return;
                        }
                        if (directory?.kind === "daemon") {
                            redirect(res, "/search/");
                            return;
                        }
                        if (home && pathname === "/") {
                            const arrival = await resolveHomeArrival(req);
                            if (arrival !== null) {
                                redirect(res, arrival.location, req.method === "GET" ? arrival.cookie : undefined);
                                return;
                            }
                        }
                        const secure = isSecureRequest(req);
                        if (search) {
                            if (typeof seam.listWorkspaces !== "function" || typeof seam.listSessions !== "function") {
                                throw new RequestError(404, "Search is unavailable without a daemon workspace directory.");
                            }
                            const params = new URL(rawUrl, "http://search.local").searchParams;
                            const body = await documents.search(admitted, /** @type {any} */ (seam), {
                                q: params.get("q") ?? undefined,
                                workspace: params.get("workspace") ?? undefined,
                                status: params.get("status") ?? undefined,
                                kind: params.get("kind") ?? undefined,
                            }, { creationsAvailable: creations !== null });
                            res.writeHead(200, { ...privateHeaders, "content-type": "text/html; charset=utf-8", "content-length": body.byteLength });
                            res.end(req.method === "HEAD" ? undefined : body);
                            return;
                        }
                        if (directory !== null) {
                            if (typeof seam.listWorkspaces !== "function" || typeof seam.listSessions !== "function") {
                                throw new RequestError(404, "Workspace or session not found.");
                            }
                            const remembered = readPlaceCookie(req, secure);
                            /** @type {Record<string, string>} */
                            let setCookie = {};
                            const body = await documents.read(directory, /** @type {any} */ (seam), admitted, {
                                own: ownNavigation(req),
                                preferredSessionId: remembered?.sessionId ?? null,
                                creationsAvailable: creations !== null,
                                onSelected: (ws, selected) => {
                                    if (req.method === "GET" && ws.archived_at === null && selected !== null && selected.archived_at === null) {
                                        setCookie = { "set-cookie": formatPlaceCookie(ws.id, selected.id, secure) };
                                    }
                                },
                            });
                            if (body === null) throw new RequestError(404, "Workspace or session not found.");
                            res.writeHead(200, { ...privateHeaders, ...setCookie, "content-type": "text/html; charset=utf-8", "content-length": body.byteLength });
                            res.end(req.method === "HEAD" ? undefined : body);
                            return;
                        }
                        const body = home ? documents.home(admitted)
                            : account ? documents.account()
                            : inventory ? documents.sessions(inventory)
                            : null;
                        if (body === null) throw new RequestError(404, "The requested page does not exist.");
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
            cleanup.defer(() => assets.close?.());
            cleanup.defer(async () => { await Promise.allSettled(requests); });
            cleanup.defer(() => diagrams?.close());
            await cleanup.disposeAsync();
        },
    };
}
