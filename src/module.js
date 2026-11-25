import { readFile } from "node:fs/promises";
import { ConfigurationError, Knob } from "@plurnk/plurnk-meta";
import { Problems } from "@plurnk/plurnk-contracts";
import { loadBrandAssets, parseBrandConfig } from "./brand.js";
import indexDocument from "./index-document.js";
import { parseDirectory } from "./directory-addresses.js";
import Documents from "./documents.js";
import {
    parseAcpEndpoint,
    privateHeaders,
    privateHeadersFor,
    redirect,
    RequestError,
    resolveIssuerOrigin,
    sameOriginRequest,
} from "./http.js";
import { readAsset, sendAsset } from "./static-assets.js";
import Diagrams from "./diagrams.js";

/** @typedef {import("../types/module.js").MermaidCredentialVerifier} MermaidCredentialVerifier */
/** @typedef {import("../types/module.js").WebModulePort} WebModulePort */
/** @typedef {Awaited<ReturnType<typeof readAsset>>} LoadedAsset */
/**
 * @typedef {{
 *   readonly acpUrl: string | null,
 *   readonly overviewSessions: number | null,
 *   readonly overviewExcerptChars: number | null,
 *   readonly brand: import("./brand.js").BrandConfig,
 * }} DocumentKnobs
 */
/**
 * @typedef {{
 *   start: (knobs: DocumentKnobs) => Promise<void>,
 *   snapshot: () => Promise<{ documents: Documents, resources: ReadonlyMap<string, LoadedAsset> }>,
 *   close?: () => Promise<void> | void,
 * }} ModuleAssetSource
 */

/**
 * Extract a single `Bearer <token>` credential from an HTTP `Authorization` header.
 * @param {string | string[] | undefined} header
 * @returns {string | null}
 */
function parseBearerToken(header) {
    if (typeof header !== "string" || header.includes(",")) return null;
    const match = /^\s*Bearer\s+([^\s,]+)\s*$/iu.exec(header);
    return match ? match[1] : null;
}

