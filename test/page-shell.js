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
    if (kind === "error" || kind === "account") {
        const card = page.getByRole("article");
        assert.equal(await card.count(), 1);
        if (kind === "error") {
            assert.equal(await card.locator('[aria-hidden="true"]').innerText(), "⚠️");
            assert.equal(await card.getByRole("link", { name: "Home", exact: true }).getAttribute("href"), "/");
        }
        for (const colorScheme of ["light", "dark"]) {
            await page.emulateMedia({ colorScheme });
            const style = await card.evaluate((element) => {
                const card = getComputedStyle(element);
                return { padding: parseFloat(card.paddingInlineStart), shadow: card.boxShadow, background: card.backgroundColor };
            });
            assert.ok(style.padding > 0, `${colorScheme}: ${kind} article receives Pico card spacing`);
            assert.notEqual(style.shadow, "none", `${colorScheme}: ${kind} article receives Pico card presentation`);
            assert.notEqual(style.background, "rgba(0, 0, 0, 0)", `${colorScheme}: ${kind} article has a visible surface`);
        }
    }
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
    assert.equal(await page.getByRole("link", { name: "Skip to content", exact: true }).count(), 0);
    await navigation.getByRole("link", { name: "Plurnk", exact: true }).focus();
    await page.keyboard.press("Tab");
    const focus = await navigation.getByRole("link", { name: "Workspaces", exact: true }).evaluate((element) => {
        const style = getComputedStyle(element);
        return { active: document.activeElement === element, shadow: style.boxShadow, outline: style.outlineStyle };
    });
    assert.equal(focus.active, true, "native header links remain keyboard navigable");
    assert.ok(focus.shadow !== "none" || focus.outline !== "none", "keyboard focus remains visible");
}
