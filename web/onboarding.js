import { $, on, the } from "on_the_money";
import SessionAgent, { randomUUID } from "./session-agent.js";
import { isRecord } from "./session-translator.js";
import accessHeaders from "./access-headers.js";
import managementAction from "./management-action.js";
import describeFailure from "./failure.js";

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly label: string,
 *   readonly envKey: string,
 *   readonly preferred: RegExp,
 *   readonly fallbackSelector: string,
 * }} HostedProvider
 */

/** @type {readonly HostedProvider[]} */
const HOSTED_PROVIDERS = [
    { id: "anthropic", label: "Anthropic", envKey: "ANTHROPIC_API_KEY", preferred: /claude-sonnet-4|claude-3-7-sonnet/iu, fallbackSelector: "anthropic/claude-sonnet-4-20250514" },
    { id: "openai", label: "OpenAI", envKey: "OPENAI_API_KEY", preferred: /gpt-5|gpt-4\.1|o4-mini/iu, fallbackSelector: "openai/gpt-4.1" },
    { id: "google", label: "Google Gemini", envKey: "GEMINI_API_KEY", preferred: /gemini-2\.5-pro|gemini-2\.5-flash/iu, fallbackSelector: "google/gemini-2.5-pro" },
    { id: "deepseek", label: "DeepSeek", envKey: "DEEPSEEK_API_KEY", preferred: /deepseek-chat|deepseek-v3/iu, fallbackSelector: "deepseek/deepseek-chat" },
    { id: "openrouter", label: "OpenRouter", envKey: "OPENROUTER_API_KEY", preferred: /claude-sonnet-4|qwen3-coder/iu, fallbackSelector: "openrouter/anthropic/claude-sonnet-4" },
];

/**
 * @typedef {{
 *   readonly runtime?: string,
 *   readonly id: string,
 *   readonly label: string,
 *   readonly alias: string,
 *   readonly selector: string,
 *   readonly baseUrl?: string,
 * }} LocalCandidate
 */

/**
 * {§web-onboarding} Visual first-run model setup over the daemon's operator `.env` cascade.
 * @param {() => {
 *   auth: "session" | "none",
 *   signal: AbortSignal,
 *   onConfigured?: (alias: string) => Promise<void> | void,
 * }} getContext
 */
