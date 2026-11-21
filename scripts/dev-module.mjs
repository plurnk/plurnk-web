import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv, promisify } from "node:util";
import { brotliCompress, gzip } from "node:zlib";
import { build } from "vite";
import createModule from "../src/module.js";
import prepareAssets from "./assets.mjs";

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const CODECS = /** @type {const} */ ([["br", compressBrotli], ["gzip", compressGzip]]);

/** @type {Record<string, string>} */
const MEDIA_TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".txt": "text/plain",
    ".woff2": "font/woff2",
};

/**
 * {§web-asset-encoding} Pre-compress live assets in memory with the same Brotli/gzip discipline as dist/.
 * @param {import("../src/module.js").LoadedAsset["body"]} body
 * @param {string} mediaType
 * @returns {Promise<import("../src/module.js").LoadedAsset>}
 */
async function encodeAsset(body, mediaType) {
    /** @type {Array<readonly [string, import("../src/module.js").LoadedAsset["body"]]>} */
    const variants = mediaType === "text/html" ? [] : (await Promise.all(CODECS.map(async ([encoding, compress]) => {
        const bytes = /** @type {import("../src/module.js").LoadedAsset["body"]} */ (await compress(body));
        return bytes.byteLength < body.byteLength ? /** @type {const} */ ([encoding, bytes]) : null;
    }))).filter((entry) => entry !== null);
    const representations = new Map([["identity", body], ...variants]);
    const preferred = [...representations].toSorted(([, a], [, b]) => a.byteLength - b.byteLength).map(([encoding]) => encoding);
    return { body, mediaType, representations, preferred };
}

/** @param {string} directory */
async function treeSignature(directory) {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => resolve(entry.parentPath, entry.name))
        .sort();
    const parts = await Promise.all(files.map(async (file) => {
        const info = await stat(file);
        return `${relative(directory, file)}:${info.size}:${info.mtimeMs}`;
    }));
    return parts.join("\n");
}

/**
 * {§web-build} Live-source development module: compiles web/ + src/documents.js into a
 * disposable directory whenever source mtime/size changes, preserving production CSP,
 * compressed asset negotiation, and OAuth stylesheet registration without restarting the daemon.
 *
 * @param {{
 *   webRoot?: URL,
 *   documentsUrl?: URL,
 *   configFile?: string,
 * }} [options]
 */
