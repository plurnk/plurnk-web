import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlainReasoningContent } from "./reasoning.ts";

test("reasoning is escaped plaintext rather than rendered Markdown", () => {
  const content = "# heading\n\n**bold**\n<script>alert('no')</script>";
  const html = renderToStaticMarkup(createElement(PlainReasoningContent, {
    hasContent: true,
    children: content,
  }));

  assert.match(html, /class="reasoning-content"/);
  assert.match(html, /# heading\n\n\*\*bold\*\*/);
  assert.match(html, /&lt;script&gt;alert\(&#x27;no&#x27;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<(?:h1|strong|script)>/);
});

test("completed empty reasoning has no content projection", () => {
  assert.equal(renderToStaticMarkup(createElement(PlainReasoningContent)), "");
});
