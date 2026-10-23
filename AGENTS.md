# plurnk-web

An independently packaged Plurnk daemon module serving native OTM documents.
Read ARCHITECTURE.md first, the owning SPEC.md contract before changing behavior,
and OTM's installed README completely before writing browser code.

HTML owns document content and structure. Directory navigation uses real links
and lists; ordinary actions use semantic forms and native controls. The core
interactive worker requires JavaScript: do not build a parallel no-JS agent
interface. OTM enhances documents, not a generic JavaScript application shell.
Readable English lives at its rendering site, not in placeholders replaced at
boot. OTM defects and missing general mechanisms go upstream; do not introduce
consumer shims or disable its checks to work around them.
Keep CSS concerns in four files: app-vendor.css (pinned Pico Classless Green),
app-structure.css (layout), app-style.css (token overrides), and app-state.css
(attribute-driven visual state). Use #148800 brand accents, readable light/dark
colors and system monospace typography. Do not add decorative theming, navigation,
state machinery or dependencies for future work. Content-renderer dependencies
load their own styles with their lazy modules, not through the shared page stylesheet.

The module uses only public Plurnk contracts. It owns no listener, daemon,
database or agent lifecycle. Before adding a constant, default, limit or setting,
apply ARCHITECTURE.md's configuration-authority rule: identify the panel choice or
the mechanism that justifies it. Configuration belongs in ai.plurnk/.env.defaults,
read through Knob with no local fallback. Do not create browser-side daemon policy.

Frontend source lives in web/. Vite owns development serving and production
compilation; the module serves only the built ai.plurnk/dist/ asset inventory.
Keep Vite out of runtime dependencies. Generated assets are packed, not committed.

Commit, then run `npm run test:candidate -- <packed-platform-directory>` with published or
candidate platform and terminal client archives. It gates the committed HEAD in a throwaway
clone: `npm ci` from the lockfile, the archives installed beside it without saving, then
`npm test`, including a packed installation on an isolated daemon. The checkout, which may be
the plugin root an operator's daemon serves, is only read; a failed gate leaves its clone
for diagnosis and names it.
Commit verified changes with the registered agent as author and the operator as
signed committer, then push to the canonical forge. No automatic publication.
Work lands from a `<type>/<slug>` branch as a signed `--no-ff` merge whose subject reads
`<type>(<scope>): land … (#N)`; gate that merge commit itself, then push it as `main`.

Use focused checks while iterating; the full candidate gate verifies the assembled
package before landing. Keep candidate archives independent of active daemon work.
Never restart the operator's service or probe a paid model as a side effect of a gate.
Check browser console warnings/errors and uncaught exceptions yourself. Exercise
relevant origin, authentication and lifecycle boundaries; localhost success does
not establish ordinary HTTP behavior. Diagnose failures before changing assertions.

General JavaScript lint covers the module, browser, tests and build tooling; OTM
rules apply to browser authoring. Use modern ESM and platform APIs, preserve error
causes, and remove unused code rather than suppress checks. Do not restyle unrelated
code, introduce compatibility aliases, or copy a private platform validator.

Repository issues own investigation; SPEC.md owns current behavior.
Create issues with one Conventional type label and the accountable agent. Use full
issue URLs for other repositories; local #N references name this repository only.

Before changing a contract, reconcile its specification, implementation,
documentation and meaningful coverage. Do not preserve contradictory teaching.
Use the service's named-tag convention: one `§lowercase-kebab` declaration at
the beginning of its owning SPEC.md block, and `{§lowercase-kebab}` citations
elsewhere. Tags are unique within the repository; every citation resolves and
every contract has an implementation or coverage witness. A citation is not a
substitute for testing the promised behavior through its real boundary.
`npm test` runs the shared specification checker as part of lint. No local
validator or adjacent service checkout is required.
