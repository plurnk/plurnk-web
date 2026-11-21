/** @param {string} pathname */
export default function indexDocument(pathname) {
    // {§web-index-documents} Resolve static directory indexes before a server can treat a file as a folder;
    // `/~/` named-directory paths carry literal workspace names under {§web-directory-addresses}.
    if (/^\/(?:~|%7[eE])(?:\/|$)/u.test(pathname)) return pathname;
    return pathname.endsWith("/") ? `${pathname}index.html` : pathname;
}
