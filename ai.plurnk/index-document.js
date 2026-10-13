/** @param {string} pathname */
export default function indexDocument(pathname) {
    // {§web-index-documents} Resolve before a server can treat a file as a folder.
    return pathname.endsWith("/") ? `${pathname}index.html` : pathname;
}
