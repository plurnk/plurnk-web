import { $, on, the } from "on_the_money";
import { DEFAULT_SESSION_NAME, directoryPath, nextSequentialName } from "../src/directory-addresses.js";
import { allowProjectFolder } from "./endpoints.js";
import describeFailure from "./failure.js";
import managementAction from "./management-action.js";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @typedef {{
 *   readonly id: number,
 *   readonly name: string,
 *   readonly project_root: string | null,
 *   readonly project_label: string | null,
 *   readonly archived_at: string | null,
 * }} WorkspaceSummary
 */

/**
 * Normalize a `workspace.list` `/acp` response into `WorkspaceSummary[]`.
 * @param {unknown} raw
 * @returns {WorkspaceSummary[]}
 */
export function parseWorkspaceList(raw) {
    const list = isRecord(raw) && Array.isArray(raw.workspaces) ? raw.workspaces : [];
    /** @type {WorkspaceSummary[]} */
    const out = [];
    for (const item of list) {
        if (!isRecord(item) || typeof item.id !== "number" || typeof item.name !== "string" || item.name === "") continue;
        const projectRoot = typeof item.project_root === "string"
            ? item.project_root
            : typeof item.projectRoot === "string"
                ? item.projectRoot
                : null;
        const projectLabel = typeof item.project_label === "string"
            ? item.project_label
            : typeof item.projectLabel === "string"
                ? item.projectLabel
                : null;
        const archivedAt = typeof item.archived_at === "string"
            ? item.archived_at
            : typeof item.archivedAt === "string"
                ? item.archivedAt
                : null;
        out.push({
            id: item.id,
            name: item.name,
            project_root: projectRoot,
            project_label: projectLabel,
            archived_at: archivedAt,
        });
    }
    return out;
}

/**
 * {§web-page-shell} Populate `#dialog-workspaces` with unarchived workspaces and archived count.
 * @param {readonly WorkspaceSummary[]} allWorkspaces
 * @param {string | null} currentWorkspaceName
 */
export function renderWorkspacesDialog(allWorkspaces, currentWorkspaceName = null) {
    const dialog = $("#dialog-workspaces");
    if (!(dialog instanceof HTMLElement)) return;
    const list = $(dialog, "[data-workspaces-list]");
    const empty = $(dialog, "[data-workspaces-empty]");
    const unarchived = allWorkspaces.filter(({ archived_at }) => archived_at === null);
    const archivedCount = allWorkspaces.length - unarchived.length;
    the(dialog, "archived-workspaces-count", String(archivedCount));

    if (list instanceof HTMLUListElement) {
        if (unarchived.length === 0) {
            list.replaceChildren();
            list.hidden = true;
            if (empty instanceof HTMLElement) empty.hidden = false;
        } else {
            list.hidden = false;
            if (empty instanceof HTMLElement) empty.hidden = true;
            $.cloneEach(list, "#workspace-list-item", unarchived, (li, ws) => {
                const link = $(li, "a");
                const glyphEl = $(li, "[data-workspace-item-glyph]");
                const nameEl = $(li, "[data-workspace-item-name]");
                const effectiveProject = ws.project_label ?? ws.project_root;
                const separateFolder = ws.project_label !== null && ws.project_label !== ws.name;
                if (glyphEl) glyphEl.textContent = effectiveProject !== null ? "🗂️" : "☁️";
                if (nameEl) nameEl.textContent = ws.name;
                const path = directoryPath({ kind: "workspace", workspace: ws.name });
                if (link instanceof HTMLAnchorElement) {
                    if (path !== null) link.href = path;
                    else link.removeAttribute("href");
                    if (ws.name === currentWorkspaceName) link.setAttribute("aria-current", "page");
                    else link.removeAttribute("aria-current");
                    const existingTag = $(link, "[data-workspace-item-project]");
                    existingTag?.remove();
                    if (separateFolder && ws.project_label !== null) {
                        link.append(" ");
                        const tag = $.clone(link, "#workspace-project-tag");
                        if (tag) tag.textContent = ws.project_label;
                    }
                }
            });
        }
    }
}

