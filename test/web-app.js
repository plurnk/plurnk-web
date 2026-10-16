import assert from "node:assert/strict";
import browserDiagnostics, { httpFailure } from "./browser-diagnostics.js";

function contrast(foreground, background) {
    const luminance = (color) => color.match(/[\d.]+/gu).slice(0, 3)
        .map((value) => Number(value) / 255)
        .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
        .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
    const a = luminance(foreground);
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export default async function verifyWebApp(browser, base) {
    const context = await browser.newContext();
    const checkBrowser = browserDiagnostics(context);
    try {
        const tab = await context.newPage();
        const cdp = await context.newCDPSession(tab);
        await cdp.send("Page.enable");
        await tab.goto(base);
        const { url, errors, data } = await cdp.send("Page.getAppManifest");
        assert.equal(url, new URL("/manifest.webmanifest", base).href);
        assert.deepEqual(errors, []);
        const manifest = JSON.parse(data);
        assert.equal(manifest.id, "/");
        assert.equal(manifest.start_url, "/");
        assert.equal(manifest.scope, "/");
        assert.equal(manifest.name, "Plurnk");
        assert.equal(manifest.short_name, "Plurnk");
        assert.equal(manifest.display, "standalone");
        assert.equal(manifest.theme_color, "#148800");
        assert.equal(manifest.background_color, "#ffffff");
        assert.equal(manifest.lang, "en");
        assert.equal(manifest.dir, "ltr");
        assert.deepEqual(manifest.icons.map(({ sizes, purpose }) => [sizes, purpose]),
            [["any", "any"], ["any", "maskable"]]);
        assert.deepEqual((await cdp.send("Page.getInstallabilityErrors")).installabilityErrors, []);

        for (const [name, content] of Object.entries({
            "viewport": "width=device-width, initial-scale=1",
            "color-scheme": "light dark",
            "theme-color": manifest.theme_color,
            "application-name": manifest.name,
            "description": manifest.description,
            "robots": "noindex, nofollow",
            "referrer": "same-origin",
        })) {
            assert.equal(await tab.locator(`meta[name="${name}"]`).getAttribute("content"), content, name);
        }
        assert.equal(await tab.locator("html").getAttribute("lang"), "en");
        assert.equal(await tab.locator("meta[charset]").getAttribute("charset"), "utf-8");
        assert.deepEqual(await tab.locator('link[rel="icon"]').evaluateAll((links) => links.map((link) => [link.getAttribute("href"), link.getAttribute("sizes")])),
            [["/icons/plurnk.svg", "any"]]);
        assert.equal(await tab.locator('link[rel="apple-touch-icon"]').count(), 0);

        for (const { src } of manifest.icons) {
            const res = await fetch(new URL(src, base));
            assert.equal(res.status, 200, src);
            assert.equal(res.headers.get("content-type"), "image/svg+xml");
            const dimensions = await tab.evaluate(async (src) => {
                const image = new Image();
                image.src = src;
                await image.decode();
                return [image.naturalWidth, image.naturalHeight];
            }, src);
            assert.ok(dimensions.every((value) => value > 0), `${src}: scalable artwork decodes`);
        }
        const mask = await tab.evaluate(async () => {
            const image = new Image();
            image.src = "/icons/plurnk-maskable.svg";
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 512;
            const context = canvas.getContext("2d");
            context.drawImage(image, 0, 0, 512, 512);
            const { data } = context.getImageData(0, 0, 512, 512);
            let transparent = 0;
            let outside = 0;
            let inside = 0;
            for (let y = 0; y < 512; y++) {
                for (let x = 0; x < 512; x++) {
                    const i = (y * 512 + x) * 4;
                    if (data[i + 3] !== 255) transparent++;
                    if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) {
                        if (Math.hypot(x + 0.5 - 256, y + 0.5 - 256) > 512 * 0.4) outside++;
                        else inside++;
                    }
                }
            }
            return { transparent, outside, inside };
        });
        assert.equal(mask.transparent, 0, "maskable background must be opaque");
        assert.equal(mask.outside, 0, "all mascot artwork fits in the safe circle");
        assert.ok(mask.inside > 10_000, "maskable icon contains the mascot, not a blank background");

        assert.equal((await tab.goto(new URL("/missing", base).href)).status(), 404);
        assert.equal(await tab.locator("h1").innerText(), "⚠️ 404 Not Found");
        for (const colorScheme of ["light", "dark"]) {
            await tab.emulateMedia({ colorScheme });
            const colors = await tab.evaluate(() => {
                const link = document.createElement("a");
                link.href = "/";
                link.textContent = "Contrast specimen";
                const button = document.createElement("button");
                button.textContent = "Contrast specimen";
                document.body.append(link, button);
                const result = {
                    background: getComputedStyle(document.documentElement).backgroundColor,
                    heading: getComputedStyle(document.querySelector("h1")).color,
                    link: getComputedStyle(link).color,
                    button: getComputedStyle(button).color,
                    buttonBackground: getComputedStyle(button).backgroundColor,
                };
                link.remove();
                button.remove();
                return result;
            });
            assert.ok(contrast(colors.heading, colors.background) >= 4.5, `${colorScheme} heading contrast`);
            assert.ok(contrast(colors.link, colors.background) >= 4.5, `${colorScheme} link contrast`);
            assert.ok(contrast(colors.button, colors.buttonBackground) >= 4.5, `${colorScheme} button contrast`);
            assert.equal(colors.buttonBackground, "rgb(20, 136, 0)", "brand color owns the primary button");
        }
        for (const theme of ["light", "dark"]) {
            await tab.emulateMedia({ colorScheme: theme === "light" ? "dark" : "light" });
            const resolved = await tab.evaluate((theme) => {
                document.documentElement.dataset.theme = theme;
                const root = getComputedStyle(document.documentElement);
                return { scheme: root.colorScheme, primary: root.getPropertyValue("--pico-primary").trim() };
            }, theme);
            assert.deepEqual(resolved, { scheme: theme, primary: theme === "light" ? "#148800" : "#4eb31b" });
        }
        await tab.evaluate(() => document.documentElement.removeAttribute("data-theme"));
        for (const width of [320, 768, 1280]) {
            await tab.setViewportSize({ width, height: 720 });
            assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        }
        assert.deepEqual(await tab.evaluate(() => caches.keys()), []);
        assert.equal(await tab.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
        checkBrowser([httpFailure("/missing", 404)]);
    } finally {
        await context.close();
    }
}
