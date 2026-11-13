import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import Documents from "../src/documents.js";
import { privateHeaders } from "../src/http.js";
import createModule from "../src/module.js";

/** @type {Promise<Map<string, { body: Buffer | string, type: string }>> | null} */
let baseAssetsPromise = null;
/** @type {Map<string, Promise<{ assets: Map<string, { body: Buffer | string, type: string }>, document: Buffer }>>} */
const compiledEntries = new Map();

async function compileEntry(entryURL) {
    let pending = compiledEntries.get(entryURL.href);
    if (!pending) {
        pending = (async () => {
            if (!baseAssetsPromise) {
                baseAssetsPromise = (async () => {
                    const inventory = JSON.parse(await readFile(new URL("../dist/assets.json", import.meta.url), "utf8"));
                    return new Map(await Promise.all(inventory.map(async ([path, file, type]) =>
                        [path, { body: await readFile(new URL(`../dist/${file}`, import.meta.url)), type }])));
                })();
            }
            const baseAssets = await baseAssetsPromise;
            const assets = new Map(baseAssets);
            const built = await build({
                logLevel: "error",
                build: { write: false, rolldownOptions: { input: fileURLToPath(entryURL) } },
            });
            const [{ output }] = /** @type {{ output: any[] }[]} */ (Array.isArray(built) ? built : [built]);
            for (const entry of output) assets.set(`/${entry.fileName}`, {
                body: entry.type === "chunk" ? entry.code : entry.source,
                type: entry.type === "chunk" ? "text/javascript" : entry.fileName.endsWith(".css") ? "text/css" : entry.fileName.endsWith(".woff2") ? "font/woff2" : "text/plain",
            });
            const entry = output.find((entry) => entry.type === "chunk" && entry.isEntry);
            const template = baseAssets.get("/index.html").body.toString()
                // The component entry has its own module graph, not the production entry's preloads.
                .replace(/<link\b[^>]*rel="modulepreload"[^>]*>/gu, "")
                .replace(/<script\b[^>]*src="\/assets\/[^"]+\.js"[^>]*><\/script>/u, `<script type="module" src="/${entry.fileName}"></script>`);
            const documents = new Documents(template, false, 64);
            const document = await documents.read({ kind: "session", workspace: "conversation", session: "user" }, {
                listWorkspaces: async () => [{ id: 7, name: "conversation", project_root: null, project_label: null, archived_at: null }],
                listSessions: async () => [{ id: 9, name: "user", parentSessionId: null, origin: "model", owner: "_plurnk", kind: "root", lifecycle: "idle", archived_at: null }],
            }, false);
            return { assets, document };
        })();
        compiledEntries.set(entryURL.href, pending);
    }
    return pending;
}

