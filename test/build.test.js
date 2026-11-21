import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { build } from "vite";
import { chromium } from "playwright";
import Documents from "../src/documents.js";
import browserDiagnostics from "./browser-diagnostics.js";

test("{§web-page-shell} compact header stays on one row and long workspace places scroll without JavaScript", async (t) => {
    const inventory = JSON.parse(await readFile(new URL("../dist/assets.json", import.meta.url), "utf8"));
    const assets = new Map(await Promise.all(inventory.map(async ([path, file, contentType]) =>
        [path, { body: await readFile(new URL(`../dist/${file}`, import.meta.url)), contentType }])));
    const documents = new Documents(assets.get("/index.html").body.toString(), false, 128);
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
                for (const name of ["w", "~/ptl/project", `~/project/${"long-name-".repeat(20)}`]) {
                    const port = {
                        listWorkspaces: async () => [{ id: 1, name, project_root: null, project_label: null, archived_at: null }],
                        listSessions: async () => [{ id: 2, name: "user", parentSessionId: null, origin: "model", kind: "root", lifecycle: "idle", archived_at: null }],
                    };
                    html = await documents.read({ kind: "session", workspace: name, session: "user" }, port, authenticated);
                    await page.goto("http://web.test/");
                    assert.equal(await page.locator("header > #header-place").count(), 1);
                    assert.equal(await page.locator('main nav[aria-label="breadcrumb"]').count(), 0);
                    const measure = () => page.evaluate(() => {
                        const header = document.querySelector("body > header");
                        const place = header.querySelector("#header-place");
                        const createGroup = header.querySelector("[data-header-create]");
                        const searchIcon = header.querySelector('[data-nav="search"] > svg');
                        return {
                            header: header.getBoundingClientRect().toJSON(),
                            logo: header.querySelector('a[href="/"]').getBoundingClientRect().toJSON(),
                            mascot: header.querySelector('a[href="/"] > img').getBoundingClientRect().toJSON(),
                            glyph: searchIcon.getBoundingClientRect().toJSON(),
                            create: createGroup.getBoundingClientRect().toJSON(),
                            menu: header.querySelector('nav[aria-label="Main navigation"]').getBoundingClientRect().toJSON(),
                            place: place.getBoundingClientRect().toJSON(),
                            font: parseFloat(getComputedStyle(header).fontSize),
                            scrollable: place.scrollWidth > place.clientWidth,
                            verticalOverflow: place.scrollHeight > place.clientHeight + 1,
                            overflow: document.documentElement.scrollWidth > innerWidth,
                            labelsVisible: [...header.querySelectorAll("[data-header-label]")].every((el) => getComputedStyle(el).display !== "none"),
                        };
                    });
                    for (const width of [500, 320, 768, 500]) {
                        await page.setViewportSize({ width, height: 700 });
                        const { logo, mascot, glyph, create, menu, place, header, overflow, font, scrollable, verticalOverflow, labelsVisible } = await measure();
                        assert.equal(mascot.height, mascot.width, "the mascot retains a square glyph box");
                        assert.ok(glyph.width > 0 && mascot.width >= glyph.width, "the mascot scales alongside header icons");
                        assert.equal(overflow, false);
                        assert.equal(verticalOverflow, false, "place controls fit their scroll area vertically");
                        assert.equal(labelsVisible, width >= 768, `${width}px collapses header button text labels below 768px`);
                        assert.equal(await page.locator('#session-workspace [data-text="workspace-name"]').textContent(), name);
                        assert.equal(await page.locator('#header-session [data-text="active-session-name"]').textContent(), "user");
                        assert.ok(place.y < logo.bottom && place.bottom > logo.y, "place shares the mascot row");
                        assert.ok(menu.y < logo.bottom && menu.bottom > logo.y, "menu shares the mascot row");
                        assert.ok(place.x >= create.right - 1 && place.right <= menu.x + 1, "the place remains between creation and navigation controls");
                        assert.ok(header.height <= Math.max(logo.height, create.height, menu.height, place.height) + font, "header padding is at most one text line in total");
                        await page.locator("#session-workspace").focus();
                        assert.equal(await page.locator("#session-workspace").evaluate((btn) => {
                            const style = getComputedStyle(btn);
                            return document.activeElement === btn && style.boxShadow.includes("inset");
                        }), true, "keyboard focus stays visible inside the header place scroll area");
                        if (name.length > 100) {
                            assert.equal(scrollable, true, "long names are retained in a locally scrollable header place");
                            assert.equal(await page.locator("#header-place").evaluate((el) => {
                                el.scrollLeft = el.scrollWidth;
                                return el.scrollLeft > 0;
                            }), true);
                        }
                    }
                    if (name === "~/ptl/project") {
                        await page.setViewportSize({ width: 768, height: 700 });
                        await page.evaluate(() => { document.documentElement.style.fontSize = "48px"; });
                        const { logo, mascot, glyph, create, menu, place, overflow, verticalOverflow } = await measure();
                        assert.ok(mascot.width >= glyph.width, "the mascot follows enlarged navigation glyphs, not a fixed pixel size");
                        assert.equal(mascot.height, mascot.width);
                        assert.ok(place.y < logo.bottom && place.bottom > logo.y, "large text still has one header row");
                        assert.ok(place.x >= create.right - 1 && place.right <= menu.x + 1);
                        assert.equal(overflow, false);
                        assert.equal(verticalOverflow, false, "large text introduces no vertical header place scroll");
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

test("{§web-page-shell} disconnection is a named header glyph before Search and Profile, not a second connection state", async (t) => {
    const inventory = JSON.parse(await readFile(new URL("../dist/assets.json", import.meta.url), "utf8"));
    const assets = new Map(await Promise.all(inventory.map(async ([path, file, contentType]) =>
        [path, { body: await readFile(new URL(`../dist/${file}`, import.meta.url)), contentType }])));
    const documents = new Documents(assets.get("/index.html").body.toString(), false, 128);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 700 } });
    const checkBrowser = browserDiagnostics(context);
    const port = {
        listWorkspaces: async () => [{ id: 7, name: "project", project_root: null, project_label: null, archived_at: null }],
        listSessions: async () => [{ id: 9, name: "user", parentSessionId: null, origin: "model", kind: "root", lifecycle: "idle", archived_at: null }],
    };
    const emptyPort = {
        listWorkspaces: async () => [{ id: 7, name: "project", project_root: null, project_label: null, archived_at: null }],
        listSessions: async () => [],
    };
    let html;
    await context.route("http://web.test/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill(path === "/" ? { body: html, contentType: "text/html" } : assets.get(path));
    });
    const page = await context.newPage();
    for (const authenticated of [false, true]) {
        html = await documents.read({ kind: "session", workspace: "project", session: "user" }, port, authenticated);
        await page.goto("http://web.test/");
        const indicator = page.getByRole("img", { name: "Disconnected", exact: true, includeHidden: true });
        assert.equal(await indicator.count(), 1);
        assert.equal(await indicator.getAttribute("title"), "Disconnected");
        assert.equal(await indicator.locator("svg").count(), 1);
        for (const colorScheme of /** @type {const} */ (["light", "dark"])) {
            await page.emulateMedia({ colorScheme });
            for (const state of ["initial", "connecting", "connected", "interrupted", "disconnected", "signed-out", "connected"]) {
                await page.locator("#session-status").evaluate((element, state) => { element.dataset.connection = state; }, state);
                assert.equal(await indicator.isVisible(), ["disconnected", "signed-out"].includes(state), `${state}: the header follows observed transport state only`);
                if (await indicator.isVisible()) {
                    const box = await indicator.boundingBox();
                    const search = await page.getByRole("link", { name: "Search", exact: true }).boundingBox();
                    assert.ok(box.x + box.width <= search.x, "the plug is immediately left of Search");
                    assert.ok(Math.abs(box.y + box.height / 2 - search.y - search.height / 2) < 1);
                    if (authenticated) {
                        const profile = await page.getByRole("link", { name: "Profile", exact: true }).boundingBox();
                        assert.ok(search.x + search.width <= profile.x, "Profile follows Search on the same row");
                    }
                }
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            }
        }
        html = await documents.read({ kind: "workspace", workspace: "project" }, emptyPort, authenticated);
        await page.goto("http://web.test/");
        assert.equal(await indicator.isVisible(), false, "a document without an observation never claims disconnection");
    }
    checkBrowser();
});

