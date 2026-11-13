import assert from "node:assert/strict";
import { chromium } from "playwright";
import { engines } from "./engines.js";
import browserDiagnostics, { httpFailure } from "./browser-diagnostics.js";
import conversationFixture from "./conversation-fixture.js";

const SAMPLES = {
    ts: "// greet\nexport function greet(name: string): number {\n    return `hi ${name}`.length + 42;\n}\n",
    diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old line\n+new line\n",
    json: "{\n  \"key\": [1, true, null, \"text\"]\n}\n",
    sh: "# comment\nif [ -n \"$HOME\" ]; then echo \"ok\"; fi\n",
};
const fence = (language, code) => "```" + language + "\n" + code + "```";

/** Every registered range, by highlight name, with whether its text node is in the document. */
const ranges = (page) => page.evaluate(() => [...CSS.highlights].map(([name, highlight]) =>
    [name, [...highlight].map((range) => ({ connected: range.startContainer.isConnected, text: range.toString() }))]));

export async function verifyCodeHighlight(t) {
    const { server, url } = await conversationFixture();
    try {
        for (const engine of engines) {
            await t.test(engine.name(), async (t) => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    await page.goto(url);
                    await page.waitForFunction(() => typeof window.present === "function");
                    const present = (messages) => page.evaluate((messages) => window.present(messages), messages);
                    const loaded = () => page.evaluate(() => performance.getEntriesByType("resource").map(({ name }) => name).filter((name) => /code-highlight-renderer-/u.test(name)));

                    await t.test("plain, untagged, indented and inline code load nothing", async () => {
                        await present([{ id: "plain", role: "assistant", content: [fence("text", "const x = 1;\n"), fence("", "let y;\n"), fence("Plaintext", "z\n"), "    indented\n", "`inline`"].join("\n\n") }]);
                        assert.equal(await page.locator("[data-messages] pre code").count(), 4);
                        assert.equal(await page.locator("[data-code-lang]").count(), 0);
                        assert.deepEqual(await loaded(), []);
                    });

                    await t.test("language-tagged fences highlight through ranges without changing the content", async () => {
                        await present([{ id: "code", role: "assistant", content: Object.entries(SAMPLES).map(([language, code]) => fence(language, code)).join("\n\n") + "\n\n" + fence("TypeScript extra", "let n = 1;\n") }]);
                        await page.waitForFunction(() => document.querySelectorAll("[data-code-highlighted]").length === 5);
                        const article = page.locator("[data-messages] article");
                        assert.deepEqual(await article.locator("pre code").evaluateAll((codes) => codes.map((code) => code.dataset.codeLang)), ["ts", "diff", "json", "sh", "typescript"]);
                        assert.deepEqual(await article.locator("pre code").evaluateAll((codes) => codes.map((code) => code.childNodes.length === 1 && code.firstChild.nodeType === Node.TEXT_NODE)), [true, true, true, true, true]);
                        assert.deepEqual((await article.locator("pre code").allTextContents()).slice(0, 4), Object.values(SAMPLES));
                        assert.equal(await article.locator("[class], [style], span").count(), 0, "highlighting adds no markup to content");
                        const assets = await loaded();
                        assert.ok(assets.some((name) => name.endsWith(".js")) && assets.some((name) => name.endsWith(".css")), "renderer and palette load lazily");
                        assert.ok(assets.every((name) => new URL(name).origin === new URL(url).origin));
                        const registered = Object.fromEntries((await ranges(page)).map(([name, list]) => [name, list.map(({ text }) => text)]));
                        for (const [name, token] of [["plurnk-code-keyword", "export"], ["plurnk-code-keyword", "return"], ["plurnk-code-comment", "// greet"],
                            ["plurnk-code-string", "\"text\""], ["plurnk-code-number", "42"], ["plurnk-code-title", "greet"],
                            ["plurnk-code-inserted", "+new line"], ["plurnk-code-deleted", "-old line"], ["plurnk-code-comment", "# comment"]]) {
                            assert.ok(registered[name]?.includes(token), `${name} covers ${JSON.stringify(token)}: ${JSON.stringify(registered[name])}`);
                        }
                    });

                    await t.test("every token color keeps 4.5:1 against the code background in both schemes", async () => {
                        for (const colorScheme of /** @type {const} */ (["light", "dark"])) {
                            await page.emulateMedia({ colorScheme });
                            const ratios = await page.locator("[data-messages] pre code").first().evaluate((code) => {
                                const rgb = (value) => value.match(/[\d.]+/gu).slice(0, 3).map(Number);
                                const luminance = (value) => {
                                    const [r, g, b] = rgb(value).map((channel) => channel / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
                                    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
                                };
                                // The painted background is the nearest opaque one behind the code.
                                let surface = code;
                                while (surface && (getComputedStyle(surface).backgroundColor.match(/[\d.]+/gu)?.[3] ?? "1") === "0") surface = surface.parentElement;
                                const background = getComputedStyle(surface ?? document.body).backgroundColor;
                                return [...CSS.highlights.keys()].map((name) => {
                                    const color = getComputedStyle(code, `::highlight(${name})`).color;
                                    const [light, dark] = [luminance(color), luminance(background)].sort((a, b) => b - a);
                                    return { name, color, ratio: (light + 0.05) / (dark + 0.05) };
                                });
                            });
                            assert.ok(ratios.length >= 8, `${colorScheme}: ${JSON.stringify(ratios)}`);
                            for (const { name, color, ratio } of ratios) assert.ok(ratio >= 4.5, `${colorScheme} ${name} ${color}: ${ratio.toFixed(2)}`);
                        }
                        await page.emulateMedia({ colorScheme: null });
                    });

                    await t.test("an unchanged outlet keeps its ranges; a replaced generation releases them", async () => {
                        const before = await ranges(page);
                        await present([{ id: "code", role: "assistant", content: Object.entries(SAMPLES).map(([language, code]) => fence(language, code)).join("\n\n") + "\n\n" + fence("TypeScript extra", "let n = 1;\n") },
                            { id: "later", role: "assistant", content: "Later" }]);
                        assert.deepEqual(await ranges(page), before, "an unchanged body is not highlighted again");
                        await present([{ id: "next", role: "assistant", content: fence("js", "const answer = 42;\n") }]);
                        await page.waitForFunction(() => document.querySelectorAll("[data-code-highlighted]").length === 1);
                        const after = (await ranges(page)).flatMap(([, list]) => list);
                        assert.ok(after.length > 0);
                        assert.ok(after.every(({ connected }) => connected), "no range outlives its text node");
                    });
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}

export async function verifyUnavailableCodeHighlight() {
    const { server, url } = await conversationFixture();
    try {
        const browser = await chromium.launch();
        try {
            const context = await browser.newContext();
            const checkBrowser = browserDiagnostics(context);
            const page = await context.newPage();
            const refused = [];
            await page.route("**/code-highlight-renderer-*.js", (route) => {
                refused.push(new URL(route.request().url()).pathname);
                return route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });
            });
            await page.goto(url);
            await page.waitForFunction(() => typeof window.present === "function");
            await page.evaluate((content) => window.present([{ id: "code", role: "assistant", content }]), fence("ts", SAMPLES.ts));
            await page.locator('[data-code-error="Syntax highlighting unavailable"]').waitFor();
            assert.equal(await page.locator("[data-messages] pre code").textContent(), SAMPLES.ts);
            assert.equal(await page.evaluate(() => CSS.highlights.size), 0);
            await page.evaluate(() => window.present([{ id: "plain", role: "assistant", content: "**Still connected**" }]));
            assert.equal(await page.locator("[data-messages] article strong").textContent(), "Still connected");
            assert.ok(refused.length > 0, "the renderer's chunk was actually refused");
            assert.equal(new Set(refused).size, 1, "only the intended chunk was refused");
            checkBrowser([...refused.map((path) => httpFailure(path, 404)),
                new RegExp(`^exception: Failed to fetch dynamically imported module: ${RegExp.escape(new URL(refused[0], url).href)}$`, "u")]);
        } finally { await browser.close(); }
    } finally { await server.close(); }
}