/** {§web-assets} @returns {ModuleAssetSource} */
function productionAssets() {
    /** @type {{ documents: Documents, resources: ReadonlyMap<string, LoadedAsset> } | null} */
    let loaded = null;
    return {
        async start({ acpUrl, overviewSessions, overviewExcerptChars, brand }) {
            // {§web-assets} Requests select entries, never filesystem paths.
            /** @type {import("./static-assets.js").AssetEntry[]} */
            const inventory = JSON.parse(await readFile(new URL("../dist/assets.json", import.meta.url), "utf8"));
            const resources = new Map(await Promise.all(inventory.map(async ([pathname, file, mediaType, encoded]) => /** @type {const} */ ([
                pathname,
                await readAsset(file, mediaType, encoded),
            ]))));
            const root = resources.get("/index.html");
            if (root === undefined) throw new Error("The web asset inventory must include index.html.");
            const stylesheetPath = Documents.stylesheet(root.body.toString("utf8"));
            const stylesheetAsset = resources.get(stylesheetPath);
            if (!stylesheetAsset || stylesheetAsset.mediaType !== "text/css") {
                throw new Error("The application stylesheet is absent from the web asset inventory.");
            }
            await loadBrandAssets(brand, resources);
            const documents = new Documents(root.body.toString("utf8"), {
                acpUrl,
                overviewSessions,
                overviewExcerptChars,
                brand,
            });
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
 * @returns {import("@plurnk/plurnk-modules").DaemonModule<unknown, WebModulePort>}
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
    const brand = parseBrandConfig(process.env);
    const acpEndpoint = contain(() => parseAcpEndpoint(process.env.PLURNK_ACP_URL));
    const overviewSessions = contain(() => Knob.integer("PLURNK_WEB_OVERVIEW_SESSIONS", 1));
    const overviewExcerptChars = contain(() => Knob.integer("PLURNK_WEB_OVERVIEW_EXCERPT_CHARS", 1));
    const diagrams = Diagrams.create(contain);
    let stopped = false;
    /** @type {Set<Promise<void>>} */
    const requests = new Set();
    const stop = () => { stopped = true; };

    return {
        mounts: ["/"],
        contained: Object.freeze(contained),
        setup() {},
        async start(seam) {
            await assets.start({
                acpUrl: acpEndpoint?.acpUrl ?? null,
                overviewSessions,
                overviewExcerptChars,
                brand,
            });

            /** @param {import("node:http").IncomingMessage} req */
            const responseHeadersFor = (req) => privateHeadersFor({
                acpHttpOrigin: acpEndpoint?.httpOrigin ?? null,
                acpWsOrigin: acpEndpoint?.wsOrigin ?? null,
                issuerOrigin: resolveIssuerOrigin(seam.credentials?.face?.() ?? null, req),
            });

            /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
            const serve = async (req, res) => {
                const { documents, resources } = await assets.snapshot();
                const rawUrl = req.url ?? "/";
                const pathname = rawUrl.split("?")[0];
                const diagram = pathname === "/render/mermaid";
                const headers = responseHeadersFor(req);
                try {
                    if (diagram) {
                        if (req.method !== "POST") {
                            res.setHeader("allow", "POST");
                            throw new RequestError(405, "Use POST for diagram compilation.");
                        }
                        sameOriginRequest(req);
                        if (diagrams === null) {
                            throw new RequestError(503, "Diagram compilation is unavailable because its configuration is invalid.");
                        }
                        const credentials = seam.credentials ?? null;
                        if ((credentials?.face() ?? null) !== null && credentials !== null) {
                            const token = parseBearerToken(req.headers.authorization);
                            if (token === null) throw new RequestError(401, "Sign in to render diagrams.");
                            const verified = await Promise.resolve(credentials.verify(token));
                            if (verified == null) throw new RequestError(401, "Sign in to render diagrams.");
                        }
                        await diagrams.serve(req, res);
                        return;
                    }

                    const directory = parseDirectory(pathname);
                    const home = indexDocument(pathname) === "/index.html";
                    const search = indexDocument(pathname) === "/search/index.html";
                    const settings = indexDocument(pathname) === "/settings/index.html";
                    const callback = pathname === "/auth/callback";

                    if (directory !== null || home || search || settings || callback) {
                        if (req.method !== "GET" && req.method !== "HEAD") {
                            res.setHeader("allow", "GET, HEAD");
                            throw new RequestError(405, "Method not allowed.");
                        }
                        if (directory?.kind === "daemon") {
                            redirect(res, "/search/", headers);
                            return;
                        }
                        if (acpEndpoint === null) {
                            throw new RequestError(503, "The web client is unavailable because PLURNK_ACP_URL is invalid.");
                        }
                        if (search && (overviewSessions === null || overviewExcerptChars === null)) {
                            throw new RequestError(503, "Search is unavailable because its overview configuration is invalid.");
                        }
                        let body;
                        if (home) {
                            body = documents.home();
                        } else if (callback) {
                            body = documents.callback();
                        } else if (search) {
                            const params = new URL(rawUrl, "http://search.local").searchParams;
                            body = documents.search({
                                q: params.get("q") ?? undefined,
                                workspace: params.get("workspace") ?? undefined,
                                status: params.get("status") ?? undefined,
                                kind: params.get("kind") ?? undefined,
                            });
                        } else if (settings) {
                            const params = new URL(rawUrl, "http://settings.local").searchParams;
                            body = documents.settings({
                                workspace: params.get("workspace") ?? undefined,
                                session: params.get("session"),
                            });
                        } else if (directory !== null) {
                            body = documents.session(directory.workspace);
                        } else {
                            throw new RequestError(404, "The requested page does not exist.");
                        }
                        res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8", "content-length": body.byteLength });
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
                    const body = diagram
                        ? Buffer.from(JSON.stringify(Problems.create("web", "diagram-request-rejected", error.status, error.message)))
                        : documents.error(error.status, error.message);
                    res.writeHead(error.status, {
                        ...headers,
                        "content-type": diagram ? "application/problem+json" : "text/html; charset=utf-8",
                        "content-length": body.byteLength,
                    });
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
            cleanup.defer(() => assets.close?.());
            cleanup.defer(async () => { await Promise.allSettled(requests); });
            cleanup.defer(() => diagrams?.close());
            await cleanup.disposeAsync();
        },
    };
}