test("{§web-build} production HTML references compiled assets, not development modules", async () => {
    const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
    assert.match(html, /src="\/assets\/[^"]+\.js"/u);
    assert.match(html, /href="\/assets\/[^"]+\.css"/u);
    assert.doesNotMatch(html, /@vite\/client|\/app\.js|\/styles\/app-/u);
    const inventory = JSON.parse(await readFile(new URL("../dist/assets.json", import.meta.url), "utf8"));
    for (const asset of [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/gu)].map((match) => match[1])) {
        assert.ok(inventory.some(([path]) => path === asset), `inventory includes ${asset}`);
    }
    assert.ok(inventory.some(([path, , type]) => path === "/index.html" && type === "text/html"));
    assert.ok(inventory.some(([path]) => path === "/manifest.webmanifest"));
    const license = await readFile(new URL("../dist/vendor/DEPENDENCIES-LICENSE.txt", import.meta.url), "utf8");
    assert.match(license, /@agentclientprotocol\/sdk/u);
    assert.match(license, /temml - 0\.14\.0 \(MIT\)/u);
    assert.doesNotMatch(license, /beautiful-mermaid|ondine|piscina|elkjs/u, "diagram compilation is absent from browser dependencies");
    assert.match(license, /marked-footnote - 1\.4\.0 \(MIT\)/u);
    assert.match(license, /MIT/u);
    const footnoteLicense = await readFile(new URL("../dist/vendor/MARKED-FOOTNOTE-LICENSE.txt", import.meta.url), "utf8");
    assert.match(footnoteLicense, /Copyright \(c\) 2023-2024 Stilearning/u);
    assert.match(footnoteLicense, /The above copyright notice and this permission notice shall be included/u);
    assert.ok(inventory.some(([path]) => path === "/vendor/MARKED-FOOTNOTE-LICENSE.txt"));
    // {§web-assets} Every bundled package's entry carries its license text, or names the text retained beside it.
    const bare = [...license.matchAll(/^## (\S+) - \S+ \(.*\)\n\n(?=## |$)/gmu)].map(([, name]) => name);
    const retained = (name) => `/vendor/${name.replace(/^@/u, "").replaceAll("/", "-").toUpperCase()}-LICENSE.txt`;
    assert.deepEqual(bare.filter((name) => !inventory.some(([path]) => path === retained(name))), [], "a bundled package without its license text");
    for (const name of bare) {
        const text = await readFile(new URL(`../dist${retained(name)}`, import.meta.url), "utf8");
        assert.ok(text.startsWith(`${name} `) && /Permission|Licensed under|Redistribution/u.test(text), `${retained(name)} holds ${name}'s license`);
    }
    assert.ok(inventory.some(([path, , type]) => /\/Temml-[^/]+\.woff2$/u.test(path) && type === "font/woff2"));
    assert.ok(inventory.some(([path]) => /\/math-renderer-[^/]+\.js$/u.test(path)), "math remains a separate lazy chunk");
    assert.ok(inventory.some(([path]) => /\/math-renderer-[^/]+\.css$/u.test(path)), "renderer styles remain separate from the application stylesheet");
    // {§web-code-content} The highlighter and its palette are their own lazy chunk.
    assert.ok(inventory.some(([path]) => /\/code-highlight-renderer-[^/]+\.js$/u.test(path)), "the highlighter is a separate lazy chunk");
    assert.ok(inventory.some(([path]) => /\/code-highlight-renderer-[^/]+\.css$/u.test(path)), "the palette is separate from the application stylesheet");
    assert.match(license, /highlight\.js - 11\.\d+\.\d+ \(BSD-3-Clause\)/u);
    assert.ok(!inventory.some(([path]) => /mermaid-renderer|\.wasm$/u.test(path)), "no browser diagram compiler or WASM asset");
});

test("{§web-build} {§web-document} production compiles the 5-S cascade and retains native state selectors", async () => {
    const bundle = await build({
        configFile: fileURLToPath(new URL("../vite.config.js", import.meta.url)),
        logLevel: "error",
        build: { write: false },
    });
    const [{ output }] = /** @type {{ output: any[] }[]} */ (Array.isArray(bundle) ? bundle : [bundle]);
    const indexCss = output.find((entry) => entry.type === "asset" && /^assets\/index-[^/]+\.css$/u.test(entry.fileName));
    assert.ok(indexCss, "compiled output includes the root index stylesheet");
    const css = String(indexCss.source);
    const layerPositions = ["schema", "scheme", "structure", "style", "state"].map((layer) => css.indexOf(`@layer ${layer}{`));
    assert.ok(layerPositions.every((pos, i) => pos >= 0 && (i === 0 || pos > layerPositions[i - 1])),
        `5-S cascade layers appear in canonical order: ${JSON.stringify(layerPositions)}`);
    assert.match(css, /aria-invalid/u);
    assert.match(css, /aria-busy/u);
    assert.match(css, /light-dark\(/u);
    assert.match(css, /prefers-reduced-motion/u);
    assert.ok(css.includes("focus-visible"), "native keyboard-focus selectors survive production compilation");
    assert.match(css, /details\[open\]|\[open\]>summary/u, "native disclosure state survives production compilation");
    assert.match(css, /#session-conversation\s+:where\(details\s*>\s*ul\)\s*>\s*li[\s\S]*?list-style:\s*none/u, "conversation loop and operation list resets survive production compilation");
});

test("{§web-asset-encoding} the build records only useful, lossless static representations", async () => {
    const inventory = JSON.parse(await readFile(new URL("../dist/assets.json", import.meta.url), "utf8"));
    for (const [path, file, mediaType, encoded] of inventory) {
        assert.doesNotMatch(path, /\.(br|gz)$/u, "encoded files have no separate public address");
        const original = await readFile(new URL(`../dist/${file}`, import.meta.url));
        if (mediaType === "text/html") assert.deepEqual(encoded, {});
        for (const [coding, representation] of Object.entries(encoded)) {
            assert.ok(["br", "gzip"].includes(coding));
            const bytes = await readFile(new URL(`../dist/${representation}`, import.meta.url));
            assert.ok(bytes.byteLength < original.byteLength, `${path} ${coding}`);
            assert.deepEqual(coding === "br" ? brotliDecompressSync(bytes) : gunzipSync(bytes), original);
        }
        if (/\/session-[^/]+\.js$/u.test(path)) assert.deepEqual(Object.keys(encoded).sort(), ["br", "gzip"]);
    }
});

test("{§web-language} source-only build declares and packages no dictionary", async () => {
    const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
    assert.doesNotMatch(html, /<meta\b[^>]*name="i18n"/u);
    assert.match(html, /<title data-text="page-title">Plurnk<\/title>/u);
    assert.match(html, /<main\b[^>]*data-page="home"[^>]*>\s*<\/main>/u);
    const inventory = JSON.parse(await readFile(new URL("../dist/assets.json", import.meta.url), "utf8"));
    assert.ok(!inventory.some(([path]) => path.startsWith("/locales/")));
});

test("{§web-installation} {§web-page-shell} standalone manifest, viewport-fit=cover and safe-area insets survive without raster fallbacks", async () => {
    const manifest = JSON.parse(await readFile(new URL("../dist/manifest.webmanifest", import.meta.url), "utf8"));
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.start_url, "/");
    assert.equal(manifest.scope, "/");
    assert.equal(manifest.theme_color, "#148800");
    assert.deepEqual(manifest.icons.map(({ src, type, sizes, purpose }) => ({ src, type, sizes, purpose })), [
        { src: "/icons/plurnk.svg", type: "image/svg+xml", sizes: "any", purpose: "any" },
        { src: "/icons/plurnk-maskable.svg", type: "image/svg+xml", sizes: "any", purpose: "maskable" },
    ]);
    const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
    assert.match(html, /<meta\b[^>]*name="viewport"[^>]*content="width=device-width,\s*initial-scale=1,\s*viewport-fit=cover"/u);
    assert.doesNotMatch(html, /apple-mobile-web-app|mobile-web-app-capable|apple-touch-icon|\.png/u);
    const inventory = JSON.parse(await readFile(new URL("../dist/assets.json", import.meta.url), "utf8"));
    assert.ok(!inventory.some(([path]) => path.endsWith(".png")), "no unused raster icon is packed");
    const [, stylesheetFile] = inventory.find(([path]) => path === Documents.stylesheet(html));
    const css = await readFile(new URL(`../dist/${stylesheetFile}`, import.meta.url), "utf8");
    for (const edge of ["top", "right", "bottom", "left"]) {
        assert.match(css, new RegExp(`env\\(safe-area-inset-${edge}`, "u"), `compiled CSS preserves safe-area-inset-${edge}`);
    }
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
