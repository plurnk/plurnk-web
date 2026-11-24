import assert from "node:assert/strict";
import { directoryPath } from "../src/directory-addresses.js";
import verifyPageShell from "./page-shell.js";

function isUntouchedDraft(session, allSessions) {
    const kind = session.kind ?? (session.parentSessionId === null ? "root" : "work");
    const hasModelChildren = allSessions.some((s) => s.origin === "model" && (s.archivedAt ?? null) === null && s.parentSessionId === session.id);
    return session.parentSessionId === null
        && kind === "root"
        && session.lifecycle === "idle"
        && !session.reply
        && !(typeof session.title === "string" && session.title.trim() !== "")
        && !(Array.isArray(session.loops) && session.loops.length > 0)
        && (session.gates ?? 0) === 0
        && !hasModelChildren;
}

// {§web-session-directory} {§web-search} Workspace-grouped native navigation on the packed daemon, with the browser's JavaScript posture supplied by the caller.
export default async function verifySessionDirectory(page, workspace) {
    const wsPath = directoryPath({ kind: "workspace", workspace: workspace.name });
    const path = (session) => directoryPath({ kind: "session", workspace: workspace.name, session: session.name });
    const wsCard = page.locator(`#search-workspaces > ul > li[data-directory-entry="workspace"][data-workspace-id="${workspace.id}"] > article`);
    await wsCard.waitFor({ state: "visible" });
    assert.equal(await wsCard.count(), 1);
    if (wsPath !== null) {
        assert.equal(await wsCard.locator(':scope > header > a[data-text="name"]').getAttribute("href"), wsPath);
    } else {
        assert.equal(await wsCard.locator(':scope > header > span[data-text="name"]').textContent(), workspace.name);
    }

    const link = (session) => wsCard.locator(`a[data-session-link][aria-label=${JSON.stringify(session.name)}]`);
    const entry = (session) => link(session).locator("xpath=ancestor::article[1]");
    const identity = (session) => entry(session).locator(":scope > header, :scope > details > summary");
    const childLinks = ":scope > li > article > header [data-session-link], :scope > li > article > details > summary [data-session-link]";
    const names = (list) => list.locator(childLinks).evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label") ?? element.textContent?.replace(/^#/u, "") ?? ""));

    const models = workspace.sessions.filter((s) => s.origin === "model" && !isUntouchedDraft(s, workspace.sessions));
    const drafts = workspace.sessions.filter((s) => s.origin === "model" && isUntouchedDraft(s, workspace.sessions));
    const parentOf = (session) => workspace.sessions.find(({ id }) => id === session.parentSessionId);
    const background = models.filter((session) => session.parentSessionId !== null && parentOf(session).origin !== "model");
    const primary = models.filter(({ parentSessionId }) => parentSessionId === null);
    const directory = page.url();

    for (const draft of drafts) {
        assert.equal(await link(draft).count(), 0, `untouched draft ${draft.name} stays hidden from /search/`);
    }
    if (wsPath === null) return;

    const rootList = wsCard.locator(":scope > ul[data-workspace-sessions]");
    if (primary.length > 0) {
        assert.deepEqual(await names(rootList), primary.map(({ name }) => name));
    } else {
        assert.equal(await rootList.count(), 0);
    }
    assert.deepEqual(
        (await wsCard.locator("a[data-session-link]").evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")))).toSorted(),
        models.map(({ name }) => name).toSorted(),
    );
    assert.equal(await wsCard.locator("details[open]").count(), 0);
    assert.equal(await wsCard.locator('[role="tree"], [role="treeitem"]').count(), 0);
    const backgroundSection = wsCard.locator(":scope > details[data-workspace-background]");
    assert.equal(await backgroundSection.count(), background.length === 0 ? 0 : 1);
    if (background.length) {
        assert.equal(await backgroundSection.locator(":scope > summary").innerText(), "Background work");
        assert.deepEqual(await names(backgroundSection.locator(":scope > ul")), background.map(({ name }) => name));
    }
    for (const session of models) {
        assert.equal(await identity(session).locator("[data-lifecycle]").getAttribute("aria-label"), session.lifecycle);
        assert.equal(await identity(session).locator("[data-lifecycle]").getAttribute("title"), session.lifecycle);
        assert.equal(await entry(session).locator(":scope > p").count(), 0, "no session-kind metadata row");
        const parent = parentOf(session);
        const parentLabel = identity(session).locator("[data-session-parent]");
        assert.equal(await parentLabel.count(), parent ? 1 : 0);
        if (parent) {
            assert.equal(await parentLabel.textContent(), `${parent.name} > `);
            assert.equal(await parentLabel.locator("a").count(), parent.origin === "model" ? 1 : 0);
            if (parent.origin === "model") assert.equal(await parentLabel.locator("a").getAttribute("href"), path(parent));
        }
        const enclosing = await link(session).evaluate((element) => element.closest("li").parentElement.closest('li[data-directory-entry="session"]')?.querySelector("[data-session-link]")?.getAttribute("href") ?? null);
        assert.equal(enclosing, parent?.origin === "model" ? path(parent) : null, `${session.name}: immediate model parent`);
        const children = models.filter(({ parentSessionId }) => parentSessionId === session.id);
        const disclosure = entry(session).locator(":scope > details");
        assert.equal(await disclosure.count(), children.length ? 1 : 0, `${session.name}: leaves have no disclosure`);
        if (children.length) {
            assert.equal(await disclosure.locator(":scope > summary [data-session-identity]").count(), 1);
            assert.deepEqual(await names(disclosure.locator(":scope > ul")), children.map(({ name }) => name));
        }
        assert.equal(await link(session).isVisible(), session.parentSessionId === null, `${session.name}: initially collapsed`);
    }
    for (const internal of workspace.sessions.filter(({ origin }) => origin !== "model")) {
        assert.equal(await link(internal).count(), 0);
    }

    const parent = models.find(({ name }) => name === "primary");
    if (!parent) return;
    const review = models.find(({ name }) => name === "review");
    const evidence = models.find(({ name }) => name === "evidence");
    const summary = entry(parent).locator(":scope > details > summary");
    for (const colorScheme of /** @type {const} */ (["light", "dark"])) {
        await page.emulateMedia({ colorScheme });
        await summary.focus();
        const closed = await summary.evaluate((element) => ({
            marker: getComputedStyle(element, "::after").content,
            focus: getComputedStyle(element).outlineStyle,
        }));
        assert.match(closed.marker, /▸/u, `${colorScheme}: compiled stylesheet supplies the closed disclosure marker`);
        assert.notEqual(closed.focus, "none", `${colorScheme}: disclosure keyboard focus is visible`);
        await page.keyboard.press("Enter");
        assert.equal(await link(review).isVisible(), true);
        assert.equal(await link(evidence).isVisible(), false);
        assert.match(await summary.evaluate((element) => getComputedStyle(element, "::after").content), /▾/u);
        await page.keyboard.press("Space");
        assert.equal(await link(review).isVisible(), false);
        assert.equal(await summary.evaluate((element) => getComputedStyle(element, "::after").content), closed.marker);
    }
    const summaryBox = await summary.boundingBox();
    await summary.click({ position: { x: summaryBox.width - 8, y: 10 } });
    await entry(review).locator(":scope > details > summary").press("Space");
    assert.equal(await link(evidence).isVisible(), true);
    await verifyPageShell(page, { title: "Search — Plurnk", kind: "search" });
    await link(evidence).click();
    await page.waitForFunction(
        (expected) => document.querySelector('#workspace-tabs a[aria-current="true"]')?.getAttribute("data-tab-session") === expected,
        evidence.name,
    );
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).hash, path(evidence));
    const openSessionSettings = async () => {
        const activeTab = page.locator('#workspace-tabs a[aria-current="true"]');
        if (await activeTab.isVisible()) {
            await activeTab.click();
        } else {
            await page.locator("#session-current").click();
        }
        await page.waitForURL((url) => new URL(url).pathname === "/settings/" && new URL(url).hash === "#session");
    };
    await openSessionSettings();
    const parentLink = page.locator('#workspace-settings [data-settings-panel="session"] [data-session-parent-line]');
    await parentLink.waitFor({ state: "visible" });
    assert.equal((await parentLink.innerText()).trim(), "Parent: review");
    assert.equal(await page.locator("#session-directory").count(), 0);
    await parentLink.getByRole("link", { name: "review", exact: true }).click();
    await page.waitForFunction(
        () => document.querySelector('#workspace-tabs a[aria-current="true"]')?.getAttribute("data-tab-session") === "review",
    );
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).hash, path(review));
    if (background.length > 0) {
        await page.goto(directory);
        await page.locator("#search-workspaces [data-workspace-background] > summary").waitFor({ state: "visible" });
        await backgroundSection.locator(":scope > summary").click();
        const incoming = models.find(({ name }) => name === "incoming");
        assert.equal(await link(incoming).isVisible(), true);
        await link(incoming).click();
        await page.waitForFunction(
            () => document.querySelector('#workspace-tabs a[aria-current="true"]')?.getAttribute("data-tab-session") === "incoming",
        );
        await openSessionSettings();
        const incomingParentLink = page.locator('#workspace-settings [data-settings-panel="session"] [data-session-parent-line]');
        await incomingParentLink.waitFor({ state: "visible" });
        assert.equal((await incomingParentLink.innerText()).trim(), "Parent: _plurnk");
        assert.equal(await incomingParentLink.locator("a").count(), 0);
    }
    await page.goto(directory);
    await wsCard.waitFor({ state: "visible" });
}
