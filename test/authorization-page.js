import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// {§web-authorization-style} Verify the authority's actual document with the packed application CSS.
export default async function verifyAuthorizationPage(page, response, { warning = false, password = false } = {}) {
    const inventory = JSON.parse(await readFile(new URL("../ai.plurnk/assets.json", import.meta.url), "utf8"));
    const [[stylesheet]] = inventory.filter(([, , type]) => type === "text/css");
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
            const root = getComputedStyle(document.documentElement);
            const input = document.querySelector('input[type="password"]');
            return {
                font: article.fontFamily, background: article.backgroundColor, shadow: article.boxShadow,
                padding: parseFloat(article.paddingInlineStart), primary: root.getPropertyValue("--pico-primary").trim(),
                inputHeight: input?.getBoundingClientRect().height, inputPadding: input ? parseFloat(getComputedStyle(input).paddingInlineStart) : null,
            };
        });
        assert.match(style.font, /monospace/u);
        assert.notEqual(style.background, "rgba(0, 0, 0, 0)");
        assert.notEqual(style.shadow, "none");
        assert.ok(style.padding > 0);
        assert.equal(style.primary, colorScheme === "light" ? "#148800" : "#4eb31b");
        if (password) {
            assert.ok(style.inputHeight >= 40, "production pruning keeps Pico's native form-control sizing");
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
