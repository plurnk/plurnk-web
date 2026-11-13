import assert from "node:assert/strict";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics from "./browser-diagnostics.js";

// {§web-workspace-settings} Multi-engine verification of workspace subsystem management across Overview and Session scopes.
export default async function verifyWorkspaceSettingsUnit(t) {
    const fixture = await conversationFixture(new URL("./workspace-settings-entry.js", import.meta.url));
    try {
        for (const engine of engines) {
            await t.test(engine.name(), async () => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 740 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    page.setDefaultTimeout(8_000);

                    /** @type {any[]} */
                    const requests = [];
                    /** @type {any} */
                    let nextProblem = null;
                    /** @type {any} */
                    let wsPolicy = {};
                    /** @type {any[]} */
                    let mcpDefs = [
                        {
                            alias: "svc-git",
                            origin: "service",
                            state: "active",
                            definition: { type: "stdio", command: "git-mcp", args: ["--read-only"] },
                            detail: { tools: ["status", "diff"] },
                        },
                        {
                            alias: "remote-docs",
                            origin: "workspace",
                            state: "authorization-required",
                            definition: { type: "streamable-http", url: "https://mcp.example/mcp", authorization: { type: "oauth" } },
                            authorization: {},
                        },
                    ];
                    /** @type {any[]} */
                    let skillDefs = [];
                    /** @type {any[]} */
                    let scheduleDefs = [];
                    /** @type {any[]} */
                    let personaDefs = [
                        {
                            alias: "auditor",
                            origin: "workspace",
                            state: "active",
                            definition: { description: "Security reviewer", body: "Audit boundaries.", effort: "high" },
                        },
                    ];
                    let activeSessionPersona = "none";
                    /** @type {any[]} */
                    let workspaceEnv = [
                        { alias: "WS_TOKEN", origin: "workspace", state: "active", provenance: { source: ".env" }, definition: { value: "ws-secret-value" } },
                    ];
                    /** @type {any[]} */
                    let sessionEnv = [
                        { alias: "SESS_TOKEN", origin: "session", state: "active", definition: { value: "sess-secret-value" } },
                    ];

                    await page.route("**/auth/token", (route) =>
                        route.fulfill({ status: 200, json: { token_type: "Bearer", access_token: "ws-settings-token" } }),
                    );

                    fixture.onAcp(async (input, headers) => {
                        assert.equal(headers.authorization, "Bearer ws-settings-token");
                        requests.push(input);
                        if (nextProblem) {
                            const err = nextProblem;
                            nextProblem = null;
                            return { error: { code: -32000, message: err.detail, data: err } };
                        }
                        if (input.method === "session/resume") {
                            return {
                                result: {
                                    configOptions: [{
                                        configId: "persona",
                                        name: "Persona",
                                        type: "select",
                                        currentValue: activeSessionPersona,
                                        options: [
                                            { value: "none", name: "None (default)", description: null },
                                            ...personaDefs.map((p) => ({
                                                value: p.alias,
                                                name: p.alias,
                                                description: p.definition.description ?? null,
                                            })),
                                        ],
                                    }],
                                    availableCommands: [],
                                },
                            };
                        }
                        if (input.method === "session/set_config_option") {
                            activeSessionPersona = input.params.value;
                            return {
                                result: {
                                    configOptions: [{
                                        configId: "persona",
                                        name: "Persona",
                                        type: "select",
                                        currentValue: activeSessionPersona,
                                        options: [
                                            { value: "none", name: "None (default)", description: null },
                                            ...personaDefs.map((p) => ({
                                                value: p.alias,
                                                name: p.alias,
                                                description: p.definition.description ?? null,
                                            })),
                                        ],
                                    }],
                                },
                            };
                        }
                        assert.equal(input.method, "_plurnk/action");
                        const { kind, params } = input.params;
                        switch (kind) {
                            case "workspace.capabilities.get":
                                return { result: { service: {}, workspace: wsPolicy, effective: wsPolicy } };
                            case "workspace.capabilities.set":
                                wsPolicy = params.policy;
                                return { result: { service: {}, workspace: wsPolicy, effective: wsPolicy } };
                            case "workspace.mcp.list":
                                return { result: { family: "mcp", definitions: mcpDefs } };
                            case "workspace.mcp.enable":
                            case "workspace.mcp.disable": {
                                mcpDefs = mcpDefs.map((d) => d.alias === params.alias
                                    ? { ...d, state: kind.endsWith("enable") ? "active" : "disabled" }
                                    : d);
                                return { result: { status: 200 } };
                            }
                            case "workspace.mcp.remove":
                                mcpDefs = mcpDefs.filter((d) => d.alias !== params.alias);
                                return { result: { status: 200 } };
                            case "workspace.mcp.discover":
                                return {
                                    result: {
                                        family: "mcp",
                                        candidates: [{
                                            alias: "sqlite-mcp",
                                            summary: `SQLite inspector (${params.query})`,
                                            definition: { type: "stdio", command: "npx", args: ["-y", "sqlite-mcp"] },
                                            provenance: { kind: "registry" },
                                        }],
                                    },
                                };
                            case "workspace.mcp.replace": {
                                const { alias, ...def } = params;
                                const filtered = mcpDefs.filter((d) => d.alias !== alias);
                                mcpDefs = [...filtered, { alias, origin: "workspace", state: "active", definition: def }];
                                return { result: { status: 201 } };
                            }
                            case "workspace.mcp.oauth.begin":
                                return {
                                    result: {
                                        status: 202,
                                        alias: params.alias,
                                        authorization: { url: "https://auth.example/authorize?state=xyz" },
                                    },
                                };
                            case "workspace.mcp.oauth.complete":
                                mcpDefs = mcpDefs.map((d) => d.alias === params.alias ? { ...d, state: "active" } : d);
                                return { result: { status: 200, alias: params.alias } };
                            case "workspace.skills.list":
                                return { result: { family: "skills", definitions: skillDefs } };
                            case "workspace.skills.discover":
                                return {
                                    result: {
                                        family: "skills",
                                        candidates: [{
                                            alias: "lint-guide",
                                            summary: "Linting conventions",
                                            definition: { source: params.source, commit: "a".repeat(40) },
                                            provenance: { kind: "git", source: params.source },
                                        }],
                                    },
                                };
                            case "workspace.skills.replace": {
                                const { alias, ...def } = params;
                                skillDefs = [...skillDefs.filter((d) => d.alias !== alias), { alias, origin: "workspace", state: "active", definition: def }];
                                return { result: { status: 201 } };
                            }
                            case "workspace.schedule.list":
                                return { result: { family: "schedule", definitions: scheduleDefs } };
                            case "workspace.schedule.discover":
                                return {
                                    result: {
                                        family: "schedule",
                                        candidates: [{
                                            summary: `Next occurrence for ${params.rule}: 2026-11-14T09:00:00Z`,
                                            definition: {},
                                            provenance: { kind: "preview" },
                                        }],
                                    },
                                };
                            case "workspace.schedule.replace": {
                                const { alias, ...def } = params;
                                scheduleDefs = [...scheduleDefs.filter((d) => d.alias !== alias), { alias, origin: "workspace", state: "active", definition: def }];
                                return { result: { status: 201 } };
                            }
                            case "workspace.personas.list":
                                return { result: { family: "personas", definitions: personaDefs } };
                            case "workspace.personas.replace": {
                                const { alias, ...def } = params;
                                personaDefs = [...personaDefs.filter((d) => d.alias !== alias), { alias, origin: "workspace", state: "active", definition: def }];
                                return { result: { status: 201 } };
                            }
                            case "workspace.env.list":
                                return { result: { family: "env", definitions: workspaceEnv } };
                            case "session.env.list":
                                return { result: { family: "env", definitions: [...workspaceEnv, ...sessionEnv] } };
                            case "workspace.env.replace":
                                workspaceEnv = [...workspaceEnv.filter((d) => d.alias !== params.alias), { alias: params.alias, origin: "workspace", state: "active", definition: { value: params.value } }];
                                return { result: { status: 201 } };
                            case "session.env.replace":
                                sessionEnv = [...sessionEnv.filter((d) => d.alias !== params.alias), { alias: params.alias, origin: "session", state: "active", definition: { value: params.value } }];
                                return { result: { status: 201 } };
                            default:
                                throw new Error(`Unexpected action ${kind}`);
                        }
                    });

                    await page.goto(fixture.url);
                    await page.waitForFunction(() => typeof window.openSettings === "function");

                    // 1. Overview mode (sessionName = null): workspace-only actions with workspaceId: 7 and omitted sessionId
                    await page.locator("#workspace-tabs [data-workspace-settings]").click();
                    const dialog = page.locator("#dialog-workspace-settings");
                    await dialog.waitFor({ state: "visible" });
                    await page.waitForFunction(() => document.querySelector("#dialog-workspace-settings > article")?.getAttribute("aria-busy") === null);

                    assert.equal(requests.at(-1).params.workspaceId, 7);
                    assert.equal("sessionId" in requests.at(-1).params, false, "Overview mode sends workspaceId without session attachment");

                    for (const width of [320, 1280]) {
                        await page.setViewportSize({ width, height: 740 });
                        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no page overflow at ${width}px`);
                    }
                    await page.setViewportSize({ width: 320, height: 740 });

                    // Capabilities: structured rule builder + 409 active-work refusal preserving draft
                    const capPanel = dialog.locator('[data-settings-panel="capabilities"]');
                    await capPanel.getByRole("combobox", { name: "Rule list", exact: true }).selectOption("deny");
                    await capPanel.getByRole("textbox", { name: "Runtime", exact: true }).fill("sh");
                    await capPanel.getByRole("textbox", { name: "Traits", exact: true }).fill("network");
                    nextProblem = {
                        type: "https://problems.plurnk.xyz/workspace/active-work",
                        title: "Conflict",
                        status: 409,
                        detail: "Workspace has active loop work.",
                        recovery: "Wait for active loops to settle or stop them first.",
                    };
                    await capPanel.getByRole("button", { name: "Add rule", exact: true }).click();
                    await page.waitForFunction(() => document.querySelector("#dialog-workspace-settings [data-text='ws-settings-message']")?.textContent === "Workspace has active loop work.");
                    assert.equal(await dialog.locator('[data-text="ws-settings-recovery"]').textContent(), "Wait for active loops to settle or stop them first.");
                    assert.equal(await capPanel.getByRole("textbox", { name: "Runtime", exact: true }).inputValue(), "sh", "409 refusal preserves unsaved rule input");

                    await capPanel.getByRole("button", { name: "Add rule", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll("#dialog-workspace-settings [data-cap-rows] tr").length === 1);
                    assert.match(await capPanel.locator("[data-cap-rows] tr").first().textContent(), /deny[\s\S]*runtime=sh · traits=network/u);
                    assert.equal(await capPanel.getByRole("textbox", { name: "Runtime", exact: true }).inputValue(), "");
                    await capPanel.locator("[data-cap-rows] tr").first().getByRole("button", { name: "Remove", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll("#dialog-workspace-settings [data-cap-rows] tr").length === 0);

                    // MCP: list, service-vs-workspace buttons, OAuth begin+complete, discover+Add, streamable-http save
                    await dialog.getByRole("button", { name: "MCP", exact: true }).click();
                    const mcpPanel = dialog.locator('[data-settings-panel="mcp"]');
                    await page.waitForFunction(() => document.querySelectorAll('#dialog-workspace-settings [data-settings-panel="mcp"] [data-family-rows] tr').length === 2);
                    const svcRow = mcpPanel.locator("[data-family-rows] tr").nth(0);
                    const oauthRow = mcpPanel.locator("[data-family-rows] tr").nth(1);
                    assert.equal(await svcRow.getByRole("button", { name: "Remove", exact: true, includeHidden: true }).isVisible(), false, "service-origin MCP server has no Remove button");
                    assert.equal(await oauthRow.getByRole("button", { name: "Authorize", exact: true }).isVisible(), true);

                    await oauthRow.getByRole("button", { name: "Authorize", exact: true }).click();
                    const oauthBox = mcpPanel.locator("[data-mcp-oauth-box]");
                    await oauthBox.waitFor({ state: "visible" });
                    assert.equal(await oauthBox.locator("[data-mcp-oauth-link]").getAttribute("href"), "https://auth.example/authorize?state=xyz");
                    await oauthBox.getByLabel("OAuth callback URL", { exact: true }).fill("http://127.0.0.1/callback?code=ok&state=xyz");
                    await oauthBox.getByRole("button", { name: "Complete authorization", exact: true }).click();
                    await oauthBox.waitFor({ state: "hidden" });
                    assert.equal(await oauthRow.locator('[data-text="family-status"]').textContent(), "active");

                    await mcpPanel.getByRole("searchbox", { name: "Search MCP registry", exact: true }).fill("sqlite");
                    await mcpPanel.locator("[data-family-discover-form]").getByRole("button", { name: "Discover", exact: true }).click();
                    await mcpPanel.locator("[data-candidate-rows] li").first().waitFor({ state: "visible" });
                    await mcpPanel.locator("[data-candidate-rows] li").first().getByRole("button", { name: "Add", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#dialog-workspace-settings [data-settings-panel="mcp"] [data-family-rows] tr').length === 3);

                    // Skills: discover + candidate Add (stripping commit)
                    await dialog.getByRole("button", { name: "Skills", exact: true }).click();
                    const skillsPanel = dialog.locator('[data-settings-panel="skills"]');
                    await skillsPanel.getByRole("textbox", { name: "Skill discovery source", exact: true }).fill("https://git.example/skills.git");
                    await skillsPanel.locator("[data-family-discover-form]").getByRole("button", { name: "Discover", exact: true }).click();
                    await skillsPanel.locator("[data-candidate-rows] li").first().waitFor({ state: "visible" });
                    await skillsPanel.locator("[data-candidate-rows] li").first().getByRole("button", { name: "Add", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#dialog-workspace-settings [data-settings-panel="skills"] [data-family-rows] tr').length === 1);
                    const skillReplaceReq = requests.find((r) => r.params?.kind === "workspace.skills.replace");
                    assert.equal("commit" in skillReplaceReq.params.params, false, "client strips service-owned commit field when adding discovered skill");

                    // Schedule: rule preview + save normalizing bare session name to session://
                    await dialog.getByRole("button", { name: "Schedule", exact: true }).click();
                    const schedulePanel = dialog.locator('[data-settings-panel="schedule"]');
                    await schedulePanel.getByRole("textbox", { name: "Preview schedule rule", exact: true }).fill("FREQ=DAILY");
                    await schedulePanel.locator("[data-family-discover-form]").getByRole("button", { name: "Preview", exact: true }).click();
                    await schedulePanel.locator("[data-candidate-rows] li").first().waitFor({ state: "visible" });
                    assert.equal(await schedulePanel.locator("[data-candidate-rows] li").first().getByRole("button", { name: "Add", exact: true, includeHidden: true }).isVisible(), false);
                    await schedulePanel.getByRole("textbox", { name: "Schedule name", exact: true }).fill("daily-audit");
                    await schedulePanel.getByRole("textbox", { name: "Target session", exact: true }).fill("user");
                    await schedulePanel.getByRole("textbox", { name: "Schedule rule", exact: true }).fill("0 9 * * 1-5");
                    await schedulePanel.getByRole("textbox", { name: "Scheduled prompt", exact: true }).fill("Check status.");
                    await schedulePanel.getByRole("button", { name: "Save schedule", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#dialog-workspace-settings [data-settings-panel="schedule"] [data-family-rows] tr').length === 1);
                    assert.equal(requests.find((r) => r.params?.kind === "workspace.schedule.replace").params.params.target, "session://user");

                    // Overview Environment: locked to workspace scope, hides session scope selector, never leaks secret values
                    await dialog.getByRole("button", { name: "Environment", exact: true }).click();
                    const envSection = dialog.locator('[data-settings-panel="env"]');
                    await page.waitForFunction(() => document.querySelectorAll('#dialog-workspace-settings [data-settings-panel="env"] tbody tr').length === 1);
                    assert.equal(await envSection.locator("[data-ws-env-scope-form]").isVisible(), false, "Overview mode hides session env scope switcher");
                    assert.doesNotMatch(await envSection.textContent(), /ws-secret-value/u);

                    await dialog.getByRole("button", { name: "Close", exact: true }).click();
                    await dialog.waitFor({ state: "hidden" });

                    // 2. Session mode (sessionName = "user"): slash-command Settings jump + per-session persona configOption + session env scope
                    await page.evaluate(() => window.setSessionContext("user"));
                    assert.equal(await page.evaluate(() => window.runCommand("/personas list")), true);
                    const cmdCard = page.locator("#session-command-results > ul > li").last();
                    await cmdCard.getByRole("button", { name: "Settings", exact: true }).click();
                    await dialog.waitFor({ state: "visible" });
                    const personasPanel = dialog.locator('[data-settings-panel="personas"]');
                    await personasPanel.waitFor({ state: "visible" });
                    const sessionPersonaForm = personasPanel.locator("[data-session-persona-form]");
                    await sessionPersonaForm.waitFor({ state: "visible" });
                    await sessionPersonaForm.getByRole("combobox", { name: "Active session persona", exact: true }).selectOption("auditor");
                    await sessionPersonaForm.getByRole("button", { name: "Apply to session", exact: true }).click();
                    await page.waitForFunction(() => document.querySelector("#dialog-workspace-settings [data-text='ws-settings-message']")?.textContent === "Session persona: auditor.");
                    assert.equal(activeSessionPersona, "auditor");

                    // Switch to Environment in Session mode and verify session listing scope
                    await dialog.getByRole("button", { name: "Environment", exact: true }).click();
                    await envSection.locator("[data-ws-env-scope-form]").waitFor({ state: "visible" });
                    await envSection.getByRole("combobox", { name: "Environment listing scope", exact: true }).selectOption("session");
                    await page.waitForFunction(() => document.querySelectorAll('#dialog-workspace-settings [data-settings-panel="env"] tbody tr').length === 2);
                    assert.doesNotMatch(await envSection.textContent(), /ws-secret-value|sess-secret-value/u);

                    checkBrowser();
                } finally {
                    await browser.close();
                }
            });
        }
    } finally {
        await fixture.server.close();
    }
}
