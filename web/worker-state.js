import { $, $$, the } from "on_the_money";
import { directoryPath } from "../ai.plurnk/directory-addresses.js";
import { clocks, gauges, workspaceIdentity } from "./worker-status.js";
import workerDescendants from "./worker-descendants.js";

/** {§web-worker-status} {§web-worker-identity} Project the SDK's state; retain no separate daemon state.
 * @param {HTMLElement} element
 */
export default function workerState(element) {
    const { threadId, workerName } = element.dataset;
    if (!threadId || !workerName) throw new Error("Worker identity is incomplete.");
    const breadcrumb = $("#worker-workspace");
    const folder = $("#worker-folder");
    const connectionNotice = $("#worker-connection");
    if (!breadcrumb || !folder || !connectionNotice) throw new Error("Worker status document is incomplete.");
    const presentDescendants = workerDescendants(element);
    /** @param {{plurnk?: import("@plurnk/plurnk-agui/client").AguiPlusState, budget?: import("@plurnk/plurnk-agui/client").AguiBudgetState}} state
     * @param {number} now
     */
    return (state, now) => {
        const { workspace, status } = state.plurnk ?? {};
        if (workspace) {
            if (`${workspace.id}#${workerName}` !== threadId) throw new Error("Worker state identifies a different workspace.");
            const identity = workspaceIdentity(workspace, workerName);
            the("page-title", identity.pageTitle);
            the(breadcrumb, {
                workspaceName: identity.workspaceName, workspacePath: identity.workspacePath,
                workspaceIcon: identity.workspaceIcon, workspaceIconLabel: identity.workspaceIconLabel,
            });
            the(folder, "project-label", identity.projectLabel);
            the(connectionNotice, { workerPath: identity.workerPath, signInPath: `/auth/login?return=${encodeURIComponent(identity.workerPath)}` });
            for (const link of $$("main a[data-worker-name]")) {
                const worker = /** @type {HTMLAnchorElement} */ (link).dataset.workerName;
                if (!worker) throw new Error("Worker navigation has no identity.");
                the(link, "worker-path", directoryPath({ kind: "worker", workspace: workspace.name, worker }));
            }
            the(element, {
                preparation: workspace.preparation.map(({ family, alias, phase }) => `${phase} ${family}${alias ? `/${alias}` : ""}`).join("; "),
                activity: workspace.activity ? `${workspace.activity.phase}${workspace.activity.percent === null ? "" : ` ${workspace.activity.percent}%`}` : "",
                activityMessage: workspace.activity?.message ?? "",
            });
        }
        if (status) {
            if (!workspace) throw new Error("Worker state has no workspace identity.");
            the(element, { ...gauges(status, state.budget), ...clocks(status, now) });
            presentDescendants(status.descendants, workspace.name);
        }
    };
}