/**
 * {§web-workspace-creation} Wire `#dialog-workspace-create` (`form#workspace-create`) to create workspaces and a starter `session1` over `/acp`.
 * @param {{
 *   signal: AbortSignal,
 *   getKnownWorkspaceNames?: () => Iterable<string>,
 *   navigate?: (url: string) => void,
 * }} options
 */
export function wireWorkspaceCreateDialog({
    signal,
    getKnownWorkspaceNames,
    navigate = (url) => { location.assign(url); },
}) {
    const dialog = $("#dialog-workspace-create");
    if (!(dialog instanceof HTMLElement)) return () => {};

    if (!allowProjectFolder()) {
        $(dialog, "[data-project-folder-toggle]")?.remove();
        $(dialog, "[data-project-folder-input]")?.remove();
    }

    let busy = false;
    return on(dialog, "submit", "form#workspace-create", (event, form) => {
        if (!(form instanceof HTMLFormElement)) return;
        event.preventDefault();
        if (busy) return;
        the(dialog, "workspace-create-error", "");
        const data = new FormData(form);
        const rawName = String(data.get("name") ?? "").trim();
        const useProjectFolder = data.get("useProjectFolder") === "1";
        const rawProjectRoot = String(data.get("projectRoot") ?? "").trim();

        if (!allowProjectFolder() && (useProjectFolder || rawProjectRoot !== "")) {
            the(dialog, "workspace-create-error", "Project folder workspaces are disabled on this web interface.");
            return;
        }
        if (useProjectFolder && rawProjectRoot === "") {
            the(dialog, "workspace-create-error", "Enter a project folder path.");
            return;
        }

        const projectRoot = useProjectFolder ? rawProjectRoot : (rawProjectRoot !== "" ? rawProjectRoot : null);
        busy = true;
        void (async () => {
            try {
                /** @type {unknown} */
                let created;
                if (rawName === "" && projectRoot === null) {
                    const initialNames = new Set(getKnownWorkspaceNames ? getKnownWorkspaceNames() : []);
                    if (initialNames.size === 0) {
                        const listed = await managementAction("workspace.list", { includeArchived: true }, "", signal).catch(() => null);
                        for (const ws of parseWorkspaceList(listed)) initialNames.add(ws.name);
                    }
                    for (let attempt = 0; attempt < 8; attempt += 1) {
                        const candidate = nextSequentialName("workspace", initialNames);
                        try {
                            created = await managementAction("workspace.create", { name: candidate, projectRoot: null }, "", signal);
                            break;
                        } catch (error) {
                            if (Reflect.get(Object(error), "status") === 409 && attempt < 7) {
                                initialNames.add(candidate);
                                continue;
                            }
                            throw error;
                        }
                    }
                } else {
                    created = await managementAction("workspace.create", {
                        ...(rawName === "" ? {} : { name: rawName }),
                        projectRoot,
                    }, "", signal);
                }

                const wsName = isRecord(created) && typeof created.workspaceName === "string" && created.workspaceName !== ""
                    ? created.workspaceName
                    : rawName;
                if (!wsName) {
                    throw new Error("The daemon returned no workspace name.");
                }

                let sessionName = DEFAULT_SESSION_NAME;
                try {
                    const createdSession = await managementAction("session/new", {
                        _meta: { plurnk: { workspace: wsName, sessionName: DEFAULT_SESSION_NAME } },
                    }, "", signal);
                    const rawSessionId = isRecord(createdSession) && typeof createdSession.sessionId === "string"
                        ? createdSession.sessionId
                        : "";
                    if (rawSessionId.includes("#")) {
                        sessionName = rawSessionId.split("#")[1] || DEFAULT_SESSION_NAME;
                    }
                } catch {
                    const wsOnly = directoryPath({ kind: "workspace", workspace: wsName });
                    if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close();
                    navigate(wsOnly ?? "/");
                    return;
                }

                const target = directoryPath({ kind: "session", workspace: wsName, session: sessionName })
                    ?? directoryPath({ kind: "workspace", workspace: wsName })
                    ?? "/";
                if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close();
                navigate(target);
            } catch (error) {
                const { message, recovery } = await describeFailure(error);
                the(dialog, "workspace-create-error", [message, recovery].filter(Boolean).join(" "));
            } finally {
                busy = false;
            }
        })();
    });
}
