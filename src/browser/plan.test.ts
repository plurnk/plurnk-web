import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanContent } from "./plan.ts";

test("PLAN renders task status and literal content without a memory-prefix protocol", () => {
  const html = renderToStaticMarkup(createElement(PlanContent, { entries: [
    { content: "Memory: Check the evidence.", priority: "medium", status: "pending" },
    { content: "Memory: Inspect <source>.", priority: "high", status: "in_progress" },
    { content: "Memory: Ran the tests.", priority: "low", status: "completed" },
  ] }));
  assert.match(html, /plan-pending.*?>○<.*?Memory: Check the evidence\./);
  assert.match(html, /plan-in_progress.*?>◇<.*?Memory: Inspect &lt;source&gt;\./);
  assert.match(html, /plan-completed.*?>✓<.*?Memory: Ran the tests\./);
  assert.doesNotMatch(html, /💾|<source>/);
});
