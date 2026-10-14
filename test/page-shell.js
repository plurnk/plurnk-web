import assert from "node:assert/strict";

// {§web-page-shell} Measure the rendered document, including focus and narrow-screen layout.
export default async function verifyPageShell(page, { title, kind }) {
    assert.equal(await page.title(), title);
    assert.equal(await page.locator("main").count(), 1);
    assert.equal(await page.locator("main h1").count(), 1);
    assert.equal(await page.locator("main").getAttribute("data-page"), kind);
    const navigation = page.getByRole("navigation", { name: "Main navigation", exact: true });
    assert.equal(await navigation.getByRole("link", { name: "Plurnk", exact: true }).getAttribute("href"), "/");
    assert.equal(await navigation.getByRole("link", { name: "Workspaces", exact: true }).getAttribute("href"), "/~/");
    assert.equal(await page.locator("[style], [class]").count(), 0);
    for (const width of [320, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const bounds = await page.locator("main").evaluate((main) => {
            const canvas = document.createElement("canvas");
            const context = canvas.getContext("2d");
            context.font = getComputedStyle(main).font;
            return {
                content: main.getBoundingClientRect().width,
                header: document.querySelector("header").getBoundingClientRect().width,
                readable: context.measureText("0").width * 65,
                viewport: innerWidth,
                overflow: document.documentElement.scrollWidth > innerWidth,
            };
        });
        assert.equal(bounds.overflow, false, `${kind} fits ${width}px without horizontal scrolling`);
        const expected = kind === "worker" ? bounds.viewport : Math.min(bounds.readable, bounds.viewport);
        assert.ok(Math.abs(bounds.content - expected) < 1, `${kind} main width ${bounds.content} should be ${expected}`);
        assert.ok(Math.abs(bounds.header - expected) < 1, `${kind} navigation shares the document width`);
    }
    await page.getByRole("link", { name: "Skip to content", exact: true }).focus();
    const focus = await page.evaluate(() => {
        const element = document.activeElement;
        const bounds = element.getBoundingClientRect();
        return { text: element.textContent, width: bounds.width, height: bounds.height };
    });
    assert.equal(focus.text, "Skip to content");
    assert.ok(focus.width > 1 && focus.height > 1, "focused skip link is visible");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "main");
}
