export const answerSchema = {
    type: "object",
    properties: {
        action: { type: "string", enum: ["inspect", "leave"], title: "Next action" },
        content: { type: "string", title: "Exact answer" },
        count: { type: "integer", minimum: 0 },
        confirm: { type: "boolean" },
        detail: { type: "string" },
    },
    required: ["action", "content", "count", "confirm"],
    additionalProperties: false,
};

export const exactAnswer = { action: "inspect", content: "  cobalt heron\n  ", count: 0, confirm: false };

export const questionOperation = `\`\`\`question\n${JSON.stringify({
    message: "Which action should the worker take?", requestedSchema: answerSchema,
})}\n\`\`\``;
