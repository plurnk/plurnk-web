# plurnk-web

An optional Plurnk daemon plugin serving native OTM documents at `/`.
Pico Classless Green supplies the styling, with #148800 brand accents and system
monospace typography. It follows the browser's light/dark preference.
Requires a current stable browser; no legacy-browser compatibility layer is shipped.
No chat interface or additional server. The root links to the daemon's workspace
directory at `/~/`; workspace pages list model workers as real links, with native
collapsed child branches and a “Background work” section for branches beneath
internal actors. Bookkeeping workers are omitted. Worker pages show identity,
breadcrumbs, their actual parent, and live read-only status, without a duplicate page
heading. There is no conversation UI.
The workspace list marks folderless workspaces with ☁️ and folder-backed ones with 📁.
On a workspace page, matching workspace/folder labels share one 📁 breadcrumb;
otherwise ☁️ identifies the workspace and a separate 📁 line shows its project
folder, if any. Folder labels use the daemon's home abbreviation, not the browser's.
Non-worker pages use a 65ch reading width; worker pages use the available width.
Page titles, breadcrumbs and empty/error documents support ordinary browser
navigation with or without JavaScript.
Header controls: 📁 Workspaces, ⚙️ Account, ✖ Sign out.
Breadcrumbs fit between the mascot and menu, or center below them when space is short.

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

Web uses the daemon's shared `PLURNK_AUTH` and `PLURNK_PASS` configuration.
There is one local operator account and no username setting. With authentication
enabled, set a password; an empty password does not admit a browser,
including on localhost. The daemon owns the sign-in form and credential validation.
Set `PLURNK_AGUI_ISSUER` to the public origin when a proxy fronts the daemon.
`PLURNK_AUTH=0` explicitly makes directories anonymous too.

The daemon's native sign-in and setup/error pages use the same compiled Pico
stylesheet as web. Authentication remains daemon-owned; web supplies no login form.

The browser receives an HttpOnly session cookie; no access token, refresh token,
password or operator secret is embedded in a page or browser storage. **Sign out**
ends this browser's sign-in and its module credentials together. Revisiting requires
sign-in. **Account → Sessions** lists the authority's live sign-ins, marks this session,
and offers native forms to revoke one or all other sessions. No device or last-activity
information is invented. Other sessions and independently authorized clients remain
intact. A daemon restart invalidates sessions. Remotely, use HTTPS.

The same-origin `POST /auth/token` connection primitive supplies short-lived
AG-UI access credentials to a signed-in browser. OAuth refresh credentials stay
server-side; rotation and revocation use the daemon's authority.

Worker pages passively connect through the official HttpAgent. They show lifecycle,
elapsed time, turns, request/token totals and cost from the daemon; unavailable
accounting stays **Unknown**, not zero. A finished loop leaves the page watching
for the next one. Closing, refreshing or navigating away never cancels work.
Connection failure stops observation and marks the displayed values as stale;
use **Reconnect** or, after revocation, **Sign in**. No automatic work retries occur.

English is rendered in the document, not filled in by JavaScript. The current
page needs no duplicate English dictionary or browser storage, and has no language
picker or stored preferences. Ordinary navigation and forms
remain native HTML; live worker status requires JavaScript.

## Install from source

Requires Node.js 26+ and a Plurnk service with the module-client credential and
workspace-label APIs
([credential authority](https://github.com/plurnk/plurnk-service/blob/main/plurnk-core/SPEC.md),
including sign-in inventory, shared browser/module revocation, password-only login,
and registered authorization-page styles, plus daemon-supplied folder labels).
These APIs are not in the current published service;
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
deterministic local model; no paid inference is involved. Separate journeys exercise
the shipped read-only worker page without injecting an SDK or mocking AG-UI.
It exercises synchronization, observer/control disconnects, approval interrupts,
shutdown and the real browser sign-in/access-token lifecycle. Cross-client prompt
delivery, exact READ operands and correlated results are compared live and after
refresh through the SDK's messages, without custom-row reconstruction. No AG-UI traffic is
mocked and no client-owned replay cache hides differences from the daemon's history.
Browser journeys also check console warnings/errors and uncaught exceptions;
deliberately tested failures require explicit diagnostic expectations.

`web/index.html` and `web/app.js` are the document and browser entry point.
Vite bundles OTM from its npm entry and compiles the CSS. Build preparation copies
Pico's readable pinned substrate and dependency licenses, and derives a maskable SVG
from the mascot. HttpAgent loads only on worker pages; Vite includes the bundled
dependencies' license notices. Production prunes unused CSS rules, variables and keyframes from
the browser and server-rendered document sources, plus the authority's publicly
exported document specimens, before minification. The AG-UI package supplies those
specimens as a development dependency only; no daemon code enters the browser bundle.
Its public type declarations currently require Node typings, including for type-only
browser consumers; these declarations are erased, not bundled.
The generated asset inventory tells the plugin which production files to serve.
Build output is packed but not committed. [SPEC.md](SPEC.md) defines the contract.

The `web/styles/index.css` import entry composes the four source layers in order
before production pruning, so references between layers remain visible:

| File | Concern |
|---|---|
| `app-vendor.css` | Generated, unmodified Pico substrate. |
| `app-structure.css` | Reading width, gutters and wrapping. |
| `app-style.css` | Substrate token overrides; brand accents and system monospace. |
| `app-state.css` | Worker page width, connection state and native focus visibility. |

Authored CSS is checked with OTM's Stylelint rules. No remote fonts are required.

Code: MIT. The hamster artwork derives from Google's Noto Emoji under Apache-2.0,
with glasses and a green bow added. See [artwork attribution](web/public/icons/NOTO-NOTICE.txt).
