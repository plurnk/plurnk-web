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
                    fixture.setPolicy(null);
                    let activeWork = false;
                    let failNextSessionOptions = false;
                    let failNextScheduleAlreadyRunning = false;
                    /** @type {any[]} */
                    let mcpDefs = [
                        {
                            alias: "svc-git",
                            origin: "service",
                            state: "unavailable",
                            definition: { type: "stdio", command: "git-mcp", args: ["--read-only", "--config=/very/long/path/to/operator/mcp/configuration.json"] },
                            detail: { description: "Git repository MCP", tools: ["git_status", "git_log"] },
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
                    let activeSessionModelPersisted = false;
                    let activeSessionEffort = "low";
                    let activeSpawnModel = "inherit";
                    let activeSessionMode = "review";
                    let activeSessionTitle = "";
                    /** @type {any[]} */
                    let workspaceDefs = [
                        { id: 7, name: "conversation", projectRoot: "/srv/conversation", projectLabel: "~/conversation", archivedAt: null },
                        { id: 8, name: "sandbox", projectRoot: null, projectLabel: null, archivedAt: null },
                        { id: 9, name: "retired-ws", projectRoot: null, projectLabel: null, archivedAt: "2026-11-20T00:00:00Z" },
                    ];
                    /** @type {any[]} */
                    let sessionDefs = [
                        { id: 1, name: "user", origin: "model", kind: "root", lifecycle: "idle", title: "", archivedAt: null },
                        { id: 2, name: "ops", origin: "model", kind: "fork", lifecycle: "completed", title: "Ops branch", parentSessionId: 1, archivedAt: null },
                        { id: 3, name: "old-sess", origin: "model", kind: "root", lifecycle: "completed", title: "Archived work", archivedAt: "2026-11-20T00:00:00Z" },
                    ];
                    /** @type {any[]} */
                    let memberDefs = [];
                    /** @type {any[]} */
                    let serviceEnv = [
                        { alias: "SVC_SHARED", origin: "service", state: "dormant", definition: { value: "shared-val" } },
                    ];
                    /** @type {any[]} */
                    let serviceMcpDefs = [
                        {
                            alias: "svc-git",
                            origin: "service",
                            state: "dormant",
                            definition: { type: "stdio", command: "git-mcp", args: ["--read-only"] },
                        },
                    ];
                    /** @type {Record<string, Record<string, string>>} */
                    const serviceMcpSecrets = {};
                    /** @type {Record<string, Record<string, string>>} */
                    const workspaceMcpSecrets = {};
                    let providerConfigured = false;
                    /** @type {any[]} */
                    let workspaceEnv = [
                        { alias: "WS_TOKEN", origin: "workspace", state: "active", provenance: { source: ".env" }, definition: { value: "ws-secret-value" } },
                    ];
                    /** @type {any[]} */
                    let sessionEnv = [
                        { alias: "SESS_TOKEN", origin: "session", state: "active", definition: { value: "sess-secret-value" } },
                    ];

                    await context.addInitScript((acpOrigin) => {
                        if (location.protocol === "about:") return;
                        localStorage.setItem("plurnk_oidc_grant", JSON.stringify({
                            acpOrigin,
                            issuer: "http://idp.test",
                            clientId: "plurnk-web",
                            tokenEndpoint: "http://idp.test/token",
                            accessToken: "ws-settings-token",
                        }));
                    }, new URL(fixture.url).origin);

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
                            : activeSessionModel === "anthropic/claude-sonnet-4-5"
                                ? ["low", "medium", "high", "max"]
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
                                configId: "child",
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
                        const sessionStatusMeta = () => {
                            if (!activeSessionModelPersisted) {
                                return { status: { model: null } };
                            }
                            if (activeSessionModel.includes("/")) {
                                const slash = activeSessionModel.indexOf("/");
                                return {
                                    status: {
                                        model: {
                                            provider: activeSessionModel.slice(0, slash),
                                            model: activeSessionModel.slice(slash + 1),
                                            ...(currentEfforts.length > 0 ? { effort: activeSessionEffort, effortSource: "explicit" } : {}),
                                        },
                                    },
                                };
                            }
                            return {
                                status: {
                                    model: {
                                        alias: activeSessionModel,
                                        provider: "fixture",
                                        model: activeSessionModel === "fast" ? "fast" : "small",
                                        ...(currentEfforts.length > 0 ? { effort: activeSessionEffort, effortSource: "explicit" } : {}),
                                    },
                                },
                            };
                        };
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
                                    _meta: { plurnk: sessionStatusMeta() },
                                },
                            };
                        }
                        if (input.method === "session/set_title") {
                            activeSessionTitle = input.params.title;
                            return { result: { title: activeSessionTitle } };
                        }
                        if (input.method === "session/archive" || input.method === "session/unarchive") {
                            const targetName = String(input.params?.sessionId ?? "").split("#")[1] ?? "";
                            const archivedAt = input.method === "session/archive" ? "2026-11-26T00:00:00Z" : null;
                            sessionDefs = sessionDefs.map((s) => s.name === targetName ? { ...s, archivedAt } : s);
                            return { result: {} };
                        }
                        if (input.method === "session/set_config_option") {
                            if (input.params.configId === "persona") activeSessionPersona = input.params.value;
                            if (input.params.configId === "model") {
                                activeSessionModel = input.params.value;
                                activeSessionModelPersisted = true;
                            }
                            if (input.params.configId === "thought_level") activeSessionEffort = input.params.value;
                            if (input.params.configId === "child") activeSpawnModel = input.params.value;
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
                        const pageFamilyList = (family, items, queryParams) => {
                            const needle = typeof queryParams?.query === "string" ? queryParams.query.trim().toLowerCase() : "";
                            const stateFilter = typeof queryParams?.state === "string" ? queryParams.state : "";
                            const filtered = items.filter((item) => {
                                if (stateFilter && item.state !== stateFilter) return false;
                                if (needle) {
                                    const hay = `${item.alias ?? ""} ${JSON.stringify(item.definition ?? {})} ${JSON.stringify(item.detail ?? {})}`.toLowerCase();
                                    if (!hay.includes(needle)) return false;
                                }
                                return true;
                            });
                            const offset = typeof queryParams?.offset === "number" ? queryParams.offset : 0;
                            const limit = typeof queryParams?.limit === "number" ? queryParams.limit : filtered.length || 100;
                            const definitions = filtered.slice(offset, offset + limit);
                            const nextOffset = offset + definitions.length < filtered.length ? offset + definitions.length : undefined;
                            return {
                                result: {
                                    family,
                                    definitions,
                                    offset,
                                    total: filtered.length,
                                    ...(nextOffset !== undefined ? { nextOffset } : {}),
                                },
                            };
                        };
                        switch (kind) {
                            case "models.list": {
                                const limit = typeof params?.limit === "number" ? params.limit : 100;
                                assert.ok(limit >= 1 && limit <= 100, "models.list honors schema maximum limit of 100");
                                const offset = typeof params?.offset === "number" ? params.offset : 0;
                                const fillerAlibaba = Array.from({ length: 115 }, (_, idx) => {
                                    const num = String(idx + 1).padStart(3, "0");
                                    return {
                                        selector: `alibaba/qwen-${num}`,
                                        provider: "alibaba",
                                        providerName: "Alibaba",
                                        model: `qwen-${num}`,
                                        modelName: `Alibaba Qwen ${num}`,
                                        limits: { contextTokens: 131072 },
                                        capabilities: {
                                            attachment: false,
                                            reasoning: false,
                                            efforts: ["off"],
                                            toolCall: true,
                                            inputModalities: ["text"],
                                            outputModalities: ["text"],
                                        },
                                        cost: { inputPer1M: 0.25, outputPer1M: 0.75 },
                                        readiness: { ready: true, causes: [] },
                                    };
                                });
                                /** @type {Array<{ selector: string, provider: string, providerName: string, model: string, modelName: string, limits: { contextTokens: number }, capabilities: { attachment: boolean, reasoning: boolean, efforts: string[], toolCall: boolean, inputModalities: string[], outputModalities: string[] }, cost?: { inputPer1M: number, outputPer1M: number, cacheReadPer1M?: number }, readiness: { ready: boolean, causes: unknown[] } }>} */
                                const allCatalog = [
                                    ...fillerAlibaba,
                                    {
                                        selector: "anthropic/claude-sonnet-4-5",
                                        provider: "anthropic",
                                        providerName: "Anthropic",
                                        model: "claude-sonnet-4-5",
                                        modelName: "Claude Sonnet 4.5",
                                        limits: { contextTokens: 200000 },
                                        capabilities: {
                                            attachment: true,
                                            reasoning: true,
                                            efforts: ["low", "medium", "high", "max"],
                                            toolCall: true,
                                            inputModalities: ["text", "image"],
                                            outputModalities: ["text"],
                                        },
                                        cost: { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3 },
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
                                        cost: { inputPer1M: 0, outputPer1M: 0 },
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
                                        cost: { inputPer1M: 0.15, outputPer1M: 0.6 },
                                        readiness: { ready: true, causes: [] },
                                    },
                                    {
                                        selector: "google/gemini-2.5-pro",
                                        provider: "google",
                                        providerName: "Google",
                                        model: "gemini-2.5-pro",
                                        modelName: "Gemini 2.5 Pro",
                                        limits: { contextTokens: 1000000 },
                                        capabilities: {
                                            attachment: true,
                                            reasoning: true,
                                            efforts: ["low", "high"],
                                            toolCall: true,
                                            inputModalities: ["text", "image"],
                                            outputModalities: ["text"],
                                        },
                                        cost: { inputPer1M: 12, outputPer1M: 40 },
                                        readiness: { ready: true, causes: [] },
                                    },
                                ];
                                const byProvider = params?.provider
                                    ? allCatalog.filter((m) => m.provider.toLowerCase() === String(params.provider).toLowerCase())
                                    : allCatalog;
                                const needle = typeof params?.search === "string" ? params.search.trim().toLowerCase() : "";
                                const bySearch = needle
                                    ? byProvider.filter((m) =>
                                        m.selector.toLowerCase().includes(needle)
                                        || m.modelName.toLowerCase().includes(needle)
                                        || m.providerName.toLowerCase().includes(needle))
                                    : byProvider;
                                const minInput = typeof params?.minInputPer1M === "number" ? params.minInputPer1M : undefined;
                                const maxInput = typeof params?.maxInputPer1M === "number" ? params.maxInputPer1M : undefined;
                                const filtered = bySearch.filter((m) => {
                                    if (minInput !== undefined && (m.cost === undefined || m.cost.inputPer1M < minInput)) return false;
                                    if (maxInput !== undefined && (m.cost === undefined || m.cost.inputPer1M > maxInput)) return false;
                                    return true;
                                });
                                const sortMode = typeof params?.sort === "string" ? params.sort : "selector";
                                const sorted = [...filtered].toSorted((a, b) => {
                                    if (sortMode === "cost-asc" || sortMode === "cost-desc") {
                                        const aNull = a.cost === undefined;
                                        const bNull = b.cost === undefined;
                                        if (aNull !== bNull) return aNull ? 1 : -1;
                                        if (!aNull && !bNull) {
                                            const dir = sortMode === "cost-asc" ? 1 : -1;
                                            if (a.cost.inputPer1M !== b.cost.inputPer1M) return (a.cost.inputPer1M - b.cost.inputPer1M) * dir;
                                            if (a.cost.outputPer1M !== b.cost.outputPer1M) return (a.cost.outputPer1M - b.cost.outputPer1M) * dir;
                                        }
                                    } else if (sortMode === "context-desc" && a.limits.contextTokens !== b.limits.contextTokens) {
                                        return b.limits.contextTokens - a.limits.contextTokens;
                                    }
                                    return a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0;
                                });
                                const items = sorted.slice(offset, offset + limit);
                                const nextOffset = offset + items.length;
                                return {
                                    result: {
                                        items,
                                        offset,
                                        total: sorted.length,
                                        ...(nextOffset < sorted.length ? { nextOffset } : {}),
                                        providers: [...new Set(allCatalog.map((m) => m.provider))].toSorted(),
                                    },
                                };
                            }
                            case "models.providers":
                                return {
                                    result: {
                                        providers: [{
                                            provider: "openrouter",
                                            providerName: "OpenRouter",
                                            ready: providerConfigured,
                                            readiness: providerConfigured ? "ready" : "Missing OPENROUTER_API_KEY",
                                            credentialKeys: [{
                                                key: "OPENROUTER_API_KEY",
                                                secret: true,
                                                configured: providerConfigured,
                                                ...(providerConfigured ? { origin: "service" } : {}),
                                                editable: true,
                                            }],
                                        }],
                                    },
                                };
                            case "service.config.set":
                                if (params?.key === "OPENROUTER_API_KEY") providerConfigured = true;
                                return { result: { key: params?.key, status: "applied" } };
                            case "service.config.unset":
                                if (params?.key === "OPENROUTER_API_KEY") providerConfigured = false;
                                return { result: { key: params?.key, status: "removed" } };
                            case "service.mcp.list":
                                return pageFamilyList("mcp", serviceMcpDefs, params);
                            case "service.mcp.replace": {
                                const { alias, ...def } = params;
                                serviceMcpDefs = [...serviceMcpDefs.filter((d) => d.alias !== alias), { alias, origin: "service", state: "dormant", definition: def }];
                                return { result: { status: 201 } };
                            }
                            case "service.mcp.remove": {
                                const alias = String(params?.alias ?? "");
                                serviceMcpDefs = serviceMcpDefs.filter((d) => d.alias !== alias);
                                delete serviceMcpSecrets[alias];
                                return { result: { status: 200 } };
                            }
                            case "service.mcp.secrets.list": {
                                /** @type {Record<string, string[]>} */
                                const byServer = {};
                                for (const [alias, map] of Object.entries(serviceMcpSecrets)) {
                                    const keys = Object.keys(map).toSorted();
                                    if (keys.length > 0) byServer[alias] = keys;
                                }
                                return { result: { byServer } };
                            }
                            case "service.mcp.secrets.set": {
                                const alias = String(params?.alias ?? "");
                                const next = { ...(serviceMcpSecrets[alias] ?? {}), ...(params?.secrets ?? {}) };
                                serviceMcpSecrets[alias] = next;
                                return { result: { alias, keys: Object.keys(next).toSorted() } };
                            }
                            case "service.mcp.secrets.unset": {
                                const alias = String(params?.alias ?? "");
                                const current = { ...(serviceMcpSecrets[alias] ?? {}) };
                                const keys = Array.isArray(params?.keys) ? params.keys : Object.keys(current);
                                for (const k of keys) delete current[String(k)];
                                if (Object.keys(current).length === 0) delete serviceMcpSecrets[alias];
                                else serviceMcpSecrets[alias] = current;
                                return { result: { alias, keys: Object.keys(current).toSorted() } };
                            }
                            case "workspace.mcp.list":
                                return pageFamilyList("mcp", [
                                    ...serviceMcpDefs.filter((svc) => !mcpDefs.some((ws) => ws.alias === svc.alias)),
                                    ...mcpDefs,
                                ], params);
                            case "workspace.mcp.secrets.list": {
                                /** @type {Record<string, { keys: string[], inheritedKeys: string[] }>} */
                                const byServer = {};
                                const allAliases = new Set([
                                    ...Object.keys(serviceMcpSecrets),
                                    ...Object.keys(workspaceMcpSecrets),
                                ]);
                                for (const alias of allAliases) {
                                    const keys = Object.keys(workspaceMcpSecrets[alias] ?? {}).toSorted();
                                    const maskedByWorkspace = mcpDefs.some((d) => d.alias === alias && d.origin === "workspace");
                                    const inheritedKeys = maskedByWorkspace ? [] : Object.keys(serviceMcpSecrets[alias] ?? {}).toSorted();
                                    if (keys.length > 0 || inheritedKeys.length > 0) {
                                        byServer[alias] = { keys, inheritedKeys };
                                    }
                                }
                                return { result: { byServer } };
                            }
                            case "workspace.mcp.secrets.set": {
                                const alias = String(params?.alias ?? "");
                                const next = { ...(workspaceMcpSecrets[alias] ?? {}), ...(params?.secrets ?? {}) };
                                workspaceMcpSecrets[alias] = next;
                                return { result: { alias, keys: Object.keys(next).toSorted() } };
                            }
                            case "workspace.mcp.secrets.unset": {
                                const alias = String(params?.alias ?? "");
                                const current = { ...(workspaceMcpSecrets[alias] ?? {}) };
                                const keys = Array.isArray(params?.keys) ? params.keys : Object.keys(current);
                                for (const k of keys) delete current[String(k)];
                                if (Object.keys(current).length === 0) delete workspaceMcpSecrets[alias];
                                else workspaceMcpSecrets[alias] = current;
                                return { result: { alias, keys: Object.keys(current).toSorted() } };
                            }
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
                            case "workspace.mcp.discover": {
                                if (!params?.query) {
                                    if (params?.cursor === "reg-page-2") {
                                        return {
                                            result: {
                                                family: "mcp",
                                                candidates: [{
                                                    alias: "postgres-mcp",
                                                    summary: "PostgreSQL inspector (page 2)",
                                                    definition: { type: "stdio", command: "npx", args: ["-y", "postgres-mcp"] },
                                                    provenance: { kind: "registry" },
                                                }],
                                            },
                                        };
                                    }
                                    return {
                                        result: {
                                            family: "mcp",
                                            candidates: [{
                                                alias: "browse-mcp",
                                                summary: "Registry catalog item (page 1)",
                                                definition: { type: "stdio", command: "npx", args: ["-y", "browse-mcp"] },
                                                provenance: { kind: "registry" },
                                            }],
                                            nextCursor: "reg-page-2",
                                        },
                                    };
                                }
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
                            }
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
                                return pageFamilyList("skills", skillDefs, params);
                            case "workspace.skills.discover": {
                                const allSkills = [
                                    {
                                        alias: "lint-guide",
                                        summary: "Linting conventions",
                                        definition: { source: params.source, commit: "a".repeat(40) },
                                        provenance: { kind: "git", source: params.source },
                                    },
                                    {
                                        alias: "sql-guide",
                                        summary: "SQL formatting rules",
                                        definition: { source: params.source, commit: "b".repeat(40) },
                                        provenance: { kind: "git", source: params.source },
                                    },
                                ];
                                const q = typeof params?.query === "string" ? params.query.trim().toLowerCase() : "";
                                const candidates = q ? allSkills.filter((c) => c.alias.includes(q) || c.summary.toLowerCase().includes(q)) : allSkills;
                                return {
                                    result: {
                                        family: "skills",
                                        candidates,
                                        total: candidates.length,
                                    },
                                };
                            }
                            case "workspace.skills.replace": {
                                const { alias, ...def } = params;
                                skillDefs = [...skillDefs.filter((d) => d.alias !== alias), { alias, origin: "workspace", state: "active", definition: def }];
                                return { result: { status: 201 } };
                            }
                            case "workspace.list":
                                return { result: { workspaces: workspaceDefs } };
                            case "workspace.archive": {
                                const wsId = Number(params?.workspaceId ?? input.params.workspaceId ?? 0);
                                workspaceDefs = workspaceDefs.map((ws) =>
                                    ws.id === wsId ? { ...ws, archivedAt: params?.archived ? "2026-11-26T00:00:00Z" : null } : ws);
                                return { result: {} };
                            }
                            case "workspace.sessions":
                                return { result: { sessions: sessionDefs } };
                            case "entry.read": {
                                if (params.target === "mcp:///plurnk.json") {
                                    return {
                                        result: {
                                            status: 200,
                                            entry: {
                                                channels: {
                                                    body: {
                                                        content: JSON.stringify({
                                                            tools: [
                                                                {
                                                                    name: "edit",
                                                                    description: "Create or edit a workspace file.",
                                                                    inputSchema: {
                                                                        type: "object",
                                                                        required: ["path"],
                                                                        properties: {
                                                                            path: { type: "string", description: "Target path or URI." },
                                                                            text: { type: "string", description: "File content." },
                                                                        },
                                                                    },
                                                                },
                                                                {
                                                                    name: "sh",
                                                                    description: "Run shell code.",
                                                                    inputSchema: {
                                                                        type: "object",
                                                                        required: ["text"],
                                                                        properties: { text: { type: "string", description: "Shell command." } },
                                                                    },
                                                                },
                                                                { name: "done", description: "Turn-only done verb (must be filtered out)." },
                                                                { name: "wait", description: "Turn-only wait verb (must be filtered out)." },
                                                                { name: "question", description: "Turn-only question verb (must be filtered out)." },
                                                            ],
                                                        }),
                                                    },
                                                },
                                            },
                                        },
                                    };
                                }
                                if (params.target === "mcp:///svc-git.json") {
                                    return {
                                        result: {
                                            status: 200,
                                            entry: {
                                                channels: {
                                                    body: {
                                                        content: JSON.stringify({
                                                            tools: [
                                                                {
                                                                    name: "git_status",
                                                                    description: "Inspect repository working tree status.",
                                                                    inputSchema: {
                                                                        type: "object",
                                                                        required: ["branch"],
                                                                        properties: {
                                                                            branch: { type: "string", description: "Branch name to inspect." },
                                                                            short: { type: "boolean", description: "Compact output." },
                                                                        },
                                                                    },
                                                                },
                                                                { name: "git_log", description: "Show recent commits." },
                                                            ],
                                                        }),
                                                    },
                                                },
                                            },
                                        },
                                    };
                                }
                                return { result: { status: 404, entry: null } };
                            }
                            case "workspace.schedule.list":
                                return pageFamilyList("schedule", scheduleDefs, params);
                            case "workspace.schedule.discover":
                                return {
                                    result: {
                                        family: "schedule",
                                        candidates: [{
                                            summary: params.rule
                                                ? `Next occurrence for ${params.rule}: 2026-11-14T09:00:00Z`
                                                : "now 2026-11-23T09:00:00+00:00[UTC]",
                                            definition: {},
                                            provenance: { kind: "preview" },
                                        }],
                                    },
                                };
                            case "workspace.schedule.replace": {
                                const { alias, ...def } = params;
                                const isRun = Array.isArray(def.run);
                                scheduleDefs = [
                                    ...scheduleDefs.filter((d) => d.alias !== alias),
                                    {
                                        alias,
                                        origin: "workspace",
                                        state: "active",
                                        definition: def,
                                        detail: {
                                            kind: isRun ? "run" : "prompt",
                                            status: "open",
                                            rule: def.rule ?? "manual",
                                            text: def.rule === "manual" ? "manual trigger"
                                                : def.rule === "once" ? "unscheduled single-shot obligation"
                                                    : String(def.rule),
                                            next: def.rule === "manual" || def.rule === "once" ? null : "2026-11-24T09:00:00+00:00[UTC]",
                                            lastFiredAt: null,
                                            doneAt: null,
                                        },
                                    },
                                ];
                                return { result: { status: 201 } };
                            }
                            case "workspace.schedule.run": {
                                const entry = scheduleDefs.find((d) => d.alias === params.alias);
                                if (!entry) throw new Error(`Unknown schedule ${params.alias}`);
                                if (failNextScheduleAlreadyRunning) {
                                    failNextScheduleAlreadyRunning = false;
                                    return {
                                        error: {
                                            code: -32000,
                                            message: `Schedule '${params.alias}' is already running in this workspace.`,
                                            data: {
                                                type: "https://problems.plurnk.xyz/schedule/delivery/already-running",
                                                title: "Already running",
                                                status: 409,
                                                detail: `Schedule '${params.alias}' is already running in this workspace.`,
                                            },
                                        },
                                    };
                                }
                                if (entry.definition.rule === "once" && entry.detail?.status === "done") {
                                    return {
                                        error: {
                                            code: -32000,
                                            message: `Schedule '${params.alias}' is already done.`,
                                            data: {
                                                type: "https://problems.plurnk.xyz/schedule/delivery/already-done",
                                                title: "Already done",
                                                status: 409,
                                                detail: `Schedule '${params.alias}' is already done; reopen with status "open" to execute again.`,
                                            },
                                        },
                                    };
                                }
                                const nextStatus = entry.definition.rule === "once" ? "done" : "open";
                                const nowIso = "2026-11-23T09:05:00+00:00[UTC]";
                                entry.detail = {
                                    ...entry.detail,
                                    status: nextStatus,
                                    lastFiredAt: nowIso,
                                    doneAt: nextStatus === "done" ? nowIso : null,
                                };
                                const results = Array.isArray(entry.definition.run)
                                    ? entry.definition.run.map((step, index) => ({
                                        index,
                                        server: step.server,
                                        tool: step.tool,
                                        status: index === 0 ? 201 : 200,
                                        uri: index === 0 ? "log:///1/1/1/edit" : `exec:///${step.server}/abc`,
                                        preview: index === 0 ? "edited workspace:///notes.md" : "clean tree on main",
                                    }))
                                    : undefined;
                                return {
                                    result: {
                                        alias: entry.alias,
                                        status: nextStatus,
                                        loopId: 12,
                                        lastFiredAt: nowIso,
                                        doneAt: nextStatus === "done" ? nowIso : null,
                                        ...(results ? { results } : {}),
                                    },
                                };
                            }
                            case "workspace.schedule.status": {
                                const entry = scheduleDefs.find((d) => d.alias === params.alias);
                                if (entry) {
                                    entry.detail = {
                                        ...entry.detail,
                                        status: params.status,
                                        doneAt: params.status === "done" ? "2026-11-23T09:06:00+00:00[UTC]" : null,
                                    };
                                }
                                return { result: { alias: params.alias, status: params.status } };
                            }
                            case "workspace.personas.list":
                                return pageFamilyList("personas", personaDefs, params);
                            case "workspace.personas.replace": {
                                const { alias, ...def } = params;
                                personaDefs = [...personaDefs.filter((d) => d.alias !== alias), { alias, origin: "workspace", state: "active", definition: def }];
                                return { result: { status: 201 } };
                            }
                            case "workspace.members.list":
                                return pageFamilyList("members", memberDefs, params);
                            case "workspace.members.discover": {
                                const limit = typeof params?.limit === "number" ? params.limit : 10;
                                const allFiles = Array.from({ length: 12 }, (_, idx) => `docs/page-${idx + 1}.md`);
                                return {
                                    result: {
                                        family: "members",
                                        candidates: [{
                                            alias: params.query,
                                            summary: `would include 10 files (2 already members)`,
                                            definition: { glob: params.query },
                                            provenance: { kind: "preview", source: params.query },
                                            detail: {
                                                kind: "preview",
                                                effect: String(params.query).startsWith("!") ? "exclude" : "include",
                                                pattern: String(params.query).replace(/^!/u, ""),
                                                matched: 12,
                                                fresh: 10,
                                                alreadyMembers: 2,
                                                ignored: 0,
                                                files: allFiles.slice(0, limit),
                                            },
                                        }],
                                        total: 1,
                                    },
                                };
                            }
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
                            case "service.env.list":
                                return pageFamilyList("env", serviceEnv, params);
                            case "service.env.replace": {
                                const alias = String(params?.alias ?? "");
                                serviceEnv = [
                                    ...serviceEnv.filter((d) => d.alias !== alias),
                                    { alias, origin: "service", state: "dormant", definition: { value: String(params?.value ?? "") } },
                                ];
                                return { result: { status: 201 } };
                            }
                            case "service.env.remove":
                                serviceEnv = serviceEnv.filter((d) => d.alias !== params.alias);
                                return { result: { status: 200 } };
                            case "workspace.env.list":
                                return pageFamilyList("env", workspaceEnv, params);
                            case "session.env.list":
                                return pageFamilyList("env", [...workspaceEnv, ...sessionEnv], params);
                            case "service.env.discover":
                            case "workspace.env.discover":
                            case "session.env.discover":
                                return {
                                    result: {
                                        family: "env",
                                        candidates: [{
                                            alias: "PLURNK_LOG_LEVEL",
                                            summary: "Log verbosity level",
                                            definition: { value: "info" },
                                            provenance: { kind: "defaults", source: ".env.defaults" },
                                        }],
                                        total: 1,
                                    },
                                };
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

                    // 1. Workspace-only mode on /settings/workspaces?workspace=conversation (sessionName = null): zero stacked settings modals, standardized Workspaces table + inline disclosure
                    await page.goto(new URL("/settings/workspaces?workspace=conversation", fixture.url).href);
                    const settingsArticle = page.locator("#workspace-settings");
                    await settingsArticle.waitFor({ state: "visible" });
                    await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null && document.querySelectorAll('#workspace-settings [data-workspaces-rows] tr').length === 2);
                    assert.equal(await page.locator("#workspace-settings dialog").count(), 0, "settings tabs mount zero stacked <dialog> modals");
                    assert.equal(await settingsArticle.getByRole("link", { name: "Workspaces", exact: true }).getAttribute("aria-current"), "page");
                    assert.equal(await settingsArticle.locator("#workspace-rename").isVisible(), true);
                    assert.equal(await settingsArticle.locator('button[form="workspace-archive"]').isVisible(), true);
                    const wsDisclosure = settingsArticle.locator('details[data-family-disclosure="workspaces"]');
                    assert.equal(await wsDisclosure.isVisible(), true);
                    assert.equal(await wsDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), false);

                    // Standardized Workspaces collection bar: Active/Archived/All state filter + search + row Archive/Unarchive
                    const wsPanel = settingsArticle.locator('[data-settings-panel="workspaces"]');
                    const wsStateSelect = wsPanel.locator('[data-collection-filter-form] select[name="state"]');
                    await wsStateSelect.selectOption("archived");
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-workspaces-rows] tr').length === 1);
                    assert.match(await wsPanel.locator("[data-workspaces-rows] tr").first().textContent(), /retired-ws/u);
                    await wsPanel.locator("[data-workspaces-rows] tr").first().getByRole("button", { name: "Unarchive", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-workspaces-rows] tr').length === 0);
                    await wsStateSelect.selectOption("active");
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-workspaces-rows] tr').length === 3);
                    await wsPanel.locator("[data-workspaces-rows] tr", { hasText: "retired-ws" }).getByRole("button", { name: "Archive", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-workspaces-rows] tr').length === 2);

                    await settingsArticle.getByRole("link", { name: "MCP", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/mcp");
                    await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null && document.querySelectorAll('#workspace-settings [data-settings-panel="mcp"] [data-family-rows] tr').length === 2);

                    const mcpListReq = requests.findLast((r) => r.params?.kind === "workspace.mcp.list");
                    assert.equal(mcpListReq?.params?.kind, "workspace.mcp.list");
                    assert.equal(mcpListReq?.params?.workspaceId, 7);
                    assert.equal(mcpListReq !== undefined && "sessionId" in mcpListReq.params, false, "Workspace-only /settings/mcp sends workspaceId without session attachment");
                    assert.equal(await settingsArticle.getByRole("link", { name: "MCP", exact: true }).getAttribute("aria-current"), "page");

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
                    // Empty-query MCP Registry browsing + cursor Next/Previous pagination
                    await mcpDisclosure.locator("[data-family-discover-form]").getByRole("button", { name: "Discover", exact: true }).click();
                    await mcpDisclosure.locator("[data-candidate-rows] li").first().waitFor({ state: "visible" });
                    assert.match(await mcpDisclosure.locator("[data-candidate-rows] li").first().textContent(), /browse-mcp/u);
                    await mcpDisclosure.locator("[data-candidate-next]").click();
                    await page.waitForFunction(() => (document.querySelector('#workspace-settings [data-settings-panel="mcp"] [data-candidate-rows] li')?.textContent ?? "").includes("postgres-mcp"));
                    await mcpDisclosure.locator("[data-candidate-prev]").click();
                    await page.waitForFunction(() => (document.querySelector('#workspace-settings [data-settings-panel="mcp"] [data-candidate-rows] li')?.textContent ?? "").includes("browse-mcp"));

                    await mcpDisclosure.getByRole("searchbox", { name: "Search MCP registry", exact: true }).fill("sqlite");
                    await mcpDisclosure.locator("[data-family-discover-form]").getByRole("button", { name: "Discover", exact: true }).click();
                    await page.waitForFunction(() => (document.querySelector('#workspace-settings [data-settings-panel="mcp"] [data-candidate-rows] li')?.textContent ?? "").includes("sqlite-mcp"));
                    await mcpDisclosure.locator("[data-candidate-rows] li").first().getByRole("button", { name: "Add", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="mcp"] [data-family-rows] tr').length === 3);
                    assert.equal(await mcpDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), false, "adding a candidate collapses the inline disclosure");

                    // Always-available collection filter bar filters installed MCP servers live
                    const mcpFilter = mcpPanel.getByRole("searchbox", { name: "Filter MCP servers", exact: true });
                    await mcpFilter.fill("sqlite");
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="mcp"] [data-family-rows] tr').length === 1);
                    assert.equal(await mcpPanel.locator('[data-text="collection-summary"]').textContent(), "Showing 1–1 of 1");
                    await mcpFilter.fill("");
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="mcp"] [data-family-rows] tr').length === 3);

                    await mcpDisclosure.locator("> summary").click();
                    await mcpDisclosure.getByRole("combobox", { name: "MCP transport", exact: true }).selectOption("streamable-http");
                    await mcpDisclosure.getByRole("combobox", { name: "Endpoint authentication", exact: true }).selectOption("bearer");
                    await mcpDisclosure.getByRole("textbox", { name: "Server alias", exact: true }).fill("edge-api");
                    await mcpDisclosure.getByLabel("Endpoint URL", { exact: true }).fill("https://edge.example/mcp");
                    await mcpDisclosure.getByRole("textbox", { name: "Bearer token reference", exact: true }).fill("${EDGE_TOKEN}");
                    activeWork = true;
                    await mcpDisclosure.getByRole("button", { name: "Save server", exact: true }).click();
                    await page.waitForFunction(() => document.querySelector('#workspace-settings [data-text="ws-settings-message"]')?.textContent === "Workspace has active loop work.");
                    assert.equal(await settingsArticle.locator("[data-settings-feedback]").getAttribute("data-feedback-level"), "error");
                    assert.equal(await settingsArticle.locator("[data-settings-feedback]").getAttribute("role"), "alert");
                    assert.equal(await mcpDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), true, "409 refusal keeps the disclosure open");
                    assert.equal(await settingsArticle.locator('[data-text="ws-settings-recovery"]').textContent(), "Wait for active loops to settle or stop them first.");
                    await settingsArticle.locator("[data-feedback-dismiss]").click();
                    assert.equal(await settingsArticle.locator("[data-settings-feedback]").getAttribute("data-feedback-level"), "idle");
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

                    // Skills: inline disclosure -> discover with optional query filter + candidate Add (stripping commit)
                    await settingsArticle.getByRole("link", { name: "Skills", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/skills");
                    await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
                    const skillsPanel = settingsArticle.locator('[data-settings-panel="skills"]');
                    const skillsDisclosure = skillsPanel.locator('details[data-family-disclosure="skills"]');
                    await skillsDisclosure.locator("> summary").click();
                    await skillsDisclosure.getByRole("textbox", { name: "Skill discovery source", exact: true }).fill("https://git.example/skills.git");
                    await skillsDisclosure.getByRole("searchbox", { name: "Filter discovered skills", exact: true }).fill("lint");
                    await skillsDisclosure.locator("[data-family-discover-form]").getByRole("button", { name: "Discover", exact: true }).click();
                    await skillsDisclosure.locator("[data-candidate-rows] li").first().waitFor({ state: "visible" });
                    assert.equal(await skillsDisclosure.locator("[data-candidate-rows] li").count(), 1, "skills discovery filters candidates by query");
                    await skillsDisclosure.locator("[data-candidate-rows] li").first().getByRole("button", { name: "Add", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="skills"] [data-family-rows] tr').length === 1);
                    assert.equal(await skillsDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), false);
                    const skillReplaceReq = requests.find((r) => r.params?.kind === "workspace.skills.replace");
                    assert.equal("commit" in skillReplaceReq.params.params, false, "client strips service-owned commit field when adding discovered skill");

                    // Schedule & Macro Control Panel: verify Reset matches Save schedule button height under Pico/OTM
                    await settingsArticle.getByRole("link", { name: "Schedule", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/schedule");
                    const schedulePanel = settingsArticle.locator('[data-settings-panel="schedule"]');
                    const scheduleDisclosure = schedulePanel.locator('details[data-family-disclosure="schedule"]');
                    await page.waitForFunction(() => (document.querySelector('#workspace-settings [data-text="schedule-clock"]')?.textContent ?? "").includes("UTC"));
                    await scheduleDisclosure.locator("> summary").click();
                    const buttonHeightDelta = await page.evaluate(() => {
                        const resetBtn = document.querySelector('#workspace-settings [data-schedule-reset]')?.getBoundingClientRect();
                        const saveBtn = document.querySelector('#workspace-settings [data-schedule-save-form] footer button[type="submit"]')?.getBoundingClientRect();
                        return resetBtn && saveBtn ? Math.abs(resetBtn.height - saveBtn.height) : 999;
                    });
                    assert.ok(buttonHeightDelta <= 2, `Schedule Reset button height matches Save schedule button (delta=${buttonHeightDelta}px)`);
                    await scheduleDisclosure.getByRole("textbox", { name: "Schedule name", exact: true }).fill("daily-audit");
                    await scheduleDisclosure.getByRole("combobox", { name: "Schedule timing", exact: true }).selectOption("repeating");
                    await scheduleDisclosure.getByRole("combobox", { name: "Repeat frequency", exact: true }).selectOption("weekdays");
                    await scheduleDisclosure.getByLabel("Repeat time", { exact: true }).fill("09:00");
                    await scheduleDisclosure.getByRole("button", { name: "Preview", exact: true }).click();
                    await page.waitForFunction(() => (document.querySelector('#workspace-settings [data-text="schedule-preview"]')?.textContent ?? "").includes("0 9 * * 1-5"));
                    await scheduleDisclosure.getByRole("combobox", { name: "Target session", exact: true }).fill("user");
                    await scheduleDisclosure.getByRole("combobox", { name: "Target session persona", exact: true }).selectOption("auditor");
                    await scheduleDisclosure.getByRole("textbox", { name: "Scheduled prompt", exact: true }).fill("Check status.");
                    await scheduleDisclosure.getByRole("button", { name: "Save schedule", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="schedule"] [data-family-rows] tr').length === 1);
                    assert.equal(await scheduleDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), false);
                    const promptReplace = requests.find((r) => r.params?.kind === "workspace.schedule.replace" && r.params?.params?.alias === "daily-audit");
                    assert.equal(promptReplace.params.params.target, "session://user");
                    assert.equal(promptReplace.params.params.rule, "0 9 * * 1-5");
                    assert.equal(promptReplace.params.params.persona, "auditor");

                    // Craft a multi-step "once" Macro using Server + Tool autocomplete (filtering out turn-only verbs!) and guided schema arguments
                    await scheduleDisclosure.locator("> summary").click();
                    await scheduleDisclosure.getByRole("textbox", { name: "Schedule name", exact: true }).fill("repo-macro");
                    await scheduleDisclosure.getByRole("combobox", { name: "Schedule kind", exact: true }).selectOption("run");
                    await scheduleDisclosure.getByRole("combobox", { name: "Schedule timing", exact: true }).selectOption("once");
                    const step1 = scheduleDisclosure.locator("[data-schedule-step]").nth(0);
                    const step1Tool = step1.getByRole("combobox", { name: "Step tool", exact: true });
                    await step1Tool.click();
                    const step1ToolList = step1.locator('[data-schedule-combobox="tool"] [data-combobox-list]');
                    await step1ToolList.waitFor({ state: "visible" });
                    assert.equal(await step1ToolList.locator('[data-combobox-option="done"]').count(), 0, "turn-only done verb is filtered out of macro tool autocomplete");
                    assert.equal(await step1ToolList.locator('[data-combobox-option="wait"]').count(), 0, "turn-only wait verb is filtered out of macro tool autocomplete");
                    await step1ToolList.locator('[data-combobox-option="edit"]').click();
                    await step1.getByLabel("path argument", { exact: true }).fill("workspace:///notes.md");
                    await step1.getByLabel("text argument", { exact: true }).fill("hello");
                    assert.deepEqual(JSON.parse(await step1.getByLabel("Step arguments JSON", { exact: true }).inputValue()), {
                        path: "workspace:///notes.md",
                        text: "hello",
                    });

                    // Add Step 2 against active MCP server `svc-git` with tool schema hydrated from `mcp:///svc-git.json`
                    await scheduleDisclosure.getByRole("button", { name: "+ Add step", exact: true }).click();
                    const step2 = scheduleDisclosure.locator("[data-schedule-step]").nth(1);
                    const step2Server = step2.getByRole("combobox", { name: "Step server", exact: true });
                    await step2Server.click();
                    const step2ServerList = step2.locator('[data-schedule-combobox="server"] [data-combobox-list]');
                    await step2ServerList.waitFor({ state: "visible" });
                    await step2ServerList.locator('[data-combobox-option="svc-git"]').click();
                    const step2Tool = step2.getByRole("combobox", { name: "Step tool", exact: true });
                    await step2Tool.click();
                    const step2ToolList = step2.locator('[data-schedule-combobox="tool"] [data-combobox-list]');
                    await step2ToolList.waitFor({ state: "visible" });
                    await step2ToolList.locator('[data-combobox-option="git_status"]').click();
                    await step2.getByLabel("branch argument", { exact: true }).waitFor({ state: "visible" });
                    await step2.getByLabel("branch argument", { exact: true }).fill("main");
                    await step2.getByLabel("short argument", { exact: true }).selectOption("true");

                    // Switching Server back to plurnk clears incompatible MCP tool & stale args, then switching back to svc-git works cleanly
                    await step2Server.click();
                    await step2ServerList.waitFor({ state: "visible" });
                    await step2ServerList.locator('[data-combobox-option="plurnk"]').click();
                    assert.equal(await step2Tool.inputValue(), "", "switching server clears incompatible previous tool");
                    assert.equal(await step2.getByLabel("Step arguments JSON", { exact: true }).inputValue(), "{}", "switching server clears stale tool arguments");
                    await step2Server.click();
                    await step2ServerList.waitFor({ state: "visible" });
                    await step2ServerList.locator('[data-combobox-option="svc-git"]').click();
                    await step2Tool.click();
                    await step2ToolList.waitFor({ state: "visible" });
                    await step2ToolList.locator('[data-combobox-option="git_status"]').click();
                    await step2.getByLabel("branch argument", { exact: true }).waitFor({ state: "visible" });
                    await step2.getByLabel("branch argument", { exact: true }).fill("main");
                    await step2.getByLabel("short argument", { exact: true }).selectOption("true");
                    await step2.getByLabel("Step aside label", { exact: true }).fill("Check git tree");

                    await scheduleDisclosure.getByRole("button", { name: "Save schedule", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="schedule"] [data-family-rows] tr').length === 2);
                    const macroReplace = requests.find((r) => r.params?.kind === "workspace.schedule.replace" && r.params?.params?.alias === "repo-macro");
                    assert.deepEqual(macroReplace.params.params, {
                        alias: "repo-macro",
                        rule: "once",
                        run: [
                            { server: "plurnk", tool: "edit", arguments: { path: "workspace:///notes.md", text: "hello" } },
                            { server: "svc-git", tool: "git_status", arguments: { branch: "main", short: true }, aside: "Check git tree" },
                        ],
                    });

                    // Run now renders inline step receipts, transitions "once" obligation to done, and disables Run now until Reopen
                    const macroRow = schedulePanel.locator("[data-family-rows] tr").nth(1);
                    assert.match(await macroRow.textContent(), /repo-macro[\s\S]*Macro[\s\S]*2 steps: plurnk\.edit → svc-git\.git_status/u);
                    await macroRow.getByRole("button", { name: "Run now", exact: true }).click();
                    const receiptBox = schedulePanel.locator("[data-schedule-receipt]");
                    await receiptBox.waitFor({ state: "visible" });
                    assert.equal(await receiptBox.locator("[data-receipt-step]").count(), 2);
                    assert.match(await receiptBox.textContent(), /plurnk\.edit[\s\S]*201[\s\S]*log:\/\/\/1\/1\/1\/edit[\s\S]*svc-git\.git_status[\s\S]*clean tree on main/u);
                    assert.equal(await macroRow.getByRole("button", { name: "Run now", exact: true }).isDisabled(), true, "completed once obligation disables Run now");
                    assert.equal(await macroRow.getByRole("button", { name: "Reopen", exact: true }).isVisible(), true);
                    await macroRow.getByRole("button", { name: "Reopen", exact: true }).click();
                    await page.waitForFunction(() => {
                        const row = document.querySelectorAll('#workspace-settings [data-settings-panel="schedule"] [data-family-rows] tr')[1];
                        return row?.getAttribute("data-schedule-obligation") === "open";
                    });
                    assert.equal(await macroRow.getByRole("button", { name: "Run now", exact: true }).isDisabled(), false);

                    // 409 already-running surfaces cleanly in the receipt drawer without clobbering the row
                    failNextScheduleAlreadyRunning = true;
                    await macroRow.getByRole("button", { name: "Run now", exact: true }).click();
                    await page.waitForFunction(() => (document.querySelector('#workspace-settings [data-text="receipt-status-label"]')?.textContent ?? "").includes("409 already-running"));
                    assert.equal(await receiptBox.getAttribute("data-receipt-status"), "error");
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "schedule control panel fits 320px viewport with receipt open");

                    // Edit round-trips existing prompt schedule into timing dropdowns + persona + prompt
                    const promptRow = schedulePanel.locator("[data-family-rows] tr").nth(0);
                    await promptRow.getByRole("button", { name: "Edit", exact: true }).click();
                    assert.equal(await scheduleDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), true);
                    assert.equal(await scheduleDisclosure.getByRole("textbox", { name: "Schedule name", exact: true }).inputValue(), "daily-audit");
                    assert.equal(await scheduleDisclosure.getByRole("combobox", { name: "Schedule timing", exact: true }).inputValue(), "repeating");
                    assert.equal(await scheduleDisclosure.getByRole("combobox", { name: "Repeat frequency", exact: true }).inputValue(), "weekdays");
                    assert.equal(await scheduleDisclosure.getByRole("combobox", { name: "Target session", exact: true }).inputValue(), "user");
                    assert.equal(await scheduleDisclosure.getByRole("combobox", { name: "Target session persona", exact: true }).inputValue(), "auditor");
                    assert.equal(await scheduleDisclosure.getByRole("textbox", { name: "Scheduled prompt", exact: true }).inputValue(), "Check status.");
                    await scheduleDisclosure.getByRole("button", { name: "Cancel", exact: true }).click();
                    await scheduleDisclosure.locator("> summary").click();

                    // Members: single Add rules form with debounced inline live preview (x matches + first 10 paths) + batch add + row Remove ({ file })
                    await settingsArticle.getByRole("link", { name: "Members", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/members");
                    await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
                    const membersPanel = settingsArticle.locator('[data-settings-panel="members"]');
                    const membersDisclosure = membersPanel.locator('details[data-family-disclosure="members"]');
                    assert.equal(await membersDisclosure.locator("[data-family-discover-form]").count(), 0, "Members has no separate preview form");
                    await membersDisclosure.locator("> summary").click();
                    const membersFilesInput = membersDisclosure.getByRole("textbox", { name: "Member globs", exact: true });
                    await membersFilesInput.fill("docs/**");
                    await page.waitForFunction(() => (document.querySelector('#workspace-settings [data-text="members-preview-summary"]')?.textContent ?? "").includes("12 matches"));
                    assert.equal(await membersDisclosure.locator("[data-members-preview-list] li").count(), 10, "inline Members preview shows first 10 matching paths");
                    await membersDisclosure.getByRole("button", { name: "Add rules", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="members"] [data-family-rows] tr').length === 1);
                    assert.equal(await membersDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), false);
                    await membersDisclosure.locator("> summary").click();
                    await membersFilesInput.fill("!docs/drafts/**");
                    await membersDisclosure.getByRole("button", { name: "Add rules", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="members"] [data-family-rows] tr').length === 2);
                    assert.equal(await membersDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), false);
                    await membersPanel.locator("[data-family-rows] tr").first().getByRole("button", { name: "Remove", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="members"] [data-family-rows] tr').length === 1);
                    assert.deepEqual(requests.find((r) => r.params?.kind === "workspace.members.remove").params.params, { file: "docs/**" });

                    // Workspace-only Environment: hides Session scope option, has no secret checkbox, supports discovery prefill & Service scope, never leaks values
                    await settingsArticle.getByRole("link", { name: "Environment", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/env");
                    const envSection = settingsArticle.locator('[data-settings-panel="env"]');
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="env"] tbody tr').length === 1);
                    assert.equal(await envSection.locator('[data-scope-option="session"]').isVisible(), false, "Workspace-only mode hides session env scope button");
                    assert.doesNotMatch(await envSection.textContent(), /ws-secret-value/u);
                    const envDisclosure = envSection.locator('details[data-family-disclosure="env"]');
                    await envDisclosure.locator("> summary").click();
                    assert.equal(await envDisclosure.locator('input[name="secret"]').count(), 0, "Environment form has no secret checkbox");
                    await envDisclosure.locator("[data-family-discover-form]").getByRole("button", { name: "Discover", exact: true }).click();
                    await envDisclosure.locator("[data-candidate-rows] li").first().waitFor({ state: "visible" });
                    await envDisclosure.locator("[data-candidate-rows] li").first().getByRole("button", { name: "Add", exact: true }).click();
                    assert.equal(await envDisclosure.locator('[data-env-set-form] input[name="alias"]').inputValue(), "PLURNK_LOG_LEVEL");
                    await envSection.locator('[data-scope-option="service"]').click();
                    await page.waitForFunction(() => document.querySelector('#workspace-settings [data-settings-panel="env"]')?.getAttribute("data-panel-scope") === "service");
                    await envDisclosure.locator('[data-env-set-form] input[name="alias"]').fill("SVC_DEFAULT_TZ");
                    await envDisclosure.locator('[data-env-set-form] input[name="value"]').fill("UTC");
                    await envDisclosure.locator('[data-env-set-form] button[type="submit"]').click();
                    await page.waitForFunction(() => document.querySelector('#workspace-settings [data-settings-panel="env"] tr[data-env-alias="SVC_DEFAULT_TZ"]') !== null);
                    assert.deepEqual(
                        requests.findLast((r) => r.params?.kind === "service.env.replace")?.params?.params,
                        { alias: "SVC_DEFAULT_TZ", value: "UTC" },
                    );

                    // Multi-key per-server MCP secrets at both Service and Workspace scopes (with inherited key visibility and per-key removal)
                    await settingsArticle.getByRole("link", { name: "MCP", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/mcp");
                    await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
                    const mcpScopePanel = settingsArticle.locator('[data-settings-panel="mcp"]');
                    const mcpScopeDisc = mcpScopePanel.locator('details[data-family-disclosure="mcp"]');
                    await mcpScopeDisc.locator("> summary").click();
                    assert.equal(await mcpScopeDisc.locator("[data-mcp-secret-fields]").isVisible(), true, "Workspace MCP shows multi-key secret fields");
                    // Switch to Service scope and create weatherTracker with 2 encrypted keys (WEATHER_KEY + WEATHER_BACKUP_KEY)
                    await mcpScopePanel.locator('[data-scope-option="service"]').click();
                    await page.waitForFunction(() => document.querySelector('#workspace-settings [data-settings-panel="mcp"]')?.getAttribute("data-panel-scope") === "service");
                    await mcpScopeDisc.locator('select[name="transport"]').selectOption("stdio");
                    await mcpScopeDisc.locator('input[name="alias"]').fill("weather-tracker");
                    await mcpScopeDisc.locator('input[name="command"]').fill("weather-mcp");
                    await mcpScopeDisc.locator('[data-mcp-secret-row] input[name="secretName"]').first().fill("WEATHER_KEY");
                    await mcpScopeDisc.locator('[data-mcp-secret-row] input[name="secretValue"]').first().fill("sk-nyc-secret-111");
                    await mcpScopeDisc.locator("[data-mcp-add-secret-row]").click();
                    await mcpScopeDisc.locator('[data-mcp-secret-row] input[name="secretName"]').nth(1).fill("WEATHER_BACKUP_KEY");
                    await mcpScopeDisc.locator('[data-mcp-secret-row] input[name="secretValue"]').nth(1).fill("sk-nyc-backup-222");
                    await mcpScopeDisc.getByRole("button", { name: "Save server", exact: true }).click();
                    await page.waitForFunction(() => [...document.querySelectorAll('#workspace-settings [data-settings-panel="mcp"] [data-family-rows] tr')].some((tr) => tr.textContent?.includes("weather-tracker")));
                    assert.doesNotMatch(await mcpScopePanel.textContent(), /sk-nyc-secret-111|sk-nyc-backup-222/u);
                    assert.deepEqual(
                        requests.findLast((r) => r.params?.kind === "service.mcp.secrets.set")?.params?.params,
                        {
                            alias: "weather-tracker",
                            secrets: { WEATHER_KEY: "sk-nyc-secret-111", WEATHER_BACKUP_KEY: "sk-nyc-backup-222" },
                        },
                    );
                    const svcWeatherRow = mcpScopePanel.locator("[data-family-rows] tr", { hasText: "weather-tracker" });
                    assert.equal(await svcWeatherRow.locator("[data-family-secrets]").textContent(), "Keys (2)");
                    // Switch back to Workspace scope: weather-tracker shows inherited keys (Keys (2 svc)), and Workspace can override WEATHER_KEY with El Paso secret + remove it
                    await mcpScopePanel.locator('[data-scope-option="workspace"]').click();
                    await page.waitForFunction(() => document.querySelector('#workspace-settings [data-settings-panel="mcp"]')?.getAttribute("data-panel-scope") === "workspace");
                    await page.waitForFunction(() => [...document.querySelectorAll('#workspace-settings [data-settings-panel="mcp"] [data-family-rows] tr')].some((tr) => tr.textContent?.includes("weather-tracker")));
                    const wsWeatherRow = mcpScopePanel.locator("[data-family-rows] tr", { hasText: "weather-tracker" });
                    assert.equal(await wsWeatherRow.locator("[data-family-secrets]").textContent(), "Keys (2 svc)");
                    await wsWeatherRow.locator("[data-family-secrets]").click();
                    const secretsBox = mcpScopePanel.locator("[data-mcp-secrets-box]");
                    await secretsBox.waitFor({ state: "visible" });
                    assert.match(await secretsBox.locator("[data-mcp-secrets-inherited]").textContent(), /Inherited from Service: WEATHER_BACKUP_KEY, WEATHER_KEY/u);
                    await secretsBox.locator('[data-mcp-secret-row] input[name="secretName"]').first().fill("WEATHER_KEY");
                    await secretsBox.locator('[data-mcp-secret-row] input[name="secretValue"]').first().fill("sk-elpaso-secret-999");
                    await secretsBox.getByRole("button", { name: "Save keys", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll("#workspace-settings [data-mcp-configured-keys] li").length === 1);
                    assert.doesNotMatch(await mcpScopePanel.textContent(), /sk-elpaso-secret-999/u);
                    assert.deepEqual(
                        requests.findLast((r) => r.params?.kind === "workspace.mcp.secrets.set")?.params?.params,
                        { alias: "weather-tracker", secrets: { WEATHER_KEY: "sk-elpaso-secret-999" } },
                    );
                    assert.equal(await wsWeatherRow.locator("[data-family-secrets]").textContent(), "Keys (1)");
                    await secretsBox.locator("[data-mcp-configured-keys] li").first().getByRole("button", { name: "Remove", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll("#workspace-settings [data-mcp-configured-keys] li").length === 0);
                    assert.deepEqual(
                        requests.findLast((r) => r.params?.kind === "workspace.mcp.secrets.unset")?.params?.params,
                        { alias: "weather-tracker", keys: ["WEATHER_KEY"] },
                    );

                    // Help tab renders keyboard shortcuts and live-filterable slash commands
                    await settingsArticle.getByRole("link", { name: "Help", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/help");
                    const helpPanel = settingsArticle.locator('[data-settings-panel="help"]');
                    await helpPanel.waitFor({ state: "visible" });
                    assert.equal(await helpPanel.locator('dl[aria-label="Keyboard shortcuts"]').isVisible(), true);
                    const helpFilter = helpPanel.getByRole("searchbox", { name: "Filter commands", exact: true });
                    await helpFilter.fill("rollback");
                    assert.deepEqual(
                        await helpPanel.locator("[data-command-name]:not([hidden])").evaluateAll((els) => els.map((el) => el.getAttribute("data-command-name"))),
                        ["rollback"],
                    );

                    // About tab folded into /settings/about hydrates @plurnk/plurnk-service version from /acp initialize + @plurnk/plurnk-web version + MIT + issues link
                    await settingsArticle.getByRole("link", { name: "About", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/about");
                    const aboutPanel = settingsArticle.locator('[data-settings-panel="about"]');
                    await aboutPanel.waitFor({ state: "visible" });
                    await page.waitForFunction(() => document.querySelector('#workspace-settings [data-text="about-service-version"]')?.textContent === "1.0.0");
                    assert.equal(await aboutPanel.locator("[data-about-service-term]").isVisible(), true);
                    assert.match(await aboutPanel.locator('[data-text="about-web-version"]').textContent(), /^\d+\.\d+\.\d+$/u);
                    assert.equal(await aboutPanel.locator("[data-about-desktop-term]").isVisible(), false, "ordinary browser hides plurnk-desktop row");
                    assert.match(await aboutPanel.textContent(), /MIT/u);
                    assert.equal(await aboutPanel.locator('a[href="https://github.com/plurnk/plurnk-service/issues"]').count(), 1);

                    // 2. Session mode (sessionName = "user"): `/personas list` navigates directly to /settings/personas?workspace=conversation&session=user
                    await page.goto(fixture.url);
                    await page.waitForFunction(() => typeof window.runCommand === "function");
                    await page.evaluate(() => window.setSessionContext("user"));
                    void page.evaluate(() => window.runCommand("/personas list"));
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/personas");
                    await settingsArticle.waitFor({ state: "visible" });
                    const personasPanel = settingsArticle.locator('[data-settings-panel="personas"]');
                    await personasPanel.waitFor({ state: "visible" });
                    assert.equal(await settingsArticle.getByRole("link", { name: "Personas", exact: true }).getAttribute("aria-current"), "page");
                    assert.equal(await personasPanel.locator("[data-session-persona-form]").count(), 0, "session persona selector lives on /settings/sessions");
                    const personasDisclosure = personasPanel.locator('details[data-family-disclosure="personas"]');
                    await personasDisclosure.locator("> summary").click();
                    const personaModelCombo = personasDisclosure.getByRole("combobox", { name: "Persona default model", exact: true });
                    const personaEffortSelect = personasDisclosure.getByRole("combobox", { name: "Persona default effort", exact: true });
                    await page.setViewportSize({ width: 1280, height: 740 });
                    const personaLayout = await page.evaluate(() => {
                        const modelInput = document.querySelector('#workspace-settings [data-personas-save-form] input[name="model"]')?.getBoundingClientRect();
                        const effortSel = document.querySelector('#workspace-settings [data-personas-save-form] select[name="effort"]')?.getBoundingClientRect();
                        return {
                            aligned: Boolean(modelInput && effortSel && Math.abs(modelInput.top - effortSel.top) <= 2),
                            modelWider: Boolean(modelInput && effortSel && modelInput.width > effortSel.width * 1.5),
                        };
                    });
                    assert.equal(personaLayout.aligned, true, "Persona model and effort align vertically on desktop");
                    assert.equal(personaLayout.modelWider, true, "Persona model grows while effort shrinks on desktop");
                    await page.setViewportSize({ width: 320, height: 740 });
                    await personaModelCombo.fill("claude");
                    const personaClaudeOpt = personasDisclosure.locator('[data-model-combobox="personaModel"] [role="option"][data-combobox-option="anthropic/claude-sonnet-4-5"]');
                    await personaClaudeOpt.waitFor({ state: "visible" });
                    await personaClaudeOpt.click();
                    assert.deepEqual(
                        await personaEffortSelect.locator("option").evaluateAll((opts) => opts.map((o) => o.getAttribute("value"))),
                        ["", "low", "medium", "high", "max"],
                        "selecting a persona model narrows optional default effort choices dynamically",
                    );
                    await personasDisclosure.locator("> summary").click();

                    // Rejected session/options surfaces Problem detail & recovery in dedicated error callout
                    failNextSessionOptions = true;
                    await settingsArticle.getByRole("link", { name: "Sessions", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/sessions");
                    await page.waitForFunction(() => document.querySelector("#workspace-settings [data-text='ws-settings-message']")?.textContent === "Session options temporarily unavailable.");
                    assert.equal(await settingsArticle.locator("[data-settings-feedback]").getAttribute("data-feedback-level"), "error");
                    assert.equal(await settingsArticle.locator('[data-text="ws-settings-recovery"]').textContent(), "Retry opening the Session tab.");

                    // Re-select Sessions tab: hydrates via session/options with dynamic model-driven efforts, session Approval policy, and standardized Sessions table
                    await settingsArticle.getByRole("link", { name: "Workspaces", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/workspaces");
                    assert.equal(await settingsArticle.locator('[data-settings-panel="workspaces"] [data-workspace-mode-form]').count(), 0, "Approval policy lives on /settings/sessions");
                    await settingsArticle.getByRole("link", { name: "Sessions", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/sessions");
                    const sessionPanel = settingsArticle.locator('[data-settings-panel="sessions"]');
                    await sessionPanel.waitFor({ state: "visible" });
                    await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
                    await sessionPanel.locator('#session-title input[name="title"]').fill("Security audit");
                    await sessionPanel.getByRole("button", { name: "Save title", exact: true }).click();
                    await page.waitForFunction(() => document.querySelector("#workspace-settings [data-text='ws-settings-message']")?.textContent === "Title: Security audit.");
                    assert.equal(await settingsArticle.locator("[data-settings-feedback]").getAttribute("data-feedback-level"), "success");
                    assert.equal(activeSessionTitle, "Security audit");

                    const sessionConfigForm = sessionPanel.locator("[data-session-config-form]");
                    await sessionConfigForm.waitFor({ state: "visible" });
                    await page.setViewportSize({ width: 1280, height: 740 });
                    const sessionLayout = await page.evaluate(() => {
                        const fs = document.querySelector('#workspace-settings [data-session-config-form] > fieldset')?.getBoundingClientRect();
                        const btn = document.querySelector('#workspace-settings [data-session-config-form] footer > button')?.getBoundingClientRect();
                        const modelInput = document.querySelector('#workspace-settings [data-session-config-form] input[name="model"]')?.getBoundingClientRect();
                        const effortSel = document.querySelector('#workspace-settings [data-session-config-form] select[name="effort"]')?.getBoundingClientRect();
                        return {
                            applyRightAligned: Boolean(fs && btn && Math.abs(fs.right - btn.right) <= 4),
                            fieldsAligned: Boolean(modelInput && effortSel && Math.abs(modelInput.top - effortSel.top) <= 2),
                            modelWiderThanEffort: Boolean(modelInput && effortSel && modelInput.width > effortSel.width * 1.5),
                        };
                    });
                    assert.equal(sessionLayout.applyRightAligned, true, "Apply to session button aligns to the right edge of the form footer");
                    assert.equal(sessionLayout.fieldsAligned, true, "Model input and Reasoning effort select align vertically on /settings/sessions");
                    assert.equal(sessionLayout.modelWiderThanEffort, true, "Model field grows while Reasoning effort shrinks on /settings/sessions");
                    await page.setViewportSize({ width: 320, height: 740 });

                    const modelCombo = sessionConfigForm.getByRole("combobox", { name: "Active session model", exact: true });
                    const spawnCombo = sessionConfigForm.getByRole("combobox", { name: "Child session model", exact: true });
                    const effortSelect = sessionConfigForm.getByRole("combobox", { name: "Reasoning effort", exact: true });
                    assert.deepEqual(
                        await effortSelect.locator("option").evaluateAll((opts) => opts.map((o) => o.getAttribute("value"))),
                        ["low", "high"],
                        "initial model populates exact supported efforts without fake placeholder",
                    );

                    // Fresh session (status.model === null) persists default alias when clicking Apply to session
                    await sessionConfigForm.getByRole("button", { name: "Apply to session", exact: true }).click();
                    await page.waitForFunction(() => (document.querySelector("#workspace-settings [data-text='ws-settings-message']")?.textContent ?? "").includes("fixture/small"));
                    assert.equal(activeSessionModelPersisted, true, "fresh session Apply to session persists default alias instead of no-oping");

                    // Combobox searches past alphabetical row 100 (120-model catalog) and dynamically resolves efforts for anthropic/claude-sonnet-4-5!
                    await modelCombo.click();
                    const modelList = sessionConfigForm.locator('[data-model-combobox="model"] [data-combobox-list]');
                    await modelList.waitFor({ state: "visible" });
                    const initialFirstOption = await modelList.locator('[role="option"]').first().getAttribute("data-combobox-option");
                    assert.equal(initialFirstOption, "local", "declared aliases rank first before alibaba/* catalog entries");
                    await modelCombo.press("ArrowDown");
                    const activeFirstId = await modelList.locator('[role="option"]').first().getAttribute("id");
                    assert.equal(await modelList.locator('[role="option"]').first().getAttribute("data-active"), "true", "ArrowDown highlights active option via data-active");
                    assert.equal(await modelCombo.getAttribute("aria-activedescendant"), activeFirstId, "ArrowDown updates aria-activedescendant");
                    await modelCombo.press("Escape");
                    await modelList.waitFor({ state: "hidden" });
                    assert.equal(await modelCombo.getAttribute("aria-expanded"), "false", "Escape closes combobox listbox");
                    await modelCombo.fill("claude");
                    const claudeOption = modelList.locator('[role="option"][data-combobox-option="anthropic/claude-sonnet-4-5"]');
                    await claudeOption.waitFor({ state: "visible" });
                    await claudeOption.click();
                    await modelList.waitFor({ state: "hidden" });
                    assert.equal(await modelCombo.inputValue(), "anthropic/claude-sonnet-4-5");
                    assert.deepEqual(
                        await effortSelect.locator("option").evaluateAll((opts) => opts.map((o) => o.getAttribute("value"))),
                        ["low", "medium", "high", "max"],
                        "selecting a catalog model beyond row 100 immediately updates supported Reasoning effort options",
                    );

                    // Uncataloged alias disables effort; fixture/plain updates to off/adaptive; fast selects alias default effort "high"
                    await modelCombo.fill("uncataloged");
                    await modelList.locator('[role="option"][data-combobox-option="uncataloged"]').click();
                    assert.equal(await effortSelect.isDisabled(), true, "uncataloged route with no advertised efforts disables effort select");

                    await modelCombo.fill("plain");
                    const plainOption = modelList.locator('[role="option"][data-combobox-option="fixture/plain"]');
                    await plainOption.waitFor({ state: "visible" });
                    await plainOption.click();
                    assert.equal(await effortSelect.isDisabled(), false);
                    assert.deepEqual(
                        await effortSelect.locator("option").evaluateAll((opts) => opts.map((o) => o.getAttribute("value"))),
                        ["off", "adaptive"],
                    );

                    await modelCombo.fill("fast");
                    const fastOption = modelList.locator('[role="option"][data-combobox-option="fast"]');
                    await fastOption.waitFor({ state: "visible" });
                    await fastOption.click();
                    await page.waitForFunction(() => {
                        const sel = document.querySelector('#workspace-settings [data-session-config-form] select[name="effort"]');
                        return sel instanceof HTMLSelectElement && !sel.disabled && sel.options.length === 2 && sel.value === "high";
                    });
                    assert.deepEqual(
                        await effortSelect.locator("option").evaluateAll((opts) => opts.map((o) => o.getAttribute("value"))),
                        ["medium", "high"],
                        "switching model dynamically recomputes supported efforts from catalog",
                    );
                    assert.equal(await effortSelect.inputValue(), "high", "alias default effort is selected automatically");
                    await effortSelect.selectOption("medium");

                    // Child session model combobox finds models beyond row 100 (google/gemini-2.5-pro) as well as inherit & aliases
                    await spawnCombo.click();
                    const spawnList = sessionConfigForm.locator('[data-model-combobox="childModel"] [data-combobox-list]');
                    await spawnList.waitFor({ state: "visible" });
                    assert.equal(await spawnList.locator('[role="option"]').first().getAttribute("data-combobox-option"), "inherit");
                    await spawnCombo.fill("gemini");
                    const geminiOption = spawnList.locator('[role="option"][data-combobox-option="google/gemini-2.5-pro"]');
                    await geminiOption.waitFor({ state: "visible" });
                    await geminiOption.click();
                    assert.equal(await spawnCombo.inputValue(), "google/gemini-2.5-pro");

                    await sessionConfigForm.getByRole("combobox", { name: "Active session persona", exact: true }).selectOption("auditor");
                    await sessionConfigForm.getByRole("combobox", { name: "Approval policy", exact: true }).selectOption("accept");
                    await sessionConfigForm.getByRole("button", { name: "Apply to session", exact: true }).click();
                    await page.waitForFunction(() => (document.querySelector("#workspace-settings [data-text='ws-settings-message']")?.textContent ?? "").includes("Approval policy: accept"));
                    assert.equal(activeSessionModel, "fast");
                    assert.equal(activeSessionEffort, "medium");
                    assert.equal(activeSpawnModel, "google/gemini-2.5-pro");
                    assert.equal(activeSessionPersona, "auditor");
                    assert.equal(activeSessionMode, "accept");

                    // Standardized Sessions inline disclosure + collection bar (Active/Archived/All + row Archive/Unarchive)
                    const sessCreateDisclosure = sessionPanel.locator('details[data-family-disclosure="sessions"]');
                    assert.equal(await sessCreateDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), false);
                    await sessCreateDisclosure.locator("> summary").click();
                    assert.equal(await sessCreateDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), true);
                    await sessCreateDisclosure.locator("> summary").click();
                    const sessStateSelect = sessionPanel.locator('[data-collection-filter-form] select[name="state"]');
                    assert.equal(await sessionPanel.locator("[data-sessions-rows] tr").count(), 2);
                    await sessStateSelect.selectOption("archived");
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-sessions-rows] tr').length === 1);
                    assert.match(await sessionPanel.locator("[data-sessions-rows] tr").first().textContent(), /#old-sess/u);
                    await sessionPanel.locator("[data-sessions-rows] tr").first().getByRole("button", { name: "Unarchive", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-sessions-rows] tr').length === 0);
                    await sessStateSelect.selectOption("active");
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-sessions-rows] tr').length === 3);

                    // Models tab in Session mode: inline grow/shrink/apply form, stationary aliases table, comma-formatted context, pricing, min/max price filter, sort, and zero-shake debounced catalog search!
                    await settingsArticle.getByRole("link", { name: "Models", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/models");
                    const modelsPanel = settingsArticle.locator('[data-settings-panel="models"]');
                    await modelsPanel.waitFor({ state: "visible" });
                    const modelsSessionForm = modelsPanel.locator("form[data-models-session-form]");
                    await modelsSessionForm.waitFor({ state: "visible" });
                    assert.equal(await modelsSessionForm.getByRole("combobox", { name: "Active session model", exact: true }).inputValue(), "fast");

                    await page.setViewportSize({ width: 1280, height: 740 });
                    const modelsLayout = await page.evaluate(() => {
                        const modelInput = document.querySelector('#workspace-settings [data-models-session-form] input[name="model"]')?.getBoundingClientRect();
                        const effortSel = document.querySelector('#workspace-settings [data-models-session-form] select[name="effort"]')?.getBoundingClientRect();
                        const applyBtn = document.querySelector('#workspace-settings [data-models-session-form] button[data-models-apply]')?.getBoundingClientRect();
                        return {
                            fieldsAligned: Boolean(modelInput && effortSel && Math.abs(modelInput.top - effortSel.top) <= 2),
                            inlineApply: Boolean(modelInput && applyBtn && Math.abs(modelInput.bottom - applyBtn.bottom) <= 4),
                            modelWiderThanEffort: Boolean(modelInput && effortSel && modelInput.width > effortSel.width * 1.5),
                        };
                    });
                    assert.equal(modelsLayout.fieldsAligned, true, "Model input and Reasoning effort select align vertically on /settings/models");
                    assert.equal(modelsLayout.inlineApply, true, "Apply button sits inline beside Model and Effort on desktop");
                    assert.equal(modelsLayout.modelWiderThanEffort, true, "Model field grows while Reasoning effort shrinks on /settings/models");
                    await page.setViewportSize({ width: 320, height: 740 });

                    await modelsSessionForm.getByRole("combobox", { name: "Reasoning effort", exact: true }).selectOption("high");
                    await modelsSessionForm.getByRole("button", { name: "Apply", exact: true }).click();
                    await page.waitForFunction(() => (document.querySelector("#workspace-settings [data-text='ws-settings-message']")?.textContent ?? "").includes("Effort: high"));
                    assert.equal(activeSessionEffort, "high");
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="models"] [data-models-alias-rows] tr').length === 3);
                    assert.equal(await modelsPanel.locator("[data-models-catalog-rows] tr").count(), 10, "first page shows 10 of 120 catalog models");
                    assert.equal(await modelsPanel.locator('[data-text="model-total"]').textContent(), "120");
                    assert.equal(
                        await modelsPanel.locator('[data-text="model-more"]').textContent(),
                        "More matches are available; narrow the search.",
                        "model-more omits confusing 'or paginate.' jargon",
                    );
                    assert.equal(
                        await modelsPanel.locator("[data-models-catalog-wrap] thead th").count(),
                        5,
                        "catalog table shows 5 columns (Selector, Name, Context, Price (/1M), Actions) without Efforts or Readiness",
                    );
                    const nextPageBtn = modelsPanel.locator("[data-models-next]");
                    const prevPageBtn = modelsPanel.locator("[data-models-prev]");
                    assert.equal(await prevPageBtn.isDisabled(), true);
                    assert.equal(await nextPageBtn.isDisabled(), false);
                    await nextPageBtn.click();
                    await page.waitForFunction(() => document.querySelector('#workspace-settings [data-settings-panel="models"] [data-text="model-offset"]')?.textContent === "10");
                    assert.equal(await modelsPanel.locator("[data-models-catalog-rows] tr").count(), 10, "second page shows next 10 catalog models");
                    assert.equal(await prevPageBtn.isDisabled(), false);
                    assert.equal(await nextPageBtn.isDisabled(), false);
                    await prevPageBtn.click();
                    await page.waitForFunction(() => document.querySelector('#workspace-settings [data-settings-panel="models"] [data-text="model-offset"]')?.textContent === "0");
                    assert.equal(await prevPageBtn.isDisabled(), true);

                    // Provider filter narrows directly to anthropic, shows comma-formatted context and USD/1M pricing, and exposes 1-click Use in session & Use as child
                    const providerSelect = modelsPanel.getByRole("combobox", { name: "Filter by provider", exact: true });
                    await providerSelect.selectOption("anthropic");
                    await page.waitForFunction(() =>
                        document.querySelector('#workspace-settings [data-settings-panel="models"] [data-text="model-total"]')?.textContent === "1"
                        && document.querySelector('#workspace-settings [data-models-catalog-rows] [data-text="model-selector"]')?.textContent === "anthropic/claude-sonnet-4-5",
                    );
                    assert.equal(await modelsPanel.locator('[data-models-catalog-rows] [data-text="model-context"]').first().textContent(), "200,000");
                    assert.equal(await modelsPanel.locator('[data-models-catalog-rows] [data-text="model-price"]').first().textContent(), "$3 / $15");
                    await modelsPanel.locator("[data-models-catalog-rows] tr").first().getByRole("button", { name: "Use in session", exact: true }).click();
                    await page.waitForFunction(() => (document.querySelector("#workspace-settings [data-text='ws-settings-message']")?.textContent ?? "").includes("anthropic/claude-sonnet-4-5"));
                    assert.equal(activeSessionModel, "anthropic/claude-sonnet-4-5");
                    await modelsPanel.locator("[data-models-catalog-rows] tr").first().getByRole("button", { name: "Use as child", exact: true }).click();
                    await page.waitForFunction(() => (document.querySelector("#workspace-settings [data-text='ws-settings-message']")?.textContent ?? "").includes("Child model: anthropic/claude-sonnet-4-5"));
                    assert.equal(activeSpawnModel, "anthropic/claude-sonnet-4-5");
                    await providerSelect.selectOption("");
                    await page.waitForFunction(() => document.querySelector('#workspace-settings [data-settings-panel="models"] [data-text="model-total"]')?.textContent === "120");

                    // Sort by most expensive and filter by Min $/1M and Max $/1M
                    const sortSelect = modelsPanel.getByRole("combobox", { name: "Sort models", exact: true });
                    await sortSelect.selectOption("cost-desc");
                    await page.waitForFunction(() =>
                        document.querySelector('#workspace-settings [data-models-catalog-rows] [data-text="model-selector"]')?.textContent === "google/gemini-2.5-pro",
                    );
                    assert.equal(await modelsPanel.locator('[data-models-catalog-rows] [data-text="model-context"]').first().textContent(), "1,000,000");
                    assert.equal(await modelsPanel.locator('[data-models-catalog-rows] [data-text="model-price"]').first().textContent(), "$12 / $40");

                    const minPriceInput = modelsPanel.locator('[data-models-search-form] input[name="minPrice"]');
                    const maxPriceInput = modelsPanel.locator('[data-models-search-form] input[name="maxPrice"]');
                    await minPriceInput.fill("1");
                    await maxPriceInput.fill("5");
                    await page.waitForFunction(() =>
                        document.querySelector('#workspace-settings [data-settings-panel="models"] [data-text="model-total"]')?.textContent === "1"
                        && document.querySelector('#workspace-settings [data-models-catalog-rows] [data-text="model-selector"]')?.textContent === "anthropic/claude-sonnet-4-5",
                    );
                    await minPriceInput.fill("");
                    await maxPriceInput.fill("0");
                    await page.waitForFunction(() =>
                        document.querySelector('#workspace-settings [data-settings-panel="models"] [data-text="model-total"]')?.textContent === "1"
                        && document.querySelector('#workspace-settings [data-models-catalog-rows] [data-text="model-price"]')?.textContent === "Free",
                    );
                    await maxPriceInput.fill("");
                    await sortSelect.selectOption("selector");
                    await page.waitForFunction(() => document.querySelector('#workspace-settings [data-settings-panel="models"] [data-text="model-total"]')?.textContent === "120");

                    // Typing into catalog search keeps the Aliases table stationary above it (zero vertical shake!)
                    const catalogSearch = modelsPanel.getByRole("searchbox", { name: "Search model catalog", exact: true });
                    await catalogSearch.click();
                    const geomBefore = await catalogSearch.evaluate((el) => ({
                        top: el.getBoundingClientRect().top,
                        offsetTop: el instanceof HTMLElement ? el.offsetTop : -1,
                    }));
                    await catalogSearch.pressSequentially("small", { delay: 15 });
                    await page.waitForFunction(() =>
                        document.querySelector('#workspace-settings [data-models-catalog-rows] [data-text="model-name"]')?.textContent === "Small (small)",
                    );
                    const geomAfter = await catalogSearch.evaluate((el) => ({
                        top: el.getBoundingClientRect().top,
                        offsetTop: el instanceof HTMLElement ? el.offsetTop : -1,
                    }));
                    assert.equal(geomAfter.offsetTop, geomBefore.offsetTop, "catalog search offsetTop stays fixed above filtered results");
                    assert.ok(
                        Math.abs(geomAfter.top - geomBefore.top) <= 1,
                        `catalog search input stays vertically anchored while typing (delta=${Math.abs(geomAfter.top - geomBefore.top)})`,
                    );
                    assert.equal(await modelsPanel.locator("[data-models-alias-rows] tr").count(), 3, "Aliases table stays intact while searching catalog");
                    assert.equal(
                        await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
                        "Search model catalog",
                        "typing sequentially into Search model catalog retains focus across every character",
                    );
                    assert.equal(await catalogSearch.inputValue(), "small");
                    await catalogSearch.fill("");
                    await page.waitForFunction(() => document.querySelector('#workspace-settings [data-settings-panel="models"] [data-text="model-total"]')?.textContent === "120");
                    await modelsPanel.locator("[data-models-alias-rows] tr").first().getByRole("button", { name: "Use in session", exact: true }).click();
                    await page.waitForFunction(() => (document.querySelector("#workspace-settings [data-text='ws-settings-message']")?.textContent ?? "").includes("fixture/small"));
                    assert.equal(activeSessionModel, "local");

                    // Providers & API keys disclosure saves via service.config.set and clears via service.config.unset
                    const providersDisc = modelsPanel.locator("details[data-providers-disclosure]");
                    assert.equal(await providersDisc.isVisible(), true);
                    await providersDisc.locator("> summary").click();
                    const openrouterForm = providersDisc.locator("form[data-provider-key-form]").first();
                    await openrouterForm.locator("input[data-provider-key-input]").fill("sk-or-unit-test-key");
                    await openrouterForm.getByRole("button", { name: "Save", exact: true }).click();
                    await page.waitForFunction(() => (document.querySelector("#workspace-settings [data-text='ws-settings-message']")?.textContent ?? "").includes("Saved OPENROUTER_API_KEY"));
                    assert.deepEqual(
                        requests.findLast((r) => r.params?.kind === "service.config.set")?.params?.params,
                        { key: "OPENROUTER_API_KEY", value: "sk-or-unit-test-key" },
                    );

                    // Personas 1-click Use in session
                    await settingsArticle.getByRole("link", { name: "Personas", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/personas");
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="personas"] [data-family-rows] tr').length >= 1);
                    await settingsArticle.locator('[data-settings-panel="personas"] [data-family-rows] tr').first().getByRole("button", { name: "Use in session", exact: true }).click();
                    await page.waitForFunction(() => (document.querySelector("#workspace-settings [data-text='ws-settings-message']")?.textContent ?? "").includes("Persona: auditor"));

                    // Switch to Environment in Session mode and verify session listing scope via unified scope switcher
                    await settingsArticle.getByRole("link", { name: "Environment", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/env");
                    await envSection.locator('[data-scope-option="session"]').waitFor({ state: "visible" });
                    await envSection.locator('[data-scope-option="session"]').click();
                    await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="env"] tbody tr').length === 2);
                    assert.doesNotMatch(await envSection.textContent(), /ws-secret-value|sess-secret-value/u);
                    assert.equal(
                        await envSection.locator('tr[data-env-alias="WS_TOKEN"] [data-env-unset]').isVisible(),
                        false,
                        "Session scope hides Unset on workspace-owned env rows",
                    );

                    // 3. Daemon confinement policy reflection:
                    //    (a) projectRoot="none", missing families ["schedule", "env"], MCP streamable-http+publicOnly, skills mcp-only
                    fixture.setPolicy({
                        projectRoot: "none",
                        families: ["mcp", "members", "personas", "skills"],
                        mcp: { workspaceTransports: ["streamable-http"], publicOnly: true },
                        skills: { workspaceSources: ["mcp"], publicOnly: true },
                    });
                    await page.goto(new URL("/settings/schedule?workspace=conversation", fixture.url).href);
                    await settingsArticle.waitFor({ state: "visible" });
                    await page.waitForFunction(() => {
                        const schedLink = document.querySelector('#workspace-settings [data-settings-section="schedule"]');
                        return schedLink?.parentElement?.hidden === true;
                    });
                    assert.equal(await settingsArticle.locator('[data-settings-section="schedule"]').isVisible(), false, "unregistered schedule family tab is hidden");
                    assert.equal(await settingsArticle.locator('[data-settings-section="env"]').isVisible(), false, "unregistered env family tab is hidden");
                    assert.equal(await settingsArticle.locator('[data-settings-section="members"]').isVisible(), false, "projectRoot=none hides Members tab");
                    assert.equal(await settingsArticle.locator('[data-settings-panel="schedule"]').isVisible(), false, "hidden section panel is hidden on direct URL arrival");
                    assert.equal(await settingsArticle.locator('[data-text="ws-settings-message"]').textContent(), "This settings section is unavailable for this workspace.");
                    assert.equal(await settingsArticle.locator("[data-settings-feedback]").getAttribute("data-feedback-level"), "warning");

                    // Inline + New workspace hides project folder controls under projectRoot="none"
                    await settingsArticle.getByRole("link", { name: "Workspaces", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/workspaces");
                    await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
                    await wsDisclosure.locator("> summary").click();
                    assert.equal(await wsDisclosure.locator("[data-project-folder-toggle]").isVisible(), false);
                    assert.equal(await wsDisclosure.locator("[data-project-folder-input]").isVisible(), false);

                    // /settings/mcp disables stdio, defaults to streamable-http, and displays publicOnly note
                    await settingsArticle.getByRole("link", { name: "MCP", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/mcp");
                    await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
                    await mcpDisclosure.locator("> summary").click();
                    assert.equal(await mcpDisclosure.locator('select[name="transport"] option[value="stdio"]').isDisabled(), true);
                    assert.equal(await mcpDisclosure.locator('select[name="transport"]').inputValue(), "streamable-http");
                    assert.equal(await mcpDisclosure.locator("[data-mcp-http-fields]").isVisible(), true);
                    assert.equal(await mcpDisclosure.locator("[data-mcp-stdio-fields]").isVisible(), false);
                    assert.match(await mcpDisclosure.locator('[data-policy-note="mcp-http"]').textContent(), /Public HTTP\(S\) endpoints only/u);

                    // /settings/skills hides Git-only ref input when only mcp source is allowed
                    await settingsArticle.getByRole("link", { name: "Skills", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/skills");
                    await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
                    await skillsDisclosure.locator("> summary").click();
                    assert.equal(await skillsDisclosure.locator('input[name="ref"]').isVisible(), false, "Git-only ref input hides when git skill sources are disabled");
                    assert.match(await skillsDisclosure.locator('[data-policy-note="skills"]').textContent(), /Allowed skill sources: mcp/u);

                    // /settings/personas hides file-path mode under projectRoot="none" while keeping inline creation usable
                    await settingsArticle.getByRole("link", { name: "Personas", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/personas");
                    await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
                    const personasDisc = settingsArticle.locator('details[data-family-disclosure="personas"]');
                    await personasDisc.locator("> summary").click();
                    assert.equal(await personasDisc.locator('select[name="personaMode"] option[value="source"]').isDisabled(), true);
                    assert.equal(await personasDisc.locator('select[name="personaMode"]').inputValue(), "inline");
                    assert.equal(await personasDisc.locator('[data-family-discover-form] input[name="source"]').isVisible(), false);

                    //    (b) confined mode with empty MCP transports + empty skill sources hides + Add disclosures while keeping tables visible,
                    //        and confined mode keeps local personas/skills notes visible when admitted
                    fixture.setPolicy({
                        projectRoot: "confined",
                        families: ["env", "mcp", "members", "personas", "schedule", "skills"],
                        mcp: { workspaceTransports: [], publicOnly: true },
                        skills: { workspaceSources: ["mcp", "local"], publicOnly: true },
                    });
                    await settingsArticle.getByRole("link", { name: "MCP", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/mcp");
                    await page.waitForFunction(() => document.querySelector('#workspace-settings details[data-family-disclosure="mcp"]')?.hasAttribute("hidden") === true);
                    assert.equal(await mcpDisclosure.isVisible(), false, "empty workspaceTransports hides + Add server disclosure");
                    assert.equal(await mcpPanel.locator("[data-family-rows] tr").count(), 4, "existing MCP servers remain visible when workspace creation is disabled");
                    assert.equal(await settingsArticle.locator('[data-settings-section="members"]').isVisible(), true, "confined rooted workspace keeps Members tab visible");

                    await settingsArticle.getByRole("link", { name: "Skills", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/skills");
                    await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
                    assert.equal(await skillsDisclosure.isVisible(), true, "confined workspace with local+mcp keeps + Add skill visible");
                    assert.match(await skillsDisclosure.locator('[data-policy-note="skills"]').textContent(), /inside this workspace's project folder/u);

                    await settingsArticle.getByRole("link", { name: "Personas", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/personas");
                    await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
                    await personasDisc.locator("> summary").click();
                    assert.equal(await personasDisc.locator('select[name="personaMode"] option[value="source"]').isDisabled(), false, "confined rooted workspace keeps persona file-path mode available");
                    await personasDisc.locator('select[name="personaMode"]').selectOption("source");
                    assert.match(await personasDisc.locator('[data-policy-note="personas-source"]').textContent(), /inside this workspace's project folder/u);

                    await settingsArticle.getByRole("link", { name: "Workspaces", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/workspaces");
                    await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
                    await wsDisclosure.locator("> summary").click();
                    await wsDisclosure.locator("[data-toggle-project-folder]").check();
                    assert.equal(await wsDisclosure.locator("[data-project-folder-input]").isVisible(), true);
                    assert.match(await wsDisclosure.locator("[data-project-folder-note]").textContent(), /configured workspace directory/u);

                    fixture.setPolicy(null);
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
