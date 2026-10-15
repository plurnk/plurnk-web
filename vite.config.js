import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import purgeCSS from "@fullhuman/postcss-purgecss";
import { authorizationDocumentSpecimens } from "@plurnk/plurnk-agui";
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

export default defineConfig(({ command }) => ({
    root: fileURLToPath(new URL("./web/", import.meta.url)),
    appType: "mpa",
    plugins: [{
        name: "plurnk-index-documents",
        configureServer: configureDirectories,
        configurePreviewServer: configureDirectories,
    }],
    server: { host: "127.0.0.1" },
    preview: { host: "127.0.0.1" },
    // {§web-build} Scan both browser documents and the server-owned document renderer.
    css: {
        postcss: {
            plugins: command === "build" ? [purgeCSS({
                content: [
                    fileURLToPath(new URL("./web/**/*.{html,js}", import.meta.url)),
                    fileURLToPath(new URL("./ai.plurnk/documents.js", import.meta.url)),
                    ...authorizationDocumentSpecimens().map((raw) => ({ raw, extension: "html" })),
                ],
                defaultExtractor: (content) => content.match(/[A-Za-z0-9_-]+/gu) ?? [],
                // Browser pseudo-states are not HTML tokens, including inside :is() and :where().
                safelist: { standard: [/^:/], deep: [/aria-/, /role-/, /data-/] },
                variables: true,
                keyframes: true,
            })] : [],
        },
    },
    build: {
        target: "esnext",
        license: { fileName: "vendor/DEPENDENCIES-LICENSE.txt" },
        modulePreload: { polyfill: false },
        outDir: fileURLToPath(new URL("./ai.plurnk/dist/", import.meta.url)),
        emptyOutDir: true,
    },
}));
