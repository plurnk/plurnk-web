import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import Documents from "../ai.plurnk/documents.js";
import { privateHeaders } from "../ai.plurnk/http.js";
import createModule from "../ai.plurnk/module.js";

// A component fixture using the real document and browser modules, not a second HTML implementation.
export default async function conversationFixture(entryURL = new URL("./conversation-entry.js", import.meta.url), routes = new Map()) {
    const original = process.env.PLURNK_AUTH;
    process.env.PLURNK_AUTH = "0";
    const module = createModule();
    if (original === undefined) delete process.env.PLURNK_AUTH;
    else process.env.PLURNK_AUTH = original;
    let serve;
    await module.start({ registerHttpRoute(_path, handler) { serve = handler; } });
    const inventory = JSON.parse(await readFile(new URL("../ai.plurnk/assets.json", import.meta.url), "utf8"));
    const assets = new Map(await Promise.all(inventory.map(async ([path, file, type]) =>
        [path, { body: await readFile(new URL(`../ai.plurnk/dist/${file}`, import.meta.url)), type }])));
    const { output } = await build({
        logLevel: "error",
        build: { write: false, rolldownOptions: { input: fileURLToPath(entryURL) } },
    });
    for (const entry of output) assets.set(`/${entry.fileName}`, {
        body: entry.type === "chunk" ? entry.code : entry.source,
        type: entry.type === "chunk" ? "text/javascript" : entry.fileName.endsWith(".css") ? "text/css" : entry.fileName.endsWith(".woff2") ? "font/woff2" : "text/plain",
    });
    const entry = output.find((entry) => entry.type === "chunk" && entry.isEntry);
    const template = assets.get("/index.html").body.toString()
        // The component entry has its own module graph, not the production entry's preloads.
        .replace(/<link\b[^>]*rel="modulepreload"[^>]*>/gu, "")
        .replace(/<script\b[^>]*src="\/assets\/[^"]+\.js"[^>]*><\/script>/u, `<script type="module" src="/${entry.fileName}"></script>`);
    const documents = new Documents(template, false, 64);
    const document = await documents.read({ kind: "session", workspace: "conversation", session: "user" }, {
        listWorkspaces: async () => [{ id: 7, name: "conversation", project_root: null, project_label: null }],
        listSessions: async () => [{ id: 9, name: "user", parentSessionId: null, origin: "model", owner: "_plurnk", kind: "root", lifecycle: "idle" }],
    }, false);
    let acpHandler = null;
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
                    capabilities: {},
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
        if (path === "/acp" && acpHandler) { void handleAcp(request, response); return; }
        if (path === "/render/mermaid") { void serve(request, response); return; }
        const asset = path === "/conversation-test" ? { body: document, type: "text/html" } : assets.get(path);
        response.writeHead(asset ? 200 : 404, { ...privateHeaders, "content-type": asset?.type ?? "text/plain" });
        response.end(asset?.body ?? "Not found");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        onAcp: (handler) => { acpHandler = handler; },
        server: {
            close: async () => {
                for (const entry of sseStreams.values()) {
                    if (entry.res && !entry.res.writableEnded) entry.res.end();
                }
                sseStreams.clear();
                await module.close();
                await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            },
        },
        url: `http://127.0.0.1:${server.address().port}/conversation-test`,
    };
}
