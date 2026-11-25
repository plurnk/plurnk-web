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
        $.reconcile(target, "#session-descendant", nodes, {
            attr: "data-descendant-id",
            key: ({ session }) => session.id,
            fill(row, { session, children }) {
                const path = directoryPath({ kind: "session", workspace, session: session.name });
                if (path === null) throw new Error("Descendant has no directory address.");
                the(row, {
                    "descendant-name": session.name, "descendant-path": path,
                    "descendant-kind": session.kind, "descendant-lifecycle": session.lifecycle, "descendant-gates": gateCount(session.gates),
                });
                let branch = $(row, ":scope > details");
                if (children.length) {
                    branch ??= $.clone(row, "#session-descendant-children");
                    the(branch, "descendant-children", children.length);
                    const nested = $(branch, ":scope > ul");
                    if (!nested) throw new Error("Descendant branch has no list.");
                    fill(nested, children, workspace);
                } else branch?.remove();
            },
        });
    };
    /** @param {readonly import("./session-status.js").DescendantItem[]} sessions @param {string} workspace */
    return (sessions, workspace) => {
        const revision = JSON.stringify([workspace, sessions]);
        if (revision === rendered) return;
        fill(list, descendantTree(sessions), workspace);
        rendered = revision;
    };
}
