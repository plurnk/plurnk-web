import indexDocument from "./index-document.js";

/** @typedef {{ kind: "daemon" } | { kind: "workspace", workspace: string } | { kind: "worker", workspace: string, worker: string }} Directory */

/** @param {Directory} directory @returns {string | null} */
export function directoryPath(directory) {
    // {§web-directory-addresses} No normalization or substitute identity for legacy names.
    if (directory.kind === "daemon") return "/~/";
    const { workspace } = directory;
    if (!workspace || !workspace.isWellFormed() || workspace.split("/").some((part) => part === "." || part === "..")) return null;
    const path = `/~/${workspace.split("/").map(encodeURIComponent).join("/")}`;
    if (directory.kind === "workspace") return `${path}/`;
    if (!directory.worker || !directory.worker.isWellFormed()) return null;
    return `${path}@${encodeURIComponent(directory.worker)}/`;
}

/** @param {string} target Origin-relative request target. @returns {Directory | null} */
export function parseDirectory(target) {
    const pathname = indexDocument(target.split(/[?#]/u, 1)[0]);
    // Split syntax before decoding; an encoded @ or slash is part of the name.
    const match = /^\/(?:~|%7[eE])\/(?:(?<workspace>[^@]+)(?:@(?<worker>[^/@]+))?\/)?index\.html$/u.exec(pathname);
    if (!match) return null;
    const { workspace, worker } = match.groups ?? {};
    if (workspace === undefined) return { kind: "daemon" };
    try {
        /** @type {Directory} */
        const directory = worker === undefined
            ? { kind: "workspace", workspace: decodeURIComponent(workspace) }
            : { kind: "worker", workspace: decodeURIComponent(workspace), worker: decodeURIComponent(worker) };
        return directoryPath(directory) === null ? null : directory;
    } catch (error) {
        if (error instanceof URIError) return null;
        throw error;
    }
}
