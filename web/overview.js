import { $, on, the } from "on_the_money";
import { directoryPath } from "../src/directory-addresses.js";
import managementAction from "./management-action.js";
import { createOverviewRenderer } from "./overview-render.js";
import { createOverviewStore, isRecord } from "./overview-state.js";
import { subscribeWorkspaceNotifications } from "./workspace-notifications.js";

/**
 * {§web-search} {§web-session-directory} {§web-workspace-archive} {§web-session-archive}
 * Live workspace-grouped Search & Directory panel (`/settings/search`) powered exclusively by `/acp` + `/notifications`.
 * @param {HTMLElement} panel
 * @param {{
 *   readonly connectionTarget?: HTMLElement,
 *   readonly contextWorkspace?: string,
 *   readonly contextSession?: string | null,
 * }} [options]
 */
export default function observeOverview(panel, {
    connectionTarget = panel,
    contextWorkspace = "",
    contextSession = null,
} = {}) {
    const workspacesOutlet = $(panel, "#search-workspaces") ?? panel;
    const controlsForm = $(panel, "#search-controls");
    const searchInput = controlsForm ? $(controlsForm, "input[data-overview-search]") : null;
    const suggestionsList = controlsForm ? $(controlsForm, "#search-suggestions") : null;
    const wsField = controlsForm ? $(controlsForm, "[data-search-workspace]") : null;
    const statusSelect = controlsForm ? $(controlsForm, "select[data-overview-scope]") : null;
    const kindField = controlsForm ? $(controlsForm, "[data-search-kind]") : null;

    let resources = new AbortController();
    /** @type {AbortController | null} */
    let searchAbort = null;
    /** @type {unknown[]} */
    const inFlightNotifications = [];
    let disposed = false;

    const store = createOverviewStore();
    const renderer = createOverviewRenderer(workspacesOutlet, suggestionsList);

    const readFieldValue = (/** @type {Element | null} */ el, /** @type {string} */ fallback = "") =>
        el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el.value : fallback;

    let filterQuery = searchInput instanceof HTMLInputElement ? searchInput.value : "";
    let filterWorkspace = readFieldValue(wsField, "");
    let filterStatus = readFieldValue(statusSelect, "all");
    let filterKind = readFieldValue(kindField, "all");

    const currentFilters = () => ({
        filterQuery,
        filterWorkspace,
        filterStatus,
        filterKind,
    });

    function syncUrlQuery() {
        if (location.pathname !== "/settings/search") return;
        const params = new URLSearchParams();
        if (contextWorkspace) {
            params.set("workspace", contextWorkspace);
            if (contextSession) params.set("session", contextSession);
        }
        if (filterQuery.trim()) params.set("q", filterQuery.trim());
        if (filterWorkspace) params.set("filterWorkspace", filterWorkspace);
        if (filterStatus && filterStatus !== "all") params.set("status", filterStatus);
        if (filterKind && filterKind !== "all") params.set("kind", filterKind);
        const query = params.toString();
        const nextUrl = `${location.pathname}${query ? `?${query}` : ""}`;
        if (`${location.pathname}${location.search}` !== nextUrl) {
            history.replaceState(null, "", nextUrl);
        }
    }

    async function fetchAcpSearch() {
        searchAbort?.abort();
        searchAbort = null;
        inFlightNotifications.length = 0;
        const controller = new AbortController();
        searchAbort = controller;
        const signal = AbortSignal.any([resources.signal, controller.signal]);
        try {
            const loaded = await store.fetchSnapshot({
                filterQuery,
                filterWorkspace,
                filterStatus,
                filterKind,
                signal,
                isDisposed: () => disposed,
                takeBufferedNotifications: () => {
                    const buffered = inFlightNotifications.splice(0);
                    if (searchAbort === controller) searchAbort = null;
                    return buffered;
                },
                onResync: () => { void fetchAcpSearch(); },
            });
            if (loaded) {
                renderer.reconcileDom(store, currentFilters());
            }
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") return;
        } finally {
            if (searchAbort === controller) searchAbort = null;
        }
    }

    let unarchiveBusy = false;
    on(panel, "submit", "form[data-inline-unarchive]", (event, form) => {
        if (!(form instanceof HTMLFormElement)) return;
        event.preventDefault();
        if (unarchiveBusy) return;
        const kind = form.dataset.inlineUnarchive;
        const data = new FormData(form);
        const wsName = String(data.get("workspace") ?? "").trim();
        const sessName = String(data.get("session") ?? "").trim();
        if (!wsName) return;
        const wsEntry = [...store.workspacesById.values()].find(({ name }) => name === wsName);
        unarchiveBusy = true;
        void (async () => {
            try {
                if (kind === "workspace") {
                    await managementAction(
                        "workspace.archive",
                        { workspace: wsName, ...(wsEntry ? { workspaceId: wsEntry.id } : {}), archived: false },
                        "",
                        resources.signal,
                        { workspace: wsName, ...(wsEntry ? { workspaceId: wsEntry.id } : {}) },
                    );
                    location.assign(directoryPath({ kind: "workspace", workspace: wsName }) ?? "/settings/search");
                    return;
                }
                if (kind === "session" && sessName && wsEntry) {
                    if (wsEntry.archived) {
                        await managementAction(
                            "workspace.archive",
                            { workspaceId: wsEntry.id, archived: false },
                            "",
                            resources.signal,
                            { workspaceId: wsEntry.id },
                        );
                    }
                    await managementAction(
                        "session/unarchive",
                        {},
                        `${wsEntry.id}#${sessName}`,
                        resources.signal,
                    );
                    location.assign(directoryPath({ kind: "session", workspace: wsName, session: sessName }) ?? "/settings/search");
                }
            } finally {
                unarchiveBusy = false;
            }
        })();
    });

    if (controlsForm instanceof HTMLFormElement) {
        on(controlsForm, "submit", "form", (event) => {
            event.preventDefault();
            filterQuery = searchInput instanceof HTMLInputElement ? searchInput.value : "";
            filterWorkspace = readFieldValue(wsField, "");
            filterStatus = readFieldValue(statusSelect, "all");
            filterKind = readFieldValue(kindField, "all");
            syncUrlQuery();
            renderer.applyFilter(store, currentFilters());
            void fetchAcpSearch();
        });
        on(controlsForm, "input", "input[data-overview-search]", (_event, input) => {
            if (input instanceof HTMLInputElement) {
                filterQuery = input.value;
                syncUrlQuery();
                renderer.applyFilter(store, currentFilters());
                void fetchAcpSearch();
            }
        });
        on(controlsForm, "change", "select", (_event, select) => {
            if (!(select instanceof HTMLSelectElement)) return;
            filterWorkspace = readFieldValue(wsField, "");
            filterStatus = readFieldValue(statusSelect, "all");
            filterKind = readFieldValue(kindField, "all");
            syncUrlQuery();
            renderer.applyFilter(store, currentFilters());
            void fetchAcpSearch();
        });
    }

    void fetchAcpSearch();

    const notifications = subscribeWorkspaceNotifications({
        onStateChange: (state) => {
            if (!disposed) the(connectionTarget, "connection", state);
        },
        onNotification: (payload) => {
            if (disposed) return;
            if (searchAbort !== null && isRecord(payload) && payload.event !== "notifications/resync") {
                inFlightNotifications.push(payload);
            }
            if (store.applyNotification(payload, { filterStatus, onResync: () => { void fetchAcpSearch(); } })) {
                renderer.reconcileDom(store, currentFilters());
            }
        },
    });

    const offPageHide = on.target(window, "pagehide", () => {
        if (disposed) return;
        searchAbort?.abort();
        resources.abort();
    });
    const offPageShow = on.target(window, "pageshow", (event) => {
        if (disposed) return;
        if (event instanceof PageTransitionEvent && event.persisted) {
            resources = new AbortController();
            void fetchAcpSearch();
        }
    });

    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            offPageHide();
            offPageShow();
            notifications.unsubscribe();
            searchAbort?.abort();
            resources.abort();
        },
    };
}
