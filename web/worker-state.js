import { $, $$, the } from "on_the_money";
import { directoryPath } from "../ai.plurnk/directory-addresses.js";
import { clocks, gauges, workspaceIdentity } from "./worker-status.js";

/** {§web-worker-status} {§web-worker-identity} Project the SDK's state; retain no separate daemon state.
 * @param {HTMLElement} element
 */
export default function workerState(element) {
    const { threadId, workerName } = element.dataset;
    if (!threadId || !workerName) throw new Error("Worker identity is incomplete.");
    const breadcrumb = $("#worker-workspace");
    const folder = $("#worker-folder");
    const preparation = $(element, "[data-preparation]");
    const inbox = $(element, "#worker-inbox ol");
    if (!breadcrumb || !folder || !preparation || !inbox) throw new Error("Worker status document is incomplete.");
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
            the(element, { workerPath: identity.workerPath, signInPath: `/auth/login?return=${encodeURIComponent(identity.workerPath)}` });
            for (const link of $$("main a[data-worker-name]")) {
                const worker = /** @type {HTMLAnchorElement} */ (link).dataset.workerName;
                if (!worker) throw new Error("Worker navigation has no identity.");
                the(link, "worker-path", directoryPath({ kind: "worker", workspace: workspace.name, worker }));
            }
            the(element, {
                preparationCount: workspace.preparation.length,
                activityPhase: workspace.activity?.phase ?? "None",
                activityCounts: workspace.activity ? `${workspace.activity.completed} / ${workspace.activity.total}` : "—",
                activityPercent: workspace.activity?.percent ?? "—",
                activityMessage: workspace.activity?.message ?? "",
            });
            $.cloneEach(preparation, "#worker-preparation", workspace.preparation, (row, item) => {
                the(row, { preparationFamily: item.family, preparationAlias: item.alias ?? "", preparationPhase: item.phase, preparationSince: item.since });
            });
        }
        if (status) {
            the(element, { ...gauges(status, state.budget), ...clocks(status, now) });
            $.cloneEach(inbox, "#worker-pending-message", status.inbox, (row, item) => {
                the(row, { inboxPath: item.path, inboxId: item.id ?? "None", inboxLoop: item.loopId, inboxLifecycle: item.lifecycle });
            });
        }
    };
}
