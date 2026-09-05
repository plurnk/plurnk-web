import { createElement } from "react";

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

const icons = { completed: "✓", in_progress: "◇", pending: "○" } as const;

export function PlanContent({ entries }: { entries: PlanEntry[] }) {
  return createElement("section", { className: "plan", "aria-label": "Plan" },
    createElement("div", { className: "semantic-label" }, "Plan"),
    createElement("ol", null, ...entries.map((entry, index) =>
      createElement("li", { className: `plan-${entry.status}`, key: `${index}:${entry.content}` },
        createElement("span", { "aria-hidden": true }, icons[entry.status]),
        createElement("span", null, entry.content),
      ),
    )),
  );
}
