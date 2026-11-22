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
                    let activeWork = false;
                    /** @type {any[]} */
                    let mcpDefs = [
                        {
                            alias: "svc-git",
                            origin: "service",
                            state: "unavailable",
                            definition: { type: "stdio", command: "git-mcp", args: ["--read-only", "--config=/very/long/path/to/operator/mcp/configuration.json"] },
                            problem: { detail: "Configured MCP server 'svc-git' is unavailable. Error: MCP connection failed." },
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
                    let activeSessionModel = "local";
                    let activeSessionEffort = "low";
                    /** @type {any[]} */
                    let memberDefs = [];
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
                        if (activeWork && input.method === "_plurnk/action" && !input.params.kind.endsWith(".list")) {
                            return {
                                error: {
                                    code: -32000,
                                    message: "Workspace has active loop work.",
                                    data: {
                                        type: "https://problems.plurnk.xyz/workspace/active-work",
                                        title: "Conflict",
                                        status: 409,
                                        detail: "Workspace has active loop work.",
                                        recovery: "Wait for active loops to settle or stop them first.",
                                    },
                                },
                            };
                        }
                        if (input.method === "providers/list") {
                            return {
                                result: {
                                    providers: [
                                        { providerId: "local", supported: ["fixture"], required: false, _meta: { plurnk: { alias: "local", provider: "fixture", model: "small", effort: "low", effortSource: "default", active: true } } },
                                        { providerId: "fast", supported: ["fixture"], required: false, _meta: { plurnk: { alias: "fast", provider: "fixture", model: "fast", effort: "high", effortSource: "default", active: false } } },
                                    ],
                                },
                            };
                        }
                        const sessionConfigOptions = () => [
                            {
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
                            },
                            {
                                configId: "thought_level",
                                name: "Reasoning Effort",
                                type: "select",
                                currentValue: activeSessionEffort,
                                options: [
                                    { value: "low", name: "low" },
                                    { value: "high", name: "high" },
                                ],
                            },
                        ];
                        const sessionStatusMeta = () => ({
                            status: {
                                model: {
                                    alias: activeSessionModel,
                                    provider: "fixture",
                                    model: activeSessionModel === "fast" ? "fast" : "small",
                                    effort: activeSessionEffort,
                                    effortSource: "explicit",
                                },
                            },
                        });
                        if (input.method === "session/resume") {
                            return {
                                result: {
                                    configOptions: sessionConfigOptions(),
                                    availableCommands: [],
                                    _meta: { plurnk: sessionStatusMeta() },
                                },
                            };
                        }
                        if (input.method === "session/set_config_option") {
                            if (input.params.configId === "persona") activeSessionPersona = input.params.value;
                            if (input.params.configId === "model") activeSessionModel = input.params.value;
                            if (input.params.configId === "thought_level") activeSessionEffort = input.params.value;
                            return {
                                result: {
                                    configOptions: sessionConfigOptions(),
                                    _meta: { plurnk: sessionStatusMeta() },
                                },
                            };
                        }
                        assert.equal(input.method, "_plurnk/action");
                        const { kind, params } = input.params;
                        switch (kind) {
                            case "models.list":
                                return {
                                    result: {
                                        items: [{
                                            selector: "fixture/small",
                                            provider: "fixture",
                                            providerName: "Fixture",
                                            model: "small",
                                            modelName: params?.search ? `Small (${params.search})` : "Fixture Small",
                                            limits: { contextTokens: 32768 },
                                            capabilities: {
                                                attachment: false,
                                                reasoning: true,
                                                efforts: ["low", "high"],
                                                toolCall: true,
                                                inputModalities: ["text"],
                                                outputModalities: ["text"],
                                            },
                                            readiness: { ready: true, causes: [] },
                                        }],
                                        offset: 0,
                                        total: 1,
                                    },
                                };
                            case "models.local":
                                return { result: { candidates: [] } };
                            case "service.env.list":
                                return { result: { configFile: "/tmp/.env", entries: [] } };
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
                            case "workspace.members.list":
                                return { result: { family: "members", definitions: memberDefs } };
                            case "workspace.members.discover":
                                return {
                                    result: {
                                        family: "members",
                                        candidates: [{
                                            alias: params.query,
                                            summary: `Matches 2 files (${params.query})`,
                                            definition: { glob: params.query },
                                            provenance: { kind: "preview", source: params.query },
                                        }],
                                    },
                                };
                            case "workspace.members.add": {
                                const files = Array.isArray(params.files) ? params.files : [];
                                for (const glob of files) {
                                    memberDefs = [
                                        ...memberDefs.filter((d) => d.alias !== glob),
                                        { alias: glob, origin: "workspace", state: "active", definition: { glob }, detail: { effect: glob.startsWith("!") ? "exclude" : "include", matched: 2 } },
                                    ];
                                }
                                return { result: { status: 201, family: "members", definitions: memberDefs } };
                            }
                            case "workspace.members.remove":
                                memberDefs = memberDefs.filter((d) => d.alias !== params.file);
                                return { result: { status: 200, family: "members", alias: params.file, removed: true } };
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

                    // 1. Workspace-only mode on /settings/?workspace=conversation (sessionName = null): workspace-only actions with workspaceId: 7 and omitted sessionId
                    await page.goto(new URL("/settings/?workspace=conversation", fixture.url).href);
                    const settingsArticle = page.locator("#workspace-settings");
                    await settingsArticle.waitFor({ state: "visible" });
                    assert.equal(await settingsArticle.getByRole("link", { name: "General", exact: true }).getAttribute("aria-current"), "true");
                    assert.equal(await settingsArticle.locator("#workspace-rename").isVisible(), true);
                    assert.equal(await settingsArticle.locator("#workspace-archive").isVisible(), true);

                    await settingsArticle.getByRole("link", { name: "MCP", exact: true }).click();
                    await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null && document.querySelectorAll('#workspace-settings [data-settings-panel="mcp"] [data-family-rows] tr').length === 2);

                    assert.equal(requests.at(-1).params.kind, "workspace.mcp.list");
                    assert.equal(requests.at(-1).params.workspaceId, 7);
                    assert.equal("sessionId" in requests.at(-1).params, false, "Workspace-only /settings/ sends workspaceId without session attachment");
                    assert.equal(await settingsArticle.getByRole("link", { name: "MCP", exact: true }).getAttribute("aria-current"), "true");

                    for (const width of [320, 1280]) {
                        await page.setViewportSize({ width, height: 740 });
                        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no page overflow at ${width}px`);
                    }
                    await page.setViewportSize({ width: 1280, height: 740 });
                    assert.equal(
                        await page.evaluate(() => {
                            const fig = document.querySelector('#workspace-settings [data-settings-panel="mcp"] [data-family-table-wrap]');
                            const tbl = fig?.querySelector("table");
                            return Boolean(fig && tbl && tbl.scrollWidth <= fig.clientWidth);
                        }),
                        true,
                        "MCP table fits cleanly inside 72rem desktop measure without horizontal table scrollbar",
                    );
                    await page.setViewportSize({ width: 320, height: 740 });

                    // MCP: list, Retry on unavailable row, service-vs-workspace buttons, OAuth begin+complete, + Add server dialog (discover+Add, 409 refusal keeping dialog open, save + remove)
                    const mcpPanel = settingsArticle.locator('[data-settings-panel="mcp"]');
                    const mcpDialog = page.locator("#dialog-settings-mcp");
                    assert.equal(await mcpPanel.isVisible(), true);
                    assert.equal(await mcpDialog.isVisible(), false, "creation forms live inside closed <dialog> until opened");
                    const svcRow = mcpPanel.locator("[data-family-rows] tr").nth(0);
                    const oauthRow = mcpPanel.locator("[data-family-rows] tr").nth(1);
                    assert.equal(await svcRow.getByRole("button", { name: "Remove", exact: true, includeHidden: true }).isVisible(), false, "service-origin MCP server has no Remove button");
                    assert.equal(await svcRow.getByRole("button", { name: "Retry", exact: true }).isVisible(), true, "unavailable MCP server exposes 1-click Retry");
                    assert.equal(await svcRow.getByRole("button", { name: "Disable", exact: true }).isVisible(), true);
                    assert.equal(await svcRow.getByRole("button", { name: "Enable", exact: true, includeHidden: true }).isVisible(), false);
                    await svcRow.getByRole("button", { name: "Retry", exact: true }).click();
                    await page.waitForFunction(() => document.querySelector('#workspace-settings [data-settings-panel="mcp"] [data-family-rows] tr [data-text="family-status"]')?.textContent === "active");
                    assert.equal(await svcRow.getByRole("button", { name: "Retry", exact: true, includeHidden: true }).isVisible(), false, "Retry hides once server is active");

                    assert.equal(await oauthRow.getByRole("button", { name: "Authorize", exact: true }).isVisible(), true);
                    await oauthRow.getByRole("button", { name: "Authorize", exact: true }).click();
                    const oauthBox = mcpPanel.locator("[data-mcp-oauth-box]");
                    await oauthBox.waitFor({ state: "visible" });
                    assert.equal(await oauthBox.locator("[data-mcp-oauth-link]").getAttribute("href"), "https://auth.example/authorize?state=xyz");
                    await oauthBox.getByLabel("OAuth callback URL", { exact: true }).fill("http://127.0.0.1/callback?code=ok&state=xyz");
                    await oauthBox.getByRole("button", { name: "Complete authorization", exact: true }).click();
                    await oauthBox.waitFor({ state: "hidden" });
                    assert.equal(await oauthRow.locator('[data-text="family-status"]').textContent(), "active");

                    await mcpPanel.getByRole("button", { name: "+ Add server", exact: true }).click();
                    await mcpDialog.waitFor({ state: "visible" });
                    await mcpDialog.getByRole("searchbox", { name: "Search MCP registry", exact: true }).fill("sqlite");
                    await mcpDialog.locator("[data-family-discover-form]").getByRole("button", { name: "Discover", exact: true }).click();
                    await mcpDialog.locator("[data-candidate-rows] li").first().waitFor({ state: "visible" });
                    await mcpDialog.locator("[data-candidate-rows] li").first().getByRole("button", { name: "Add", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="mcp"] [data-family-rows] tr').length === 3);
                    assert.equal(await mcpDialog.isVisible(), false, "adding a candidate closes the dialog");

                    await mcpPanel.getByRole("button", { name: "+ Add server", exact: true }).click();
                    await mcpDialog.waitFor({ state: "visible" });
                    await mcpDialog.getByRole("combobox", { name: "MCP transport", exact: true }).selectOption("streamable-http");
                    await mcpDialog.getByRole("combobox", { name: "Endpoint authentication", exact: true }).selectOption("bearer");
                    await mcpDialog.getByRole("textbox", { name: "Server alias", exact: true }).fill("edge-api");
                    await mcpDialog.getByLabel("Endpoint URL", { exact: true }).fill("https://edge.example/mcp");
                    await mcpDialog.getByRole("textbox", { name: "Bearer token reference", exact: true }).fill("${EDGE_TOKEN}");
                    activeWork = true;
                    await mcpDialog.getByRole("button", { name: "Save server", exact: true }).click();
                    await page.waitForFunction(() => document.querySelector('#dialog-settings-mcp [data-text="ws-settings-message"]')?.textContent === "Workspace has active loop work.");
                    assert.equal(await mcpDialog.isVisible(), true, "409 refusal keeps the dialog open");
                    assert.equal(await mcpDialog.locator('[data-text="ws-settings-recovery"]').textContent(), "Wait for active loops to settle or stop them first.");
                    assert.equal(await mcpDialog.getByRole("textbox", { name: "Server alias", exact: true }).inputValue(), "edge-api", "409 refusal preserves unsaved MCP server input");
                    assert.equal(await mcpDialog.getByLabel("Endpoint URL", { exact: true }).inputValue(), "https://edge.example/mcp");
                    assert.equal(await mcpDialog.getByRole("textbox", { name: "Bearer token reference", exact: true }).inputValue(), "${EDGE_TOKEN}");

                    activeWork = false;
                    await mcpDialog.getByRole("button", { name: "Save server", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="mcp"] [data-family-rows] tr').length === 4);
                    assert.equal(await mcpDialog.isVisible(), false, "successful save closes the dialog");
                    assert.match(await mcpPanel.locator("[data-family-rows] tr").last().textContent(), /edge-api[\s\S]*https:\/\/edge\.example\/mcp \(bearer\)/u);
                    assert.equal(await mcpDialog.locator('input[name="alias"]').inputValue(), "");
                    assert.equal(await mcpDialog.locator('input[name="url"]').inputValue(), "");
                    await mcpPanel.locator("[data-family-rows] tr").last().getByRole("button", { name: "Remove", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="mcp"] [data-family-rows] tr').length === 3);

                    // Skills: + Add skill dialog -> discover + candidate Add (stripping commit)
                    await settingsArticle.getByRole("link", { name: "Skills", exact: true }).click();
                    const skillsPanel = settingsArticle.locator('[data-settings-panel="skills"]');
                    const skillsDialog = page.locator("#dialog-settings-skills");
                    await skillsPanel.getByRole("button", { name: "+ Add skill", exact: true }).click();
                    await skillsDialog.waitFor({ state: "visible" });
                    await skillsDialog.getByRole("textbox", { name: "Skill discovery source", exact: true }).fill("https://git.example/skills.git");
                    await skillsDialog.locator("[data-family-discover-form]").getByRole("button", { name: "Discover", exact: true }).click();
                    await skillsDialog.locator("[data-candidate-rows] li").first().waitFor({ state: "visible" });
                    await skillsDialog.locator("[data-candidate-rows] li").first().getByRole("button", { name: "Add", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="skills"] [data-family-rows] tr').length === 1);
                    const skillReplaceReq = requests.find((r) => r.params?.kind === "workspace.skills.replace");
                    assert.equal("commit" in skillReplaceReq.params.params, false, "client strips service-owned commit field when adding discovered skill");

                    // Schedule: + Add schedule dialog -> rule preview + save normalizing bare session name to session://
                    await settingsArticle.getByRole("link", { name: "Schedule", exact: true }).click();
                    const schedulePanel = settingsArticle.locator('[data-settings-panel="schedule"]');
                    const scheduleDialog = page.locator("#dialog-settings-schedule");
                    await schedulePanel.getByRole("button", { name: "+ Add schedule", exact: true }).click();
                    await scheduleDialog.waitFor({ state: "visible" });
                    await scheduleDialog.getByRole("textbox", { name: "Preview schedule rule", exact: true }).fill("FREQ=DAILY");
                    await scheduleDialog.locator("[data-family-discover-form]").getByRole("button", { name: "Preview", exact: true }).click();
                    await scheduleDialog.locator("[data-candidate-rows] li").first().waitFor({ state: "visible" });
                    assert.equal(await scheduleDialog.locator("[data-candidate-rows] li").first().getByRole("button", { name: "Add", exact: true, includeHidden: true }).isVisible(), false);
                    await scheduleDialog.getByRole("textbox", { name: "Schedule name", exact: true }).fill("daily-audit");
                    await scheduleDialog.getByRole("textbox", { name: "Target session", exact: true }).fill("user");
                    await scheduleDialog.getByRole("textbox", { name: "Schedule rule", exact: true }).fill("0 9 * * 1-5");
                    await scheduleDialog.getByRole("textbox", { name: "Scheduled prompt", exact: true }).fill("Check status.");
                    await scheduleDialog.getByRole("button", { name: "Save schedule", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="schedule"] [data-family-rows] tr').length === 1);
                    assert.equal(await scheduleDialog.isVisible(), false);
                    assert.equal(requests.find((r) => r.params?.kind === "workspace.schedule.replace").params.params.target, "session://user");

                    // Members: + Add rules dialog -> preview + candidate Add + batch add + row Remove ({ file })
                    await settingsArticle.getByRole("link", { name: "Members", exact: true }).click();
                    const membersPanel = settingsArticle.locator('[data-settings-panel="members"]');
                    const membersDialog = page.locator("#dialog-settings-members");
                    await membersPanel.getByRole("button", { name: "+ Add rules", exact: true }).click();
                    await membersDialog.waitFor({ state: "visible" });
                    await membersDialog.getByRole("textbox", { name: "Inspect file or glob", exact: true }).fill("docs/**");
                    await membersDialog.locator("[data-family-discover-form]").getByRole("button", { name: "Preview", exact: true }).click();
                    await membersDialog.locator("[data-candidate-rows] li").first().getByRole("button", { name: "Add", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="members"] [data-family-rows] tr').length === 1);
                    assert.equal(await membersDialog.isVisible(), false);
                    await membersPanel.getByRole("button", { name: "+ Add rules", exact: true }).click();
                    await membersDialog.waitFor({ state: "visible" });
                    await membersDialog.getByRole("textbox", { name: "Member globs", exact: true }).fill("!docs/drafts/**");
                    await membersDialog.getByRole("button", { name: "Add rules", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="members"] [data-family-rows] tr').length === 2);
                    assert.equal(await membersDialog.isVisible(), false);
                    await membersPanel.locator("[data-family-rows] tr").first().getByRole("button", { name: "Remove", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="members"] [data-family-rows] tr').length === 1);
                    assert.deepEqual(requests.find((r) => r.params?.kind === "workspace.members.remove").params.params, { file: "docs/**" });

                    // Workspace-only Environment: locked to workspace scope, hides session scope selector, never leaks secret values
                    await settingsArticle.getByRole("link", { name: "Environment", exact: true }).click();
                    const envSection = settingsArticle.locator('[data-settings-panel="env"]');
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="env"] tbody tr').length === 1);
                    assert.equal(await envSection.locator("[data-ws-env-scope-form]").isVisible(), false, "Workspace-only mode hides session env scope switcher");
                    assert.doesNotMatch(await envSection.textContent(), /ws-secret-value/u);

                    // Help tab renders keyboard shortcuts and live-filterable slash commands
                    await settingsArticle.getByRole("link", { name: "Help", exact: true }).click();
                    const helpPanel = settingsArticle.locator('[data-settings-panel="help"]');
                    await helpPanel.waitFor({ state: "visible" });
                    assert.equal(await helpPanel.locator('dl[aria-label="Keyboard shortcuts"]').isVisible(), true);
                    const helpFilter = helpPanel.getByRole("searchbox", { name: "Filter commands", exact: true });
                    await helpFilter.fill("rollback");
                    assert.deepEqual(
                        await helpPanel.locator("[data-command-name]:not([hidden])").evaluateAll((els) => els.map((el) => el.getAttribute("data-command-name"))),
                        ["rollback"],
                    );

                    // 2. Session mode (sessionName = "user"): `/personas list` navigates directly to /settings/?workspace=conversation&session=user#personas
                    await page.goto(fixture.url);
                    await page.waitForFunction(() => typeof window.runCommand === "function");
                    await page.evaluate(() => window.setSessionContext("user"));
                    void page.evaluate(() => window.runCommand("/personas list"));
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/" && new URL(url).hash === "#personas");
                    await settingsArticle.waitFor({ state: "visible" });
                    const personasPanel = settingsArticle.locator('[data-settings-panel="personas"]');
                    await personasPanel.waitFor({ state: "visible" });
                    assert.equal(await settingsArticle.getByRole("link", { name: "Personas", exact: true }).getAttribute("aria-current"), "true");
                    const sessionPersonaForm = personasPanel.locator("[data-session-persona-form]");
                    await sessionPersonaForm.waitFor({ state: "visible" });
                    await sessionPersonaForm.getByRole("combobox", { name: "Active session persona", exact: true }).selectOption("auditor");
                    await sessionPersonaForm.getByRole("button", { name: "Apply to session", exact: true }).click();
                    await page.waitForFunction(() => document.querySelector("#workspace-settings [data-text='ws-settings-message']")?.textContent === "Session persona: auditor.");
                    assert.equal(activeSessionPersona, "auditor");

                    // Models tab in Session mode: shows aliases, catalog search, + Add model onboarding dialog, and session model + effort apply
                    await settingsArticle.getByRole("link", { name: "Models", exact: true }).click();
                    const modelsPanel = settingsArticle.locator('[data-settings-panel="models"]');
                    await modelsPanel.waitFor({ state: "visible" });
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="models"] [data-models-alias-rows] tr').length === 2);
                    assert.equal(await modelsPanel.locator("[data-models-catalog-rows] tr").count(), 1);
                    const sessionModelForm = modelsPanel.locator("[data-session-model-form]");
                    await sessionModelForm.waitFor({ state: "visible" });
                    await sessionModelForm.getByRole("combobox", { name: "Active session model", exact: true }).selectOption("fast");
                    await sessionModelForm.getByRole("combobox", { name: "Reasoning effort", exact: true }).selectOption("high");
                    await sessionModelForm.getByRole("button", { name: "Apply to session", exact: true }).click();
                    await page.waitForFunction(() => (document.querySelector("#workspace-settings [data-text='ws-settings-message']")?.textContent ?? "").includes("fixture/fast"));
                    assert.equal(activeSessionModel, "fast");
                    assert.equal(activeSessionEffort, "high");
                    await modelsPanel.getByRole("button", { name: "+ Add model", exact: true }).click();
                    await page.locator("#dialog-onboarding").waitFor({ state: "visible" });
                    await page.locator("#dialog-onboarding [data-dialog-close]").first().click();
                    await page.locator("#dialog-onboarding").waitFor({ state: "hidden" });

                    // Switch to Environment in Session mode and verify session listing scope
                    await settingsArticle.getByRole("link", { name: "Environment", exact: true }).click();
                    await envSection.locator("[data-ws-env-scope-form]").waitFor({ state: "visible" });
                    await envSection.getByRole("combobox", { name: "Environment listing scope", exact: true }).selectOption("session");
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="env"] tbody tr').length === 2);
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
