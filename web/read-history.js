import "./schema-validation.js";
import { SessionTranslator } from "./session-agent.js";
import { z } from "zod/v4";
import daemonRead from "./daemon-read.js";

// {§web-session-history} Page envelopes are daemon-owned; updates project through SessionTranslator.
const UpdateSchema = z.object({ sessionUpdate: z.string().min(1) }).passthrough();
const PageSchema = z.object({
    session: z.string().min(1),
    history: z.object({
        older: z.string().min(1).nullable().optional(),
        newer: z.string().min(1).nullable().optional(),
    }),
    updates: z.array(UpdateSchema),
});

/** @param {string} address @param {"session" | "none"} auth @param {AbortSignal} signal */
export default async function readHistory(address, auth, signal) {
    const response = await daemonRead(address, auth, signal);
    const raw = PageSchema.parse(await response.json());
    const messages = SessionTranslator.projectMessages(
        /** @type {readonly import("./session-agent.js").AcpSessionUpdate[]} */ (raw.updates),
    );
    if (new Set(messages.map(({ id }) => id)).size !== messages.length) throw new Error("History page has duplicate message identities.");
    const completed = new Set(messages.flatMap((message) => message.role === "tool" && !message._meta?.plurnk ? [message.toolCallId] : []));
    const open = messages.some((message) => message.role === "assistant" && (message.toolCalls ?? []).some(({ toolCallId }) => !completed.has(toolCallId)));
    return { final: !open, older: raw.history.older ?? null, messages };
}
