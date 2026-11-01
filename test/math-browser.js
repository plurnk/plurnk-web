import assert from "node:assert/strict";
import { chromium } from "playwright";
import { engines } from "./engines.js";
import browserDiagnostics, { httpFailure } from "./browser-diagnostics.js";
import conversationFixture from "./conversation-fixture.js";

export async function verifyMath(t) {
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
                    const present = (content) => page.evaluate((content) => window.present([{ id: "math", role: "assistant", content }]), content);
                    const body = page.locator("[data-messages] article");

                    await t.test("a delayed renderer cannot resurrect removed content; unchanged math retains its nodes", async () => {
                        const release = Promise.withResolvers();
                        const arrived = page.waitForRequest("**/math-renderer-*.js");
                        await page.route("**/math-renderer-*.js", async (route) => { await release.promise; await route.continue(); });
                        try {
                            assert.equal(await page.evaluate(() => performance.getEntriesByType("resource").some(({ name }) => /math-renderer-|Temml-/u.test(name))), false);
                            await page.evaluate(() => window.present([{ id: "stale", role: "assistant", content: "$old$" }]));
                            await arrived;
                            assert.equal(await page.locator("[data-math] code").textContent(), "$old$");
                            await page.evaluate(() => window.present([{ id: "current", role: "assistant", content: String.raw`New $\mathscr{F}$` }]));
                            release.resolve();
                            await page.locator("math").waitFor();
                            assert.equal(await page.locator("[data-message-id=stale]").count(), 0);
                            assert.equal(await page.locator("math annotation").textContent(), String.raw`\mathscr{F}`);
                            await page.evaluate(async () => {
                                await document.fonts.ready;
                                window.savedMath = document.querySelector("math");
                                window.present([{ id: "current", role: "assistant", content: String.raw`New $\mathscr{F}$` }, { id: "later", role: "assistant", content: "Later" }]);
                            });
                            assert.equal(await page.evaluate(() => window.savedMath === document.querySelector("math")), true);
                            const resources = await page.evaluate(() => performance.getEntriesByType("resource").map(({ name }) => name));
                            assert.ok(resources.some((name) => /\/Temml-[^/]+\.woff2$/u.test(name)), "the required script font is locally packaged and retained by CSS pruning");
                            assert.ok(resources.every((name) => new URL(name).origin === new URL(url).origin));
                        } finally { release.resolve(); await page.unroute("**/math-renderer-*.js"); }
                    });

                    await t.test("all four delimiters produce native math without consuming code or currency", async () => {
                        await present(String.raw`Inline $x^2$, \(\alpha \to \beta\), and **bold**.

$$
\frac{a}{b}
$$

\[
\begin{pmatrix}1&2\\3&4\end{pmatrix}
\]

Costs $50 and $100.

Escaped \$x$; unclosed $x.

` + "`$code$` and `\\(code\\)`\n\n```tex\n$$code$$\n```\n\n    $indented$\n");
                        await page.waitForFunction(() => document.querySelectorAll("math").length === 4);
                        assert.equal(await body.locator("math mfrac").count(), 1);
                        assert.equal(await body.locator("math mtable").count(), 1);
                        assert.equal(await body.locator("math[display=block]").count(), 2);
                        assert.deepEqual(await body.locator("math annotation").allTextContents(), ["x^2", String.raw`\alpha \to \beta`, String.raw`\frac{a}{b}`, String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`]);
                        assert.match(await body.textContent(), /Costs \$50 and \$100\./u);
                        assert.match(await body.textContent(), /Escaped \$x\$; unclosed \$x\./u);
                        assert.deepEqual(await body.locator("code").allTextContents(), ["$code$", String.raw`\(code\)`, "$$code$$\n", "$indented$\n"]);
                        assert.equal(await body.locator("strong").innerText(), "bold");
                    });

                    await t.test("untrusted and malformed TeX cannot create application state or fetch resources", async () => {
                        const requests = [];
                        const record = (request) => requests.push(request.url());
                        page.on("request", record);
                        const source = [String.raw`$\notACommand{a}$`, String.raw`$\href{javascript:alert(1)}{x}$`,
                            String.raw`$\includegraphics{https://example.invalid/math.svg}$`, String.raw`$\htmlClass{evil}{x}$`,
                            String.raw`$\class{evil}{x}$`, String.raw`$\style{position:fixed}{x}$`, String.raw`$\data{text=connection-label}{x}$`,
                            String.raw`$$\begin{equation}x\label{session-status}\end{equation}$$`,
                            String.raw`$\gdef\secret{42}\secret$`, String.raw`$\secret$`,
                            String.raw`$\def\loop{\loop}\loop$`,
                            '<math id="injected"><mi data-text="connection-label">x</mi></math>',
                        ].join("\n\n");
                        await present(source);
                        await page.waitForFunction(() => document.querySelectorAll("[data-math-error]").length >= 2);
                        assert.match(await body.textContent(), /\\notACommand/u);
                        assert.match(await body.textContent(), /\\secret/u, "macros do not leak between expressions");
                        assert.equal(await body.locator("[id], a, img, svg, style, script, [data-text], [data-bind], .evil").count(), 0);
                        assert.equal(await page.locator("#session-status").count(), 1);
                        assert.deepEqual(requests.filter((address) => new URL(address).origin !== new URL(url).origin), []);
                        page.off("request", record);
                    });

                    await t.test("ordinary prose reflows while wide code, tables and math scroll locally", async () => {
                        await present("A long paragraph with " + "ordinary words ".repeat(20) + "\n\n```text\n" + "x".repeat(180) + "\n```\n\n| " + "longcolumn".repeat(15) + " | B |\n| --- | --- |\n| A | B |\n\n$$" + "a+".repeat(80) + "z$$");
                        await body.locator("math").waitFor();
                        for (const width of [320, 768, 420, 320]) {
                            await page.setViewportSize({ width, height: width === 420 ? 320 : 640 });
                            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                            assert.equal(await body.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, "the whole message is not a scroll container");
                            for (const selector of ["pre", "figure:has(> table)", '[data-math="block"]']) {
                                assert.equal(await body.locator(selector).evaluate((element) => getComputedStyle(element).overflowX), "auto");
                                assert.equal(await body.locator(selector).evaluate((element) => element.scrollWidth > element.clientWidth), true);
                            }
                        }
                        for (const colorScheme of ["light", "dark"]) {
                            await page.emulateMedia({ colorScheme });
                            const colors = await body.locator("math").evaluate((element) => ({ math: getComputedStyle(element).color, text: getComputedStyle(element.closest("article")).color }));
                            assert.equal(colors.math, colors.text, "math inherits the current Pico text color");
                        }
                    });
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}

export async function verifyUnavailableMath() {
    const { server, url } = await conversationFixture();
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext();
        const checkBrowser = browserDiagnostics(context);
        const page = await context.newPage();
        const refused = [];
        await page.route("**/math-renderer-*.js", (route) => {
            refused.push(new URL(route.request().url()).pathname);
            return route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });
        });
        await page.goto(url);
        await page.waitForFunction(() => typeof window.present === "function");
        await page.evaluate(() => window.present([{ id: "math", role: "assistant", content: "$x^2$" }]));
        await page.locator('[data-math-error="Math unavailable"]').waitFor();
        assert.equal(await page.locator("[data-math] code").textContent(), "$x^2$");
        assert.equal(await page.locator("math").count(), 0);
        await page.evaluate(() => window.present([{ id: "plain", role: "assistant", content: "**Still connected**" }]));
        assert.equal(await page.locator("[data-messages] article strong").textContent(), "Still connected");
        // The browser may reuse the failed preload instead of requesting the import separately.
        assert.ok(refused.length > 0, "the renderer's chunk was actually refused");
        assert.equal(new Set(refused).size, 1, "only the intended chunk was refused");
        checkBrowser([...refused.map((path) => httpFailure(path, 404)),
            new RegExp(`^exception: Failed to fetch dynamically imported module: ${RegExp.escape(new URL(refused[0], url).href)}$`, "u")]);
    } finally { await browser.close(); await server.close(); }
}
