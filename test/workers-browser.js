import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { directoryPath } from "../ai.plurnk/directory-addresses.js";
import verifyPageShell from "./page-shell.js";

// {§web-worker-directory} Native navigation on the packed daemon, with the browser's JavaScript posture supplied by the caller.
export default async function verifyWorkerDirectory(page, workspace) {
    const path = (worker) => directoryPath({ kind: "worker", workspace: workspace.name, worker: worker.name });
    const link = (worker) => page.locator(`main li > a[href=${JSON.stringify(path(worker))}]`);
    const entry = (worker) => link(worker).locator("xpath=..");
    const models = workspace.workers.filter(({ origin }) => origin === "model");
    const parentOf = (worker) => workspace.workers.find(({ id }) => id === worker.parentWorkerId);
    const background = models.filter((worker) => worker.parentWorkerId !== null && parentOf(worker).origin !== "model");
    const primary = models.filter(({ parentWorkerId }) => parentWorkerId === null);
    const directory = page.url();
    assert.deepEqual(await page.locator("main > ul > li > a").allTextContents(), primary.map(({ name }) => name));
    assert.deepEqual((await page.locator("main li > a[href*='@']").allTextContents()).toSorted(), models.map(({ name }) => name).toSorted());
    assert.equal(await page.locator("main details[open]").count(), 0);
    assert.equal(await page.locator('main [role="tree"], main [role="treeitem"]').count(), 0);
    const backgroundSection = page.locator("main > details");
    assert.equal(await backgroundSection.count(), background.length === 0 ? 0 : 1);
    if (background.length) {
        assert.equal(await backgroundSection.locator(":scope > summary").innerText(), "Background work");
        assert.deepEqual(await backgroundSection.locator(":scope > ul > li > a").allTextContents(), background.map(({ name }) => name));
    }
    for (const worker of models) {
        const parent = parentOf(worker);
        const enclosing = await link(worker).evaluate((element) => element.parentElement.parentElement.closest("li")?.querySelector(":scope > a")?.getAttribute("href") ?? null);
        assert.equal(enclosing, parent?.origin === "model" ? path(parent) : null, `${worker.name}: immediate model parent`);
        const children = models.filter(({ parentWorkerId }) => parentWorkerId === worker.id);
        const disclosure = entry(worker).locator(":scope > details");
        assert.equal(await disclosure.count(), children.length ? 1 : 0, `${worker.name}: leaves have no disclosure`);
        if (children.length) {
            assert.equal(await disclosure.locator(":scope > summary").textContent(), `${children.length} child worker${children.length === 1 ? "" : "s"}`);
            assert.deepEqual(await disclosure.locator(":scope > ul > li > a").allTextContents(), children.map(({ name }) => name));
        }
        assert.equal(await link(worker).isVisible(), worker.parentWorkerId === null, `${worker.name}: initially collapsed`);
    }
    for (const internal of workspace.workers.filter(({ origin }) => origin !== "model")) {
        assert.equal(await link(internal).count(), 0);
        assert.equal((await page.request.get(new URL(path(internal), directory).href)).status(), 404);
    }

    const parent = models.find(({ name }) => name === "primary");
    if (!parent) return;
    const review = models.find(({ name }) => name === "review");
    const evidence = models.find(({ name }) => name === "evidence");
    const summary = entry(parent).locator(":scope > details > summary");
    // Browser animation-frame callbacks do not run with JavaScript disabled.
    const markerSettled = async (expected) => {
        const deadline = performance.now() + 3000;
        let actual;
        do {
            actual = await summary.evaluate((element) => getComputedStyle(element, "::after").transform);
            if (actual === expected) return;
            await setTimeout(20);
        } while (performance.now() < deadline);
        assert.equal(actual, expected, "Pico's disclosure marker settles to its native open/closed state");
    };
    for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme });
        await summary.focus();
        const closed = await summary.evaluate((element) => ({
            marker: getComputedStyle(element, "::after").backgroundImage,
            transform: getComputedStyle(element, "::after").transform,
            focus: getComputedStyle(element).outlineStyle,
        }));
        assert.notEqual(closed.marker, "none", `${colorScheme}: compiled Pico supplies the disclosure marker`);
        const dimensions = await summary.evaluate(async (element) => {
            const background = getComputedStyle(element, "::after").backgroundImage;
            const image = new Image();
            image.src = JSON.parse(background.slice(4, -1));
            await image.decode();
            return [image.naturalWidth, image.naturalHeight];
        });
        assert.deepEqual(dimensions, [24, 24], `${colorScheme}: the shipped CSP permits Pico's actual disclosure image`);
        assert.notEqual(closed.focus, "none", `${colorScheme}: disclosure keyboard focus is visible`);
        await page.keyboard.press("Enter");
        assert.equal(await link(review).isVisible(), true);
        assert.equal(await link(evidence).isVisible(), false);
        await markerSettled("matrix(1, 0, 0, 1, 0, 0)");
        assert.notEqual(await summary.evaluate((element) => getComputedStyle(element, "::after").transform), closed.transform);
        await page.keyboard.press("Space");
        assert.equal(await link(review).isVisible(), false);
        await markerSettled(closed.transform);
    }
    await summary.click();
    await entry(review).locator(":scope > details > summary").press("Space");
    assert.equal(await link(evidence).isVisible(), true);
    await verifyPageShell(page, { title: `${workspace.name} — Plurnk`, kind: "workspace" });
    await link(evidence).click();
    assert.equal(new URL(page.url()).pathname, path(evidence));
    assert.equal(await page.locator("main > p").innerText(), "Parent: review");
    await page.locator("main > p").getByRole("link", { name: "review", exact: true }).click();
    assert.equal(new URL(page.url()).pathname, path(review));
    await page.goto(directory);
    await backgroundSection.locator(":scope > summary").click();
    const incoming = models.find(({ name }) => name === "incoming");
    assert.equal(await link(incoming).isVisible(), true);
    assert.equal(await page.locator("main > ul > li > details[open]").count(), 0, "background expansion does not open ordinary branches");
    await link(incoming).click();
    assert.equal(await page.locator("main > p").innerText(), "Parent: _plurnk");
    assert.equal(await page.locator("main > p > a").count(), 0);
    await page.goto(directory);
}
