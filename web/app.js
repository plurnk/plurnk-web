// {§web-document} One OTM boot; localStorage holds only plurnk_oidc_grant when OIDC is active.
import { $, on, the } from "on_the_money";
import initDialogs from "./dialogs.js";
import { formatPageTitle, isModuleDocument } from "./endpoints.js";
import {
    completeOidcCallback,
    hasActiveOidcGrant,
    onOidcGrantChange,
    recoverFromUnauthorized,
    signOut,
} from "./oidc.js";

await the.boot({
    locale: "en",
    defaultLocale: "en",
    persistKeys: [],
});

initDialogs();

on(document.body, "click", '[data-action="sign-out"]', () => {
    signOut();
});

on(document.body, "click", '[data-action="sign-in"]', (_event, target) => {
    const returnTo = target instanceof HTMLElement
        ? (target.getAttribute("data-return-path") || undefined)
        : undefined;
    void recoverFromUnauthorized({ returnTo, redirectOnDiscovery: true });
});

const main = $("#main");
const page = main ? the(main, "page") : null;
const isArrivalHome = page === "home" && location.pathname === "/" && isModuleDocument();
const isActiveAppView = page === "session"
    || page === "workspace"
    || page === "search"
    || page === "settings"
    || page === "callback"
    || isArrivalHome;

function syncSignOutControl() {
    const navList = $('header nav[aria-label="Main navigation"] > ul');
    if (!(navList instanceof HTMLUListElement)) return;
    const existing = $(navList, "[data-oidc-sign-out]");
    if (hasActiveOidcGrant()) {
        if (!existing) $.clone(navList, "#oidc-sign-out-item");
    } else {
        existing?.remove();
    }
}

if (isActiveAppView) {
    syncSignOutControl();
    onOidcGrantChange(syncSignOutControl);
}

// {§web-page-shell} Global Ctrl/Cmd+K jumps to /search/ unless the workspace session switcher claims it.
on.target(window, "keydown", (rawEvent) => {
    if (!(rawEvent instanceof KeyboardEvent) || rawEvent.defaultPrevented || rawEvent.isComposing || rawEvent.repeat) return;
    const modOnly = (rawEvent.metaKey !== rawEvent.ctrlKey) && !rawEvent.altKey && !rawEvent.shiftKey;
    if (!modOnly || (rawEvent.code !== "KeyK" && rawEvent.key.toLowerCase() !== "k")) return;
    if ($("dialog[open]")) return;
    if ($("#workspace-tabs")) return;
    const currentMain = $("#main");
    if (currentMain && the(currentMain, "page") === "search") {
        const input = $(currentMain, "input[data-overview-search]");
        if (input instanceof HTMLInputElement) {
            rawEvent.preventDefault();
            input.focus();
            input.select();
        }
        return;
    }
    rawEvent.preventDefault();
    location.assign("/search/");
});

if (main instanceof HTMLElement && isArrivalHome) {
    const { default: resolveArrival } = await import("./arrival.js");
    await resolveArrival(main);
} else if (main instanceof HTMLElement && page === "callback") {
    const callbackCard = $(main, "#auth-callback");
    const result = await completeOidcCallback();
    if (!result.ok && callbackCard instanceof HTMLElement) {
        the("page-title", formatPageTitle("Sign-in failed"));
        the(callbackCard, {
            "callback-title": "⚠️ Sign-in failed",
            "callback-message": result.message,
        });
        const footer = $(callbackCard, "[data-callback-footer]");
        if (footer instanceof HTMLElement) footer.hidden = false;
    }
} else if (page === "session" || page === "workspace") {
    const tabs = $("#workspace-tabs");
    if (tabs instanceof HTMLElement) {
        const { default: observeWorkspaceWorkbench } = await import("./workspace-workbench.js");
        await observeWorkspaceWorkbench(tabs);
    } else if (page === "session") {
        const status = $("#session-status");
        if (status instanceof HTMLElement) {
            const { default: observeSession } = await import("./session.js");
            observeSession(status);
        }
    }
} else if (main instanceof HTMLElement && page === "search") {
    const { default: observeOverview } = await import("./overview.js");
    observeOverview(main);
} else if (main instanceof HTMLElement && page === "settings") {
    const { default: observeWorkspaceSettings } = await import("./workspace-settings.js");
    await observeWorkspaceSettings(main);
}