export default function createDevModule(options = {}) {
    const webRoot = options.webRoot ?? new URL("../web/", import.meta.url);
    const documentsUrl = options.documentsUrl ?? new URL("../src/documents.js", import.meta.url);
    const configFile = options.configFile ?? fileURLToPath(new URL("../vite.config.js", import.meta.url));
    const webDir = fileURLToPath(webRoot);
    const documentsPath = fileURLToPath(documentsUrl);
    for (const [key, value] of Object.entries(parseEnv(readFileSync(new URL("../.env.defaults", import.meta.url), "utf8")))) {
        if (value !== undefined) process.env[key] ??= value;
    }

    /** @type {string | null} */
    let outDir = null;
    /** @type {string | null} */
    let registeredStylesheetPath = null;
    /** @type {import("../src/module.js").DocumentKnobs | null} */
    let knobs = null;
    let currentSignature = "";
    let currentDocumentsMtime = -1;
    let generation = 0;
    /** @type {typeof import("../src/documents.js").default | null} */
    let DocumentsClass = null;
    /** @type {{ documents: import("../src/documents.js").default, resources: Map<string, import("../src/module.js").LoadedAsset>, stylesheetPath: string } | null} */
    let compiled = null;
    /** @type {Promise<void> | null} */
    let building = null;

    async function sourceSignature() {
        const [webSig, docStat] = await Promise.all([treeSignature(webDir), stat(documentsPath)]);
        return { signature: `${webSig}\n@documents:${docStat.size}:${docStat.mtimeMs}`, docMtime: docStat.mtimeMs };
    }

    async function ensureCurrent() {
        const { signature, docMtime } = await sourceSignature();
        if (compiled !== null && signature === currentSignature) return compiled;
        if (building !== null) {
            await building;
            if (compiled !== null && (await sourceSignature()).signature === currentSignature) return compiled;
        }
        building = (async () => {
            if (outDir === null) outDir = await mkdtemp(join(tmpdir(), "plurnk-web-dev-"));
            if (DocumentsClass === null || docMtime !== currentDocumentsMtime) {
                generation += 1;
                const mod = await import(`${pathToFileURL(documentsPath).href}?v=${generation}`);
                DocumentsClass = mod.default;
                currentDocumentsMtime = docMtime;
            }
            await build({
                configFile,
                root: webDir,
                logLevel: "error",
                build: {
                    outDir,
                    emptyOutDir: true,
                },
            });
            const entries = (await readdir(outDir, { recursive: true, withFileTypes: true }))
                .filter((entry) => entry.isFile());
            const assetPairs = await Promise.all(entries.map(async (entry) => {
                const full = resolve(entry.parentPath, entry.name);
                const rel = relative(outDir, full).replaceAll("\\", "/");
                const mediaType = MEDIA_TYPES[extname(rel)];
                if (!mediaType) throw new Error(`Undeclared media type for built asset: ${rel}`);
                return /** @type {const} */ ([`/${rel}`, await encodeAsset(await readFile(full), mediaType)]);
            }));
            /** @type {Map<string, import("../src/module.js").LoadedAsset>} */
            const resources = new Map(assetPairs);
            const root = resources.get("/index.html");
            if (root === undefined) throw new Error("The web asset inventory must include index.html.");
            const stylesheetPath = DocumentsClass.stylesheet(root.body.toString("utf8"));
            const stylesheetAsset = resources.get(stylesheetPath);
            if (!stylesheetAsset || stylesheetAsset.mediaType !== "text/css") {
                throw new Error("The application stylesheet is absent from the web asset inventory.");
            }
            if (registeredStylesheetPath !== null && registeredStylesheetPath !== stylesheetPath) {
                resources.set(registeredStylesheetPath, stylesheetAsset);
            }
            const activeKnobs = knobs ?? { yolo: null, overviewSessions: null, overviewExcerptChars: null };
            const documents = new DocumentsClass(
                root.body.toString("utf8"),
                activeKnobs.yolo,
                activeKnobs.overviewSessions,
                activeKnobs.overviewExcerptChars,
            );
            compiled = { documents, resources, stylesheetPath };
            currentSignature = (await sourceSignature()).signature;
        })();
        try {
            await building;
        } finally {
            building = null;
        }
        if (compiled === null) throw new Error("Development build produced no assets.");
        return compiled;
    }

    return createModule({
        async setupStylesheet() {
            await prepareAssets(webRoot);
            const state = await ensureCurrent();
            registeredStylesheetPath = state.stylesheetPath;
            return state.stylesheetPath;
        },
        async start(initialKnobs) {
            knobs = initialKnobs;
            if (compiled === null) {
                await prepareAssets(webRoot);
                await ensureCurrent();
                return;
            }
            const root = compiled.resources.get("/index.html");
            if (root === undefined || DocumentsClass === null) {
                compiled = null;
                await ensureCurrent();
                return;
            }
            compiled = {
                ...compiled,
                documents: new DocumentsClass(
                    root.body.toString("utf8"),
                    initialKnobs.yolo,
                    initialKnobs.overviewSessions,
                    initialKnobs.overviewExcerptChars,
                ),
            };
        },
        async snapshot() {
            const state = await ensureCurrent();
            return { documents: state.documents, resources: state.resources };
        },
        async close() {
            if (outDir !== null) {
                const dir = outDir;
                outDir = null;
                await rm(dir, { recursive: true, force: true });
            }
        },
    });
}
