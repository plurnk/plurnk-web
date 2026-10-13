import { readdir, writeFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const inventory = (await readdir(output, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => {
        const file = relative(output, resolve(entry.parentPath, entry.name)).replaceAll("\\", "/");
        const type = types[extname(file)];
        if (!type) throw new Error(`Undeclared media type for built asset: ${file}`);
        return [`/${file}`, file, type];
    })
    .sort(([a], [b]) => a.localeCompare(b));
await writeFile(new URL("../ai.plurnk/assets.json", import.meta.url), JSON.stringify(inventory, null, 2) + "\n");
console.error(`Built ${inventory.length} production assets in ai.plurnk/dist/.`);
