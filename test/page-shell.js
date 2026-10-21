import assert from "node:assert/strict";

// {§web-page-shell} Measure the rendered document, including focus and narrow-screen layout.
export default async function verifyPageShell(page, { title, kind }) {
    assert.equal(await page.title(), title);
    assert.equal(await page.locator("main").count(), 1);
    assert.equal(await page.locator("main h1").count(), ["home", "daemon", "workspace", "worker"].includes(kind) ? 0 : 1);
    if (kind === "home") assert.equal(await page.locator("main").innerText(), "");
    assert.equal(await page.locator("main").getAttribute("data-page"), kind);
    const navigation = page.getByRole("navigation", { name: "Main navigation", exact: true });
    const home = page.getByRole("banner").getByRole("link", { name: "Plurnk", exact: true });
    assert.equal(await home.getAttribute("href"), "/");
    assert.equal(await home.getAttribute("title"), "Home");
    assert.equal(await home.innerText(), "", "the mascot has no duplicate brand text");
    assert.equal(await home.getByRole("img", { name: "Plurnk", exact: true }).getAttribute("src"), "/icons/plurnk.svg");
    assert.equal(await navigation.getByRole("link", { name: "Workspaces", exact: true }).count(), 0, "no redundant workspace action beside the breadcrumb");
    const root = page.locator('header nav[aria-label="breadcrumb"] > ul > li:first-child > [aria-label="Workspaces"]');
    assert.equal(await root.innerText(), "🗃️");
    assert.equal(await root.getAttribute("title"), "Workspaces");
    if (kind === "daemon") {
        assert.equal(await root.getAttribute("aria-current"), "page");
        assert.equal(await page.getByRole("img", { name: "Workspaces", exact: true }).count(), 1);
    }
    else assert.equal(await root.getAttribute("href"), "/~/");
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
        const expected = ["daemon", "workspace", "worker"].includes(kind) ? bounds.viewport : Math.min(bounds.readable, bounds.viewport);
        assert.ok(Math.abs(bounds.content - expected) < 1, `${kind} main width ${bounds.content} should be ${expected}`);
        assert.ok(Math.abs(bounds.header - expected) < 1, `${kind} navigation shares the document width`);
        const centers = await navigation.locator("li > a, li > form > button").evaluateAll((elements) => elements.map((element) => {
            const bounds = element.getBoundingClientRect();
            return bounds.y + bounds.height / 2;
        }));
        const logo = await home.boundingBox();
        centers.push(logo.y + logo.height / 2);
        assert.ok(Math.max(...centers) - Math.min(...centers) < 1, `${width}px: header controls share one horizontal row (${centers.join(", ")})`);
        const breadcrumb = page.getByRole("navigation", { name: "breadcrumb", exact: true });
        if (await breadcrumb.count()) {
            assert.equal(await page.locator('header > nav[aria-label="breadcrumb"]').count(), 1);
            assert.equal(await page.locator('main nav[aria-label="breadcrumb"]').count(), 0);
            const crumb = await breadcrumb.boundingBox();
            const menu = await navigation.boundingBox();
            assert.ok(crumb.x >= logo.x + logo.width && crumb.x + crumb.width <= menu.x, "breadcrumb clears the controls");
            assert.ok(Math.abs(crumb.y + crumb.height / 2 - logo.y - logo.height / 2) < 1,
                "breadcrumb stays centered on the controls' row, never a second header row");
            const rows = await breadcrumb.locator("li").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().y));
            assert.ok(Math.max(...rows) - Math.min(...rows) < 1, "breadcrumb contents remain one horizontally scrollable row");
        }
    }
    for (const [role, name, glyph] of [["link", "Account", "⚙️"], ["button", "Sign out", "✖"]]) {
        const control = navigation.getByRole(role, { name, exact: true });
        if (await control.count() === 0) continue;
        assert.equal(await control.innerText(), glyph);
        assert.equal(await control.getAttribute("title"), name, "icon actions retain native explanatory titles");
    }
    assert.equal(await page.getByRole("link", { name: "Skip to content", exact: true }).count(), 0);
    await home.focus();
    if (await navigation.getByRole("link", { name: "Account", exact: true }).count()) {
        for (const [role, name] of [["link", "Account"], ["button", "Sign out"]]) {
            await page.keyboard.press("Tab");
            assert.ok(await navigation.getByRole(role, { name, exact: true }).evaluate((element) => {
                const style = getComputedStyle(element);
                return document.activeElement === element && (style.boxShadow !== "none" || style.outlineStyle !== "none");
            }), `${name} retains native keyboard order and visible focus`);
        }
    }
    if (kind !== "daemon") {
        await page.keyboard.press("Tab");
        assert.ok(await root.evaluate((element) => {
            const style = getComputedStyle(element);
            return document.activeElement === element && (style.boxShadow !== "none" || style.outlineStyle !== "none");
        }), "the workspace breadcrumb retains native keyboard order and visible focus");
    }
}
