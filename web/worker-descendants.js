import { $, the } from "on_the_money";
import { directoryPath } from "../ai.plurnk/directory-addresses.js";
import { descendantTree } from "./worker-status.js";

/** {§web-worker-descendants} Native disclosures retain their own presentation state.
 * @param {HTMLElement} element
 */
export default function workerDescendants(element) {
    const list = $(element, "#worker-descendants > ul");
    if (!list) throw new Error("Worker document has no descendant outlet.");
    let rendered = "";
    /** Rows are kept by worker identity: an unchanged row keeps its node, focus and disclosure, and moves only when out of place.
     * @param {Element} target @param {import("./worker-status.js").DescendantNode[]} nodes @param {string} workspace
     */
    const fill = (target, nodes, workspace) => {
        const rows = new Map(Array.from(target.children, (row) => [row.getAttribute("data-descendant-id"), row]));
        const kept = new Set(nodes.map(({ worker }) => String(worker.id)));
        for (const [id, row] of rows) if (!kept.has(id ?? "")) row.remove();
        /** @type {Element | null} */
        let previous = null;
        for (const { worker, children } of nodes) {
            const row = rows.get(String(worker.id)) ?? $.clone(target, "#worker-descendant");
            const path = directoryPath({ kind: "worker", workspace, worker: worker.name });
            if (path === null) throw new Error("Descendant has no directory address.");
            the(row, {
                descendantId: worker.id, descendantName: worker.name, descendantPath: path,
                descendantKind: worker.kind, descendantLifecycle: worker.lifecycle, descendantGates: worker.gates,
            });
            let branch = $(row, ":scope > details");
            if (children.length) {
                branch ??= $.clone(row, "#worker-descendant-children");
                the(branch, "descendant-children", children.length);
                const nested = $(branch, ":scope > ul");
                if (!nested) throw new Error("Descendant branch has no list.");
                fill(nested, children, workspace);
            } else branch?.remove();
            /** @type {Element | null} */
            const position = previous === null ? target.firstElementChild : previous.nextElementSibling;
            if (position !== row) target.insertBefore(row, position);
            previous = row;
        }
    };
    /** @param {readonly import("@plurnk/plurnk-acp/client").AcpDescendant[]} workers @param {string} workspace */
    return (workers, workspace) => {
        const revision = JSON.stringify([workspace, workers]);
        if (revision === rendered) return;
        fill(list, descendantTree(workers), workspace);
        rendered = revision;
    };
}
