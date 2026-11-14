# Architecture

Web is an independently packaged Plurnk module, not an independent set of
engineering rules. It makes the daemon accessible through a browser using public
contracts, native documents and the official ACP client. Independent releases
do not confer ownership of daemon policy, identity or lifecycle.

## One owner per fact

| Concern | Authority | Web's responsibility |
|---|---|---|
| Listener, mounts, module startup/shutdown | Plurnk host | Register through the public module seam; stop admission and settle route work before releasing module resources ({§web-route-settlement}). |
| Workspaces, sessions, permissions, work and accounting | Daemon | Select and display supplied identities and facts; request explicit actions. |
| Credential issuance, expiry, revocation and sign-in inventory | Daemon credential authority | Mediate the browser's grant; never create a second issuer or account database. |
| ACP events, live messages, interrupts and replay | Official ACP SDK (`@agentclientprotocol/sdk`) | Use public SDK behavior; do not maintain a parallel protocol reducer. |
| Conversation history boundaries and pages | Daemon | Display explicitly fetched read-only pages alongside the SDK window; never upload archival presentation as agent input. |
| Document structure and ordinary interaction | Semantic HTML and native controls | Templates, links, lists, forms and disclosures. |
| Presentation state | OTM attributes and native element state | Project facts; CSS handles visual consequences. JavaScript handles behavior CSS cannot express. |
| Asset compilation and packaging | Vite and the module's build | Ship a complete local asset inventory; no runtime asset build or CDN. |
| Dynamic diagrams | Ondine in web-owned Node threads | Compile bounded source to standalone SVG; the browser displays a native image, not renderer markup. |

Missing platform or OTM functionality is a request to its owner, not permission
to build a compensating subsystem here. Prefer directly explainable ownership
over fallback chains, duplicate state or abstractions that obscure responsibility.

## Configuration authority

Apply the platform's
[configuration authority](https://github.com/plurnk/plurnk-service/blob/main/ARCHITECTURE.md#configuration-authority):
deployment choices belong in the owning package's cascading environment.

- This module declares choices in `.env.defaults`, consumed through
  the shared `Knob` reader after the host assembles the floor. Reads supply no
  replacement default. Invalid configuration goes to the existing capability
  diagnostic; unrelated daemon work remains usable.
- A limit, lifetime or posture that an operator could sensibly change needs an
  owner and a panel entry. Defaults favor least surprise, then least regret.
  Web does not redeclare the daemon's authentication or permission choices.
- Protocol values, units and algorithms remain code. Name non-obvious mechanism
  constants and explain their derivation. A local elapsed-time repaint follows
  display precision; it is not a network polling interval or work timeout.
  Semantic layout and presentation belong in CSS, not environment variables.
- A browser-facing setting, if needed, is a public projection of the host's
  resolved configuration. Never expose the environment wholesale, introduce a
  second browser configuration dialect, or bake deployment policy into Vite.
- Test deadlines and specimen data belong to their fixtures; they do not define
  product defaults. Tests of module configuration use the real panel.

The existing configuration contract is {§web-configuration}. Review ownership
before introducing a value; a blanket ban on numeric literals is not that review.

## Browser mechanisms

Prefer the platform's declarative mechanisms: HTML for structure and validation,
CSS for layout and visual state, OTM for projection, and the SDK for protocol.
Use JavaScript for integration and behavior those mechanisms do not express.
Do not recreate a substrate's rules at each call site.

The document projects content, not protocol envelopes. Keep entries minimal and
directly addressable; nesting in SDK objects does not require nested HTML.
`data-*` carries only semantics needed for presentation or interaction, never a
second serialized dataset. Accessible names need no duplicate visible labels;
decorative glyphs and arrangement belong to CSS. Structured records and rendering
bookkeeping stay in JavaScript. Add elements for meaning or native behavior, not
merely because a field is available.

Structural work does not authorize an appearance pass. Preserve the substrate
and explicitly agreed presentation; propose new visual choices separately.
Putting a choice in classless CSS does not make it structural. The current
styling boundary is {§web-document}.

Current browsers are the target. That does not imply every API is available on
every origin: secure-context and permission requirements are independent of
browser age. Test the deployment surface a feature actually supports. A missing
optional affordance must not silently become a requirement for core interaction.

Dependency code stays behind its owning boundary. Bundle locally, load optional
renderers on demand, and retain licenses. A framework-specific requirement does
not justify weakening CSP or adding a compatibility system.

### Accepted development dependency exposure

The build-only PurgeCSS → fast-glob → micromatch → braces chain (Stylelint 18 dropped
its own micromatch path) retains
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), a
stack-exhaustion risk from deeply nested glob patterns. The build supplies only
its own repository-owned content globs; these packages are absent from
the production dependency graph and browser bundle. Keep normal audit reporting
without a fork, override or suppression. Reassess when the upstream chain changes
or a consumer begins accepting untrusted patterns. This accepts the bounded
development exposure, not the dependency's correctness; [#9](https://repo.possumtech.com/plurnk/plurnk-web/issues/9)
retains the investigation and dependency evidence.

### Pinned and reviewed dependencies

| Dependency | Why it stands as it does |
|---|---|
| `zod` 4.6.7, an exact direct dependency | The SDK and the page share one copy: `web/schema-validation.js` configures it `jitless` before the SDK loads, as the page's CSP requires, and a second copy would not receive that. It moves only with the SDK's own range. |
| `ondine` 0.0.2, the server-side diagram compiler | Reviewed 2026-11-14: one maintainer, published 2026-10-20 with SLSA v1 provenance, no dependencies, its compilers WASM. Review it again at every version change. |
| `highlight.js` 11, the browser syntax tokenizer | Reviewed 2026-11-13: BSD-3-Clause, no dependencies, no `eval` or inline styles, the most widely deployed highlighter with a stable class-scope output. Web reads that output as tokens and projects them as CSS Custom Highlight ranges, so the content keeps one text node and the stylesheet needs no class selectors; Shiki's inline styles would breach the CSP and a hand-written lexer would be a second grammar authority. |
| `@types/negotiator` 0.6 for `negotiator` 1.1 | No 1.x declarations exist; `src/static-assets.js` declares the one 1.x call it relies on, `encoding(available, { preferred })`. |

## Failure and lifetime

An expected boundary failure retains the user's draft or readable source and
reports what failed. It is not successful completion. Unexpected internal
violations remain visible with useful evidence; do not replace them with an
apparently healthy empty view. Never print credentials or credential responses.

The browser owns delivery and its local resources, not admitted work. Navigation,
disconnection and teardown are not cancellation. Mutating retries and cancellation are
explicit actions, while idempotent passive observation streams recover automatically under
{§web-session-observer}; approval follows the configured client choice under
{§web-session-approval}, never an inferred permission or a replacement for daemon
authority. Resource cleanup must preserve both the original failure and cleanup
failures.

## Documentation and proof

`README.md` teaches usage; `AGENTS.md` guides contributors; this document explains
ownership and design principles. `SPEC.md` owns tagged current contracts, and the
forge owns investigation and history. Promote an explanation to its proper home
instead of repeating it across code, tests and documents.

Coverage witnesses a contract through its meaningful boundary. Build and install
the package for installed behavior; use real origins, the official SDK and an
isolated daemon for browser interactions. Enumerate relevant dimensions before
choosing cases, including failure and departure. Browser diagnostics are evidence,
not noise to filter away. Neither a tag citation nor a green test count proves an
unexercised promise. Shared development checks belong in shared tooling, never a
copied private service script or a required sibling checkout.
