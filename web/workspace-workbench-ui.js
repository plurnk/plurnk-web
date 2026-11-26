import { $, $$, on, the } from "on_the_money";
import { settingsPath } from "../src/directory-addresses.js";
import {
    computeOrderedUnarchived,
    isUntouchedDraftWorkbenchSession,
    isVisibleInTabStrip,
} from "./workspace-workbench-state.js";

/** @typedef {import("./workspace-workbench-state.js").WorkbenchSession} WorkbenchSession */

/**
 * {§web-workspace-tabs} {§web-session-creation}
 * Bottom tab strip (`#workspace-tabs`) and workbench keyboard shortcuts (`Alt+1…9`, `Alt+[/]`, `Alt+N`).
 * @param {{
 *   readonly tabs: HTMLElement,
 *   readonly tabsList: HTMLUListElement,
 *   readonly sessionsById: Map<number, WorkbenchSession>,
 *   readonly getWorkspaceId: () => number,
 *   readonly getWorkspaceName: () => string,
 *   readonly getSelectedSessionName: () => string | null,
 *   readonly onSyncHeaderPlace: () => void,
 *   readonly onSelectSession: (sessionName: string, options: { updateHistory: "push" | "replace" | "none" }) => Promise<void>,
 * }} host
 */
export function createWorkbenchTabs({
    tabs,
    tabsList,
    sessionsById,
    getWorkspaceId,
    getWorkspaceName,
    getSelectedSessionName,
    onSyncHeaderPlace,
    onSelectSession,
}) {
    function newSessionHref() {
        const currentWorkspaceName = getWorkspaceName();
        const selectedSessionName = getSelectedSessionName();
        return settingsPath("sessions", {
            workspace: currentWorkspaceName || null,
            session: selectedSessionName,
            extra: { new: "1" },
        }) ?? "/settings/sessions?new=1";
    }

    function reconcileTabs() {
        const workspaceId = getWorkspaceId();
        const currentWorkspaceName = getWorkspaceName();
        const selectedSessionName = getSelectedSessionName();
        tabs.dataset.workspaceName = currentWorkspaceName;
        the(tabs, "new-session-path", newSessionHref());
        onSyncHeaderPlace();

        const orderedUnarchived = computeOrderedUnarchived(sessionsById);
        const childParents = new Set(orderedUnarchived.flatMap(({ parentSessionId }) => parentSessionId === null ? [] : [parentSessionId]));
        const visible = orderedUnarchived.filter((entry) =>
            isVisibleInTabStrip(entry, selectedSessionName, isUntouchedDraftWorkbenchSession(entry, childParents.has(entry.id))));
        if (selectedSessionName !== null && !visible.some(({ name }) => name === selectedSessionName)) {
            const direct = [...sessionsById.values()].find(({ name }) => name === selectedSessionName);
            if (direct) visible.push(direct);
        }

        $.reconcile(tabsList, "#workspace-tab-item", visible, {
            attr: "data-tab-id",
            key: (session) => `${workspaceId}:${session.id}`,
            fill(row, session) {
                if (!(row instanceof HTMLLIElement)) return;
                const sessionHash = `#${encodeURIComponent(session.name)}`;
                const isDraft = isUntouchedDraftWorkbenchSession(session, childParents.has(session.id));
                const titleText = typeof session.title === "string" && session.title.trim() !== "" ? session.title.trim() : null;
                row.dataset.sessionKind = session.kind;
                if (isDraft) row.dataset.tabDraft = "true";
                else delete row.dataset.tabDraft;
                if (titleText !== null) row.dataset.sessionTitle = titleText;
                else delete row.dataset.sessionTitle;
                if (session.parentSessionId !== null) row.dataset.parentId = String(session.parentSessionId);
                else delete row.dataset.parentId;
                if (session.replyId !== null) row.dataset.replyId = String(session.replyId);
                else delete row.dataset.replyId;
                if (session.archived) row.dataset.archived = "true";
                else delete row.dataset.archived;

                const link = $(row, 'a[data-workspace-route="session"]');
                if (link instanceof HTMLAnchorElement) {
                    link.dataset.tabSession = session.name;
                    const nextHref = session.name === selectedSessionName
                        ? (settingsPath("sessions", { workspace: currentWorkspaceName, session: session.name }) ?? sessionHash)
                        : sessionHash;
                    if (link.getAttribute("href") !== nextHref) link.setAttribute("href", nextHref);
                    const hoverTitle = titleText !== null
                        ? `${titleText} (#${session.name} · ${session.lifecycle})`
                        : `#${session.name} (${session.lifecycle})`;
                    if (link.getAttribute("title") !== hoverTitle) link.setAttribute("title", hoverTitle);
                    if (session.name === selectedSessionName) link.setAttribute("aria-current", "true");
                    else link.removeAttribute("aria-current");

                    const lifecycleEl = $(link, "[data-lifecycle]");
                    if (lifecycleEl && lifecycleEl.getAttribute("data-lifecycle") !== session.lifecycle) {
                        lifecycleEl.setAttribute("data-lifecycle", session.lifecycle);
                    }
                    const labelEl = $(link, "[data-tab-label]");
                    const tabText = titleText ?? `#${session.name}`;
                    if (labelEl && labelEl.textContent !== tabText) labelEl.textContent = tabText;

                    let gatesBadge = $(link, "[data-session-gates]");
                    if (session.gates > 0) {
                        gatesBadge ??= $.clone(link, "#session-gates-badge");
                        const gateLabel = `${session.gates} awaiting input`;
                        gatesBadge.setAttribute("data-session-gates", String(session.gates));
                        gatesBadge.setAttribute("aria-label", gateLabel);
                        gatesBadge.setAttribute("title", gateLabel);
                        if (gatesBadge.textContent !== String(session.gates)) gatesBadge.textContent = String(session.gates);
                    } else {
                        gatesBadge?.remove();
                    }
                }
            },
        });

        tabs.dataset.tabCount = String(visible.length);
    }

    on.target(window, "keydown", (rawEvent) => {
        if (!(rawEvent instanceof KeyboardEvent) || rawEvent.defaultPrevented || rawEvent.isComposing || rawEvent.repeat) return;
        if ($("dialog[open]")) return;

        const altOnly = rawEvent.altKey && !rawEvent.ctrlKey && !rawEvent.metaKey && !rawEvent.shiftKey;
        if (!altOnly) return;

        const digitMatch = /^Digit([1-9])$/u.exec(rawEvent.code);
        if (digitMatch) {
            const links = /** @type {HTMLAnchorElement[]} */ ($$(tabsList, ":scope > li:not([hidden]) > a[data-workspace-route]"));
            const digit = Number(digitMatch[1]);
            const targetIndex = digit === 9 && links.length > 9 ? links.length - 1 : digit - 1;
            const targetLink = links[targetIndex];
            const target = targetLink?.dataset.tabSession;
            if (target) {
                rawEvent.preventDefault();
                void onSelectSession(target, { updateHistory: "push" });
            }
            return;
        }

        if (rawEvent.code === "BracketLeft" || rawEvent.code === "BracketRight") {
            const links = /** @type {HTMLAnchorElement[]} */ ($$(tabsList, ":scope > li:not([hidden]) > a[data-workspace-route]"));
            if (links.length <= 1) return;
            rawEvent.preventDefault();
            const currentIndex = links.findIndex((link) => link.getAttribute("aria-current") === "true");
            const delta = rawEvent.code === "BracketRight" ? 1 : -1;
            const nextIndex = ((currentIndex < 0 ? 0 : currentIndex) + delta + links.length) % links.length;
            const target = links[nextIndex]?.dataset.tabSession;
            if (target) void onSelectSession(target, { updateHistory: "push" });
            return;
        }

        if (rawEvent.code === "KeyN") {
            if (tabs.dataset.workspaceArchived !== "true") {
                rawEvent.preventDefault();
                location.assign(newSessionHref());
            }
        }
    });

    return {
        reconcileTabs,
        newSessionHref,
    };
}
