import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import Documents from "../ai.plurnk/documents.js";

// A component fixture using the real document and browser modules, not a second HTML implementation.
export default async function conversationFixture() {
    const template = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
    const documents = new Documents(template);
    const document = await documents.read({ kind: "worker", workspace: "conversation", worker: "user" }, {
        listWorkspaces: async () => [{ id: 7, name: "conversation", project_root: null, project_label: null }],
        listWorkers: async () => [{ id: 9, name: "user", parentWorkerId: null, origin: "model", owner: "_plurnk" }],
    }, false);
    const html = document.toString().replace('<script type="module" src="/app.js"></script>', `<script type="module">
        import { the } from "on_the_money";
        import conversation from "/conversation.js";
        await the.boot({ locale: "en", defaultLocale: "en", persistKeys: [] });
        window.present = conversation(document.querySelector("#worker-conversation"));
    </script>`);
    const server = await createServer({
        logLevel: "error", server: { port: 0 },
        plugins: [{
            name: "conversation-component-test",
            configureServer(server) {
                server.middlewares.use(async (request, response, next) => {
                    if (request.url !== "/conversation-test") return next();
                    try {
                        response.setHeader("content-type", "text/html");
                        response.end(await server.transformIndexHtml("/conversation-test", html));
                    } catch (error) { next(error); }
                });
            },
        }],
    });
    await server.listen();
    return { server, url: `http://127.0.0.1:${server.httpServer.address().port}/conversation-test` };
}
