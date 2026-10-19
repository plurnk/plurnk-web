import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { build } from "vite";
import { chromium } from "playwright";
import Documents from "../ai.plurnk/documents.js";
import browserDiagnostics from "./browser-diagnostics.js";

test("{§web-page-shell} breadcrumb placement responds to content and available space without JavaScript", async (t) => {
    const inventory = JSON.parse(await readFile(new URL("../ai.plurnk/assets.json", import.meta.url), "utf8"));
    const assets = new Map(await Promise.all(inventory.map(async ([path, file, contentType]) =>
        [path, { body: await readFile(new URL(`../ai.plurnk/dist/${file}`, import.meta.url)), contentType }])));
    const documents = new Documents(assets.get("/index.html").body.toString(), false);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    for (const javaScriptEnabled of [false, true]) {
        const context = await browser.newContext({ javaScriptEnabled });
        const checkBrowser = browserDiagnostics(context);
        try {
            let html;
            await context.route("http://web.test/**", (route) => {
                const path = new URL(route.request().url()).pathname;
                return route.fulfill(path === "/" ? { body: html, contentType: "text/html" } : assets.get(path));
            });
            const page = await context.newPage();
            for (const authenticated of [false, true]) {
                for (const [name, fitsWide] of [["w", true], ["~/ptl/project", true], [`~/project/${"long-name-".repeat(20)}`, false]]) {
                    const port = { listWorkspaces: async () => [{ id: 1, name, project_root: null, project_label: null }], listWorkers: async () => [] };
                    html = await documents.read({ kind: "workspace", workspace: name }, port, authenticated);
                    await page.goto("http://web.test/");
                    assert.equal(await page.locator('header > nav[aria-label="breadcrumb"]').count(), 1);
                    assert.equal(await page.locator('main nav[aria-label="breadcrumb"]').count(), 0);
                    const measure = () => page.evaluate(() => {
                        const header = document.querySelector("body > header");
                        return {
                            header: header.getBoundingClientRect().toJSON(),
                            logo: header.querySelector('a[href="/"]').getBoundingClientRect().toJSON(),
                            menu: header.querySelector('nav[aria-label="Main navigation"]').getBoundingClientRect().toJSON(),
                            breadcrumb: header.querySelector('nav[aria-label="breadcrumb"]').getBoundingClientRect().toJSON(),
                            padding: parseFloat(getComputedStyle(header).paddingInlineStart) * 2,
                            overflow: document.documentElement.scrollWidth > innerWidth,
                            items: [...header.querySelectorAll('nav[aria-label="breadcrumb"] li')].map((item) => item.getBoundingClientRect().toJSON()),
                        };
                    });
                    await page.setViewportSize({ width: 500, height: 700 });
                    const natural = await measure();
                    const threshold = natural.logo.width + natural.menu.width + natural.breadcrumb.width + natural.padding;
                    for (const width of [500, 320, 768, 500]) {
                        await page.setViewportSize({ width, height: 700 });
                        const { logo, menu, breadcrumb, header, overflow, items } = await measure();
                        assert.equal(overflow, false);
                        assert.equal(await page.locator('[aria-current="page"]').innerText(), name);
                        if (fitsWide && width >= threshold) {
                            assert.ok(Math.abs(breadcrumb.y - logo.y) < 1, "a short breadcrumb shares the header row");
                            assert.ok(breadcrumb.x >= logo.right && breadcrumb.right <= menu.x, "the breadcrumb fits between both controls");
                            assert.ok(items.every((item) => Math.abs(item.y - items[0].y) < 1), "an inline breadcrumb stays on one line");
                        } else {
                            assert.ok(breadcrumb.y >= Math.max(logo.bottom, menu.bottom), "the whole breadcrumb clears both controls");
                            assert.ok(Math.abs(breadcrumb.x + breadcrumb.width / 2 - header.x - header.width / 2) < 1, "the lower row is centered");
                        }
                    }
                    if (fitsWide) {
                        for (const [width, inline] of [[Math.ceil(threshold) + 1, true], [Math.floor(threshold) - 1, false]]) {
                            await page.setViewportSize({ width, height: 700 });
                            const { logo, breadcrumb } = await measure();
                            assert.equal(Math.abs(breadcrumb.y - logo.y) < 1, inline, "the actual content width determines wrapping");
                        }
                    }
                    if (name === "~/ptl/project") {
                        await page.setViewportSize({ width: 768, height: 700 });
                        await page.evaluate(() => { document.documentElement.style.fontSize = "48px"; });
                        const { logo, menu, breadcrumb, header, overflow } = await measure();
                        assert.ok(breadcrumb.y >= Math.max(logo.bottom, menu.bottom), "larger text moves the breadcrumb below without a viewport change");
                        assert.ok(Math.abs(breadcrumb.x + breadcrumb.width / 2 - header.x - header.width / 2) < 1);
                        assert.equal(overflow, false);
                        await page.evaluate(() => { document.documentElement.style.removeProperty("font-size"); });
                    }
                }
            }
            checkBrowser();
        } finally {
            await context.close();
        }
    }
});

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
    const license = await readFile(new URL("../ai.plurnk/dist/vendor/DEPENDENCIES-LICENSE.txt", import.meta.url), "utf8");
    assert.match(license, /@ag-ui\/client/u);
    assert.match(license, /temml - 0\.14\.0 \(MIT\)/u);
    assert.match(license, /beautiful-mermaid - 1\.1\.3 \(MIT\)/u);
    assert.match(license, /marked-footnote - 1\.4\.0 \(MIT\)/u);
    assert.match(license, /elkjs/u);
    assert.match(license, /MIT/u);
    const footnoteLicense = await readFile(new URL("../ai.plurnk/dist/vendor/MARKED-FOOTNOTE-LICENSE.txt", import.meta.url), "utf8");
    assert.match(footnoteLicense, /Copyright \(c\) 2023-2024 Stilearning/u);
    assert.match(footnoteLicense, /The above copyright notice and this permission notice shall be included/u);
    assert.ok(inventory.some(([path]) => path === "/vendor/MARKED-FOOTNOTE-LICENSE.txt"));
    assert.ok(inventory.some(([path, , type]) => /\/Temml-[^/]+\.woff2$/u.test(path) && type === "font/woff2"));
    assert.ok(inventory.some(([path]) => /\/math-renderer-[^/]+\.js$/u.test(path)), "math remains a separate lazy chunk");
    assert.ok(inventory.some(([path]) => /\/math-renderer-[^/]+\.css$/u.test(path)), "renderer styles remain separate from the application stylesheet");
    assert.ok(inventory.some(([path]) => /\/mermaid-renderer-[^/]+\.js$/u.test(path)), "diagrams remain a separate lazy chunk");
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

test("{§web-asset-encoding} the build records only useful, lossless static representations", async () => {
    const inventory = JSON.parse(await readFile(new URL("../ai.plurnk/assets.json", import.meta.url), "utf8"));
    for (const [path, file, mediaType, encoded] of inventory) {
        assert.doesNotMatch(path, /\.(br|gz)$/u, "encoded files have no separate public address");
        const original = await readFile(new URL(`../ai.plurnk/dist/${file}`, import.meta.url));
        if (mediaType === "text/html") assert.deepEqual(encoded, {});
        for (const [coding, representation] of Object.entries(encoded)) {
            assert.ok(["br", "gzip"].includes(coding));
            const bytes = await readFile(new URL(`../ai.plurnk/dist/${representation}`, import.meta.url));
            assert.ok(bytes.byteLength < original.byteLength, `${path} ${coding}`);
            assert.deepEqual(coding === "br" ? brotliDecompressSync(bytes) : gunzipSync(bytes), original);
        }
        if (/\/worker-[^/]+\.js$/u.test(path)) assert.deepEqual(Object.keys(encoded).sort(), ["br", "gzip"]);
    }
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
