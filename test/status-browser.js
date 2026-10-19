import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics from "./browser-diagnostics.js";

const initial = {
    plurnk: {
        workspace: { id: 7, name: "conversation", projectRoot: null, projectLabel: null, preparation: [], activity: null },
        status: { lifecycle: "idle", model: null, loopId: null, packetCount: 0, waitUntil: null, children: 0, inbox: [],
            claimedAt: null, terminatedAt: null,
            spend: { requests: 0, usage: { inputTokens: 0, outputTokens: 0 }, knownUsage: { inputTokens: 0, outputTokens: 0 }, costUsd: "0", knownCostUsd: "0" } },
    },
    budget: { contextTokens: null, contextCapacity: null, curationWeight: null, curationBudget: null },
};

// {§web-worker-status} {§web-worker-identity} The production projection and templates, without a competing state reducer.
export default async function verifyStatus(t) {
    const { server, url } = await conversationFixture(new URL("./status-entry.js", import.meta.url));
    try {
        for (const engine of [chromium, firefox, webkit]) {
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
                    const value = (key) => page.locator(`#worker-status [data-text="${key}"]`).textContent();
                    await receive(initial);
                    const requestCount = requests.length;
                    assert.equal(await value("model"), "Not selected");
                    assert.equal(await value("context"), "Unknown / Unknown");
                    assert.equal(await value("wait"), "None");
                    assert.equal(await value("inbox"), "0");
                    assert.equal(await page.locator("#worker-folder").isVisible(), false);
                    assert.equal(await page.locator("#worker-workspace [role=img]").getAttribute("aria-label"), "Folderless workspace");

                    const active = structuredClone(initial);
                    active.plurnk.workspace = { ...active.plurnk.workspace, name: 'review <script>&@%', projectRoot: "/private/home/project", projectLabel: "~/project",
                        preparation: [{ family: "mcp", alias: '<img src="/probe">', phase: "publishing", since: "2026-10-19T12:34:56.000Z" }],
                        activity: { kind: "derivation", phase: "indexing", completed: 2, total: 3, percent: 65, message: '<script>malicious()</script>' } };
                    active.plurnk.status = { ...active.plurnk.status, lifecycle: "parked", loopId: 8, packetCount: 2, waitUntil: 65_000, claimedAt: 1000,
                        model: { alias: "local", provider: "provider", model: "model", effort: "high", effortSource: "default" }, children: 2,
                        inbox: [{ path: "message://user/first", id: "client-first", loopId: 8, lifecycle: "running" },
                            { path: '<img src="/probe">', id: null, loopId: 3, lifecycle: "failed" }],
                        spend: { requests: 3, usage: null, knownUsage: { inputTokens: 999, outputTokens: 200, outputTokenDetails: { reasoningTokens: 100 } },
                            costUsd: null, knownCostUsd: "0.0000000123" } };
                    active.budget = { contextTokens: 123, contextCapacity: 999, curationWeight: 432, curationBudget: 1000 };
                    await receive(active);
                    assert.equal(await value("model"), "local — provider/model");
                    assert.equal(await value("effort"), "high (default)");
                    assert.equal(await value("wait"), "1m 3s");
                    assert.equal(await value("children"), "2");
                    assert.equal(await value("context"), "123 / 999");
                    assert.equal(await value("curation"), "432 / 1000");
                    assert.equal(await value("input"), "Unknown");
                    assert.equal(await value("cost"), "Unknown");
                    assert.equal(await value("known-cost"), "0.0000000123");
                    assert.equal(await value("known-reasoning"), "100");
                    assert.equal(await value("activity-percent"), "65", "display supplied progress, not a local ratio");
                    assert.equal(await value("inbox"), "2");
                    assert.deepEqual(await page.locator("#worker-inbox [data-text=inbox-loop]").allTextContents(), ["8", "3"]);
                    assert.deepEqual(await page.locator("#worker-inbox [data-text=inbox-lifecycle]").allTextContents(), ["running", "failed"]);
                    assert.equal(await page.locator("#worker-workspace [data-text=workspace-name]").textContent(), active.plurnk.workspace.name);
                    assert.equal(await page.locator("#worker-workspace a").getAttribute("href"), "/~/review%20%3Cscript%3E%26%40%25/");
                    assert.equal(await page.locator("#worker-directory [aria-current=page]").getAttribute("href"), "/~/review%20%3Cscript%3E%26%40%25@user/");
                    assert.equal(await page.locator("#worker-reconnect").getAttribute("action"), "/~/review%20%3Cscript%3E%26%40%25@user/");
                    assert.equal(new URL(await page.locator("[data-sign-in]").getAttribute("href"), url).searchParams.get("return"), "/~/review%20%3Cscript%3E%26%40%25@user/");
                    assert.equal(await page.title(), `${active.plurnk.workspace.name}@user — Plurnk`);
                    assert.equal(await page.locator("#worker-folder").isVisible(), true);
                    assert.equal(await page.locator("#worker-folder [data-text=project-label]").textContent(), "~/project");
                    assert.equal(await page.locator("#worker-status").getAttribute("data-thread-id"), "7#user");
                    assert.equal(page.url(), url, "names update navigation, not browser history or attachment");

                    for (const id of ["worker-accounting", "workspace-activity", "worker-inbox"]) await page.locator(`#${id} > summary`).click();
                    assert.equal(await page.locator("[data-preparation] time").getAttribute("datetime"), "2026-10-19T12:34:56.000Z");
                    assert.equal(await page.locator("[data-preparation] [data-text=preparation-alias]").textContent(), '<img src="/probe">');
                    assert.equal(await value("activity-message"), '<script>malicious()</script>');
                    assert.equal(await page.locator("#worker-status img, #worker-status script, #worker-workspace script").count(), 0);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "status fits a narrow viewport");
                    await receive(active, 70_000);
                    assert.equal(await value("wait"), "0s");
                    assert.equal(await value("lifecycle"), "parked", "deadline expiry is not a locally authored wake");
                    for (const id of ["worker-accounting", "workspace-activity", "worker-inbox"]) assert.equal(await page.locator(`#${id}`).evaluate((element) => element.open), true);
                    await assert.rejects(receive({ ...active, plurnk: { ...active.plurnk, workspace: { ...active.plurnk.workspace, id: 8 } } }), /Worker state identifies a different workspace/u);
                    assert.equal(await value("lifecycle"), "parked", "a rejected identity cannot replace valid facts");

                    await receive(initial);
                    assert.equal(await value("model"), "Not selected");
                    assert.equal(await value("effort"), "Unspecified");
                    assert.equal(await value("wait-at"), "");
                    assert.equal(await page.locator("[data-text=wait-at]").getAttribute("datetime"), null);
                    assert.equal(await value("context"), "Unknown / Unknown");
                    assert.equal(await value("activity-phase"), "None");
                    assert.equal(await value("activity-message"), "");
                    assert.equal(await value("preparation-count"), "0");
                    assert.equal(await page.locator("[data-preparation] li, #worker-inbox li").count(), 0);
                    assert.equal(await value("known-reasoning"), "Unknown");
                    assert.equal(await page.locator("#worker-folder").isVisible(), false);
                    assert.equal(await page.locator("#worker-workspace a").getAttribute("href"), "/~/conversation/");
                    assert.equal(await page.locator("#worker-status").getAttribute("data-connection"), "initial", "state projection does not own delivery or approval");
                    assert.equal(requests.length, requestCount, "projection and disclosure do not request more state or authored resources");
                    assert.equal(await page.locator("[data-messages] > li").count(), 0, "status and inbox are not conversation messages");
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}