export function createOnboardingController(getContext) {
    /** @type {HTMLDialogElement | null} */
    let dialog = null;
    /** @type {AbortController | null} */
    let activeLoad = null;
    /** @type {LocalCandidate[]} */
    let localCandidates = [];
    /** @type {Map<string, { configured: boolean, overriddenBy: string | null }>} */
    const envByKey = new Map();
    /** @type {Array<{ selector: string, provider: string, modelName: string }>} */
    let catalogModels = [];

    function ensureDialog() {
        if (dialog && dialog.isConnected) return dialog;
        const existing = $("#dialog-onboarding");
        if (existing instanceof HTMLDialogElement) {
            dialog = existing;
            return dialog;
        }
        const cloned = $.clone(document.body, "#onboarding-dialog");
        if (!(cloned instanceof HTMLDialogElement)) {
            throw new Error("Onboarding dialog template is incomplete.");
        }
        dialog = cloned;

        const article = $(dialog, "article");
        const form = $(dialog, "[data-onboarding-form]");
        const sourceSelect = form ? $(form, 'select[name="source"]') : null;
        const modelSelect = form ? $(form, 'select[name="selector"]') : null;
        const aliasInput = form ? $(form, 'input[name="alias"]') : null;
        const apiKeyInput = form ? $(form, 'input[name="apiKey"]') : null;
        if (!article || !(form instanceof HTMLFormElement)
            || !(sourceSelect instanceof HTMLSelectElement)
            || !(modelSelect instanceof HTMLSelectElement)
            || !(aliasInput instanceof HTMLInputElement)
            || !(apiKeyInput instanceof HTMLInputElement)) {
            throw new Error("Onboarding dialog controls are incomplete.");
        }

        const syncSourceSelection = () => {
            const raw = sourceSelect.value;
            apiKeyInput.setCustomValidity("");
            if (raw.startsWith("local:")) {
                const idx = Number.parseInt(raw.slice("local:".length), 10);
                const candidate = localCandidates[idx];
                form.dataset.onboardingMode = "local";
                apiKeyInput.required = false;
                apiKeyInput.value = "";
                if (candidate) {
                    aliasInput.value = candidate.alias;
                    the(article, "onboarding-key-hint", `Local endpoint: ${candidate.baseUrl ?? candidate.selector}`);
                }
                return;
            }
            const providerId = raw.startsWith("hosted:") ? raw.slice("hosted:".length) : HOSTED_PROVIDERS[0].id;
            const provider = HOSTED_PROVIDERS.find((p) => p.id === providerId) ?? HOSTED_PROVIDERS[0];
            form.dataset.onboardingMode = "hosted";
            aliasInput.value = provider.id;
            const existingKey = envByKey.get(provider.envKey);
            const alreadyConfigured = existingKey?.configured === true;
            apiKeyInput.required = !alreadyConfigured;
            apiKeyInput.placeholder = alreadyConfigured
                ? `${provider.envKey} (configured — leave empty to keep)`
                : provider.envKey;
            the(article, "onboarding-key-hint", alreadyConfigured
                ? `${provider.envKey} is already configured in the operator environment.`
                : `Saved write-only to ${provider.envKey} in the operator .env file.`);

            const matching = catalogModels.filter((m) => m.provider === provider.id);
            const choices = matching.length > 0
                ? matching.map((m) => ({ value: m.selector, label: m.modelName && m.modelName !== m.selector ? `${m.selector} — ${m.modelName}` : m.selector }))
                : [{ value: provider.fallbackSelector, label: provider.fallbackSelector }];
            $.cloneEach(modelSelect, "#onboarding-model-option", choices, (opt, item) => {
                the(opt, { "option-value": item.value, "option-label": item.label });
            });
            const preferredChoice = choices.find((c) => provider.preferred.test(c.value)) ?? choices[0];
            if (preferredChoice) {
                modelSelect.value = preferredChoice.value;
            }
        };

        on(form, "change", 'select[name="source"]', syncSourceSelection);
        on(form, "input", 'input[name="apiKey"]', () => {
            apiKeyInput.setCustomValidity("");
        });
        on(dialog, "click", "[data-dialog-close]", () => {
            activeLoad?.abort();
            apiKeyInput.value = "";
            dialog?.close();
        });

        on(form, "submit", "form", async (event) => {
            event.preventDefault();
            if (article.getAttribute("aria-busy") === "true") return;
            const ctx = getContext();
            const rawSource = sourceSelect.value;
            const alias = aliasInput.value.trim();
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(alias)) {
                aliasInput.setCustomValidity("Enter an alias using letters, digits, or underscores.");
                aliasInput.reportValidity();
                return;
            }
            aliasInput.setCustomValidity("");

            /** @type {Record<string, string | null>} */
            const updates = {};
            /** @type {string} */
            let chosenSelector;
            if (rawSource.startsWith("local:")) {
                const idx = Number.parseInt(rawSource.slice("local:".length), 10);
                const candidate = localCandidates[idx];
                if (!candidate) return;
                chosenSelector = candidate.selector;
                updates[`PLURNK_MODEL_${alias}`] = candidate.selector;
                updates[`PLURNK_BASEURL_${alias}`] = candidate.baseUrl ?? null;
                updates.PLURNK_MODEL = alias;
            } else {
                const providerId = rawSource.startsWith("hosted:") ? rawSource.slice("hosted:".length) : HOSTED_PROVIDERS[0].id;
                const provider = HOSTED_PROVIDERS.find((p) => p.id === providerId) ?? HOSTED_PROVIDERS[0];
                const secretValue = apiKeyInput.value.trim();
                apiKeyInput.value = "";
                const alreadyConfigured = envByKey.get(provider.envKey)?.configured === true;
                if (!secretValue && !alreadyConfigured) {
                    apiKeyInput.setCustomValidity(`Enter ${provider.envKey}.`);
                    apiKeyInput.reportValidity();
                    return;
                }
                chosenSelector = modelSelect.value || provider.fallbackSelector;
                if (secretValue) {
                    updates[provider.envKey] = secretValue;
                }
                updates[`PLURNK_MODEL_${alias}`] = chosenSelector;
                updates.PLURNK_MODEL = alias;
            }

            the(article, {
                "onboarding-busy": "true",
                "onboarding-status": "Saving configuration and verifying live model reply…",
                "onboarding-error": "",
                "onboarding-recovery": "",
                "onboarding-shadowed": "",
            });

            try {
                const envRes = await managementAction("service.env.set", { updates }, "", ctx.auth, ctx.signal);
                const configFile = isRecord(envRes) && typeof envRes.configFile === "string"
                    ? envRes.configFile
                    : "operator .env";
                const shadowedItems = isRecord(envRes) && Array.isArray(envRes.shadowed)
                    ? envRes.shadowed.filter(isRecord)
                    : [];
                const shadowedText = shadowedItems
                    .map((item) => typeof item.key === "string" && typeof item.overriddenBy === "string"
                        ? `${item.key} is overridden by ${item.overriddenBy}.`
                        : "")
                    .filter(Boolean)
                    .join(" ");

                if (isRecord(envRes) && Array.isArray(envRes.entries)) {
                    envByKey.clear();
                    for (const entry of envRes.entries) {
                        if (isRecord(entry) && typeof entry.key === "string") {
                            envByKey.set(entry.key, {
                                configured: Boolean(entry.configured),
                                overriddenBy: typeof entry.overriddenBy === "string" ? entry.overriddenBy : null,
                            });
                        }
                    }
                }

                // 1-turn live verification over ACP
                /** @type {string | null} */
                let verifySessionId = null;
                try {
                    const created = await managementAction("session/new", {
                        _meta: { plurnk: { session: `onboard-verify-${randomUUID().slice(0, 8)}` } },
                    }, "", ctx.auth, ctx.signal);
                    verifySessionId = isRecord(created) && typeof created.sessionId === "string" ? created.sessionId : null;
                    if (!verifySessionId) {
                        throw new Error("Verification session could not be created.");
                    }
                    await managementAction(
                        "session/set_config_option",
                        { configId: "model", value: alias },
                        verifySessionId,
                        ctx.auth,
                        ctx.signal,
                    );
                    const verifyAgent = new SessionAgent({ url: "/acp", sessionId: verifySessionId });
                    verifyAgent.headers = await accessHeaders(ctx.auth, ctx.signal);
                    const runController = new AbortController();
                    const offParentAbort = on.target(ctx.signal, "abort", () => runController.abort(ctx.signal.reason));
                    /** @type {string | undefined} */
                    let verifyError;
                    try {
                        const outcome = await verifyAgent.send({
                            abortController: runController,
                            message: { id: randomUUID(), role: "user", content: "Reply with OK." },
                        }, {
                            onError: ({ message }) => {
                                verifyError = message;
                            },
                        });
                        if (verifyError) throw new Error(verifyError);
                        if (outcome.stopReason === "error") {
                            throw new Error("Model verification failed.");
                        }
                    } finally {
                        offParentAbort();
                        verifyAgent.close();
                    }
                } finally {
                    if (verifySessionId) {
                        const cleanup = new AbortController();
                        await managementAction("session/delete", { sessionId: verifySessionId }, verifySessionId, ctx.auth, cleanup.signal).catch(() => {});
                    }
                }

                await ctx.onConfigured?.(alias);
                the(article, {
                    "onboarding-busy": null,
                    "onboarding-status": `Verified ${chosenSelector} (${alias}) and saved to ${configFile}.`,
                    "onboarding-error": "",
                    "onboarding-recovery": "",
                    "onboarding-shadowed": shadowedText,
                });
                if (!shadowedText && dialog?.open) {
                    dialog.close();
                }
            } catch (error) {
                const { message, recovery } = await describeFailure(error);
                the(article, {
                    "onboarding-busy": null,
                    "onboarding-status": "",
                    "onboarding-error": ctx.signal.aborted ? "Setup was interrupted." : message,
                    "onboarding-recovery": recovery,
                });
            }
        });

        /** @type {HTMLDialogElement & { _syncOnboarding?: () => void }} */ (dialog)._syncOnboarding = syncSourceSelection;
        return dialog;
    }

    async function open() {
        const modal = /** @type {HTMLDialogElement & { _syncOnboarding?: () => void }} */ (ensureDialog());
        const article = $(modal, "article");
        const sourceSelect = $(modal, 'select[name="source"]');
        const apiKeyInput = $(modal, 'input[name="apiKey"]');
        if (!article || !(sourceSelect instanceof HTMLSelectElement) || !(apiKeyInput instanceof HTMLInputElement)) {
            return;
        }
        apiKeyInput.value = "";
        the(article, {
            "onboarding-busy": "true",
            "onboarding-status": "Checking local inference servers and provider configuration…",
            "onboarding-error": "",
            "onboarding-recovery": "",
            "onboarding-shadowed": "",
            "onboarding-config-path": "",
        });
        if (!modal.open) modal.showModal();

        activeLoad?.abort();
        const request = activeLoad = new AbortController();
        const ctx = getContext();
        const signal = AbortSignal.any([ctx.signal, request.signal]);

        try {
            const [localRes, envRes, catalogRes] = await Promise.all([
                managementAction("models.local", {}, "", ctx.auth, signal).catch(() => ({ candidates: [] })),
                managementAction("service.env.list", {}, "", ctx.auth, signal),
                managementAction("models.list", { availability: "all", all: true, limit: 200 }, "", ctx.auth, signal).catch(() => ({ items: [] })),
            ]);
            signal.throwIfAborted();

            localCandidates = isRecord(localRes) && Array.isArray(localRes.candidates)
                ? localRes.candidates.filter((c) => isRecord(c) && typeof c.alias === "string" && typeof c.selector === "string" && typeof c.label === "string")
                    .map((c) => ({
                        id: typeof c.id === "string" ? c.id : String(c.selector),
                        label: String(c.label),
                        alias: String(c.alias),
                        selector: String(c.selector),
                        ...(typeof c.runtime === "string" ? { runtime: c.runtime } : {}),
                        ...(typeof c.baseUrl === "string" ? { baseUrl: c.baseUrl } : {}),
                    }))
                : [];

            envByKey.clear();
            const configFile = isRecord(envRes) && typeof envRes.configFile === "string" ? envRes.configFile : "";
            if (isRecord(envRes) && Array.isArray(envRes.entries)) {
                for (const entry of envRes.entries) {
                    if (isRecord(entry) && typeof entry.key === "string") {
                        envByKey.set(entry.key, {
                            configured: Boolean(entry.configured),
                            overriddenBy: typeof entry.overriddenBy === "string" ? entry.overriddenBy : null,
                        });
                    }
                }
            }

            catalogModels = isRecord(catalogRes) && Array.isArray(catalogRes.items)
                ? catalogRes.items.filter(isRecord).flatMap((m) =>
                    typeof m.selector === "string" && typeof m.provider === "string"
                        ? [{
                            selector: m.selector,
                            provider: m.provider,
                            modelName: typeof m.modelName === "string" ? m.modelName : m.selector,
                        }]
                        : [],
                )
                : [];

            const options = [
                ...localCandidates.map((loc, idx) => ({
                    value: `local:${idx}`,
                    label: `${loc.label} (Local)`,
                })),
                ...HOSTED_PROVIDERS.map((hp) => ({
                    value: `hosted:${hp.id}`,
                    label: `${hp.label} (${hp.envKey})${envByKey.get(hp.envKey)?.configured ? " — configured" : ""}`,
                })),
            ];
            $.cloneEach(sourceSelect, "#onboarding-source-option", options, (opt, item) => {
                the(opt, { "option-value": item.value, "option-label": item.label });
            });
            if (options[0]) sourceSelect.value = options[0].value;
            modal._syncOnboarding?.();
            the(article, {
                "onboarding-busy": null,
                "onboarding-status": "",
                "onboarding-config-path": configFile ? `Configuration file: ${configFile}` : "",
            });
        } catch (error) {
            if (request.signal.aborted) return;
            const { message, recovery } = await describeFailure(error);
            the(article, {
                "onboarding-busy": null,
                "onboarding-status": "",
                "onboarding-error": message,
                "onboarding-recovery": recovery,
            });
        }
    }

    return { open };
}
