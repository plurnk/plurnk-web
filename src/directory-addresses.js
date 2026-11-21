/** @typedef {{ kind: "daemon" } | { kind: "workspace", workspace: string } | { kind: "session", workspace: string, session: string }} Directory */

/**
 * {§web-directory-addresses} Map canonical workspace and session identities to `/~/<workspace>` and `/~/<workspace>#<session>`.
 * No normalization or substitute identity for legacy names.
 * @param {Directory} directory
 * @returns {string | null}
 */
export function directoryPath(directory) {
    if (directory.kind === "daemon") return "/~/";
    const { workspace } = directory;
    if (!workspace || !workspace.isWellFormed() || workspace.split("/").some((part) => part === "." || part === "..")) return null;
    const path = `/~/${workspace.split("/").map(encodeURIComponent).join("/")}`;
    if (directory.kind === "workspace") return path;
    if (!directory.session || !directory.session.isWellFormed()) return null;
    return `${path}#${encodeURIComponent(directory.session)}`;
}

/**
 * {§web-directory-addresses} Decode an origin-relative `/~/<workspace>[#<session>]` target without database lookups.
 * @param {string} target Origin-relative request target or href.
 * @returns {Directory | null}
 */
export function parseDirectory(target) {
    const hashIndex = target.indexOf("#");
    const beforeHash = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
    const rawSession = hashIndex >= 0 ? target.slice(hashIndex + 1) : undefined;
    const pathname = beforeHash.split("?", 1)[0];
    const match = /^\/(?:~|%7[eE])\/(?<workspace>.*)$/u.exec(pathname);
    if (!match) return null;
    const rawWorkspace = match.groups?.workspace ?? "";
    if (rawWorkspace === "") {
        return rawSession === undefined ? { kind: "daemon" } : null;
    }
    if (rawSession === "") return null;
    try {
        const workspace = decodeURIComponent(rawWorkspace);
        if (rawSession === undefined) {
            /** @type {Directory} */
            const directory = { kind: "workspace", workspace };
            return directoryPath(directory) === null ? null : directory;
        }
        const session = decodeURIComponent(rawSession);
        /** @type {Directory} */
        const directory = { kind: "session", workspace, session };
        return directoryPath(directory) === null ? null : directory;
    } catch (error) {
        if (error instanceof URIError) return null;
        throw error;
    }
}

export const DEFAULT_SESSION_NAME = "session1";

/**
 * {§web-workspace-creation} {§web-session-creation} Allocate the next `<prefix><N>` (`N >= 1`) across active and archived names.
 * @param {"workspace" | "session"} prefix
 * @param {Iterable<string>} existingNames
 * @returns {string}
 */
export function nextSequentialName(prefix, existingNames) {
    const pattern = new RegExp(`^${prefix}([1-9]\\d*)$`, "u");
    let max = 0;
    for (const name of existingNames) {
        const match = pattern.exec(name);
        if (!match) continue;
        const n = Number(match[1]);
        if (Number.isSafeInteger(n) && n > max) max = n;
    }
    return `${prefix}${max + 1}`;
}

/**
 * {§web-workspace-settings} Build `/settings/?workspace=<workspace>[&session=<session>][#<section>]` for representable workspace names.
 * @param {string} workspace
 * @param {string | null} [session]
 * @param {string | null} [section]
 * @returns {string | null}
 */
export function workspaceSettingsPath(workspace, session = null, section = null) {
    if (directoryPath({ kind: "workspace", workspace }) === null) return null;
    const params = new URLSearchParams({ workspace });
    if (session !== null && session !== "" && session.isWellFormed()) {
        params.set("session", session);
    }
    const hash = section ? `#${encodeURIComponent(section)}` : "";
    return `/settings/?${params}${hash}`;
}

/**
 * {§web-directory-addresses} Extract a session name from a URL hash fragment, ignoring empty fragments and in-message footnote anchors.
 * @param {string} hash `location.hash` or `#<session>` string.
 * @returns {string | null}
 */
export function parseSessionHash(hash) {
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    if (!raw || raw.startsWith("footnote-")) return null;
    try {
        const decoded = decodeURIComponent(raw);
        return decoded && decoded.isWellFormed() ? decoded : null;
    } catch {
        return null;
    }
}
