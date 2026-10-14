import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "vite";

test("{§web-build} production HTML references compiled assets, not development modules", async () => {
    const html = await readFile(new URL("../ai.plurnk/dist/index.html", import.meta.url), "utf8");
    assert.match(html, /src="\/assets\/[^"]+\.js"/u);
    assert.match(html, /href="\/assets\/[^"]+\.css"/u);
    assert.doesNotMatch(html, /@vite\/client|\/app\.js|\/styles\/app-/u);
    const inventory = JSON.parse(await readFile(new URL("../ai.plurnk/assets.json", import.meta.url), "utf8"));
    for (const asset of [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/gu)].map((match) => match[1])) {
        assert.ok(inventory.some(([path]) => path === asset), `inventory includes ${asset}`);
    }
    assert.ok(inventory.some(([path, , type]) => path === "/index.html" && type === "text/html"));
    assert.ok(inventory.some(([path]) => path === "/manifest.webmanifest"));
});

test("{§web-build} production prunes unused CSS without dropping native state selectors", async () => {
    const target = fileURLToPath(new URL("../web/styles/index.css", import.meta.url));
    const bundle = await build({
        configFile: fileURLToPath(new URL("../vite.config.js", import.meta.url)),
        logLevel: "error",
        build: { write: false },
        plugins: [{
            name: "css-pruning-witness",
            enforce: "pre",
            async load(id) {
                if (id !== target) return;
                return await readFile(id, "utf8")
                    + '\n:root { --unused-build-witness: red; }'
                    + '\nunused-build-witness { color: red; }'
                    + '\n[aria-invalid="true"] { --retained-build-witness: 1; opacity: var(--retained-build-witness); }';
            },
        }],
    });
    const css = bundle.output.filter((entry) => entry.type === "asset" && entry.fileName.endsWith(".css"))
        .map((entry) => entry.source).join("\n");
    assert.doesNotMatch(css, /unused-build-witness/u);
    assert.match(css, /aria-invalid/u);
    assert.match(css, /retained-build-witness/u);
    assert.match(css, /prefers-color-scheme/u);
    assert.match(css, /prefers-reduced-motion/u);
    assert.ok(css.includes("focus-visible"), "native keyboard-focus selectors survive production pruning");
    assert.match(css, /details\[open\]/u, "native disclosure state survives production pruning");
});

test("{§web-language} source-only build declares and packages no dictionary", async () => {
    const html = await readFile(new URL("../ai.plurnk/dist/index.html", import.meta.url), "utf8");
    assert.doesNotMatch(html, /<meta\b[^>]*name="i18n"/u);
    assert.match(html, /<title data-i18n="title">Plurnk<\/title>/u);
    assert.match(html, /<main\b[^>]*data-page="home"[^>]*>\s*<\/main>/u);
    const inventory = JSON.parse(await readFile(new URL("../ai.plurnk/assets.json", import.meta.url), "utf8"));
    assert.ok(!inventory.some(([path]) => path.startsWith("/locales/")));
});

test("{§web-installation} the modern app declares scalable icons without raster fallbacks", async () => {
    const manifest = JSON.parse(await readFile(new URL("../ai.plurnk/dist/manifest.webmanifest", import.meta.url), "utf8"));
    assert.deepEqual(manifest.icons.map(({ src, type, sizes, purpose }) => ({ src, type, sizes, purpose })), [
        { src: "/icons/plurnk.svg", type: "image/svg+xml", sizes: "any", purpose: "any" },
        { src: "/icons/plurnk-maskable.svg", type: "image/svg+xml", sizes: "any", purpose: "maskable" },
    ]);
    const html = await readFile(new URL("../ai.plurnk/dist/index.html", import.meta.url), "utf8");
    assert.doesNotMatch(html, /apple-mobile-web-app|mobile-web-app-capable|apple-touch-icon|\.png/u);
    const inventory = JSON.parse(await readFile(new URL("../ai.plurnk/assets.json", import.meta.url), "utf8"));
    assert.ok(!inventory.some(([path]) => path.endsWith(".png")), "no unused raster icon is packed");
});

test("{§web-build} compilation removes stale output and emits no source maps", async () => {
    const output = await mkdtemp(join(tmpdir(), "plurnk-web-build-"));
    try {
        await writeFile(join(output, "stale.js"), "obsolete");
        await build({
            configFile: fileURLToPath(new URL("../vite.config.js", import.meta.url)),
            logLevel: "error",
            build: { outDir: output },
        });
        await assert.rejects(readFile(join(output, "stale.js")), { code: "ENOENT" });
        const html = await readFile(join(output, "index.html"), "utf8");
        assert.match(html, /\/assets\//u);
        assert.ok(!(await readdir(output, { recursive: true })).some((file) => file.endsWith(".map")));
    } finally {
        await rm(output, { recursive: true, force: true });
    }
});
