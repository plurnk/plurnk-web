# plurnk-web

An optional Plurnk daemon plugin serving an OTM Hello world document at `/`.
Pico Classless Green supplies the styling and follows the browser's light/dark
preference. No chat interface or additional server.

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

## Development

`npm test` checks the module and OTM document, then packs and installs the plugin
with a published service in a temporary directory. The installed test uses an
isolated configuration, database and dynamically assigned port, plus Playwright
Chromium. Install that test browser with `npx playwright install chromium` if
necessary. The operator's daemon and configuration are not used.

`npm run build` copies OTM's browser artifact, Pico's pinned Classless Green
stylesheet and both licenses into the package. It does not compile the document
or run a frontend bundler. Generated vendor files
are packed but not committed. [SPEC.md](SPEC.md) defines the current contract.

MIT.
