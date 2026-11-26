import { $, on } from "on_the_money";
import { DEFAULT_SESSION_NAME, directoryPath, nextSequentialName } from "../src/directory-addresses.js";
import { syncProjectFolderField } from "./dialogs.js";
import { daemonPolicy, onDaemonPolicy } from "./endpoints.js";
import managementAction from "./management-action.js";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @typedef {{
 *   readonly workspaceId: number,
 *   readonly workspaceName: string,
 *   readonly sessionName: string | null,
 *   readonly hasProjectRoot?: boolean | null,
 *   readonly signal: AbortSignal,
 * }} WorkspaceSettingsContext
 */

/**
 * @typedef {{
 *   readonly id: number,
 *   readonly name: string,
 *   readonly projectRoot: string | null,
 *   readonly projectLabel: string | null,
 *   readonly archivedAt: string | null,
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
        const projectRoot = typeof item.projectRoot === "string" ? item.projectRoot : null;
        const projectLabel = typeof item.projectLabel === "string" ? item.projectLabel : null;
        const archivedAt = typeof item.archivedAt === "string" ? item.archivedAt : null;
        out.push({
            id: item.id,
            name: item.name,
            projectRoot,
            projectLabel,
            archivedAt,
        });
    }
    return out;
}

/**
 * {§web-workspace-creation} Wire the inline `form#workspace-create` inside `/settings/workspaces` to create workspaces and a starter `session1` over `/acp`.
 * @param {HTMLElement} container
 * @param {{
 *   readonly signal: AbortSignal,
 *   readonly getKnownWorkspaceNames?: () => Iterable<string>,
 *   readonly runMutation: (work: (signal: AbortSignal) => Promise<string>) => Promise<void>,
 *   readonly navigate?: (url: string) => void,
 * }} options
 */
export function wireWorkspaceCreateForm(container, {
    signal,
    getKnownWorkspaceNames,
    runMutation,
    navigate = (url) => { location.assign(url); },
}) {
    const formEl = $(container, "form#workspace-create");
    if (!(formEl instanceof HTMLFormElement)) return () => {};
    syncProjectFolderField(formEl);

    const applyProjectRootPolicy = (/** @type {import("./endpoints.js").DaemonPolicy | null} */ policy) => {
        const mode = policy?.projectRoot ?? "unrestricted";
        formEl.dataset.projectRootPolicy = mode;
        const toggleLabel = $(formEl, "[data-project-folder-toggle]");
        const toggleInput = $(formEl, "[data-toggle-project-folder]");
        const rootInput = $(formEl, "[data-project-folder-input]");
        const noteEl = $(formEl, "[data-project-folder-note]");
        if (mode === "none") {
            if (toggleLabel instanceof HTMLElement) toggleLabel.hidden = true;
            if (toggleInput instanceof HTMLInputElement) toggleInput.checked = false;
            if (rootInput instanceof HTMLInputElement) {
                rootInput.hidden = true;
                rootInput.value = "";
            }
            if (noteEl instanceof HTMLElement) {
                noteEl.hidden = true;
                noteEl.textContent = "";
            }
        } else {
            if (toggleLabel instanceof HTMLElement) toggleLabel.hidden = false;
            if (rootInput instanceof HTMLInputElement) {
                rootInput.hidden = false;
                rootInput.placeholder = mode === "confined"
                    ? "Path inside configured workspace directory"
                    : "/path/to/project";
            }
            if (noteEl instanceof HTMLElement) {
                if (mode === "confined") {
                    noteEl.hidden = false;
                    noteEl.textContent = "Paths must stay inside the daemon's configured workspace directory.";
                } else {
                    noteEl.hidden = true;
                    noteEl.textContent = "";
                }
            }
        }
        syncProjectFolderField(formEl);
    };
    applyProjectRootPolicy(daemonPolicy());
    const offPolicy = onDaemonPolicy((policy) => { applyProjectRootPolicy(policy); });
    on.target(signal, "abort", () => { offPolicy(); });

    const offSubmit = on(container, "submit", "form#workspace-create", (event, form) => {
        if (!(form instanceof HTMLFormElement)) return;
        event.preventDefault();
        const data = new FormData(form);
        const rawName = String(data.get("name") ?? "").trim();
        const useProjectFolder = data.get("useProjectFolder") === "1";
        const rawProjectRoot = String(data.get("projectRoot") ?? "").trim();

        void runMutation(async (mutSignal) => {
            if (daemonPolicy()?.projectRoot === "none" && (useProjectFolder || rawProjectRoot !== "")) {
                throw new Error("Project folder workspaces are disabled by daemon policy.");
            }
            if (useProjectFolder && rawProjectRoot === "") {
                throw new Error("Enter a project folder path.");
            }
            const projectRoot = useProjectFolder ? rawProjectRoot : (rawProjectRoot !== "" ? rawProjectRoot : null);

            /** @type {unknown} */
            let created;
            if (rawName === "" && projectRoot === null) {
                const initialNames = new Set(getKnownWorkspaceNames ? getKnownWorkspaceNames() : []);
                if (initialNames.size === 0) {
                    const listed = await managementAction("workspace.list", { includeArchived: true }, "", mutSignal).catch(() => null);
                    for (const ws of parseWorkspaceList(listed)) initialNames.add(ws.name);
                }
                for (let attempt = 0; attempt < 8; attempt += 1) {
                    const candidate = nextSequentialName("workspace", initialNames);
                    try {
                        created = await managementAction("workspace.create", { name: candidate, projectRoot: null }, "", mutSignal);
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
                }, "", mutSignal);
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
                }, "", mutSignal);
                const rawSessionId = isRecord(createdSession) && typeof createdSession.sessionId === "string"
                    ? createdSession.sessionId
                    : "";
                if (rawSessionId.includes("#")) {
                    sessionName = rawSessionId.split("#")[1] || DEFAULT_SESSION_NAME;
                }
            } catch {
                const wsOnly = directoryPath({ kind: "workspace", workspace: wsName });
                navigate(wsOnly ?? "/");
                return `Created workspace ${wsName}.`;
            }

            const target = directoryPath({ kind: "session", workspace: wsName, session: sessionName })
                ?? directoryPath({ kind: "workspace", workspace: wsName })
                ?? "/";
            navigate(target);
            return `Created workspace ${wsName}.`;
        });
    });

    return () => {
        offPolicy();
        offSubmit();
    };
}
