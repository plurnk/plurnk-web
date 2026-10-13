# plurnk-web

An optional daemon module serving an OTM document. Read SPEC.md before changing
behavior, and OTM's installed README before writing browser code.

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
state machinery or dependencies for future work.

The module uses only public Plurnk contracts. It owns no listener, daemon,
database or agent lifecycle. Configuration belongs in ai.plurnk/.env.defaults.

Frontend source lives in web/. Vite owns development serving and production
compilation; the module serves only the built ai.plurnk/dist/ asset inventory.
Keep Vite out of runtime dependencies. Generated assets are packed, not committed.

Run `npm ci --no-audit --no-fund`, then `npm test`. The gate includes a packed
installation on an isolated daemon; it must not touch the operator's service.
Commit verified changes with the registered agent as author and the operator as
signed committer, then push to the canonical forge. No automatic publication.

Repository issues own investigation; SPEC.md owns current behavior.

Before changing a contract, reconcile its specification, implementation,
documentation and meaningful coverage. Do not preserve contradictory teaching.
Use the service's named-tag convention: one `§lowercase-kebab` declaration at
the beginning of its owning SPEC.md block, and `{§lowercase-kebab}` citations
elsewhere. Tags are unique within the repository; every citation resolves and
every contract has an implementation or coverage witness. A citation is not a
substitute for testing the promised behavior through its real boundary.
