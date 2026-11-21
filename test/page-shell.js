import assert from "node:assert/strict";

// {§web-page-shell} Measure the rendered document, including focus and narrow-screen layout.
export default async function verifyPageShell(page, { title, kind }) {
    assert.equal(await page.title(), title);
    assert.equal(await page.locator("main").count(), 1);
    assert.equal(await page.locator("main h1").count(), ["home", "search", "workspace", "session"].includes(kind) ? 0 : 1);
    assert.equal(await page.locator("main").getAttribute("data-page"), kind);
    const navigation = page.getByRole("navigation", { name: "Main navigation", exact: true });
    const searchLink = page.getByRole("banner").getByRole("link", { name: "Search", exact: true });
    assert.equal(await searchLink.getAttribute("href"), "/search/");
    assert.equal(await searchLink.getAttribute("title"), "Search (Ctrl+K)");
    assert.equal(await searchLink.locator("svg").count(), 1);
    assert.equal(await page.getByRole("banner").locator("img").count(), 0, "top bar carries no mascot image");
    assert.equal(await page.locator("[style], [class]").count(), 0);
    if (kind === "error" || kind === "account" || kind === "settings") {
        const card = page.getByRole("article");
        assert.equal(await card.count(), 1);
        if (kind === "error") {
            assert.equal(await card.locator('[aria-hidden="true"]').innerText(), "⚠️");
            assert.equal(await card.getByRole("link", { name: "Home", exact: true }).getAttribute("href"), "/");
        }
        for (const colorScheme of /** @type {const} */ (["light", "dark"])) {
            await page.emulateMedia({ colorScheme });
            const style = await card.evaluate((element) => {
                const card = getComputedStyle(element);
                return { padding: parseFloat(card.paddingInlineStart), shadow: card.boxShadow, background: card.backgroundColor };
            });
            assert.ok(style.padding > 0, `${colorScheme}: ${kind} article receives substrate card spacing`);
            assert.notEqual(style.shadow, "none", `${colorScheme}: ${kind} article receives substrate card presentation`);
            assert.notEqual(style.background, "rgba(0, 0, 0, 0)", `${colorScheme}: ${kind} article has a visible surface`);
        }
    }
    const place = page.locator("header > #header-place");
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
        const expected = ["home", "search", "workspace", "session", "settings", "account"].includes(kind) ? bounds.viewport : Math.min(bounds.readable, bounds.viewport);
        assert.ok(Math.abs(bounds.content - expected) < 1, `${kind} main width ${bounds.content} should be ${expected}`);
        assert.ok(Math.abs(bounds.header - bounds.viewport) < 1, `${kind} header spans the full viewport width`);
        const centers = await navigation.locator("li > a").evaluateAll((elements) => elements.map((element) => {
            const bounds = element.getBoundingClientRect();
            return bounds.y + bounds.height / 2;
        }));
        const searchBox = await searchLink.boundingBox();
        centers.push(searchBox.y + searchBox.height / 2);
        assert.ok(Math.max(...centers) - Math.min(...centers) < 2, `${width}px: header controls share one horizontal row (${centers.join(", ")})`);
        if (await place.count()) {
            const placeBox = await place.boundingBox();
            const menuBox = await navigation.boundingBox();
            const leftEdge = searchBox.x + searchBox.width;
            assert.ok(placeBox.x >= leftEdge - 1 && placeBox.x + placeBox.width <= menuBox.x + 1, "header place stays between far-left Search and main navigation");
            assert.ok(Math.abs(placeBox.y + placeBox.height / 2 - searchBox.y - searchBox.height / 2) < 2,
                "header place stays centered on the controls' row, never a second header row");
        }
    }
    await page.setViewportSize({ width: 320, height: 900 });
    assert.equal((await searchLink.innerText()).trim(), "", "320px collapses Search text label to icon action");
    const accountLink = navigation.getByRole("link", { name: "Account", exact: true });
    if (await accountLink.count() > 0) {
        assert.equal((await accountLink.innerText()).trim(), "", "320px collapses Account text label to icon action");
        assert.equal(await accountLink.locator("svg").count(), 1);
        assert.equal(await accountLink.getAttribute("title"), "Account", "Account icon retains explanatory title");
    }
    assert.equal(await page.getByRole("link", { name: "Skip to content", exact: true }).count(), 0);
    await searchLink.focus();
    assert.ok(await searchLink.evaluate((element) => {
        const style = getComputedStyle(element);
        return document.activeElement === element && (style.boxShadow !== "none" || style.outlineStyle !== "none");
    }), "Search retains visible keyboard focus");
    if (await place.locator("a:visible, button:visible").count() === 0 && await accountLink.count() > 0) {
        await page.keyboard.press("Tab");
        assert.ok(await accountLink.evaluate((element) => {
            const style = getComputedStyle(element);
            return document.activeElement === element && (style.boxShadow !== "none" || style.outlineStyle !== "none");
        }), "Account retains native keyboard order and visible focus");
    }
}
