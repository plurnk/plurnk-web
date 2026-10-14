import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { chromium } from "playwright";
import verifyWebApp from "./web-app.js";
import verifyDocument from "./document.js";
import verifyAgui from "./agui-browser.js";
import startModel from "./model-fixture.js";

const run = promisify(execFile);
const root = new URL("../", import.meta.url);

test("{§web-package} packed plugin on the published daemon", { timeout: 240_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-web-install-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const consumer = join(directory, "consumer");
    const home = join(directory, "home");
    await mkdir(consumer);
    await mkdir(home);
    const { stdout } = await run("npm", ["pack", "--json", "--pack-destination", directory], { cwd: root });
    const archives = Object.values(JSON.parse(stdout));
    assert.equal(archives.length, 1);
    const [archive] = archives;
    assert.ok(archive.files.some(({ path }) => /^ai\.plurnk\/dist\/assets\/.+\.js$/u.test(path)));
    assert.ok(archive.files.some(({ path }) => /^ai\.plurnk\/dist\/assets\/.+\.css$/u.test(path)));
    assert.ok(archive.files.some(({ path }) => path === "ai.plurnk/dist/vendor/OTM-LICENSE.txt"));
    assert.ok(archive.files.some(({ path }) => path === "ai.plurnk/dist/vendor/PICO-LICENSE.txt"));
    assert.ok(archive.files.some(({ path }) => path === "ai.plurnk/assets.json"));
    assert.ok(archive.files.some(({ path }) => path === "ai.plurnk/index-document.js"));
    assert.ok(archive.files.some(({ path }) => path === "ai.plurnk/directory-addresses.js"));
    for (const path of ["manifest.webmanifest", "icons/plurnk.svg", "icons/plurnk-maskable-512.png", "icons/NOTO-NOTICE.txt", "icons/APACHE-2.0.txt",
        ...[16, 32, 180, 192, 512].map((size) => `icons/plurnk-${size}.png`)]) {
        assert.ok(archive.files.some((file) => file.path === `ai.plurnk/dist/${path}`), path);
    }
    assert.ok(!archive.files.some(({ path }) => /^(test|scripts|node_modules|web|ai\.plurnk\/public)\/|vite\.config|\.map$/u.test(path)));
    await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "web-installation-test", private: true, type: "module" }));
    await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund",
        "@plurnk/plurnk-service@3.2.0", join(directory, archive.filename)],
    { cwd: consumer, maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
    await run("npm", ["ls", "--all"], { cwd: consumer, maxBuffer: 8 * 1024 * 1024 });

    const require = createRequire(join(consumer, "package.json"));
    const { default: Launch } = await import(pathToFileURL(require.resolve("@plurnk/plurnk-service/launch")));
    const daemonBin = join(consumer, "node_modules", ".bin", "plurnk-service");
    const plugin = join(consumer, "node_modules", "@plurnk", "plurnk-web");
    await t.test("{§web-directory-addresses} the packed codec preserves exact names", async () => {
        const { directoryPath, parseDirectory } = await import(pathToFileURL(join(plugin, "ai.plurnk", "directory-addresses.js")));
        const directory = { kind: "worker", workspace: "~/project @%/index.html", worker: "user" };
        const path = directoryPath(directory);
        assert.equal(path, "/~/~/project%20%40%25/index.html@user/");
        assert.deepEqual(parseDirectory(new URL(path, "https://example.test").pathname), directory);
    });
    const start = (overrides = {}) => Launch.start({
        command: [daemonBin, "start"],
        cwd: consumer,
        env: {
            PATH: process.env.PATH,
            HOME: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            XDG_DATA_HOME: join(home, ".local", "share"),
            XDG_STATE_HOME: join(home, ".local", "state"),
            XDG_CACHE_HOME: join(home, ".cache"),
            XDG_RUNTIME_DIR: join(home, "run"),
            ...overrides,
        },
        host: "127.0.0.1",
        port: 0,
        readyTimeoutMs: 30_000,
        stopGraceMs: 10_000,
    });
    const withDaemon = async (overrides, verify) => {
        const daemon = await start(overrides);
        try {
            await verify(new URL("/", daemon.url).href, daemon);
        } finally {
            assert.deepEqual(await daemon.stop(), { code: 0, signal: null });
        }
    };

    await t.test("{§web-host} discovery, default floor and route precedence", async (discovery) => {
        await withDaemon({}, async (base) => {
            const page = await fetch(base);
            assert.equal(page.status, 200);
            assert.match(await page.text(), /<h1 data-i18n="greeting">Hello world<\/h1>/u);
            const explicitIndex = await fetch(new URL("/index.html?q=one%2Ftwo", base));
            assert.equal(explicitIndex.status, 200, "{§web-index-documents} packed explicit index selects the root document");
            assert.equal(await explicitIndex.text(), await (await fetch(base)).text());
            const agui = await fetch(new URL("/agui", base));
            assert.notEqual(agui.status, 200);
            assert.match(agui.headers.get("content-type"), /application\/problem\+json/u);
            assert.equal(typeof (await agui.json()).type, "string");
            for (const path of ["/not-a-page", "/~/", "/~/example/", "/~/example@user/"]) {
                const unknown = await fetch(new URL(path, base));
                assert.equal(unknown.status, 404, `${path}: the codec does not activate protected routes`);
                assert.equal(await unknown.text(), "Not found\n");
            }

            const browser = await chromium.launch();
            try {
                await discovery.test("{§web-installation} browser recognizes app metadata and decodes every icon", () => verifyWebApp(browser, base));
                await discovery.test("{§web-language} source English remains intact without translation or persistence", () => verifyDocument(browser, base));
                for (const javaScriptEnabled of [true, false]) {
                    await discovery.test(`{§web-document} classless green follows color preference with JavaScript ${javaScriptEnabled ? "on" : "off"}`, async () => {
                        const context = await browser.newContext({ javaScriptEnabled, colorScheme: "light" });
                        try {
                            const tab = await context.newPage();
                            await tab.goto(base);
                            assert.equal(await tab.locator("main h1").innerText(), "Hello world");
                            assert.equal(await tab.title(), "Plurnk");
                            for (const [colorScheme, primary] of [["light", "#148800"], ["dark", "#4eb31b"]]) {
                                await tab.emulateMedia({ colorScheme });
                                const rendered = await tab.evaluate(() => {
                                    const root = getComputedStyle(document.documentElement);
                                    return {
                                        primary: root.getPropertyValue("--pico-primary").trim(),
                                        scheme: root.colorScheme,
                                        padding: parseFloat(getComputedStyle(document.querySelector("main")).paddingTop),
                                        font: getComputedStyle(document.querySelector("main h1")).fontFamily,
                                        monospace: root.getPropertyValue("--pico-font-family-monospace").trim(),
                                    };
                                });
                                assert.equal(rendered.primary, primary);
                                assert.equal(rendered.scheme, colorScheme);
                                assert.ok(rendered.padding > 0, "semantic main receives the substrate layout");
                                assert.deepEqual(rendered.font.split(",").map((name) => name.trim()),
                                    rendered.monospace.split(",").map((name) => name.trim()),
                                    "headings inherit the system monospace stack");
                            }
                        } finally {
                            await context.close();
                        }
                    });
                }
            } finally {
                await browser.close();
            }
        });
    });

    await t.test("{§web-agui-conformance} official HttpAgent in the browser on an authenticated daemon", async (conformance) => {
        const model = await startModel();
        const token = randomUUID();
        const projectRoot = join(directory, "project");
        await mkdir(projectRoot);
        await writeFile(join(projectRoot, "witness.txt"), "cobalt heron\n");
        try {
            await withDaemon({
                ...model.env,
                PLURNK_AGUI_TOKEN: token,
                PLURNK_MEMBERS_witness: "witness.txt",
            }, async (base) => {
                const browser = await chromium.launch();
                try {
                    await verifyAgui(browser, base, token, projectRoot, model, conformance);
                } finally {
                    await browser.close();
                }
            });
        } finally {
            await model.close();
        }
    });

    await t.test("{§web-host} disabled and invalid settings do not claim root", async () => {
        for (const value of ["0", "invalid"]) {
            await withDaemon({ PLURNK_WEB_ENABLED: value }, async (base, daemon) => {
                const res = await fetch(base);
                assert.equal(res.status, 404);
                const problem = await res.json();
                assert.match(problem.type, /route-not-found/u);
                if (value === "invalid") {
                    assert.match(daemon.stdout() + daemon.stderr(), /PLURNK_WEB_ENABLED/u);
                }
            });
        }
    });

    await t.test("{§web-assets} missing packaged bytes fail startup", async () => {
        const asset = join(plugin, "ai.plurnk", "dist", "index.html");
        const saved = join(directory, "index.html");
        await rename(asset, saved);
        try {
            await assert.rejects(start(), (error) => {
                assert.equal(error.kind, "exited");
                assert.match(error.stdout + error.stderr, /ENOENT/u);
                assert.match(error.stdout + error.stderr, /index\.html/u);
                return true;
            });
        } finally {
            await rename(saved, asset);
        }
    });

    await t.test("{§web-host} duplicate root owner is rejected by the host", async () => {
        const fixture = join(consumer, "node_modules", "@plurnk", "web-conflict-fixture");
        await mkdir(fixture);
        await writeFile(join(fixture, "package.json"), JSON.stringify({
            name: "@plurnk/web-conflict-fixture", version: "1.0.0", type: "module",
            exports: { "./module": "./module.js" }, plurnk: { kind: "module", module: "./module" },
        }));
        await writeFile(join(fixture, "module.js"), 'export default { mounts: ["/"], start(seam) { seam.registerHttpRoute("/", (_req, res) => res.end("conflict")); } };\n');
        try {
            await assert.rejects(start(), (error) => {
                assert.equal(error.kind, "exited");
                assert.match(error.stdout + error.stderr, /plurnk-web/u);
                assert.match(error.stdout + error.stderr, /web-conflict-fixture/u);
                return true;
            });
        } finally {
            await rm(fixture, { recursive: true });
        }
    });

    await t.test("{§web-host} absent package leaves root unclaimed", async () => {
        const saved = join(directory, "uninstalled-plugin");
        await rename(plugin, saved);
        try {
            await withDaemon({}, async (base) => {
                const res = await fetch(base);
                assert.equal(res.status, 404);
                assert.match((await res.json()).type, /route-not-found/u);
            });
        } finally {
            await rename(saved, plugin);
        }
    });

    assert.equal(JSON.parse(await readFile(join(plugin, "plugin.json"), "utf8")).name, "plurnk-web");
});
