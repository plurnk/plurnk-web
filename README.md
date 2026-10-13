# plurnk-web

An optional Plurnk daemon plugin serving an OTM Hello world document at `/`.
Pico Classless Green supplies the styling, with #148800 brand accents and system
monospace typography. It follows the browser's light/dark preference.
No chat interface or additional server.

## Install from source

Requires Node.js 26+ and an existing Plurnk service installation.

```sh
npm ci --no-audit --no-fund
npm test
npm pack
```

Install the resulting archive beside the service, in the same npm installation:

```sh
npm install --no-audit --no-fund /path/to/plurnk-plurnk-web-0.1.0.tgz
```

Restart that daemon and visit its root URL, normally `http://localhost:1066/`.
Native extension trust applies; the standard policy admits `@plurnk/*` packages.
The plugin inherits the daemon's host and port, and leaves more-specific routes
alone. It does not install or start a service.

Set `PLURNK_WEB_ENABLED=0` in the service environment and restart to disable the
module without uninstalling it. The sole setting is documented in
[ai.plurnk/.env.defaults](ai.plurnk/.env.defaults).

## Install as an app

Use the browser's **Install app**, **Add to Home Screen** or **Add to Dock** action,
where supported. The manifest supplies Plurnk's name, icons and standalone window.
Localhost works over HTTP; remote installation requires HTTPS, normally supplied
by your reverse proxy. Installation does not install or start the daemon.

The app requires its daemon to be reachable. It does not register a service worker,
cache workspace data, or provide offline operation. Browser and OS support varies.

## Development

`npm test` checks the module and OTM document, then packs and installs the plugin
with a published service in a temporary directory. The installed test uses an
isolated configuration, database and dynamically assigned port, plus Playwright
Chromium. Install that test browser with `npx playwright install chromium` if
necessary. The operator's daemon and configuration are not used.

`npm run build` copies OTM's browser artifact, Pico's pinned Classless Green
stylesheet and both licenses into the package. It also rasterizes the source SVG
into favicon, Apple touch and app icons; the maskable variant has safe-area padding.
It does not compile the document or run a frontend bundler. Generated icons and vendor files
are packed but not committed. [SPEC.md](SPEC.md) defines the current contract.

The four stylesheets in `ai.plurnk/public/styles/` load in order:

| File | Concern |
|---|---|
| `app-vendor.css` | Generated, unmodified Pico substrate. |
| `app-structure.css` | Layout; no overrides yet. |
| `app-style.css` | Substrate token overrides; brand accents and system monospace. |
| `app-state.css` | Attribute-driven visual state; no rules yet. |

Authored CSS is checked with OTM's Stylelint rules. No frontend bundler or remote
fonts are required.

Code: MIT. The hamster artwork derives from Google's Noto Emoji under Apache-2.0,
with glasses and a green bow added. See [artwork attribution](ai.plurnk/public/icons/NOTO-NOTICE.txt).
