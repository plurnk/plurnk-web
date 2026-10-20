# Architecture

Web is an independently packaged Plurnk module, not an independent set of
engineering rules. It makes the daemon accessible through a browser using public
contracts, native documents and the official AG-UI client. Independent releases
do not confer ownership of daemon policy, identity or lifecycle.

## One owner per fact

| Concern | Authority | Web's responsibility |
|---|---|---|
| Listener, mounts, module startup/shutdown | Plurnk host | Register through the public module seam; release module resources. |
| Workspaces, workers, permissions, work and accounting | Daemon | Select and display supplied identities and facts; request explicit actions. |
| Credential issuance, expiry, revocation and sign-in inventory | Daemon credential authority | Mediate the browser's grant; never create a second issuer or account database. |
| AG-UI events, messages, interrupts and replay | HttpAgent | Use public SDK behavior; do not maintain a parallel protocol reducer or transcript. |
| Document structure and ordinary interaction | Semantic HTML and native controls | Templates, links, lists, forms and disclosures. |
| Presentation state | OTM attributes and native element state | Project facts; CSS handles visual consequences. JavaScript handles behavior CSS cannot express. |
| Asset compilation and packaging | Vite and the module's build | Ship a complete local asset inventory; no runtime asset build or CDN. |
| Dynamic diagrams | Ondine in web-owned Node worker threads | Compile bounded source to standalone SVG; the browser displays a native image, not renderer markup. |

Missing platform or OTM functionality is a request to its owner, not permission
to build a compensating subsystem here. Prefer directly explainable ownership
over fallback chains, duplicate state or abstractions that obscure responsibility.

## Configuration authority

Apply the platform's
[configuration authority](https://github.com/plurnk/plurnk-service/blob/main/ARCHITECTURE.md#configuration-authority):
deployment choices belong in the owning package's cascading environment.

- This module declares choices in `ai.plurnk/.env.defaults`, consumed through
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

Current browsers are the target. That does not imply every API is available on
every origin: secure-context and permission requirements are independent of
browser age. Test the deployment surface a feature actually supports. A missing
optional affordance must not silently become a requirement for core interaction.

Dependency code stays behind its owning boundary. Bundle locally, load optional
renderers on demand, and retain licenses. A framework-specific requirement does
not justify weakening CSP or adding a compatibility system.

### Accepted development dependency exposure

The build-only Stylelint → micromatch → braces chain retains
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), a
stack-exhaustion risk from deeply nested glob patterns. The lint command supplies
the repository-owned `web/styles/*.css` pattern; these packages are absent from
the production dependency graph and browser bundle. Keep normal audit reporting
without a fork, override or suppression. Reassess when the upstream chain changes
or a consumer begins accepting untrusted patterns. This accepts the bounded
development exposure, not the dependency's correctness; [#9](https://repo.possumtech.com/plurnk/plurnk-web/issues/9)
retains the investigation and dependency evidence.

## Failure and lifetime

An expected boundary failure retains the user's draft or readable source and
reports what failed. It is not successful completion. Unexpected internal
violations remain visible with useful evidence; do not replace them with an
apparently healthy empty view. Never print credentials or credential responses.

The browser owns delivery and its local resources, not admitted work. Navigation,
disconnection and teardown are not cancellation. Retry and cancellation are
explicit actions; approval follows the configured client choice under
{§web-worker-approval}, never an inferred permission or a replacement for daemon
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
