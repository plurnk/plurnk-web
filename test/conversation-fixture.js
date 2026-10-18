import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import Documents from "../ai.plurnk/documents.js";
import { privateHeaders } from "../ai.plurnk/http.js";

// A component fixture using the real document and browser modules, not a second HTML implementation.
export default async function conversationFixture() {
    const inventory = JSON.parse(await readFile(new URL("../ai.plurnk/assets.json", import.meta.url), "utf8"));
    const assets = new Map(await Promise.all(inventory.map(async ([path, file, type]) =>
        [path, { body: await readFile(new URL(`../ai.plurnk/dist/${file}`, import.meta.url)), type }])));
    const { output } = await build({
        logLevel: "error",
        build: { write: false, rolldownOptions: { input: fileURLToPath(new URL("./conversation-entry.js", import.meta.url)) } },
    });
    for (const entry of output) assets.set(`/${entry.fileName}`, {
        body: entry.type === "chunk" ? entry.code : entry.source,
        type: entry.type === "chunk" ? "text/javascript" : entry.fileName.endsWith(".css") ? "text/css" : entry.fileName.endsWith(".woff2") ? "font/woff2" : "text/plain",
    });
    const entry = output.find((entry) => entry.type === "chunk" && entry.isEntry);
    const template = assets.get("/index.html").body.toString()
        .replace(/<script\b[^>]*src="\/assets\/[^"]+\.js"[^>]*><\/script>/u, `<script type="module" src="/${entry.fileName}"></script>`);
    const documents = new Documents(template);
    const document = await documents.read({ kind: "worker", workspace: "conversation", worker: "user" }, {
        listWorkspaces: async () => [{ id: 7, name: "conversation", project_root: null, project_label: null }],
        listWorkers: async () => [{ id: 9, name: "user", parentWorkerId: null, origin: "model", owner: "_plurnk" }],
    }, false);
    const server = createServer((request, response) => {
        const asset = request.url === "/conversation-test" ? { body: document, type: "text/html" } : assets.get(request.url);
        response.writeHead(asset ? 200 : 404, { ...privateHeaders, "content-type": asset?.type ?? "text/plain" });
        response.end(asset?.body ?? "Not found");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server: { close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) },
        url: `http://127.0.0.1:${server.address().port}/conversation-test` };
}
