import { existsSync } from "node:fs";
import { after } from "node:test";
import { chromium, firefox, webkit } from "playwright";

// {§web-build} The supported browser engines tested across component and installed suites.
export const engines = [chromium, firefox, webkit];

const MESA_EGL = "/usr/share/glvnd/egl_vendor.d/50_mesa.json";
const webkitEnv = existsSync(MESA_EGL)
    ? { ...process.env, __EGL_VENDOR_LIBRARY_FILENAMES: MESA_EGL, LIBGL_ALWAYS_SOFTWARE: "1" }
    : undefined;

/** @type {Map<import("playwright").BrowserType, (options?: import("playwright").LaunchOptions) => Promise<import("playwright").Browser>>} */
const rawLaunch = new Map(engines.map((engine) => {
    const launch = engine.launch.bind(engine);
    return [engine, (options) => launch(
        engine === webkit && webkitEnv ? { ...options, env: { ...webkitEnv, ...options?.env } } : options,
    )];
}));

/** @type {Map<import("playwright").BrowserType, Promise<import("playwright").Browser>>} */
const shared = new Map();

/**
 * Reuse one OS browser process per engine while isolating each caller's contexts so `browser.close()` cleans up only
 * the contexts opened by that test.
 * @param {import("playwright").BrowserType} engine
 * @param {import("playwright").LaunchOptions} [options]
 */
export async function launchBrowser(engine, options) {
    const launch = rawLaunch.get(engine) ?? engine.launch.bind(engine);
    if (options && Object.keys(options).length > 0) return launch(options);
    let pending = shared.get(engine);
    if (pending) {
        const existing = await pending.catch(() => null);
        if (!existing?.isConnected()) {
            shared.delete(engine);
            pending = undefined;
        }
    }
    if (!pending) {
        pending = launch();
        shared.set(engine, pending);
    }
    const browser = await pending;
    /** @type {Set<import("playwright").BrowserContext>} */
    const contexts = new Set();
    return /** @type {any} */ ({
        browserType: () => engine,
        version: () => browser.version(),
        isConnected: () => browser.isConnected(),
        contexts: () => [...contexts],
        /** @param {import("playwright").BrowserContextOptions} [contextOptions] */
        async newContext(contextOptions) {
            const context = await browser.newContext(contextOptions);
            contexts.add(context);
            context.once("close", () => contexts.delete(context));
            return context;
        },
        /** @param {import("playwright").BrowserContextOptions} [pageOptions] */
        async newPage(pageOptions) {
            const context = await this.newContext(pageOptions);
            return context.newPage();
        },
        async close() {
            await Promise.allSettled([...contexts].map((context) => context.close()));
            contexts.clear();
        },
    });
}

for (const engine of engines) {
    engine.launch = (options) => launchBrowser(engine, options);
}

export async function closeSharedBrowsers() {
    const browsers = [...shared.values()];
    shared.clear();
    await Promise.allSettled(browsers.map(async (pending) => (await pending).close()));
}

after(closeSharedBrowsers);

