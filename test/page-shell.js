import assert from "node:assert/strict";

// {§web-page-shell} Measure the rendered document, including focus and narrow-screen layout.
export default async function verifyPageShell(page, { title, kind }) {
    assert.equal(await page.title(), title);
    assert.equal(await page.locator("main").count(), 1);
    assert.equal(await page.locator("main h1").count(), ["home", "search", "workspace", "session"].includes(kind) ? 0 : 1);
    assert.equal(await page.locator("main").getAttribute("data-page"), kind);
    const navigation = page.getByRole("navigation", { name: "Main navigation", exact: true });
    const home = page.getByRole("banner").getByRole("link", { name: "Plurnk", exact: true });
    assert.equal(await home.getAttribute("href"), "/");
    assert.equal(await home.getAttribute("title"), "Plurnk");
    assert.equal(await home.innerText(), "", "the mascot has no duplicate brand text");
    assert.equal(await home.getByRole("img", { name: "Plurnk", exact: true }).getAttribute("src"), "/icons/plurnk.svg");
    const searchLink = navigation.getByRole("link", { name: "Search", exact: true });
    assert.equal(await searchLink.getAttribute("href"), "/search/");
    assert.equal(await searchLink.locator("svg").count(), 1);
    assert.equal(await page.locator("[style], [class]").count(), 0);
    if (kind === "error" || kind === "account") {
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
    const createGroup = page.locator("header > [data-header-create]");
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
        const expected = ["home", "search", "workspace", "session"].includes(kind) ? bounds.viewport : Math.min(bounds.readable, bounds.viewport);
        assert.ok(Math.abs(bounds.content - expected) < 1, `${kind} main width ${bounds.content} should be ${expected}`);
        assert.ok(Math.abs(bounds.header - bounds.viewport) < 1, `${kind} header spans the full viewport width`);
        const centers = await navigation.locator("li > a, li > form > button").evaluateAll((elements) => elements.map((element) => {
            const bounds = element.getBoundingClientRect();
            return bounds.y + bounds.height / 2;
        }));
        const logo = await home.boundingBox();
        centers.push(logo.y + logo.height / 2);
        assert.ok(Math.max(...centers) - Math.min(...centers) < 2, `${width}px: header controls share one horizontal row (${centers.join(", ")})`);
        if (await place.count()) {
            const placeBox = await place.boundingBox();
            const menuBox = await navigation.boundingBox();
            const leftEdge = (await createGroup.count()) ? (await createGroup.boundingBox()).x + (await createGroup.boundingBox()).width : logo.x + logo.width;
            assert.ok(placeBox.x >= leftEdge - 1 && placeBox.x + placeBox.width <= menuBox.x + 1, "header place stays between left controls and main navigation");
            assert.ok(Math.abs(placeBox.y + placeBox.height / 2 - logo.y - logo.height / 2) < 2,
                "header place stays centered on the controls' row, never a second header row");
        }
    }
    await page.setViewportSize({ width: 320, height: 900 });
    for (const [role, name, expectedTitle] of [["link", "Search", "Search (Ctrl+K)"], ["link", "Profile", "Profile"], ["button", "Sign out", "Sign out"]]) {
        const control = navigation.getByRole(role, { name, exact: true });
        if (await control.count() === 0) continue;
        assert.equal((await control.innerText()).trim(), "", "320px collapses header text labels to icon actions");
        assert.equal(await control.locator("svg").count(), 1);
        assert.equal(await control.getAttribute("title"), expectedTitle, "icon actions retain native explanatory titles");
    }
    assert.equal(await page.getByRole("link", { name: "Skip to content", exact: true }).count(), 0);
    await home.focus();
    if (await createGroup.count() === 0 && await place.locator("a, button").count() === 0) {
        await page.keyboard.press("Tab");
        assert.ok(await searchLink.evaluate((element) => {
            const style = getComputedStyle(element);
            return document.activeElement === element && (style.boxShadow !== "none" || style.outlineStyle !== "none");
        }), "Search retains native keyboard order and visible focus");
        if (await navigation.getByRole("link", { name: "Profile", exact: true }).count()) {
            for (const [role, name] of [["link", "Profile"], ["button", "Sign out"]]) {
                await page.keyboard.press("Tab");
                assert.ok(await navigation.getByRole(role, { name, exact: true }).evaluate((element) => {
                    const style = getComputedStyle(element);
                    return document.activeElement === element && (style.boxShadow !== "none" || style.outlineStyle !== "none");
                }), `${name} retains native keyboard order and visible focus`);
            }
        }
    }
}
