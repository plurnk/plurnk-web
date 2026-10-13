# plurnk-web

An optional Plurnk daemon plugin serving an OTM Hello world document at `/`.
Pico Classless Green supplies the styling, with #148800 brand accents and system
monospace typography. It follows the browser's light/dark preference.
No chat interface or additional server.

Directories select their `index.html`: `/` and `/index.html` serve the same
document, as do the two spellings for any admitted nested index. Directory links
include the trailing slash. Missing documents and assets return 404, not the
home page. Only the root document is currently shipped; workspace and worker
routes are not exposed yet.

English is rendered in the document, not filled in by JavaScript. The current
page needs no duplicate English dictionary or browser storage, and has no language
picker or stored preferences. Ordinary navigation and forms
remain native HTML; the eventual interactive worker interface requires JavaScript.

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

```sh
npm ci --no-audit --no-fund
npm run dev
```

Open the loopback URL Vite prints (normally `http://127.0.0.1:5173/`).
HTML edits reload the page; CSS edits update it in place. This serves the frontend
only and neither starts nor restarts the daemon.

`npm run build` compiles the frontend into `ai.plurnk/dist/`. The plugin serves
that build on the daemon's existing port; restart the daemon to load a new build.
`npm run preview` previews the last build locally without a daemon. It is not the
production server. Vite is development tooling only.

`npm test` checks specification tags and witnesses using Plurnk's shared
development checker, server and browser JavaScript, OTM's HTML/JavaScript/CSS
contracts and the module, then packs and installs the plugin
with a published service in a temporary directory. The installed test uses an
isolated configuration, database and dynamically assigned port, plus Playwright
Chromium. Install that test browser with `npx playwright install chromium` if
necessary. The operator's daemon and configuration are not used.
The gate also runs the official HttpAgent in Chromium against that daemon and a
deterministic local model; no paid inference or shipped conversation UI is involved.

`web/index.html` and `web/app.js` are the document and browser entry point.
Vite bundles OTM from its npm entry and compiles the CSS. Build preparation copies
Pico's pinned substrate and dependency licenses, and rasterizes the mascot SVG.
The generated asset inventory tells the plugin which production files to serve.
Build output is packed but not committed. [SPEC.md](SPEC.md) defines the contract.

The four source stylesheets in `web/styles/` load in order (combined in production):

| File | Concern |
|---|---|
| `app-vendor.css` | Generated, unmodified Pico substrate. |
| `app-structure.css` | Layout; no overrides yet. |
| `app-style.css` | Substrate token overrides; brand accents and system monospace. |
| `app-state.css` | Attribute-driven visual state; no rules yet. |

Authored CSS is checked with OTM's Stylelint rules. No remote fonts are required.

Code: MIT. The hamster artwork derives from Google's Noto Emoji under Apache-2.0,
with glasses and a green bow added. See [artwork attribution](web/public/icons/NOTO-NOTICE.txt).
