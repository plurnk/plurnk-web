import { $, $$, the } from "on_the_money";
import { directoryPath } from "../ai.plurnk/directory-addresses.js";
import { descendantTree } from "./worker-status.js";

/** {§web-worker-descendants} Native disclosures retain their own presentation state.
 * @param {HTMLElement} element
 */
export default function workerDescendants(element) {
    const list = $(element, "#worker-descendants > ul");
    if (!list) throw new Error("Worker document has no descendant outlet.");
    let rendered = "";
    /** @param {readonly import("@plurnk/plurnk-agui/client").AguiDescendant[]} workers @param {string} workspace */
    return (workers, workspace) => {
        const revision = JSON.stringify([workspace, workers]);
        if (revision === rendered) return;
        const tree = descendantTree(workers);
        const open = new Set($$(list, "li > details[open]").map((details) => details.parentElement?.getAttribute("data-descendant-id")));
        /** @param {Element} target @param {import("./worker-status.js").DescendantNode[]} nodes */
        const fill = (target, nodes) => {
            $.cloneEach(target, "#worker-descendant", nodes, (row, { worker, children }) => {
                const path = directoryPath({ kind: "worker", workspace, worker: worker.name });
                if (path === null) throw new Error("Descendant has no directory address.");
                the(row, {
                    descendantId: worker.id, descendantName: worker.name, descendantPath: path,
                    descendantKind: worker.kind, descendantLifecycle: worker.lifecycle, descendantGates: worker.gates,
                });
                if (children.length) {
                    const branch = /** @type {HTMLDetailsElement} */ ($.clone(row, "#worker-descendant-children"));
                    the(branch, "descendant-children", children.length);
                    branch.open = open.has(String(worker.id));
                    const nested = $(branch, "ul");
                    if (!nested) throw new Error("Descendant branch has no list.");
                    fill(nested, children);
                }
            });
        };
        fill(list, tree);
        rendered = revision;
    };
}
