/** {§web-session-reasoning} Display only explicit adapter coordinates; URLs and IDs stay opaque.
 * @param {unknown} coordinate
 */
export default function reasoningCoordinate(coordinate) {
    if (coordinate === undefined) return "";
    if (typeof coordinate !== "string" || !/^\d+\/\d+$/u.test(coordinate)) throw new TypeError("Reasoning coordinate must be loop/turn.");
    const [loop, turn] = coordinate.split("/");
    return `L${loop}/T${turn}`;
}
