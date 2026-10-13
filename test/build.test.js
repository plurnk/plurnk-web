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
    assert.ok(inventory.some(([path, , type]) => path === "/" && type === "text/html"));
    assert.ok(inventory.some(([path]) => path === "/manifest.webmanifest"));
});

test("{§web-language} source-only build declares and packages no dictionary", async () => {
    const html = await readFile(new URL("../ai.plurnk/dist/index.html", import.meta.url), "utf8");
    assert.doesNotMatch(html, /<meta\b[^>]*name="i18n"/u);
    assert.match(html, /<h1 data-i18n="greeting">Hello world<\/h1>/u);
    const inventory = JSON.parse(await readFile(new URL("../ai.plurnk/assets.json", import.meta.url), "utf8"));
    assert.ok(!inventory.some(([path]) => path.startsWith("/locales/")));
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
