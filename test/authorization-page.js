import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Documents from "../src/documents.js";

// {§web-authorization-style} Verify the authority's actual document with the packed application CSS.
export default async function verifyAuthorizationPage(page, response, { warning = false, password = false } = {}) {
    const inventory = JSON.parse(await readFile(new URL("../dist/assets.json", import.meta.url), "utf8"));
    // Lazy renderer stylesheets share the inventory; the authority links only the document's own.
    const stylesheet = Documents.stylesheet(await readFile(new URL("../dist/index.html", import.meta.url), "utf8"));
    assert.ok(inventory.some(([path, , type]) => path === stylesheet && type === "text/css"));
    assert.deepEqual(await page.locator('link[rel="stylesheet"]').evaluateAll((links) => links.map((link) => link.getAttribute("href"))), [stylesheet]);
    assert.equal(await page.locator("style, script, [style], [class]").count(), 0);
    assert.match(response.headers()["content-security-policy"], /style-src 'self'/u);
    assert.doesNotMatch(response.headers()["content-security-policy"], /unsafe-inline/u);
    assert.equal(await page.locator("main > article > header > h1").count(), 1);
    assert.equal(await page.getByLabel("User", { exact: true }).count(), 0);
    if (warning) assert.equal(await page.getByRole("img", { name: "Warning", exact: true }).count(), 1);
    if (password) {
        const input = page.getByLabel("Password", { exact: true });
        assert.equal(await input.getAttribute("type"), "password");
        assert.equal(await input.getAttribute("autocomplete"), "current-password");
    }
    for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme });
        const style = await page.locator("article").evaluate((element) => {
            const article = getComputedStyle(element);
            const input = document.querySelector('input[type="password"]');
            const probe = document.createElement("a");
            document.body.append(probe);
            const primary = getComputedStyle(probe).color;
            probe.remove();
            return {
                font: article.fontFamily, background: article.backgroundColor, shadow: article.boxShadow,
                padding: parseFloat(article.paddingInlineStart), primary,
                inputHeight: input?.getBoundingClientRect().height, inputPadding: input ? parseFloat(getComputedStyle(input).paddingInlineStart) : null,
            };
        });
        assert.match(style.font, /monospace/u);
        assert.notEqual(style.background, "rgba(0, 0, 0, 0)");
        assert.notEqual(style.shadow, "none");
        assert.ok(style.padding > 0);
        assert.equal(style.primary, colorScheme === "light" ? "rgb(20, 136, 0)" : "rgb(78, 179, 27)");
        if (password) {
            assert.ok(style.inputHeight >= 40, "compiled substrate keeps native form-control sizing");
            assert.ok(style.inputPadding > 0);
        }
        for (const width of [320, 1280]) {
            await page.setViewportSize({ width, height: 900 });
            const measure = await page.locator("main").evaluate((element) => {
                const context = document.createElement("canvas").getContext("2d");
                context.font = getComputedStyle(element).font;
                return {
                    viewport: innerWidth, document: document.documentElement.scrollWidth,
                    main: element.getBoundingClientRect().width, readable: context.measureText("0").width * 65,
                };
            });
            assert.equal(measure.document, measure.viewport, "authorization documents do not overflow narrow viewports");
            assert.ok(Math.abs(measure.main - Math.min(width, measure.readable)) < 1, "authorization uses the application's reading measure");
        }
    }
}