// A component fixture using the real document and browser modules, not a second HTML implementation.
export default async function conversationFixture(entryURL = new URL("./conversation-entry.js", import.meta.url), routes = new Map()) {
    const { assets, document } = await compileEntry(entryURL);
    let module = null;
    let serve = null;
    const ensureModule = async () => {
        if (!serve) {
            module = createModule();
            await module.start(/** @type {any} */ ({ registerHttpRoute(_path, handler) { serve = handler; } }));
        }
        return serve;
    };
    let acpHandler = null;
    let capabilities = {};
    let connSeq = 0;
    const sseStreams = new Map();
    const getStream = (key) => {
        if (!sseStreams.has(key)) sseStreams.set(key, { res: null, queue: [], closed: false });
        return sseStreams.get(key);
    };
    const writeSse = (key, data) => {
        const entry = getStream(key);
        if (entry.res && !entry.res.writableEnded) entry.res.write(data);
        else entry.queue.push(data);
    };
    const closeSse = (key) => {
        const entry = getStream(key);
        entry.closed = true;
        if (entry.res && !entry.res.writableEnded) entry.res.end();
    };
    const handleAcp = async (request, response) => {
        request.on("error", () => {});
        response.on("error", () => {});
        if (request.method === "GET") {
            const connId = request.headers["acp-connection-id"] ?? "";
            const sessionId = request.headers["acp-session-id"] ?? "";
            const key = `${connId}:${sessionId}`;
            response.writeHead(200, {
                ...privateHeaders,
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                "connection": "keep-alive",
            });
            response.flushHeaders();
            response.write(":\n\n");
            const entry = getStream(key);
            entry.res = response;
            for (const chunk of entry.queue.splice(0)) response.write(chunk);
            if (entry.closed) response.end();
            request.on("close", () => {
                if (entry.res === response) entry.res = null;
            });
            return;
        }
        if (request.method === "DELETE") {
            const connId = request.headers["acp-connection-id"] ?? "";
            for (const [key, entry] of sseStreams) {
                if (key.startsWith(`${connId}:`)) {
                    sseStreams.delete(key);
                    entry.closed = true;
                    if (entry.res && !entry.res.writableEnded) entry.res.end();
                }
            }
            response.writeHead(202, privateHeaders);
            response.end();
            return;
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (input.method === "initialize") {
            const connId = `conn-${++connSeq}`;
            response.writeHead(200, {
                ...privateHeaders,
                "content-type": "application/json",
                "acp-connection-id": connId,
            });
            response.end(JSON.stringify({
                jsonrpc: "2.0",
                id: input.id,
                result: {
                    protocolVersion: 2,
                    capabilities,
                    info: { name: "@plurnk/plurnk-service", version: "1.0.0" },
                },
            }));
            return;
        }
        const connId = request.headers["acp-connection-id"] ?? "";
        const sessionId = request.headers["acp-session-id"] ?? input.params?.sessionId ?? "";
        const key = `${connId}:${sessionId}`;
        response.writeHead(202, privateHeaders);
        response.end();
        if (input.method === undefined) {
            await acpHandler(input, request.headers);
            return;
        }
        const outcome = await acpHandler(input, request.headers);
        for (const update of outcome.updates ?? []) {
            writeSse(key, `data: ${JSON.stringify({
                jsonrpc: "2.0",
                method: "session/update",
                params: { sessionId, update },
            })}\n\n`);
        }
        const rpcFrame = outcome.error
            ? { jsonrpc: "2.0", id: input.id, error: outcome.error }
            : { jsonrpc: "2.0", id: input.id, result: outcome.result ?? {} };
        writeSse(key, `data: ${JSON.stringify(rpcFrame)}\n\n`);
        if (outcome.closeStream) {
            closeSse(key);
        }
    };
    const server = createServer((request, response) => {
        const path = new URL(request.url, "http://fixture.invalid").pathname;
        if (routes.has(path)) { routes.get(path)(request, response); return; }
        if (path === "/acp" && acpHandler) { void handleAcp(request, response).catch(() => {}); return; }
        if (path === "/render/mermaid") { void ensureModule().then((handler) => handler(request, response)); return; }
        const asset = path === "/conversation-test" ? { body: document, type: "text/html" } : assets.get(path);
        response.writeHead(asset ? 200 : 404, { ...privateHeaders, "content-type": asset?.type ?? "text/plain" });
        response.end(asset?.body ?? "Not found");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        onAcp: (handler) => { acpHandler = handler; },
        setCapabilities: (next) => { capabilities = next ?? {}; },
        push: (update, sessionId = "7#user") => {
            for (const [key, entry] of sseStreams) {
                if (!entry.closed) {
                    writeSse(key, `data: ${JSON.stringify({
                        jsonrpc: "2.0",
                        method: "session/update",
                        params: { sessionId, update },
                    })}\n\n`);
                }
            }
        },
        pushFrame: (frame) => {
            for (const [key, entry] of sseStreams) {
                if (!entry.closed) {
                    writeSse(key, `data: ${JSON.stringify(frame)}\n\n`);
                }
            }
        },
        server: {
            close: async () => {
                for (const entry of sseStreams.values()) {
                    if (entry.res && !entry.res.writableEnded) entry.res.end();
                }
                sseStreams.clear();
                await module?.close();
                await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            },
        },
        url: `http://127.0.0.1:${server.address().port}/conversation-test`,
    };
}
