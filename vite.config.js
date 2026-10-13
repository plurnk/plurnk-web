import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import indexDocument from "./ai.plurnk/index-document.js";

/** @param {import("vite").ViteDevServer | import("vite").PreviewServer} server */
function configureDirectories(server) {
    server.middlewares.use((req, _res, next) => {
        if (req.url && (req.method === "GET" || req.method === "HEAD")) {
            const pathname = req.url.split("?")[0];
            req.url = indexDocument(pathname) + req.url.slice(pathname.length);
        }
        next();
    });
}

export default defineConfig({
    root: fileURLToPath(new URL("./web/", import.meta.url)),
    appType: "mpa",
    plugins: [{
        name: "plurnk-index-documents",
        configureServer: configureDirectories,
        configurePreviewServer: configureDirectories,
    }],
    server: { host: "127.0.0.1" },
    preview: { host: "127.0.0.1" },
    build: {
        outDir: fileURLToPath(new URL("./ai.plurnk/dist/", import.meta.url)),
        emptyOutDir: true,
    },
});
