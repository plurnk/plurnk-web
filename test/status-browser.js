import assert from "node:assert/strict";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics from "./browser-diagnostics.js";

const initial = {
    plurnk: {
        workspace: { id: 7, name: "conversation", projectRoot: null, projectLabel: null, preparation: [], activity: null },
        status: { lifecycle: "idle", model: null, loopId: null, packetCount: 0, waitUntil: null, descendants: [], inbox: [],
            claimedAt: null, terminatedAt: null,
            spend: { requests: 0, usage: { inputTokens: 0, outputTokens: 0 }, knownUsage: { inputTokens: 0, outputTokens: 0 }, costUsd: "0", knownCostUsd: "0" } },
    },
    budget: { contextTokens: null, contextCapacity: null, curationWeight: null, curationBudget: null },
};

// {§web-session-status} {§web-session-identity} The production projection and templates, without a competing state reducer.
export default async function verifyStatus(t) {
    const { server, url } = await conversationFixture(new URL("./status-entry.js", import.meta.url));
    try {
        for (const engine of engines) {
            await t.test(engine.name(), async () => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 700 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    const requests = [];
                    page.on("request", (request) => requests.push(request.url()));
                    await page.goto(url);
                    await page.waitForFunction(() => typeof window.presentState === "function");
                    const receive = (state, now = 2000) => page.evaluate(({ state, now }) => window.presentState(state, now), { state, now });
                    const field = (key) => page.locator(`#session-status [data-status-field="${key}"]`);
                    const value = (key) => key === "lifecycle" ? field(key).getAttribute("aria-label") : page.locator(`#session-status [data-text="${key}"]`).textContent();
                    const glyph = (key) => field(key).evaluate((element) => getComputedStyle(element, "::before").content);
                    assert.equal(await page.locator("#session-status").evaluate((element) => element.tagName), "FOOTER");
                    assert.equal(await page.locator("#session-status > [data-status-line]").isVisible(), false, "unknown state is not a row of invented zeros");
                    assert.equal(await page.locator("#session-status > [role=status]").isVisible(), true, "connection state remains visible before a gauge arrives");
                    await receive(initial);
                    const statusLine = page.locator("#session-status > [data-status-line]");
                    const draft = page.getByRole("textbox", { name: "Message", exact: true });
                    const leave = () => page.locator("body > header > a").focus();
                    for (const width of [320, 1280]) {
                        await page.setViewportSize({ width, height: 700 });
                        assert.equal(await statusLine.isVisible(), false, "idle, unfocused status is hidden");
                        assert.equal(await statusLine.evaluate((element) => element.getBoundingClientRect().height), 0, "hidden status reserves no space");
                        assert.equal(await draft.isVisible(), true, "hiding status never hides the composer");
                        await draft.focus();
                        assert.equal(await statusLine.isVisible(), true, "focusing the composer reveals status");
                        await draft.press("Shift+Tab");
                        assert.equal(await page.evaluate(() => document.activeElement.id), "session-effort");
                        assert.equal(await statusLine.isVisible(), true, "keyboard movement into status retains it");
                        await leave();
                        assert.equal(await statusLine.isVisible(), false, "leaving the footer hides idle status again");
                    }
                    for (const lifecycle of ["idle", "completed", "cancelled", "failed", "queued", "running", "parked"]) {
                        await receive({ ...initial, plurnk: { ...initial.plurnk, status: { ...initial.plurnk.status, lifecycle } } });
                        assert.equal(await statusLine.isVisible(), ["queued", "running", "parked"].includes(lifecycle), `${lifecycle}: only live work keeps unfocused status visible`);
                        await draft.focus();
                        assert.equal(await statusLine.isVisible(), true, `${lifecycle}: focus reveals the supplied status`);
                        await leave();
                    }
                    await receive(initial);
                    for (const connection of ["disconnected", "signed-out"]) {
                        await page.locator("#session-status").evaluate((element, state) => element.setAttribute("data-connection", state), connection);
                        assert.equal(await statusLine.isVisible(), false);
                        assert.equal(await page.locator("#session-connection").isVisible(), true, "connection recovery is independent of status visibility");
                        assert.equal(await page.locator("#session-status > [role=status]").isVisible(), true, "connection feedback is never focus-gated");
                    }
                    await page.locator("#session-status").evaluate((element) => element.setAttribute("data-connection", "initial"));
                    await page.setViewportSize({ width: 320, height: 700 });
                    await draft.focus();
                    const approval = page.getByRole("button", { name: "Automatic approval", exact: true });
                    assert.equal(await approval.getAttribute("type"), "button");
                    assert.equal(await approval.getAttribute("aria-pressed"), "false");
                    assert.equal(await approval.isVisible(), true, "manual approval is an explicit mode, not an absent indicator");
                    assert.match(await approval.evaluate((element) => getComputedStyle(element, "::before").content), /🐹/u);
                    await approval.evaluate((element) => element.setAttribute("aria-pressed", "true"));
                    assert.match(await approval.evaluate((element) => getComputedStyle(element, "::before").content), /🔥/u);
                    await approval.evaluate((element) => element.setAttribute("aria-pressed", "false"));
                    for (const colorScheme of ["light", "dark"]) {
                        await page.emulateMedia({ colorScheme });
                        const appearance = await page.locator("#session-status > [data-status-line]").evaluate((element) => {
                            const list = getComputedStyle(element);
                            const parent = getComputedStyle(element.parentElement);
                            return { list: [list.fontSize, list.color], parent: [parent.fontSize, parent.color] };
                        });
                        assert.deepEqual(appearance.list, appearance.parent, `${colorScheme}: the status inherits Pico typography and color`);
                    }
                    const requestCount = requests.length;
                    assert.equal(await value("model"), "No model");
                    assert.equal(await value("context"), "");
                    assert.equal(await value("wait"), "");
                    assert.equal(await value("inbox"), "0");
                    for (const key of ["elapsed", "context", "descendants", "gated", "wait", "inbox", "preparation", "activity"]) {
                        assert.equal(await field(key).isVisible(), false, `${key} has no empty status placeholder`);
                    }
                    assert.equal(await page.locator("#session-status dl, #session-status table, #session-accounting, #workspace-activity, #session-inbox").count(), 0);
                    assert.equal(await page.locator("#session-folder").isVisible(), false);
                    assert.equal(await page.locator("#session-workspace [role=img]").getAttribute("aria-label"), "Folderless workspace");

                    const active = structuredClone(initial);
                    active.plurnk.workspace = { ...active.plurnk.workspace, name: 'review <script>&@%', projectRoot: "/private/home/project", projectLabel: "~/project",
                        preparation: [{ family: "mcp", alias: '<img src="/probe">', phase: "publishing", since: "2026-10-19T12:34:56.000Z" }],
                        activity: { kind: "derivation", phase: "indexing", completed: 2, total: 3, percent: 65, message: '<script>malicious()</script>' } };
                    active.plurnk.status = { ...active.plurnk.status, lifecycle: "parked", loopId: 8, packetCount: 2, waitUntil: 65_000, claimedAt: 1000,
                        model: { alias: "local", provider: "provider", model: "model", effort: "high", effortSource: "default" },
                        descendants: [
                            { id: 11, name: "child", parentSessionId: 10, kind: "work", lifecycle: "running", gates: 0 },
                            { id: 12, name: "grandchild", parentSessionId: 11, kind: "fork", lifecycle: "parked", gates: 2 },
                            { id: 13, name: "parallel", parentSessionId: 10, kind: "bare", lifecycle: "queued", gates: 1 },
                            { id: 14, name: "finished", parentSessionId: 10, kind: "work", lifecycle: "failed", gates: 0 },
                        ],
                        inbox: [{ path: "message://user/first", id: "client-first", loopId: 8, lifecycle: "running" },
                            { path: '<img src="/probe">', id: null, loopId: 3, lifecycle: "failed" }],
                        spend: { requests: 3, usage: null, knownUsage: { inputTokens: 999, outputTokens: 200, outputTokenDetails: { reasoningTokens: 100 } },
                            costUsd: null, knownCostUsd: "0.0000000123" } };
                    active.budget = { contextTokens: 123, contextCapacity: 999, curationWeight: 432, curationBudget: 1000 };
                    await receive(active);
                    assert.equal(await value("model"), "local");
                    assert.equal(await value("effort"), "high");
                    assert.equal(await field("model").getAttribute("aria-label"), "Model: provider/model; effort: high (default)");
                    assert.equal(await value("wait"), "1m03s");
                    assert.equal(await page.locator("#session-descendants > summary").getAttribute("aria-label"), "Descendant sessions: 4; active direct children: 2");
                    assert.equal(await value("gated"), "2");
                    assert.equal(await value("descendants"), "4");
                    assert.equal(await value("context"), "12%/999");
                    assert.doesNotMatch(await field("context").innerText(), /ctx/u);
                    assert.equal(await field("context").evaluate((element) => getComputedStyle(element, "::after").content), "none", "context has no decorative scroll");
                    assert.equal(await field("context").getAttribute("aria-label"), "Current packet context: 123 / 999 tokens");
                    assert.equal(await field("curation").count(), 0, "no curation display even when the SDK supplies its budget");
                    assert.equal(await page.locator("#session-status").getAttribute("data-curation"), null);
                    assert.equal(await page.locator("#session-status").getAttribute("data-curation-label"), null);
                    assert.equal(await value("input"), "999 + ?");
                    assert.equal(await value("cost"), "<$0.0001 + ?");
                    assert.equal(await field("cost").getAttribute("aria-label"), "Cumulative USD, session and descendants: unknown total; known subtotal 0.0000000123.");
                    assert.equal(await value("activity"), "indexing 65%", "display supplied progress, not a local ratio");
                    assert.equal(await value("inbox"), "2");
                    assert.doesNotMatch(await page.locator("#session-status").innerHTML(), /message:\/\/user\/first|client-first|data-known-|data-usage-/u);
                    assert.match(await glyph("lifecycle"), /💤/u);
                    assert.equal(await glyph("model"), "none", "model has no decorative dice");
                    assert.equal(await page.locator("#session-status [aria-label='Session statistics'] > li:last-child").getAttribute("data-status-field"), "cost", "cost is last in document and accessibility order");
                    for (const width of [320, 1280]) {
                        await page.setViewportSize({ width, height: 700 });
                        assert.equal(await page.locator("#session-status > [data-status-line]").evaluate((element) => getComputedStyle(element).justifyContent), "center");
                        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                    }
                    await page.setViewportSize({ width: 320, height: 700 });
                    assert.match(await field("cost").ariaSnapshot(), /unknown total; known subtotal 0.0000000123/u);
                    assert.equal(await page.locator("#session-status > [data-status-line] [aria-live], #session-status > [data-status-line] [role=status]").count(), 0, "ticking gauges do not announce every second");
                    assert.equal(await page.locator("#session-workspace [data-text=workspace-name]").textContent(), active.plurnk.workspace.name);
                    assert.equal(await page.locator("#session-workspace a").getAttribute("href"), "/~/review%20%3Cscript%3E%26%40%25/");
                    assert.equal(await page.locator('#session-directory').count(), 0);
                    assert.equal(await page.locator('nav[aria-label="breadcrumb"] [aria-current="page"]').textContent(), "user");
                    assert.equal(await page.locator("#session-reconnect").getAttribute("action"), "/~/review%20%3Cscript%3E%26%40%25@user/");
                    assert.equal(new URL(await page.locator("[data-sign-in]").getAttribute("href"), url).searchParams.get("return"), "/~/review%20%3Cscript%3E%26%40%25@user/");
                    assert.equal(await page.title(), `${active.plurnk.workspace.name}@user — Plurnk`);
                    assert.equal(await page.locator("#session-folder").isVisible(), true);
                    assert.equal(await page.locator("#session-folder [data-text=project-label]").textContent(), "~/project");
                    assert.equal(await page.locator("#session-status").getAttribute("data-session-id"), "7#user");
                    assert.equal(page.url(), url, "names update navigation, not browser history or attachment");

                    const family = page.locator("#session-descendants");
                    assert.equal(await family.evaluate((element) => element.open), false);
                    assert.equal(await family.locator(":scope > ul").isVisible(), false, "the tree occupies no default visible space");
                    await family.locator(":scope > summary").click();
                    assert.deepEqual(await family.locator(":scope > ul > li > a").allTextContents(), ["child", "parallel", "finished"]);
                    assert.equal(await family.locator('[data-descendant-id="11"] > details > summary').textContent(), "Children: 1");
                    assert.equal(await family.locator('[data-descendant-id="12"] > a').getAttribute("href"),
                        "/~/review%20%3Cscript%3E%26%40%25@grandchild/");
                    assert.equal(await family.locator('[data-descendant-id="12"] [data-text=descendant-gates]').textContent(), "2");
                    assert.equal(await family.locator('[data-descendant-id="14"] [data-text=descendant-lifecycle]').textContent(), "failed");
                    assert.equal(await family.locator('[data-descendant-id="14"] > details').count(), 0);
                    await family.locator('[data-descendant-id="11"] > details > summary').click();
                    await page.evaluate(() => { window.descendantLink = document.querySelector('[data-descendant-id="11"] > a'); });
                    assert.equal(await value("preparation"), 'publishing mcp/<img src="/probe">');
                    assert.equal(await field("activity").getAttribute("title"), '<script>malicious()</script>');
                    assert.equal(await page.locator("#session-status img, #session-status script, #session-workspace script").count(), 0);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "status fits a narrow viewport");
                    await receive(active, 70_000);
                    assert.equal(await page.evaluate(() => window.descendantLink === document.querySelector('[data-descendant-id="11"] > a')), true,
                        "clock updates do not replace a live tree");
                    assert.equal(await value("wait"), "0s");
                    assert.equal(await value("lifecycle"), "parked", "deadline expiry is not a locally authored wake");
                    assert.equal(await family.evaluate((element) => element.open), true);
                    await assert.rejects(receive({ ...active, plurnk: { ...active.plurnk, workspace: { ...active.plurnk.workspace, id: 8 } } }), /Session state identifies a different workspace/u);
                    assert.equal(await value("lifecycle"), "parked", "a rejected identity cannot replace valid facts");

                    const updated = structuredClone(active);
                    updated.plurnk.workspace.name = "renamed";
                    updated.plurnk.status.descendants[1] = { ...updated.plurnk.status.descendants[1], lifecycle: "completed", gates: 0 };
                    updated.plurnk.status.descendants.push({ id: 15, name: "new-child", parentSessionId: 13, kind: "work", lifecycle: "idle", gates: 0 });
                    await family.locator('[data-descendant-id="11"] > a').focus();
                    await page.evaluate(() => { window.focusedLink = document.activeElement; });
                    await receive(updated);
                    assert.equal(await page.evaluate(() => window.focusedLink.isConnected && document.activeElement === window.focusedLink), true,
                        "{§web-session-descendants} updating other descendants keeps this one's node and focus");
                    assert.equal(await family.locator('[data-descendant-id="11"] > details').evaluate((el) => el.open), true);
                    assert.equal(await family.locator('[data-descendant-id="13"] > details').evaluate((el) => el.open), false);
                    assert.equal(await family.locator('[data-descendant-id="12"] > a').getAttribute("href"), "/~/renamed@grandchild/");
                    assert.equal(await family.locator('[data-descendant-id="12"] [data-text=descendant-lifecycle]').textContent(), "completed");
                    assert.equal(await value("gated"), "1", "settlement changes supplied gate facts, not parent lifecycle");
                    assert.equal(await value("lifecycle"), "parked");
                    assert.equal(await value("descendants"), "5");

                    await draft.focus();
                    for (const lifecycle of ["completed", "failed", "cancelled", "running"]) {
                        await receive({ ...initial, plurnk: { ...initial.plurnk, status: { ...initial.plurnk.status, lifecycle } } });
                        assert.equal(await value("lifecycle"), lifecycle, "hiding completed presentation does not rewrite lifecycle");
                        assert.equal(await field("lifecycle").isVisible(), lifecycle !== "completed");
                        if (lifecycle === "completed") assert.equal(await field("lifecycle").evaluate((element) => element.getBoundingClientRect().width), 0);
                    }

                    await receive(initial);
                    assert.equal(await value("model"), "No model");
                    assert.equal(await value("effort"), "");
                    assert.equal(await page.locator("[data-text=wait]").getAttribute("datetime"), null);
                    assert.equal(await value("context"), "");
                    assert.equal(await value("activity"), "");
                    assert.equal(await value("preparation"), "");
                    assert.equal(await field("activity").isVisible(), false);
                    assert.equal(await field("preparation").isVisible(), false);
                    assert.equal(await value("gated"), "0");
                    assert.equal(await family.locator("li").count(), 0);
                    assert.equal(await family.isVisible(), false);
                    assert.equal(await family.evaluate((el) => el.open), true, "a census replacement preserves the containing disclosure");
                    assert.equal(await page.locator("#session-folder").isVisible(), false);
                    assert.equal(await page.locator("#session-workspace a").getAttribute("href"), "/~/conversation/");
                    assert.equal(await page.locator("#session-status").getAttribute("data-connection"), "initial", "state projection does not own delivery or approval");
                    assert.equal(requests.length, requestCount, "projection and disclosure do not request more state or authored resources");
                    assert.equal(await page.locator("[data-messages] > li").count(), 0, "status and inbox are not conversation messages");
                    const long = structuredClone(initial);
                    long.plurnk.status.model = { provider: "hosted-provider", model: "namespace/" + "long-model-name-".repeat(6), effort: "high", effortSource: "default" };
                    await page.setViewportSize({ width: 640, height: 700 });
                    await receive(long);
                    const controlGroup = page.getByRole("list", { name: "Model controls", exact: true });
                    const statistics = page.getByRole("list", { name: "Session statistics", exact: true });
                    const controlBox = await controlGroup.boundingBox();
                    const statsBox = await statistics.boundingBox();
                    assert.ok(controlBox.y + controlBox.height <= statsBox.y, "a long non-alias model wraps above statistics as one control group");
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                    assert.deepEqual(await controlGroup.locator("button").evaluateAll((buttons) => buttons.map(({ id }) => id)), ["session-yolo", "session-model", "session-effort"]);
                    await page.setViewportSize({ width: 1440, height: 900 });
                    await receive(initial);
                    const compactControls = await controlGroup.boundingBox();
                    const compactStats = await statistics.boundingBox();
                    assert.ok(Math.abs(compactControls.y - compactStats.y) < 3, "short groups share a row when they fit");
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}
