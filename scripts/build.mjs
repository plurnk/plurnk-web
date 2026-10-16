import { readFile, readdir, writeFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, gzip } from "node:zlib";
import { build } from "vite";
import "./assets.mjs";

// Keep npm pack --json's stdout machine-readable, including during prepack.
await build({ logLevel: "warn" });

// {§web-assets} An inventory makes every emitted asset required at startup.
const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".txt": "text/plain",
};
const output = fileURLToPath(new URL("../ai.plurnk/dist/", import.meta.url));
const files = (await readdir(output, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => {
        const file = relative(output, resolve(entry.parentPath, entry.name)).replaceAll("\\", "/");
        const type = types[extname(file)];
        if (!type) throw new Error(`Undeclared media type for built asset: ${file}`);
        return [`/${file}`, file, type];
    })
    .sort(([a], [b]) => a.localeCompare(b));
// {§web-asset-encoding} Sidecars belong to their resource, never the public URL inventory.
const codecs = [["br", ".br", promisify(brotliCompress)], ["gzip", ".gz", promisify(gzip)]];
const inventory = await Promise.all(files.map(async ([path, file, type]) => {
    const body = await readFile(resolve(output, file));
    const encoded = type === "text/html" ? [] : await Promise.all(codecs.map(async ([encoding, suffix, compress]) => {
        const bytes = await compress(body);
        if (bytes.byteLength >= body.byteLength) return null;
        const target = `${file}${suffix}`;
        await writeFile(resolve(output, target), bytes);
        return [encoding, target];
    }));
    return [path, file, type, Object.fromEntries(encoded.filter(Boolean))];
}));
await writeFile(new URL("../ai.plurnk/assets.json", import.meta.url), JSON.stringify(inventory, null, 2) + "\n");
console.error(`Built ${inventory.length} production assets in ai.plurnk/dist/.`);
