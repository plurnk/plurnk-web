/** {§web-session-conversation} Avoid native fragment lookup's literal/percent-decoded ambiguity.
 * @param {string} kind
 * @param {string} identity
 */
export default function anchor(kind, identity) {
    // JSON preserves lone UTF-16 surrogates before the UTF-8 conversion.
    return `${kind}-${new TextEncoder().encode(JSON.stringify(identity)).toBase64({ alphabet: "base64url", omitPadding: true })}`;
}
