import assert from "node:assert/strict";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics from "./browser-diagnostics.js";

// {§web-workspace-settings} Multi-engine verification of workspace and session management across Workspace-only and Session scopes.
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
                    let failNextSessionOptions = false;
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
                    let activeSpawnModel = "inherit";
                    let activeSessionMode = "review";
                    let activeSessionTitle = "";
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
                        assert.notEqual(input.method, "session/resume", "/settings/ must use side-effect-free session/options, never session/resume");
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
                                        { providerId: "uncataloged", supported: ["custom"], required: false, _meta: { plurnk: { alias: "uncataloged", provider: "custom", model: "plain", effortSource: "default", active: false } } },
                                    ],
                                },
                            };
                        }
                        const currentEfforts = activeSessionModel === "fast"
                            ? ["medium", "high"]
                            : activeSessionModel === "uncataloged"
                                ? []
                                : activeSessionModel === "fixture/plain"
                                    ? ["off", "adaptive"]
                                    : ["low", "high"];
                        const sessionConfigOptions = () => [
                            {
                                configId: "model",
                                name: "Model",
                                type: "select",
                                currentValue: activeSessionModel,
                                options: [
                                    { value: "local", name: "local — fixture/small", description: null },
                                    { value: "fast", name: "fast — fixture/fast", description: null },
                                    { value: "uncataloged", name: "uncataloged — custom/plain", description: null },
                                ],
                            },
                            {
                                configId: "mode",
                                name: "Approval Policy",
                                type: "select",
                                currentValue: activeSessionMode,
                                options: [
                                    { value: "review", name: "Ask before external mutations", description: null },
                                    { value: "accept", name: "Auto-approve all operations", description: null },
                                    { value: "reject", name: "Deny gated operations", description: null },
                                ],
                            },
                            {
                                configId: "spawn_model",
                                name: "Child Session Model",
                                type: "select",
                                currentValue: activeSpawnModel,
                                options: [
                                    { value: "inherit", name: "Inherit session model", description: null },
                                    { value: "local", name: "local — fixture/small", description: null },
                                    { value: "fast", name: "fast — fixture/fast", description: null },
                                ],
                            },
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
                            ...(currentEfforts.length > 0
                                ? [{
                                    configId: "thought_level",
                                    name: "Reasoning Effort",
                                    type: "select",
                                    currentValue: activeSessionEffort,
                                    options: currentEfforts.map((v) => ({ value: v, name: v })),
                                }]
                                : []),
                        ];
                        const sessionStatusMeta = () => ({
                            status: {
                                model: {
                                    ...(activeSessionModel.includes("/") ? {} : { alias: activeSessionModel }),
                                    provider: "fixture",
                                    model: activeSessionModel === "fast" ? "fast" : activeSessionModel === "fixture/plain" ? "plain" : "small",
                                    ...(currentEfforts.length > 0 ? { effort: activeSessionEffort, effortSource: "explicit" } : {}),
                                },
                            },
                        });
                        if (input.method === "session/options") {
                            if (failNextSessionOptions) {
                                failNextSessionOptions = false;
                                return {
                                    error: {
                                        code: -32000,
                                        message: "Session options temporarily unavailable.",
                                        data: {
                                            type: "https://problems.plurnk.xyz/session/unavailable",
                                            title: "Service Unavailable",
                                            status: 503,
                                            detail: "Session options temporarily unavailable.",
                                            recovery: "Retry opening the Session tab.",
                                        },
                                    },
                                };
                            }
                            return {
                                result: {
                                    configOptions: sessionConfigOptions(),
                                    availableCommands: [],
                                },
                            };
                        }
                        if (input.method === "session/set_title") {
                            activeSessionTitle = input.params.title;
                            return { result: { title: activeSessionTitle } };
                        }
                        if (input.method === "session/set_config_option") {
                            if (input.params.configId === "persona") activeSessionPersona = input.params.value;
                            if (input.params.configId === "model") activeSessionModel = input.params.value;
                            if (input.params.configId === "thought_level") activeSessionEffort = input.params.value;
                            if (input.params.configId === "spawn_model") activeSpawnModel = input.params.value;
                            if (input.params.configId === "mode") activeSessionMode = input.params.value;
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
                            case "models.list": {
                                assert.equal(params?.limit, 100, "models.list honors schema maximum limit of 100");
                                const allCatalog = [
                                    {
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
                                    },
                                    {
                                        selector: "fixture/fast",
                                        provider: "fixture",
                                        providerName: "Fixture",
                                        model: "fast",
                                        modelName: "Fixture Fast",
                                        limits: { contextTokens: 65536 },
                                        capabilities: {
                                            attachment: false,
                                            reasoning: true,
                                            efforts: ["medium", "high"],
                                            toolCall: true,
                                            inputModalities: ["text"],
                                            outputModalities: ["text"],
                                        },
                                        readiness: { ready: true, causes: [] },
                                    },
                                    {
                                        selector: "fixture/plain",
                                        provider: "fixture",
                                        providerName: "Fixture",
                                        model: "plain",
                                        modelName: "Fixture Plain",
                                        limits: { contextTokens: 16384 },
                                        capabilities: {
                                            attachment: false,
                                            reasoning: false,
                                            efforts: ["off", "adaptive"],
                                            toolCall: true,
                                            inputModalities: ["text"],
                                            outputModalities: ["text"],
                                        },
                                        readiness: { ready: true, causes: [] },
                                    },
                                ];
                                const filtered = params?.search
                                    ? allCatalog.filter((m) => m.selector.includes(params.search) || m.modelName.toLowerCase().includes(String(params.search).toLowerCase()))
                                    : allCatalog;
                                return {
                                    result: {
                                        items: filtered,
                                        offset: 0,
                                        total: filtered.length,
                                    },
                                };
                            }
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

                    // 1. Workspace-only mode on /settings/?workspace=conversation (sessionName = null): zero stacked settings modals, zero initial ACP calls
                    await page.goto(new URL("/settings/?workspace=conversation", fixture.url).href);
                    const settingsArticle = page.locator("#workspace-settings");
                    await settingsArticle.waitFor({ state: "visible" });
                    assert.equal(await page.locator('#workspace-settings dialog').count(), 0, "subsystem tabs mount zero stacked <dialog> modals");
                    assert.equal(await settingsArticle.getByRole("link", { name: "Workspace", exact: true }).getAttribute("aria-current"), "true");
                    assert.equal(await settingsArticle.locator("#workspace-rename").isVisible(), true);
                    assert.equal(await settingsArticle.locator('button[form="workspace-archive"]').isVisible(), true);
                    assert.equal(await settingsArticle.getByRole("button", { name: "+ Add workspace", exact: true }).isVisible(), true);
                    assert.equal(requests.length, 0, "Workspace-only /settings/ issues zero ACP calls on initial #workspace render");

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

                    // MCP: list, Retry on unavailable row, service-vs-workspace buttons, OAuth begin+complete, inline <details data-family-disclosure="mcp">
                    const mcpPanel = settingsArticle.locator('[data-settings-panel="mcp"]');
                    const mcpDisclosure = mcpPanel.locator('details[data-family-disclosure="mcp"]');
                    assert.equal(await mcpPanel.isVisible(), true);
                    assert.equal(await mcpDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), false, "creation forms start collapsed in inline disclosure");
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

                    await mcpDisclosure.locator("> summary").click();
                    assert.equal(await mcpDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), true);
                    await mcpDisclosure.getByRole("searchbox", { name: "Search MCP registry", exact: true }).fill("sqlite");
                    await mcpDisclosure.locator("[data-family-discover-form]").getByRole("button", { name: "Discover", exact: true }).click();
                    await mcpDisclosure.locator("[data-candidate-rows] li").first().waitFor({ state: "visible" });
                    await mcpDisclosure.locator("[data-candidate-rows] li").first().getByRole("button", { name: "Add", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="mcp"] [data-family-rows] tr').length === 3);
                    assert.equal(await mcpDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), false, "adding a candidate collapses the inline disclosure");

                    await mcpDisclosure.locator("> summary").click();
                    await mcpDisclosure.getByRole("combobox", { name: "MCP transport", exact: true }).selectOption("streamable-http");
                    await mcpDisclosure.getByRole("combobox", { name: "Endpoint authentication", exact: true }).selectOption("bearer");
                    await mcpDisclosure.getByRole("textbox", { name: "Server alias", exact: true }).fill("edge-api");
                    await mcpDisclosure.getByLabel("Endpoint URL", { exact: true }).fill("https://edge.example/mcp");
                    await mcpDisclosure.getByRole("textbox", { name: "Bearer token reference", exact: true }).fill("${EDGE_TOKEN}");
                    activeWork = true;
                    await mcpDisclosure.getByRole("button", { name: "Save server", exact: true }).click();
                    await page.waitForFunction(() => document.querySelector('#workspace-settings > [data-text="ws-settings-message"]')?.textContent === "Workspace has active loop work.");
                    assert.equal(await mcpDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), true, "409 refusal keeps the disclosure open");
                    assert.equal(await settingsArticle.locator('> [data-text="ws-settings-recovery"]').textContent(), "Wait for active loops to settle or stop them first.");
                    assert.equal(await mcpDisclosure.getByRole("textbox", { name: "Server alias", exact: true }).inputValue(), "edge-api", "409 refusal preserves unsaved MCP server input");
                    assert.equal(await mcpDisclosure.getByLabel("Endpoint URL", { exact: true }).inputValue(), "https://edge.example/mcp");
                    assert.equal(await mcpDisclosure.getByRole("textbox", { name: "Bearer token reference", exact: true }).inputValue(), "${EDGE_TOKEN}");

                    activeWork = false;
                    await mcpDisclosure.getByRole("button", { name: "Save server", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="mcp"] [data-family-rows] tr').length === 4);
                    assert.equal(await mcpDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), false, "successful save collapses the disclosure");
                    assert.match(await mcpPanel.locator("[data-family-rows] tr").last().textContent(), /edge-api[\s\S]*https:\/\/edge\.example\/mcp \(bearer\)/u);
                    assert.equal(await mcpDisclosure.locator('input[name="alias"]').inputValue(), "");
                    assert.equal(await mcpDisclosure.locator('input[name="url"]').inputValue(), "");
                    await mcpPanel.locator("[data-family-rows] tr").last().getByRole("button", { name: "Remove", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="mcp"] [data-family-rows] tr').length === 3);

                    // Skills: inline disclosure -> discover + candidate Add (stripping commit)
                    await settingsArticle.getByRole("link", { name: "Skills", exact: true }).click();
                    const skillsPanel = settingsArticle.locator('[data-settings-panel="skills"]');
                    const skillsDisclosure = skillsPanel.locator('details[data-family-disclosure="skills"]');
                    await skillsDisclosure.locator("> summary").click();
                    await skillsDisclosure.getByRole("textbox", { name: "Skill discovery source", exact: true }).fill("https://git.example/skills.git");
                    await skillsDisclosure.locator("[data-family-discover-form]").getByRole("button", { name: "Discover", exact: true }).click();
                    await skillsDisclosure.locator("[data-candidate-rows] li").first().waitFor({ state: "visible" });
                    await skillsDisclosure.locator("[data-candidate-rows] li").first().getByRole("button", { name: "Add", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="skills"] [data-family-rows] tr').length === 1);
                    assert.equal(await skillsDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), false);
                    const skillReplaceReq = requests.find((r) => r.params?.kind === "workspace.skills.replace");
                    assert.equal("commit" in skillReplaceReq.params.params, false, "client strips service-owned commit field when adding discovered skill");

                    // Schedule: inline disclosure -> rule preview + save normalizing bare session name to session://
                    await settingsArticle.getByRole("link", { name: "Schedule", exact: true }).click();
                    const schedulePanel = settingsArticle.locator('[data-settings-panel="schedule"]');
                    const scheduleDisclosure = schedulePanel.locator('details[data-family-disclosure="schedule"]');
                    await scheduleDisclosure.locator("> summary").click();
                    await scheduleDisclosure.getByRole("textbox", { name: "Preview schedule rule", exact: true }).fill("FREQ=DAILY");
                    await scheduleDisclosure.locator("[data-family-discover-form]").getByRole("button", { name: "Preview", exact: true }).click();
                    await scheduleDisclosure.locator("[data-candidate-rows] li").first().waitFor({ state: "visible" });
                    assert.equal(await scheduleDisclosure.locator("[data-candidate-rows] li").first().getByRole("button", { name: "Add", exact: true, includeHidden: true }).isVisible(), false);
                    await scheduleDisclosure.getByRole("textbox", { name: "Schedule name", exact: true }).fill("daily-audit");
                    await scheduleDisclosure.getByRole("textbox", { name: "Target session", exact: true }).fill("user");
                    await scheduleDisclosure.getByRole("textbox", { name: "Schedule rule", exact: true }).fill("0 9 * * 1-5");
                    await scheduleDisclosure.getByRole("textbox", { name: "Scheduled prompt", exact: true }).fill("Check status.");
                    await scheduleDisclosure.getByRole("button", { name: "Save schedule", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="schedule"] [data-family-rows] tr').length === 1);
                    assert.equal(await scheduleDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), false);
                    assert.equal(requests.find((r) => r.params?.kind === "workspace.schedule.replace").params.params.target, "session://user");

                    // Members: inline disclosure -> preview + candidate Add + batch add + row Remove ({ file })
                    await settingsArticle.getByRole("link", { name: "Members", exact: true }).click();
                    const membersPanel = settingsArticle.locator('[data-settings-panel="members"]');
                    const membersDisclosure = membersPanel.locator('details[data-family-disclosure="members"]');
                    await membersDisclosure.locator("> summary").click();
                    await membersDisclosure.getByRole("textbox", { name: "Inspect file or glob", exact: true }).fill("docs/**");
                    await membersDisclosure.locator("[data-family-discover-form]").getByRole("button", { name: "Preview", exact: true }).click();
                    await membersDisclosure.locator("[data-candidate-rows] li").first().getByRole("button", { name: "Add", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="members"] [data-family-rows] tr').length === 1);
                    assert.equal(await membersDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), false);
                    await membersDisclosure.locator("> summary").click();
                    await membersDisclosure.getByRole("textbox", { name: "Member globs", exact: true }).fill("!docs/drafts/**");
                    await membersDisclosure.getByRole("button", { name: "Add rules", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="members"] [data-family-rows] tr').length === 2);
                    assert.equal(await membersDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), false);
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
                    assert.equal(await personasPanel.locator("[data-session-persona-form]").count(), 0, "session persona selector lives on #session tab");

                    // Rejected session/options surfaces Problem detail & recovery instead of silently swallowing
                    failNextSessionOptions = true;
                    await settingsArticle.getByRole("link", { name: "Session", exact: true }).click();
                    await page.waitForFunction(() => document.querySelector("#workspace-settings > [data-text='ws-settings-message']")?.textContent === "Session options temporarily unavailable.");
                    assert.equal(await settingsArticle.locator('> [data-text="ws-settings-recovery"]').textContent(), "Retry opening the Session tab.");

                    // Re-select Session tab: hydrates via session/options with dynamic model-driven efforts and session Approval policy
                    await settingsArticle.getByRole("link", { name: "Workspace", exact: true }).click();
                    assert.equal(await settingsArticle.locator('[data-settings-panel="workspace"] [data-workspace-mode-form]').count(), 0, "Approval policy moved off #workspace onto #session");
                    await settingsArticle.getByRole("link", { name: "Session", exact: true }).click();
                    const sessionPanel = settingsArticle.locator('[data-settings-panel="session"]');
                    await sessionPanel.waitFor({ state: "visible" });
                    await sessionPanel.getByRole("textbox", { name: "Session title", exact: true }).fill("Security audit");
                    await sessionPanel.getByRole("button", { name: "Save title", exact: true }).click();
                    await page.waitForFunction(() => document.querySelector("#workspace-settings > [data-text='ws-settings-message']")?.textContent === "Title: Security audit.");
                    assert.equal(activeSessionTitle, "Security audit");

                    const sessionConfigForm = sessionPanel.locator("[data-session-config-form]");
                    await sessionConfigForm.waitFor({ state: "visible" });
                    await page.setViewportSize({ width: 1280, height: 740 });
                    const applyRightAligned = await page.evaluate(() => {
                        const fs = document.querySelector('#workspace-settings [data-session-config-form] > fieldset')?.getBoundingClientRect();
                        const btn = document.querySelector('#workspace-settings [data-session-config-form] footer > button')?.getBoundingClientRect();
                        return Boolean(fs && btn && Math.abs(fs.right - btn.right) <= 4);
                    });
                    assert.equal(applyRightAligned, true, "Apply to session button aligns to the right edge of the form footer");
                    await page.setViewportSize({ width: 320, height: 740 });

                    const modelSelect = sessionConfigForm.getByRole("combobox", { name: "Active session model", exact: true });
                    const effortSelect = sessionConfigForm.getByRole("combobox", { name: "Reasoning effort", exact: true });
                    assert.deepEqual(
                        await effortSelect.locator("option").evaluateAll((opts) => opts.map((o) => o.getAttribute("value"))),
                        ["low", "high"],
                        "initial model populates exact supported efforts without fake placeholder",
                    );
                    await modelSelect.selectOption("uncataloged");
                    assert.equal(await effortSelect.isDisabled(), true, "uncataloged route with no advertised efforts disables effort select");
                    await modelSelect.selectOption("fixture/plain");
                    assert.equal(await effortSelect.isDisabled(), false);
                    assert.deepEqual(
                        await effortSelect.locator("option").evaluateAll((opts) => opts.map((o) => o.getAttribute("value"))),
                        ["off", "adaptive"],
                    );
                    await modelSelect.selectOption("fast");
                    assert.equal(await effortSelect.isDisabled(), false);
                    assert.deepEqual(
                        await effortSelect.locator("option").evaluateAll((opts) => opts.map((o) => o.getAttribute("value"))),
                        ["medium", "high"],
                        "switching model dynamically recomputes supported efforts from catalog",
                    );
                    assert.equal(await effortSelect.inputValue(), "high", "alias default effort is selected automatically");
                    await effortSelect.selectOption("medium");
                    await sessionConfigForm.getByRole("combobox", { name: "Child session model", exact: true }).selectOption("fast");
                    await sessionConfigForm.getByRole("combobox", { name: "Active session persona", exact: true }).selectOption("auditor");
                    await sessionConfigForm.getByRole("combobox", { name: "Approval policy", exact: true }).selectOption("accept");
                    await sessionConfigForm.getByRole("button", { name: "Apply to session", exact: true }).click();
                    await page.waitForFunction(() => (document.querySelector("#workspace-settings > [data-text='ws-settings-message']")?.textContent ?? "").includes("Approval policy: accept"));
                    assert.equal(activeSessionModel, "fast");
                    assert.equal(activeSessionEffort, "medium");
                    assert.equal(activeSpawnModel, "fast");
                    assert.equal(activeSessionPersona, "auditor");
                    assert.equal(activeSessionMode, "accept");

                    await sessionPanel.getByRole("button", { name: "+ Add session", exact: true }).click();
                    await page.locator("#dialog-session-create").waitFor({ state: "visible" });
                    await page.locator("#dialog-session-create [data-dialog-close]").first().click();
                    await page.locator("#dialog-session-create").waitFor({ state: "hidden" });

                    // Models tab in Session mode: shows aliases (with 1-click Use in session) and catalog search (preserving focus across sequential keystrokes and superseded lookups)
                    await settingsArticle.getByRole("link", { name: "Models", exact: true }).click();
                    const modelsPanel = settingsArticle.locator('[data-settings-panel="models"]');
                    await modelsPanel.waitFor({ state: "visible" });
                    assert.equal(await modelsPanel.locator("[data-session-model-form]").count(), 0, "session model selector moved to #session tab");
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="models"] [data-models-alias-rows] tr').length === 3);
                    assert.equal(await modelsPanel.locator("[data-models-catalog-rows] tr").count(), 3);
                    const catalogSearch = modelsPanel.getByRole("searchbox", { name: "Search model catalog", exact: true });
                    await catalogSearch.focus();
                    await catalogSearch.pressSequentially("small", { delay: 15 });
                    await page.waitForFunction(() =>
                        document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null
                        && document.querySelector('#workspace-settings [data-models-catalog-rows] [data-text="model-name"]')?.textContent === "Small (small)",
                    );
                    assert.equal(
                        await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
                        "Search model catalog",
                        "typing sequentially into Search model catalog retains focus across every character",
                    );
                    assert.equal(await catalogSearch.inputValue(), "small");
                    assert.equal(
                        await settingsArticle.locator('> [data-text="ws-settings-message"]').textContent(),
                        "",
                        "superseded model catalog lookups abort silently without flashing AbortError",
                    );
                    await catalogSearch.fill("");
                    await page.waitForFunction(() =>
                        document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null
                        && document.querySelectorAll('#workspace-settings [data-settings-panel="models"] [data-models-alias-rows] tr').length === 3,
                    );
                    await modelsPanel.locator("[data-models-alias-rows] tr").first().getByRole("button", { name: "Use in session", exact: true }).click();
                    await page.waitForFunction(() => (document.querySelector("#workspace-settings > [data-text='ws-settings-message']")?.textContent ?? "").includes("fixture/small"));
                    assert.equal(activeSessionModel, "local");

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
