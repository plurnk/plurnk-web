import "./schema-validation.js";
import { MessageSchema } from "./worker-agent.js";
import { z } from "zod/v4";
import daemonRead from "./daemon-read.js";

// {§web-worker-history} Page envelopes are daemon-owned; message validation remains standard ACP.
const PageSchema = z.object({ final: z.boolean(), older: z.string().min(1).nullable(), messages: z.array(z.custom((/** @type {unknown} */ val) => MessageSchema.safeParse(val).success)) });

/** @param {string} address @param {"session" | "none"} auth @param {AbortSignal} signal */
export default async function readHistory(address, auth, signal) {
    const response = await daemonRead(address, auth, signal);
    const page = PageSchema.parse(await response.json());
    if (new Set(page.messages.map(({ id }) => id)).size !== page.messages.length) throw new Error("History page has duplicate message identities.");
    return page;
}
