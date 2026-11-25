import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import indexDocument from "./src/index-document.js";

const HTML_INCLUDE_PATTERN = /^([ \t]*)<!--\s*@include\s+([^\s]+)\s*-->[ \t]*$/gmu;

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

/**
 * {§web-build} Assemble static `<!-- @include templates/<name>.html -->` partials at build and dev time.
 * @param {string} defaultRoot
 * @returns {import("vite").Plugin}
 */
function htmlPartials(defaultRoot) {
    let resolvedRoot = defaultRoot;
    const isTemplatePartial = (file) => {
        const rel = relative(resolve(resolvedRoot, "templates"), file);
        return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && file.endsWith(".html");
    };

    return {
        name: "plurnk-html-partials",
        configResolved(config) {
            resolvedRoot = config.root;
        },
        configureServer(server) {
            server.watcher.on("change", (file) => {
                if (isTemplatePartial(file)) {
                    server.ws.send({ type: "full-reload", path: "*" });
                }
            });
        },
        transformIndexHtml: {
            order: "pre",
            async handler(html) {
                const matches = [...html.matchAll(HTML_INCLUDE_PATTERN)];
                if (matches.length === 0) return html;
                let out = "";
                let cursor = 0;
                for (const match of matches) {
                    const index = match.index ?? 0;
                    out += html.slice(cursor, index);
                    const indent = match[1] ?? "";
                    const target = match[2];
                    const fullPath = resolve(resolvedRoot, target);
                    const rel = relative(resolvedRoot, fullPath);
                    if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || !target.endsWith(".html")) {
                        throw new Error(`Invalid HTML partial include: ${target}`);
                    }
                    const partial = (await readFile(fullPath, "utf8")).replace(/\r?\n$/u, "");
                    out += partial.split(/\r?\n/u).map((line) => (line === "" ? "" : indent + line)).join("\n");
                    cursor = index + match[0].length;
                }
                out += html.slice(cursor);
                return out;
            },
        },
    };
}

const webRoot = fileURLToPath(new URL("./web/", import.meta.url));

export default defineConfig({
    root: webRoot,
    appType: "mpa",
    plugins: [
        htmlPartials(webRoot),
        {
            name: "plurnk-index-documents",
            configureServer: configureDirectories,
            configurePreviewServer: configureDirectories,
        },
    ],
    server: { host: "127.0.0.1" },
    preview: { host: "127.0.0.1" },
    build: {
        target: "esnext",
        license: { fileName: "vendor/DEPENDENCIES-LICENSE.txt" },
        modulePreload: { polyfill: false },
        outDir: fileURLToPath(new URL("./dist/", import.meta.url)),
        emptyOutDir: true,
    },
});
