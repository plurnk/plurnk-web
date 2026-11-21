import { $, $$, the } from "on_the_money";
import { directoryPath } from "../src/directory-addresses.js";
import { clocks, gauges, workspaceIdentity } from "./session-status.js";
import sessionDescendants from "./session-descendants.js";

/** {§web-session-status} {§web-session-identity} Project the SDK's state; retain no separate daemon state.
 * @param {HTMLElement} element
 * @param {Element | null} [main]
 */
export default function sessionState(element, main = $("#main")) {
    const { sessionId, sessionName } = element.dataset;
    if (!sessionId || !sessionName) throw new Error("Session identity is incomplete.");
    const folder = main instanceof HTMLElement ? $(main, "#session-folder") : null;
    const connectionNotice = main instanceof HTMLElement ? $(main, "#session-connection") : null;
    if (!(main instanceof HTMLElement) || !folder || !connectionNotice || (main.isConnected && !$("#session-workspace"))) {
        throw new Error("Session status document is incomplete.");
    }
    const presentDescendants = sessionDescendants(element);
    /** @type {ReturnType<typeof workspaceIdentity> | null} */
    let latestIdentity = null;
    const syncHeader = () => {
        if (!latestIdentity || !main.isConnected || element.hidden) return;
        the("page-title", latestIdentity.pageTitle);
        const wsControl = $("#session-workspace");
        if (wsControl) {
            the(wsControl, {
                "workspace-name": latestIdentity.workspaceName,
                "workspace-path": latestIdentity.workspacePath,
                "workspace-icon": latestIdentity.workspaceIcon,
                "workspace-icon-label": latestIdentity.workspaceIconLabel,
            });
        }
        const sessionControl = $("#header-session");
        if (sessionControl) {
            the(sessionControl, "active-session-name", sessionName);
        }
        for (const el of $$('[data-text="active-session-name"]')) {
            if (el.textContent !== sessionName) el.textContent = sessionName;
        }
        for (const input of $$('input[name="workspace"]')) {
            if (input instanceof HTMLInputElement && input.type === "hidden") {
                input.value = latestIdentity.workspaceName;
            }
        }
        for (const input of $$('input[name="session"]')) {
            if (input instanceof HTMLInputElement && input.type === "hidden") {
                input.value = sessionName;
            }
        }
    };
    /** @param {{plurnk?: Partial<import("@plurnk/plurnk-acp/client").AcpPlusState["plurnk"]> & {budget?: import("@plurnk/plurnk-acp/client").AcpBudgetState, configOptions?: readonly {configId?: string, currentValue?: unknown}[]}, budget?: import("@plurnk/plurnk-acp/client").AcpBudgetState}} state
     * @param {number} now
     */
    const present = (state, now) => {
        const { workspace, status, providers, configOptions } = state.plurnk ?? {};
        if (workspace) {
            if (`${workspace.id}#${sessionName}` !== sessionId) throw new Error("Session state identifies a different workspace.");
            const identity = workspaceIdentity(workspace, sessionName);
            latestIdentity = identity;
            syncHeader();
            the(folder, "project-label", identity.projectLabel);
            the(connectionNotice, { "session-path": identity.sessionPath, "sign-in-path": `/auth/login?return=${encodeURIComponent(identity.sessionPath)}` });
            for (const link of $$(main, "a[data-session-name]")) {
                const session = /** @type {HTMLAnchorElement} */ (link).dataset.sessionName;
                if (!session) throw new Error("Session navigation has no identity.");
                the(link, "session-path", directoryPath({ kind: "session", workspace: workspace.name, session }));
            }
            the(element, {
                preparation: workspace.preparation.map(({ family, alias, phase }) => `${phase} ${family}${alias ? `/${alias}` : ""}`).join("; "),
                activity: workspace.activity ? `${workspace.activity.phase}${workspace.activity.percent === null ? "" : ` ${workspace.activity.percent}%`}` : "",
                "activity-message": workspace.activity?.message ?? "",
            });
        }
        if (status) {
            if (!workspace) throw new Error("Session state has no workspace identity.");
            the(element, { ...gauges(status, state.budget ?? state.plurnk?.budget, { providers, configOptions }), ...clocks(status, now) });
            presentDescendants(status.descendants, workspace.name);
        }
    };
    present.syncHeader = syncHeader;
    return present;
}
