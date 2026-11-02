/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** {§web-session-reasoning} Display explicit adapter session and loop/turn identity; URLs and IDs stay opaque.
 * @param {unknown} plurnk
 */
export default function reasoningCoordinate(plurnk) {
    if (plurnk === undefined) return "";
    if (!isRecord(plurnk)) throw new TypeError("Reasoning metadata must be a record.");
    const { sessionName, loopSeq, turnSeq, coordinate } = plurnk;
    if (sessionName !== undefined && (typeof sessionName !== "string" || !sessionName)) {
        throw new TypeError("Reasoning sessionName must be a non-empty string.");
    }
    if (loopSeq !== undefined || turnSeq !== undefined) {
        if (
            typeof loopSeq !== "number" || !Number.isSafeInteger(loopSeq) || loopSeq < 0
            || typeof turnSeq !== "number" || !Number.isSafeInteger(turnSeq) || turnSeq < 0
        ) {
            throw new TypeError("Reasoning loopSeq and turnSeq must be non-negative integers.");
        }
    }
    if (coordinate !== undefined) {
        if (typeof coordinate !== "string" || !/^\d+\/\d+$/u.test(coordinate)) {
            throw new TypeError("Reasoning coordinate must be loop/turn.");
        }
        if (loopSeq !== undefined && coordinate !== `${loopSeq}/${turnSeq}`) {
            throw new TypeError("Reasoning coordinate must match loopSeq and turnSeq.");
        }
    }
    const loopTurn = loopSeq !== undefined ? `Loop ${loopSeq} > Turn ${turnSeq}` : "";
    return [sessionName, loopTurn].filter(Boolean).join(" > ");
}
