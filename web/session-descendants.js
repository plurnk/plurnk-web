import { $, the } from "on_the_money";
import { directoryPath } from "../src/directory-addresses.js";
import { descendantTree, gateCount } from "./session-status.js";

/** {§web-session-descendants} Native disclosures retain their own presentation state.
 * @param {HTMLElement} element
 */
export default function sessionDescendants(element) {
    const list = $(element, "#session-descendants > ul");
    if (!list) throw new Error("Session document has no descendant outlet.");
    let rendered = "";
    /** Rows are kept by session identity: an unchanged row keeps its node, focus and disclosure, and moves only when out of place.
     * @param {Element} target @param {import("./session-status.js").DescendantNode[]} nodes @param {string} workspace
     */
    const fill = (target, nodes, workspace) => {
        const rows = new Map(Array.from(target.children, (row) => [row.getAttribute("data-descendant-id"), row]));
        const kept = new Set(nodes.map(({ session }) => String(session.id)));
        for (const [id, row] of rows) if (!kept.has(id ?? "")) row.remove();
        /** @type {Element | null} */
        let previous = null;
        for (const { session, children } of nodes) {
            const row = rows.get(String(session.id)) ?? $.clone(target, "#session-descendant");
            const path = directoryPath({ kind: "session", workspace, session: session.name });
            if (path === null) throw new Error("Descendant has no directory address.");
            the(row, {
                descendantId: session.id, descendantName: session.name, descendantPath: path,
                descendantKind: session.kind, descendantLifecycle: session.lifecycle, descendantGates: gateCount(session.gates),
            });
            let branch = $(row, ":scope > details");
            if (children.length) {
                branch ??= $.clone(row, "#session-descendant-children");
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
    /** @param {readonly import("./session-status.js").DescendantItem[]} sessions @param {string} workspace */
    return (sessions, workspace) => {
        const revision = JSON.stringify([workspace, sessions]);
        if (revision === rendered) return;
        fill(list, descendantTree(sessions), workspace);
        rendered = revision;
    };
}
