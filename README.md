# plurnk-web

An optional Plurnk daemon plugin serving native OTM documents at `/`.
Pico Classless Green supplies the styling, with #148800 brand accents and system
monospace typography. It follows the browser's light/dark preference.
Requires a current stable browser; no legacy-browser compatibility layer is shipped.
No chat interface or additional server. The root links to the daemon's workspace
directory at `/~/`; workspace pages list workers as real links. Worker pages
currently show identity and breadcrumbs, not a conversation interface.
Non-worker pages use a 65ch reading width; worker pages use the available width.
Page titles, breadcrumbs and empty/error documents support ordinary browser
navigation with or without JavaScript.

Directories select their `index.html`: `/` and `/index.html` serve the same
document, as do the two spellings for any admitted nested index. Directory links
include the trailing slash. Missing documents and assets return 404, not the
home page. Navigation never creates workspaces or workers, claims control, or
starts inference. Folderless workspaces work the same way as project workspaces.

The [directory address contract](SPEC.md#web-directory-addresses-named-directory-addresses)
maps workspace names to `/~/<workspace>/` and workers to `/~/<workspace>@<worker>/`,
preserving slashes and encoding name punctuation. Names remain separate from
project folders; URLs do not publish workspace files.

## Sign-in

Web uses the daemon's shared `PLURNK_AUTH`, `PLURNK_USER` and `PLURNK_PASS`
configuration. It has no separate user/password configuration. With authentication
enabled, set both user and password; incomplete setup must not admit a browser,
including on localhost. The daemon owns the sign-in form and credential validation.
Set `PLURNK_AGUI_ISSUER` to the public origin when a proxy fronts the daemon.
`PLURNK_AUTH=0` explicitly makes directories anonymous too.

The browser receives an HttpOnly session cookie; no access token, refresh token,
password or operator secret is embedded in a page or browser storage. **Sign out**
ends this browser's sign-in and its module credentials together. Revisiting requires
sign-in. **Account** lists the authority's live sign-ins, marks this session, and
offers native forms to revoke one or all other sessions. No device or last-activity
information is invented. Other sessions and independently authorized clients remain
intact. A daemon restart invalidates sessions. Remotely, use HTTPS.

English is rendered in the document, not filled in by JavaScript. The current
page needs no duplicate English dictionary or browser storage, and has no language
picker or stored preferences. Ordinary navigation and forms
remain native HTML; the eventual interactive worker interface requires JavaScript.

## Install from source

Requires Node.js 26+ and a Plurnk service with the module-client credential API
([credential authority](https://github.com/plurnk/plurnk-service/blob/main/plurnk-core/SPEC.md),
including sign-in inventory and shared browser/module revocation). That API is not in the current published service;
use packed candidate packages for development and verification.

```sh
npm ci --no-audit --no-fund
npm run test:candidate -- /path/to/packed-platform-packages
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
module without uninstalling it. The module and pending-sign-in limits are documented in
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
only and neither starts nor restarts the daemon. Directory and sign-in requests
need the daemon; Vite does not emulate its data or authentication.

`npm run build` compiles the frontend into `ai.plurnk/dist/`. The plugin serves
that build on the daemon's existing port; restart the daemon to load a new build.
`npm run preview` previews the last build locally without a daemon. It is not the
production server. Vite is development tooling only.

`npm test` checks specification tags and witnesses using Plurnk's shared
development checker, server and browser JavaScript, OTM's HTML/JavaScript/CSS
contracts and the module, then packs and installs the plugin
with packed candidate service packages in a temporary directory. `test:candidate`
installs the candidate public type declarations without rewriting the lockfile,
then runs the full gate with `PLURNK_WEB_TEST_PACKAGES` naming the archive directory.
The installed test uses an
isolated configuration, database and dynamically assigned port, plus Playwright
Chromium. Install that test browser with `npx playwright install chromium` if
necessary. The operator's daemon and configuration are not used.
The gate also runs the official HttpAgent in Chromium against that daemon and a
deterministic local model; no paid inference or shipped conversation UI is involved.

`web/index.html` and `web/app.js` are the document and browser entry point.
Vite bundles OTM from its npm entry and compiles the CSS. Build preparation copies
Pico's readable pinned substrate and dependency licenses, and derives a maskable SVG
from the mascot. Production prunes unused CSS rules, variables and keyframes from
the browser and server-rendered document sources before minification.
The generated asset inventory tells the plugin which production files to serve.
Build output is packed but not committed. [SPEC.md](SPEC.md) defines the contract.

The `web/styles/index.css` import entry composes the four source layers in order
before production pruning, so references between layers remain visible:

| File | Concern |
|---|---|
| `app-vendor.css` | Generated, unmodified Pico substrate. |
| `app-structure.css` | Reading width, gutters and wrapping. |
| `app-style.css` | Substrate token overrides; brand accents and system monospace. |
| `app-state.css` | Worker page width and native focus visibility. |

Authored CSS is checked with OTM's Stylelint rules. No remote fonts are required.

Code: MIT. The hamster artwork derives from Google's Noto Emoji under Apache-2.0,
with glasses and a green bow added. See [artwork attribution](web/public/icons/NOTO-NOTICE.txt).
