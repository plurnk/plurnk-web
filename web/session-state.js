import { $, $$, the } from "on_the_money";
import { directoryPath } from "../src/directory-addresses.js";
import { clocks, gauges, workspaceIdentity } from "./session-status.js";
import sessionDescendants from "./session-descendants.js";

/** {§web-session-status} {§web-session-identity} Project the SDK's state; retain no separate daemon state.
 * @param {HTMLElement} element
 */
export default function sessionState(element) {
    const { sessionId, sessionName } = element.dataset;
    if (!sessionId || !sessionName) throw new Error("Session identity is incomplete.");
    const breadcrumb = $("#session-workspace");
    const folder = $("#session-folder");
    const connectionNotice = $("#session-connection");
    if (!breadcrumb || !folder || !connectionNotice) throw new Error("Session status document is incomplete.");
    const presentDescendants = sessionDescendants(element);
    /** @param {{plurnk?: Partial<import("@plurnk/plurnk-acp/client").AcpPlusState["plurnk"]> & {budget?: import("@plurnk/plurnk-acp/client").AcpBudgetState}, budget?: import("@plurnk/plurnk-acp/client").AcpBudgetState}} state
     * @param {number} now
     */
    return (state, now) => {
        const { workspace, status } = state.plurnk ?? {};
        if (workspace) {
            if (`${workspace.id}#${sessionName}` !== sessionId) throw new Error("Session state identifies a different workspace.");
            const identity = workspaceIdentity(workspace, sessionName);
            the("page-title", identity.pageTitle);
            the(breadcrumb, {
                workspaceName: identity.workspaceName, workspacePath: identity.workspacePath,
                workspaceIcon: identity.workspaceIcon, workspaceIconLabel: identity.workspaceIconLabel,
            });
            the(folder, "project-label", identity.projectLabel);
            the(connectionNotice, { sessionPath: identity.sessionPath, signInPath: `/auth/login?return=${encodeURIComponent(identity.sessionPath)}` });
            for (const link of $$("main a[data-session-name]")) {
                const session = /** @type {HTMLAnchorElement} */ (link).dataset.sessionName;
                if (!session) throw new Error("Session navigation has no identity.");
                the(link, "session-path", directoryPath({ kind: "session", workspace: workspace.name, session }));
            }
            the(element, {
                preparation: workspace.preparation.map(({ family, alias, phase }) => `${phase} ${family}${alias ? `/${alias}` : ""}`).join("; "),
                activity: workspace.activity ? `${workspace.activity.phase}${workspace.activity.percent === null ? "" : ` ${workspace.activity.percent}%`}` : "",
                activityMessage: workspace.activity?.message ?? "",
            });
        }
        if (status) {
            if (!workspace) throw new Error("Session state has no workspace identity.");
            the(element, { ...gauges(status, state.budget ?? state.plurnk?.budget), ...clocks(status, now) });
            presentDescendants(status.descendants, workspace.name);
        }
    };
}
