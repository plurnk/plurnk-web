# plurnk-web

An optional daemon module serving an OTM document. Read SPEC.md before changing
behavior, and OTM's installed README before writing browser code.

HTML owns content and structure. Browser JavaScript enhances the document; it
does not construct an application shell. Native browser behavior is preferred.
Keep CSS concerns in four files: app-vendor.css (pinned Pico Classless Green),
app-structure.css (layout), app-style.css (token overrides), and app-state.css
(attribute-driven visual state). Keep the existing green light/dark palette;
use system monospace typography. Do not add decorative theming, navigation,
state machinery or dependencies for future work.

The module uses only public Plurnk contracts. It owns no listener, daemon,
database or agent lifecycle. Configuration belongs in ai.plurnk/.env.defaults.

Run `npm ci --no-audit --no-fund`, then `npm test`. The gate includes a packed
installation on an isolated daemon; it must not touch the operator's service.
Commit verified changes with the registered agent as author and the operator as
signed committer, then push to the canonical forge. No automatic publication.

Repository issues own investigation; SPEC.md owns current behavior.
